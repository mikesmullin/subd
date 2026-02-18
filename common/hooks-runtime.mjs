import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { spawn, spawnSync } from 'child_process';
import { Utils } from './utils.mjs';

function firstJsonObject(text, fallback = {}) {
  if (typeof text !== 'string') return fallback;
  const start = text.indexOf('{');
  if (start < 0) return fallback;
  try {
    const [obj] = [JSON.parse(text.slice(start))];
    return obj && typeof obj === 'object' ? obj : fallback;
  } catch {
    try {
      const decoder = JSON;
      // Fallback: try parse up to first valid object boundary by scanning lines
      const lines = text.slice(start).split('\n');
      for (let i = lines.length; i >= 1; i--) {
        const candidate = lines.slice(0, i).join('\n').trim();
        if (!candidate) continue;
        try {
          const obj = decoder.parse(candidate);
          if (obj && typeof obj === 'object') return obj;
        } catch {}
      }
      return fallback;
    } catch {
      return fallback;
    }
  }
}

function getPathValue(source, dottedPath) {
  if (!dottedPath || typeof dottedPath !== 'string') return undefined;
  const parts = dottedPath.split('.');
  let current = source;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

function parseJsonStrict(value) {
  if (typeof value !== 'string') {
    throw new Error(`parseJSON(...) expects a string, got ${typeof value}`);
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`parseJSON(...) failed: ${error.message}`);
  }
}

function evaluateHookExpression(expression, payload) {
  const expr = String(expression || '').trim();
  if (!expr) return '';

  const evaluator = new Function('context', 'parseJSON', `with (context) { return (${expr}); }`);
  return evaluator(payload, parseJsonStrict);
}

function stringifyExpressionValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveExpressionString(input, payload, mode = 'string') {
  if (typeof input !== 'string') return input;

  const fullMatch = input.match(/^\s*\$\{\{([\s\S]*?)\}\}\s*$/);
  if (fullMatch) {
    const value = evaluateHookExpression(fullMatch[1], payload);
    if (mode === 'any') return value;
    if (typeof value !== 'string') {
      throw new Error(`Expected string expression result, got ${typeof value}`);
    }
    return value;
  }

  if (!input.includes('${{')) return input;

  return input.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expr) => {
    const value = evaluateHookExpression(expr, payload);
    return stringifyExpressionValue(value);
  });
}

function resolveExpressionValue(input, payload, mode = 'string') {
  if (typeof input === 'string') {
    return resolveExpressionString(input, payload, mode);
  }

  if (Array.isArray(input)) {
    return input.map((item) => resolveExpressionValue(item, payload, mode));
  }

  if (input && typeof input === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      out[key] = resolveExpressionValue(value, payload, mode);
    }
    return out;
  }

  return input;
}

function toSnakeCase(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function toEnvToken(value) {
  const snake = toSnakeCase(value);
  return snake ? snake.toUpperCase() : 'UNKNOWN';
}

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
  constructor({ template = {}, cliPath, verbose = false }) {
    this.template = template || {};
    this.cliPath = cliPath;
    this.verbose = verbose === true;
    this.hooks = [];
    this.hooksByEvent = new Map();
  }

  logHook(message) {
    if (!this.verbose) return;
    Utils.logInfo(`[HOOK] ${message}`);
  }

  summarizeText(text) {
    return String(text ?? '');
  }

  buildPipelineEnv(context = {}) {
    const env = {};

    for (const [key, value] of Object.entries(context)) {
      if (key === 'steps') continue;
      const token = toEnvToken(key);
      if (!token) continue;

      if (value === undefined || value === null) {
        env[`HOOK_${token}`] = '';
      } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        env[`HOOK_${token}`] = String(value);
      } else {
        try {
          env[`HOOK_${token}_JSON`] = JSON.stringify(value);
        } catch {
          env[`HOOK_${token}`] = String(value);
        }
      }
    }

    const steps = context.steps && typeof context.steps === 'object' ? context.steps : {};
    for (const [stepKey, stepData] of Object.entries(steps)) {
      const token = toEnvToken(stepKey);
      if (!token) continue;

      if (stepData?.output !== undefined) env[`STEP_${token}_OUTPUT`] = String(stepData.output ?? '');
    }

    return env;
  }

  logLlmTrace(hook, trace = {}) {
    if (!this.verbose) return;
    const name = hook?.name || '<unnamed>';
    const type = hook?.do?.type === 'llm' ? 'llm' : 'agent';

    const systemPrompts = Array.isArray(trace.system_prompt) ? trace.system_prompt : [];
    const assistants = Array.isArray(trace.assistant) ? trace.assistant : [];
    const toolCalls = Array.isArray(trace.tool_call) ? trace.tool_call : [];
    const toolResults = Array.isArray(trace.tool_result) ? trace.tool_result : [];
    const finals = Array.isArray(trace.final) ? trace.final : [];

    this.logHook(`event=${hook.on} hook=${name} type=${type} llm_trace system_prompt=${systemPrompts.length} assistant=${assistants.length} tool_call=${toolCalls.length} tool_result=${toolResults.length} final=${finals.length}`);

    if (systemPrompts[0]?.content) {
      this.logHook(`event=${hook.on} hook=${name} type=${type} system_prompt:\n${this.summarizeText(systemPrompts[0].content)}`);
    }

    for (const item of toolCalls) {
      const toolName = item?.name || item?.tool_name || 'unknown';
      const args = item?.arguments || item?.args || item?.input || item;
      this.logHook(`event=${hook.on} hook=${name} type=${type} tool_call name=${toolName} args=${this.summarizeText(typeof args === 'string' ? args : JSON.stringify(args))}`);
    }

    for (const item of toolResults) {
      const toolName = item?.name || item?.tool_name || 'unknown';
      const result = item?.result ?? item;
      this.logHook(`event=${hook.on} hook=${name} type=${type} tool_result name=${toolName} result=${this.summarizeText(typeof result === 'string' ? result : JSON.stringify(result))}`);
    }

    for (const item of assistants) {
      if (item?.content) {
        this.logHook(`event=${hook.on} hook=${name} type=${type} assistant_response:\n${this.summarizeText(item.content)}`);
      }
    }

    if (finals[0]?.content) {
      this.logHook(`event=${hook.on} hook=${name} type=${type} response:\n${this.summarizeText(finals[0].content)}`);
    }
  }

  async init() {
    const merged = new Map();

    const repoDir = path.resolve(process.cwd(), 'agent/hooks');
    const userDir = path.resolve(os.homedir(), '.config/daemon/agent/hooks');

    this.loadHooksFromDirectory(repoDir, merged, 'repo');
    this.loadHooksFromDirectory(userDir, merged, 'user');
    this.loadTemplateHooks(merged);

    this.hooks = Array.from(merged.values()).filter((hook) => hook.enabled !== false && hook.on && (hook.do || hook.jobs));
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
    if (parsed.on && (parsed.do || parsed.jobs)) return [parsed];
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

  async runCommandAction(hook, payload, action = null, options = {}) {
    const cfg = action || hook?.do || {};
    let renderedCfg;
    try {
      renderedCfg = resolveExpressionValue(cfg, payload, 'any') || {};
    } catch (error) {
      return { ok: false, reason: error.message || 'Failed to render shell hook config' };
    }

    const command = renderedCfg?.command;
    if (!command || typeof command !== 'string') {
      return { ok: false, reason: 'Hook command action missing do.command' };
    }

    const timeoutSec = Number(renderedCfg?.timeout || 30);
    const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 30000;

    let stdinContent = null;
    if (typeof renderedCfg?.stdin === 'string') {
      stdinContent = renderedCfg.stdin;
    } else if (renderedCfg?.stdin !== undefined) {
      return { ok: false, reason: 'Hook command do.stdin must resolve to a string' };
    } else if (typeof renderedCfg?.stdin_from === 'string') {
      const value = getPathValue(payload, String(renderedCfg.stdin_from));
      if (value !== undefined && value !== null) {
        stdinContent = typeof value === 'string' ? value : JSON.stringify(value);
      }
    }

    let renderedEnv = {};
    if (renderedCfg?.env !== undefined) {
      if (!renderedCfg.env || typeof renderedCfg.env !== 'object' || Array.isArray(renderedCfg.env)) {
        return { ok: false, reason: 'Hook command do.env must resolve to an object' };
      }
      renderedEnv = renderedCfg.env;
      for (const [envKey, envValue] of Object.entries(renderedEnv)) {
        if (typeof envValue !== 'string') {
          return { ok: false, reason: `Hook command do.env.${envKey} must resolve to a string` };
        }
      }
    }

    return await new Promise((resolve) => {
      const child = spawn('/bin/bash', ['-lc', command], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...(options?.env || {}),
          ...renderedEnv
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, timeoutMs);

      try {
        if (stdinContent !== null) {
          child.stdin.write(String(stdinContent));
        } else {
          child.stdin.write(JSON.stringify(payload));
        }
        child.stdin.end();
      } catch {}

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: error.message });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ ok: true, exitCode: code, stdout, stderr, output: stdout });
          return;
        }

        const reason = stderr.trim() || `Hook command exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`;
        resolve({ ok: false, reason, exitCode: code ?? -1, stdout, stderr });
      });
    });
  }

  async runAgentAction(hook, payload, action = null, options = {}) {
    const cfg = action || hook?.do || {};
    let renderedCfg;
    try {
      renderedCfg = resolveExpressionValue(cfg, payload, 'any') || {};
    } catch (error) {
      return { ok: false, reason: error.message || 'Failed to render llm hook config' };
    }

    const template = renderedCfg?.template;
    const prompt = renderedCfg?.prompt || 'Process this hook event.';
    if (!template || typeof template !== 'string') {
      return { ok: false, reason: 'Hook agent action requires do.template' };
    }
    if (typeof prompt !== 'string') {
      return { ok: false, reason: 'Hook agent action do.prompt must resolve to a string' };
    }

    const timeoutSec = Number(renderedCfg?.timeout || 90);
    const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 90000;

    const includeHookPayload = renderedCfg?.include_hook_payload !== false;
    const extraData = renderedCfg?.data && typeof renderedCfg.data === 'object' ? renderedCfg.data : {};
    const contextData = options?.contextData && typeof options.contextData === 'object'
      ? options.contextData
      : null;
    const implicitData = {};
    if (renderedCfg?.implicit_data !== false && contextData) {
      for (const [key, value] of Object.entries(contextData)) {
        if (['hook', 'session_id', 'timestamp', 'agent_id', 'workspace', 'reason', 'steps', 'jobs'].includes(key)) {
          continue;
        }
        implicitData[key] = value;
      }
    }
    const mergedData = {
      ...(includeHookPayload ? { hook_event: payload.hook, hook_payload: payload } : {}),
      ...implicitData,
      ...(extraData && typeof extraData === 'object' ? extraData : {})
    };
    const dataYaml = yaml.dump(mergedData);

    let stdinContent = null;
    if (typeof renderedCfg?.stdin === 'string') {
      stdinContent = renderedCfg.stdin;
    } else if (renderedCfg?.stdin !== undefined) {
      return { ok: false, reason: 'Hook agent action do.stdin must resolve to a string' };
    } else if (typeof renderedCfg?.stdin_from === 'string') {
      const value = getPathValue(payload, renderedCfg.stdin_from);
      if (value !== undefined && value !== null) {
        stdinContent = typeof value === 'string' ? value : JSON.stringify(value);
      }
    }

    const turnLimit = Number.isFinite(Number(renderedCfg?.turn_limit))
      ? Number(renderedCfg.turn_limit)
      : 1;

    let renderedEnv = {};
    if (renderedCfg?.env !== undefined) {
      if (!renderedCfg.env || typeof renderedCfg.env !== 'object' || Array.isArray(renderedCfg.env)) {
        return { ok: false, reason: 'Hook agent action do.env must resolve to an object' };
      }
      renderedEnv = renderedCfg.env;
      for (const [envKey, envValue] of Object.entries(renderedEnv)) {
        if (typeof envValue !== 'string') {
          return { ok: false, reason: `Hook agent action do.env.${envKey} must resolve to a string` };
        }
      }
    }

    const args = [this.cliPath, '-t', String(template), '-j', '-v', '-d', dataYaml];
    if (turnLimit > 0) {
      args.push('-l', String(turnLimit));
    }
    if (stdinContent !== null) {
      args.push('-i');
    }
    args.push(String(prompt));

    return await new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...(options?.env || {}),
          ...renderedEnv
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      if (stdinContent !== null) {
        try {
          child.stdin.write(String(stdinContent));
        } catch {}
      }
      try { child.stdin.end(); } catch {}

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
          let finalContent = '';
          const llmTrace = {
            system_prompt: [],
            assistant: [],
            tool_call: [],
            tool_result: [],
            final: []
          };

          for (const rawLine of stderr.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            try {
              const item = JSON.parse(line);
              if (item?.type && llmTrace[item.type]) {
                llmTrace[item.type].push(item);
              }
            } catch {}
          }

          for (const rawLine of stdout.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            try {
              const item = JSON.parse(line);
              if (item?.type === 'final') {
                finalContent = typeof item.content === 'string' ? item.content : '';
                llmTrace.final.push(item);
              }
            } catch {}
          }

          this.logLlmTrace(hook, llmTrace);

          const outputConfig = renderedCfg?.output;
          if (outputConfig?.file) {
            const outputPath = path.resolve(process.cwd(), String(outputConfig.file));
            const outputDir = path.dirname(outputPath);
            try { fs.mkdirSync(outputDir, { recursive: true }); } catch {}
            const mode = outputConfig.mode === 'append' ? 'append' : 'overwrite';
            const format = outputConfig.format === 'json' ? 'json' : 'raw';
            let rendered = finalContent;
            if (format === 'json') {
              const parsed = firstJsonObject(finalContent, {});
              rendered = JSON.stringify(parsed, null, 2);
            }
            try {
              if (mode === 'append') {
                fs.appendFileSync(outputPath, `${rendered}\n`, 'utf8');
              } else {
                fs.writeFileSync(outputPath, String(rendered), 'utf8');
              }
            } catch (error) {
              resolve({ ok: false, reason: error.message || 'Failed to persist llm hook output' });
              return;
            }
          }

          const memoConfig = renderedCfg?.memo;
          if (memoConfig && typeof memoConfig === 'object') {
            const parsed = firstJsonObject(finalContent, {});
            const facts = Array.isArray(parsed?.facts)
              ? parsed.facts.filter((value) => typeof value === 'string' && value.trim())
              : [];
            const memoryEvents = Array.isArray(parsed?.memory)
              ? parsed.memory.filter((value) => value && typeof value === 'object')
              : [];

            if (memoConfig.save_facts === true) {
              for (const fact of facts) {
                try {
                  spawnSync('memo', ['save', fact], { cwd: process.cwd(), env: process.env, stdio: 'ignore' });
                } catch {}
              }
            }

            if (memoConfig.apply_memory_events === true) {
              for (const item of memoryEvents) {
                const event = String(item.event || '').toUpperCase();
                const id = item.id === undefined || item.id === null ? '' : String(item.id).trim();
                const text = item.text === undefined || item.text === null ? '' : String(item.text).trim();
                const oldMemory = item.old_memory === undefined || item.old_memory === null ? '' : String(item.old_memory).trim();
                try {
                  if (event === 'ADD' && text) {
                    spawnSync('memo', ['save', text], { cwd: process.cwd(), env: process.env, stdio: 'ignore' });
                  } else if (event === 'UPDATE' && id && text) {
                    spawnSync('memo', ['save', id, text], { cwd: process.cwd(), env: process.env, stdio: 'ignore' });
                  } else if (event === 'DELETE' && id) {
                    const tombstone = `__DELETED__ ${oldMemory || text || 'memory entry'}`;
                    spawnSync('memo', ['save', id, tombstone], { cwd: process.cwd(), env: process.env, stdio: 'ignore' });
                  }
                } catch {}
              }
            }

            if ((memoConfig.recall_from_facts === true || memoConfig.recall_from_query === true) && memoConfig.recall_output_file) {
              const recallLines = [];
              const seen = new Set();
              const recallK = Number.isFinite(Number(memoConfig.recall_k)) && Number(memoConfig.recall_k) > 0
                ? String(Math.min(100, Number(memoConfig.recall_k)))
                : '5';

              const queries = [];
              if (memoConfig.recall_from_facts === true) {
                queries.push(...facts);
              }
              if (memoConfig.recall_from_query === true) {
                const queryPath = typeof memoConfig.query_from === 'string' && memoConfig.query_from
                  ? memoConfig.query_from
                  : 'user_message';
                const queryValue = getPathValue(payload, queryPath);
                if (typeof queryValue === 'string' && queryValue.trim()) {
                  queries.push(queryValue.trim());
                }
              }

              for (const fact of queries) {
                try {
                  const recall = spawnSync('memo', ['recall', '-k', recallK, fact], {
                    cwd: process.cwd(),
                    env: process.env,
                    stdio: ['ignore', 'pipe', 'ignore'],
                    encoding: 'utf8'
                  });
                  const buffer = String(recall?.stdout || '');
                  for (const rawLine of buffer.split('\n')) {
                    const line = rawLine.trim();
                    if (!line || line.startsWith('Top ') || !line.includes('|')) continue;
                    const [, right] = line.split('|', 2);
                    const text = String(right || '').trim();
                    if (!text || text.startsWith('__DELETED__') || seen.has(text)) continue;
                    seen.add(text);
                    recallLines.push(`- ${text}`);
                  }
                } catch {}
              }

              const outputPath = path.resolve(process.cwd(), String(memoConfig.recall_output_file));
              const contentLines = recallLines.length > 0 ? recallLines : ['(none)'];
              const header = [
                `Session: ${payload.session_id || 'unknown'}`,
                `Timestamp: ${new Date().toISOString()}`,
                '',
                'Latest user message:',
                String(payload.user_message || ''),
                '',
                'Retrieved long-term memory:',
                ...contentLines
              ];
              try {
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.writeFileSync(outputPath, `${header.join('\n')}\n`, 'utf8');
              } catch (error) {
                resolve({ ok: false, reason: error.message || 'Failed to write memo recall output file' });
                return;
              }
            }
          }

          const parsedOutput = firstJsonObject(finalContent, null);
          const normalizedOutput = parsedOutput && typeof parsedOutput === 'object'
            ? JSON.stringify(parsedOutput)
            : finalContent;

          resolve({ ok: true, output: normalizedOutput, outputJson: parsedOutput, llmTrace });
          return;
        }

        const reason = stderr.trim() || `Hook agent action exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`;
        resolve({ ok: false, reason });
      });
    });
  }

  async executeHook(hook, payload) {
    if (hook?.jobs && typeof hook.jobs === 'object') {
      return await this.runJobsAction(hook, payload);
    }

    const type = hook?.do?.type;
    if (type === 'command' || type === 'shell') {
      return await this.runCommandAction(hook, payload);
    }

    if (type === 'agent' || type === 'llm') {
      return await this.runAgentAction(hook, payload);
    }

    if (type === 'pipeline') {
      return await this.runPipelineAction(hook, payload);
    }

    return { ok: false, reason: `Unsupported hook action type: ${type || 'undefined'}` };
  }

  normalizeNeeds(needsRaw) {
    if (!needsRaw) return [];
    if (Array.isArray(needsRaw)) return needsRaw.map((item) => String(item)).filter(Boolean);
    return [String(needsRaw)].filter(Boolean);
  }

  async runJobsAction(hook, payload) {
    const jobs = hook?.jobs && typeof hook.jobs === 'object' ? hook.jobs : null;
    if (!jobs || Object.keys(jobs).length === 0) {
      return { ok: false, reason: 'Hook jobs action requires jobs.<name> definitions' };
    }

    const jobNames = Object.keys(jobs);
    const pending = new Set(jobNames);
    const completed = new Set();
    const failed = new Set();

    const globalContext = {
      ...payload,
      steps: payload?.steps && typeof payload.steps === 'object' ? { ...payload.steps } : {},
      jobs: payload?.jobs && typeof payload.jobs === 'object' ? { ...payload.jobs } : {}
    };

    while (pending.size > 0) {
      const ready = [];
      for (const jobName of pending) {
        const jobDef = jobs[jobName] || {};
        const needs = this.normalizeNeeds(jobDef.needs);
        const unmet = needs.filter((dep) => !completed.has(dep));
        const blockedByFailure = needs.some((dep) => failed.has(dep));
        if (blockedByFailure) {
          failed.add(jobName);
          pending.delete(jobName);
          continue;
        }
        if (unmet.length === 0) {
          ready.push(jobName);
        }
      }

      if (ready.length === 0) {
        const remaining = Array.from(pending);
        return { ok: false, reason: `Jobs deadlock or unmet needs among: ${remaining.join(', ')}` };
      }

      const runJob = async (jobName) => {
        const jobDef = jobs[jobName] || {};
        const steps = Array.isArray(jobDef.steps) ? jobDef.steps : [];
        if (steps.length === 0) {
          return {
            ok: false,
            jobName,
            reason: `Job '${jobName}' has no steps[]`
          };
        }

        const pipelineHook = {
          ...hook,
          name: `${hook?.name || '<unnamed>'}/${jobName}`,
          do: {
            type: 'pipeline',
            execution: 'serial',
            steps
          }
        };

        const ctx = {
          ...globalContext,
          steps: { ...globalContext.steps },
          jobs: { ...globalContext.jobs }
        };

        const result = await this.runPipelineAction(pipelineHook, ctx);
        return { ...result, jobName };
      };

      const outcomes = await Promise.all(ready.map((jobName) => runJob(jobName)));
      for (const outcome of outcomes) {
        pending.delete(outcome.jobName);
        if (!outcome.ok) {
          failed.add(outcome.jobName);
          return outcome;
        }

        completed.add(outcome.jobName);
        globalContext.steps = {
          ...globalContext.steps,
          ...(outcome.context?.steps || {})
        };
        globalContext.jobs[outcome.jobName] = {
          output: outcome?.output,
          status: 'success'
        };

        if (outcome.context && typeof outcome.context === 'object') {
          for (const [key, value] of Object.entries(outcome.context)) {
            if (['steps', 'jobs'].includes(key)) continue;
            globalContext[key] = value;
          }
        }
      }
    }

    return { ok: true };
  }

  async runPipelineAction(hook, payload) {
    const steps = Array.isArray(hook?.do?.steps) ? hook.do.steps : [];
    if (steps.length === 0) {
      return { ok: false, reason: 'Hook pipeline action requires do.steps[]' };
    }

    const execution = String(hook?.do?.execution || 'serial').toLowerCase();
    if (!['serial', 'parallel'].includes(execution)) {
      return { ok: false, reason: `Unsupported pipeline execution mode: ${execution}` };
    }

    const context = {
      ...payload,
      steps: payload?.steps && typeof payload.steps === 'object' ? { ...payload.steps } : {},
      jobs: payload?.jobs && typeof payload.jobs === 'object' ? { ...payload.jobs } : {}
    };
    const baseEnv = this.buildPipelineEnv(context);

    const runStep = async (stepInput, i) => {
      const step = stepInput || {};
      const stepType = step?.type;
      const stepName = step?.name || `step-${i + 1}`;
      const stepKey = String(step?.id || `step_${i + 1}`);
      const stepCfg = { ...(step || {}) };

      const stepHook = {
        ...hook,
        name: `${hook?.name || '<unnamed>'}/${stepName}`,
        do: stepCfg
      };

      const logType = (stepType === 'command' || stepType === 'shell') ? 'shell' : stepType;
      this.logHook(`trigger event=${hook?.on} hook=${stepHook.name} type=${logType || 'unknown'}`);

      const stepEnv = {
        ...baseEnv,
        ...this.buildPipelineEnv(context),
        HOOK_PIPELINE_STEP: stepName,
        HOOK_PIPELINE_STEP_INDEX: String(i + 1),
        HOOK_PIPELINE_EXECUTION: execution
      };

      let result;
      if (stepType === 'command' || stepType === 'shell') {
        result = await this.runCommandAction(stepHook, context, stepCfg, { env: stepEnv });
      } else if (stepType === 'agent' || stepType === 'llm') {
        result = await this.runAgentAction(stepHook, context, stepCfg, { env: stepEnv, contextData: context });
      } else {
        return { ok: false, reason: `Unsupported pipeline step type: ${stepType || 'undefined'}` };
      }

      if (!result?.ok) {
        if (stepType === 'command' || stepType === 'shell') {
          this.logHook(`event=${hook?.on} hook=${stepHook.name} type=shell exit_code=${result?.exitCode ?? 'unknown'}`);
          this.logHook(`event=${hook?.on} hook=${stepHook.name} type=shell stdout=${this.summarizeText(result?.stdout || '')}`);
          this.logHook(`event=${hook?.on} hook=${stepHook.name} type=shell stderr=${this.summarizeText(result?.stderr || '')}`);
        }
        this.logHook(`event=${hook?.on} hook=${stepHook.name} status=failed reason=${result?.reason || 'unknown'}`);
        return result;
      }

      if (stepType === 'command' || stepType === 'shell') {
        this.logHook(`event=${hook?.on} hook=${stepHook.name} type=shell exit_code=${result?.exitCode ?? 'unknown'}`);
        this.logHook(`event=${hook?.on} hook=${stepHook.name} type=shell stdout=${this.summarizeText(result?.stdout || '')}`);
        this.logHook(`event=${hook?.on} hook=${stepHook.name} type=shell stderr=${this.summarizeText(result?.stderr || '')}`);
      }
      this.logHook(`event=${hook?.on} hook=${stepHook.name} status=ok`);

      context.steps[stepKey] = {
        output: typeof result?.output === 'string' ? result.output : String(result?.output ?? '')
      };

      return { ok: true, result };
    };

    if (execution === 'parallel') {
      const outcomes = await Promise.all(steps.map((step, index) => runStep(step, index)));
      const failed = outcomes.find((item) => !item?.ok);
      if (failed) return failed;
      return { ok: true, context };
    }

    let finalResult = null;
    for (let i = 0; i < steps.length; i++) {
      const outcome = await runStep(steps[i], i);
      if (!outcome?.ok) return outcome;
      finalResult = outcome.result;
    }

    return {
      ok: true,
      context,
      output: finalResult?.output,
      outputJson: finalResult?.outputJson
    };
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
      const hookType = hook?.jobs
        ? 'jobs'
        : ((hook?.do?.type === 'command' || hook?.do?.type === 'shell') ? 'shell' : (hook?.do?.type || 'unknown'));
      this.logHook(`trigger event=${event} hook=${hook?.name || '<unnamed>'} type=${hookType}`);
      const result = await this.executeHook(hook, eventPayload);
      if (hook?.do?.type === 'command' || hook?.do?.type === 'shell') {
        this.logHook(`event=${event} hook=${hook?.name || '<unnamed>'} type=shell exit_code=${result?.exitCode ?? 'unknown'}`);
        this.logHook(`event=${event} hook=${hook?.name || '<unnamed>'} type=shell stdout=${this.summarizeText(result?.stdout || '')}`);
        this.logHook(`event=${event} hook=${hook?.name || '<unnamed>'} type=shell stderr=${this.summarizeText(result?.stderr || '')}`);
      }
      if (result.ok) {
        this.logHook(`event=${event} hook=${hook?.name || '<unnamed>'} status=ok`);
      } else {
        this.logHook(`event=${event} hook=${hook?.name || '<unnamed>'} status=failed reason=${result.reason || 'unknown'}`);
      }
      if (!result.ok && blocking) {
        return { ok: false, blocked: true, reason: result.reason || `Hook blocked event ${event}` };
      }
    }

    return { ok: true, blocked: false };
  }
}
