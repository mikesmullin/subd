import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { spawn } from 'child_process';

function wildcardMatch(pattern, value) {
  if (typeof pattern !== 'string') return false;
  if (pattern === '*') return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(String(value ?? ''));
}

function conditionMatches(expected, actual) {
  if (Array.isArray(expected)) {
    return expected.some((item) => conditionMatches(item, actual));
  }

  if (typeof expected === 'string' && expected.includes('*')) {
    return wildcardMatch(expected, actual);
  }

  return expected === actual;
}

export class HooksRuntime {
  constructor({ template = {}, cliPath }) {
    this.template = template || {};
    this.cliPath = cliPath;
    this.hooks = [];
    this.hooksByEvent = new Map();
  }

  async init() {
    const merged = new Map();

    const repoDir = path.resolve(process.cwd(), 'agent/hooks');
    const userDir = path.resolve(os.homedir(), '.config/daemon/agent/hooks');

    this.loadHooksFromDirectory(repoDir, merged, 'repo');
    this.loadHooksFromDirectory(userDir, merged, 'user');
    this.loadTemplateHooks(merged);

    this.hooks = Array.from(merged.values()).filter((hook) => hook.enabled !== false && hook.on && hook.do);
    this.hooksByEvent.clear();

    for (const hook of this.hooks) {
      if (!this.hooksByEvent.has(hook.on)) this.hooksByEvent.set(hook.on, []);
      this.hooksByEvent.get(hook.on).push(hook);
    }
  }

  hookKey(hook, fallback) {
    if (hook?.name) return `${hook.on}::${hook.name}`;
    return `${hook?.on || 'unknown'}::${fallback}`;
  }

  loadHooksFromDirectory(dirPath, merged, source) {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath).filter((name) => name.endsWith('.yaml') || name.endsWith('.yml')).sort();

    for (const name of entries) {
      const fullPath = path.join(dirPath, name);
      let parsed;
      try {
        parsed = yaml.load(fs.readFileSync(fullPath, 'utf8'));
      } catch {
        continue;
      }

      const hooks = this.extractHooks(parsed);
      hooks.forEach((hook, idx) => {
        const normalized = { ...hook, source, sourcePath: fullPath };
        merged.set(this.hookKey(normalized, `${name}#${idx}`), normalized);
      });
    }
  }

  loadTemplateHooks(merged) {
    const templateHooks = this.template?.metadata?.hooks;
    const hooks = this.extractHooks(templateHooks);
    hooks.forEach((hook, idx) => {
      const normalized = { ...hook, source: 'template' };
      merged.set(this.hookKey(normalized, `template#${idx}`), normalized);
    });
  }

  extractHooks(parsed) {
    if (!parsed) return [];
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
    if (Array.isArray(parsed.hooks)) return parsed.hooks.filter(Boolean);
    if (parsed.on && parsed.do) return [parsed];
    return [];
  }

  buildPayload(event, payload = {}) {
    const sessionId = payload.session_id || payload.sessionId || null;
    return {
      hook: event,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      agent_id: payload.agent_id || payload.agentId || 'main',
      workspace: process.cwd(),
      reason: payload.reason || '',
      ...payload
    };
  }

  matchesWhen(when, payload) {
    if (!when || typeof when !== 'object') return true;

    for (const [key, expected] of Object.entries(when)) {
      const actual = payload[key];
      if (!conditionMatches(expected, actual)) {
        return false;
      }
    }

    return true;
  }

  async runCommandAction(hook, payload) {
    const command = hook?.do?.command;
    if (!command || typeof command !== 'string') {
      return { ok: false, reason: 'Hook command action missing do.command' };
    }

    const timeoutSec = Number(hook?.do?.timeout || 30);
    const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 30000;

    return await new Promise((resolve) => {
      const child = spawn('/bin/bash', ['-lc', command], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, timeoutMs);

      try {
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
      } catch {}

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: error.message });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ ok: true });
          return;
        }

        const reason = stderr.trim() || `Hook command exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`;
        resolve({ ok: false, reason });
      });
    });
  }

  async runAgentAction(hook, payload) {
    const template = hook?.do?.template;
    const prompt = hook?.do?.prompt;
    if (!template || !prompt) {
      return { ok: false, reason: 'Hook agent action requires do.template and do.prompt' };
    }

    const timeoutSec = Number(hook?.do?.timeout || 90);
    const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 90000;

    const dataYaml = yaml.dump({ hook_event: payload.hook, hook_payload: payload });

    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [this.cliPath, '-t', String(template), '-l', '1', '-d', dataYaml, String(prompt)], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, timeoutMs);

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: error.message });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ ok: true });
          return;
        }

        const reason = stderr.trim() || `Hook agent action exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`;
        resolve({ ok: false, reason });
      });
    });
  }

  async executeHook(hook, payload) {
    const type = hook?.do?.type;
    if (type === 'command') {
      return await this.runCommandAction(hook, payload);
    }

    if (type === 'agent') {
      return await this.runAgentAction(hook, payload);
    }

    return { ok: false, reason: `Unsupported hook action type: ${type || 'undefined'}` };
  }

  async trigger(event, payload = {}, options = {}) {
    const hooks = this.hooksByEvent.get(event) || [];
    if (hooks.length === 0) {
      return { ok: true, blocked: false };
    }

    const blocking = options.blocking === true;
    const eventPayload = this.buildPayload(event, payload);

    for (const hook of hooks) {
      if (!this.matchesWhen(hook.when, eventPayload)) continue;
      const result = await this.executeHook(hook, eventPayload);
      if (!result.ok && blocking) {
        return { ok: false, blocked: true, reason: result.reason || `Hook blocked event ${event}` };
      }
    }

    return { ok: true, blocked: false };
  }
}
