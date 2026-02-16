import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import ejs from 'ejs';
import { spawn } from 'child_process';
import { globals } from '../../common/globals.mjs';
import { createPromptIncludeFn } from '../../common/prompt-includes.mjs';

const DEFAULT_GLOBAL_HEARTBEAT_PROMPT = [
  'You are the global heartbeat policy layer for subd checks.',
  'Rules:',
  '- Return structured JSON only.',
  '- Use key "ok" with boolean true/false.',
  '- Use key "summary" with concise details.',
  '- Return ok=true only when no action is needed (HEARTBEAT_OK discipline).',
  '- Follow safety and policy constraints.',
  '',
  '{{heartbeat_agent_prompts}}'
].join('\n');

function parseDurationMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value * 1000);
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const m = trimmed.match(/^(\d+)(s|m|h|d)$/i);
  if (!m) return null;

  const count = Number.parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(count) || count <= 0) return null;

  if (unit === 's') return count * 1000;
  if (unit === 'm') return count * 60 * 1000;
  if (unit === 'h') return count * 60 * 60 * 1000;
  if (unit === 'd') return count * 24 * 60 * 60 * 1000;
  return null;
}

function parseHourMinute(value) {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number.parseInt(m[1], 10);
  const minute = Number.parseInt(m[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function withinActiveHours(activeHours, now = new Date()) {
  if (!activeHours || typeof activeHours !== 'string') return true;
  const [startRaw, endRaw] = activeHours.split('-');
  if (!startRaw || !endRaw) return true;

  const start = parseHourMinute(startRaw);
  const end = parseHourMinute(endRaw);
  if (start === null || end === null) return true;

  const current = now.getHours() * 60 + now.getMinutes();
  if (start <= end) {
    return current >= start && current <= end;
  }

  return current >= start || current <= end;
}

function stableTemplateNameSort(a, b) {
  return String(a.templateName).localeCompare(String(b.templateName));
}

function safeParseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {}
  }

  return null;
}

function normalizeCheckPass(resultObj) {
  if (!resultObj || typeof resultObj !== 'object' || Array.isArray(resultObj)) {
    return { ok: false, summary: 'Invalid check result: expected JSON object' };
  }

  if (!Object.prototype.hasOwnProperty.call(resultObj, 'ok')) {
    return { ok: false, summary: 'Invalid check result: missing `ok` key' };
  }

  const ok = Boolean(resultObj.ok);
  const summary = typeof resultObj.summary === 'string'
    ? resultObj.summary
    : ok
      ? 'HEARTBEAT_OK'
      : 'Heartbeat check returned attention';

  return { ok, summary, raw: resultObj };
}

export class HeartbeatRuntime {
  constructor({ cliPath, hooksRuntime = null, jsonlMode = false, verbose = false } = {}) {
    this.cliPath = cliPath;
    this.hooksRuntime = hooksRuntime;
    this.jsonlMode = jsonlMode;
    this.verbose = verbose;
    this.workspaceRoot = process.cwd();
    this.templatesDir = globals.dbPaths.templates;
    this.stateFilePath = path.resolve(this.workspaceRoot, 'agent/state/heartbeat.yaml');
    this.lockFilePath = path.resolve(this.workspaceRoot, 'agent/state/heartbeat.lock');
    this.watchTickMs = this.resolveWatchTickMs();
  }

  resolveWatchTickMs() {
    const configured = Number(globals.getConfig('heartbeat.watch_tick_seconds'));
    if (Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured * 1000);
    }
    return 60_000;
  }

  async emitHook(event, payload = {}) {
    if (!this.hooksRuntime) return;
    try {
      await this.hooksRuntime.trigger(event, payload, { blocking: false });
    } catch {}
  }

  trace(stage, details = {}) {
    if (!this.verbose) return;
    if (this.jsonlMode) {
      const line = {
        type: 'heartbeat_stage',
        timestamp: new Date().toISOString(),
        stage,
        ...details
      };
      process.stdout.write(`${JSON.stringify(line)}\n`);
      return;
    }

    const suffix = Object.keys(details).length > 0
      ? ` ${JSON.stringify(details)}`
      : '';
    process.stdout.write(`[heartbeat:${stage}]${suffix}\n`);
  }

  output(outcome, payload = {}) {
    if (this.jsonlMode) {
      const line = {
        type: 'heartbeat',
        timestamp: new Date().toISOString(),
        outcome,
        ...payload
      };
      process.stdout.write(`${JSON.stringify(line)}\n`);
      return;
    }

    if (outcome === 'ok') {
      process.stdout.write('HEARTBEAT_OK\n');
      return;
    }
    if (outcome === 'attention') {
      process.stdout.write(`ATTENTION: ${payload.summary || 'Action required'}\n`);
      return;
    }
    process.stdout.write(`ERROR: ${payload.summary || 'Heartbeat failure'}\n`);
  }

  listTemplateFiles() {
    if (!fs.existsSync(this.templatesDir)) return [];
    return fs
      .readdirSync(this.templatesDir)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .sort()
      .map((name) => path.join(this.templatesDir, name));
  }

  loadTemplatesWithChecks() {
    const templates = [];

    for (const filePath of this.listTemplateFiles()) {
      let parsed;
      try {
        parsed = yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
      } catch {
        continue;
      }

      const templateName = path.basename(filePath, path.extname(filePath));
      const heartbeat = parsed?.metadata?.heartbeat;
      if (!heartbeat || typeof heartbeat !== 'object') continue;

      const baseIntervalMs = Number.isFinite(Number(heartbeat.interval_seconds)) && Number(heartbeat.interval_seconds) > 0
        ? Math.floor(Number(heartbeat.interval_seconds) * 1000)
        : 300_000;

      const checks = Array.isArray(heartbeat.checks) ? heartbeat.checks : [];
      const enabledChecks = [];
      for (const check of checks) {
        if (!check || typeof check !== 'object') continue;
        if (check.enabled !== true) continue;

        const id = typeof check.id === 'string' && check.id.trim() ? check.id.trim() : null;
        const type = typeof check.type === 'string' ? check.type.trim() : null;
        if (!id || !type || !['agent', 'shell'].includes(type)) continue;

        const intervalMs = parseDurationMs(check.every) || baseIntervalMs;
        enabledChecks.push({
          ...check,
          id,
          type,
          intervalMs,
          templateName,
          activeHours: typeof check.active_hours === 'string' ? check.active_hours.trim() : null,
          onAttention: heartbeat.on_attention || {}
        });
      }

      if (enabledChecks.length === 0) continue;

      templates.push({
        templateName,
        filePath,
        heartbeat,
        checks: enabledChecks,
        systemPromptFragment: typeof heartbeat.system_prompt === 'string' ? heartbeat.system_prompt : ''
      });
    }

    return templates;
  }

  buildAggregatedAgentHeartbeatPrompts(templates) {
    const blocks = templates
      .filter((template) => typeof template.systemPromptFragment === 'string' && template.systemPromptFragment.trim())
      .sort((a, b) => String(a.templateName).localeCompare(String(b.templateName)))
      .map((template) => {
        return [
          `### AGENT HEARTBEAT PROMPT: ${template.templateName}`,
          template.systemPromptFragment.trim()
        ].join('\n');
      });

    return blocks.join('\n\n');
  }

  resolveGlobalHeartbeatPromptTemplate() {
    const inlinePrompt = globals.getConfig('heartbeat.system_prompt');
    const promptFile = globals.getConfig('heartbeat.system_prompt_file');

    if (typeof inlinePrompt === 'string' && inlinePrompt.trim()) {
      return inlinePrompt;
    }

    if (typeof promptFile === 'string' && promptFile.trim()) {
      const resolved = path.resolve(this.workspaceRoot, promptFile.trim());
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error(`Configured heartbeat.system_prompt_file not found: ${promptFile}`);
      }
      return fs.readFileSync(resolved, 'utf8');
    }

    return DEFAULT_GLOBAL_HEARTBEAT_PROMPT;
  }

  async buildEffectiveGlobalHeartbeatPrompt(templates) {
    const base = this.resolveGlobalHeartbeatPromptTemplate();
    const aggregate = this.buildAggregatedAgentHeartbeatPrompts(templates);
    const includePrompt = createPromptIncludeFn({
      rootDir: this.workspaceRoot,
      maxDepth: 10
    });

    return await ejs.render(base, {
      heartbeat_agent_prompts: aggregate || '',
      includePrompt,
      process
    }, { async: true });
  }

  loadState() {
    if (!fs.existsSync(this.stateFilePath)) {
      return {
        lastChecks: {},
        lastOutcome: {},
        updatedAt: new Date().toISOString()
      };
    }

    try {
      const parsed = yaml.load(fs.readFileSync(this.stateFilePath, 'utf8')) || {};
      return {
        lastChecks: parsed.lastChecks && typeof parsed.lastChecks === 'object' ? parsed.lastChecks : {},
        lastOutcome: parsed.lastOutcome && typeof parsed.lastOutcome === 'object' ? parsed.lastOutcome : {},
        updatedAt: parsed.updatedAt || null
      };
    } catch {
      return {
        lastChecks: {},
        lastOutcome: {},
        updatedAt: new Date().toISOString()
      };
    }
  }

  saveState(state) {
    const dir = path.dirname(this.stateFilePath);
    fs.mkdirSync(dir, { recursive: true });

    const payload = {
      lastChecks: state.lastChecks || {},
      lastOutcome: state.lastOutcome || {},
      updatedAt: new Date().toISOString()
    };

    const tmpPath = `${this.stateFilePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, yaml.dump(payload));
    fs.renameSync(tmpPath, this.stateFilePath);
  }

  flattenChecks(templates) {
    const checks = [];
    for (const template of templates.sort(stableTemplateNameSort)) {
      for (const check of template.checks) {
        checks.push({ ...check, templateName: template.templateName });
      }
    }
    return checks;
  }

  checkStateKey(check) {
    return `${check.templateName}:${check.id}`;
  }

  selectMostOverdueCheck(checks, state, now = new Date()) {
    const nowMs = now.getTime();
    let winner = null;
    let winnerOverdue = Number.NEGATIVE_INFINITY;

    for (const check of checks) {
      if (!withinActiveHours(check.activeHours, now)) continue;
      const key = this.checkStateKey(check);
      const last = Number(state.lastChecks?.[key] || 0);
      const dueAt = last > 0 ? (last + check.intervalMs) : 0;
      const overdue = last > 0 ? (nowMs - dueAt) : Number.MAX_SAFE_INTEGER / 4;
      if (overdue < 0) continue;

      if (overdue > winnerOverdue) {
        winnerOverdue = overdue;
        winner = check;
      }
    }

    return winner ? { check: winner, overdueMs: winnerOverdue } : null;
  }

  runCommand(command, timeoutMs = 90_000) {
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/bash', ['-lc', command], {
        cwd: this.workspaceRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
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

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({
          code: code ?? 1,
          signal: signal || null,
          stdout,
          stderr
        });
      });
    });
  }

  async executeShellCheck(check) {
    const command = typeof check.command === 'string' ? check.command.trim() : '';
    if (!command) {
      return { outcome: 'error', summary: `Invalid shell check ${check.id}: missing command` };
    }

    const timeoutMs = Number.isFinite(Number(check.timeout_seconds)) && Number(check.timeout_seconds) > 0
      ? Math.floor(Number(check.timeout_seconds) * 1000)
      : 90_000;

    const result = await this.runCommand(command, timeoutMs);
    const text = (result.stdout || '').trim() || (result.stderr || '').trim();
    const parsed = safeParseJson(text);
    if (!parsed) {
      return {
        outcome: 'error',
        summary: `Shell check ${check.id} did not return structured JSON`
      };
    }

    const normalized = normalizeCheckPass(parsed);
    return {
      outcome: normalized.ok ? 'ok' : 'attention',
      summary: normalized.summary,
      details: normalized.raw
    };
  }

  async executeAgentCheck(check, effectiveGlobalPrompt) {
    const template = typeof check.template === 'string' ? check.template.trim() : '';
    const prompt = typeof check.prompt === 'string' ? check.prompt.trim() : '';
    if (!template || !prompt) {
      return { outcome: 'error', summary: `Invalid agent check ${check.id}: requires template and prompt` };
    }

    const timeoutMs = Number.isFinite(Number(check.timeout_seconds)) && Number(check.timeout_seconds) > 0
      ? Math.floor(Number(check.timeout_seconds) * 1000)
      : 180_000;
    const turnLimit = Number.isFinite(Number(check.turn_limit)) && Number(check.turn_limit) > 0
      ? Math.floor(Number(check.turn_limit))
      : 3;

    const composedPrompt = `${effectiveGlobalPrompt}\n\n${prompt}`.trim();

    this.trace('agent.invocation.prompt', {
      template,
      check_id: check.id,
      turn_limit: turnLimit,
      composed_prompt: composedPrompt
    });

    const childArgs = [this.cliPath, '-t', template, '-l', String(turnLimit)];
    if (this.verbose) childArgs.push('-v');
    childArgs.push(composedPrompt);

    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, childArgs, {
        cwd: this.workspaceRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, timeoutMs);

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });

    if (this.verbose && String(result.stderr || '').trim()) {
      this.trace('agent.invocation.stderr', {
        template,
        check_id: check.id,
        stderr: String(result.stderr).trim()
      });
    }

    if (result.code !== 0) {
      return {
        outcome: 'error',
        summary: `Agent check ${check.id} failed: ${String(result.stderr || result.stdout || '').trim() || `exit ${result.code}`}`
      };
    }

    const rawResponse = String(result.stdout || '').trim();

    const parsed = safeParseJson(rawResponse);
    if (!parsed) {
      return {
        outcome: 'error',
        summary: `Agent check ${check.id} did not return structured JSON`
      };
    }

    const normalized = normalizeCheckPass(parsed);
    return {
      outcome: normalized.ok ? 'ok' : 'attention',
      summary: normalized.summary,
      details: normalized.raw
    };
  }

  async maybeRunAttentionAgent(check, summary) {
    const config = check.onAttention && typeof check.onAttention === 'object' ? check.onAttention : {};
    if (config.mode !== 'agent_turn') return;

    const template = typeof config.template === 'string' ? config.template.trim() : '';
    const prompt = typeof config.prompt === 'string' && config.prompt.trim()
      ? config.prompt.trim()
      : `Heartbeat attention from ${check.templateName}:${check.id}\n${summary || ''}`;
    if (!template) return;

    await new Promise((resolve) => {
      const child = spawn(process.execPath, [this.cliPath, '-t', template, '-l', '1', prompt], {
        cwd: this.workspaceRoot,
        env: process.env,
        stdio: ['ignore', 'ignore', 'pipe']
      });

      const timeoutMs = 120_000;
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, timeoutMs);

      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async executeCheck(check, effectiveGlobalPrompt) {
    if (check.type === 'shell') {
      return await this.executeShellCheck(check);
    }
    if (check.type === 'agent') {
      return await this.executeAgentCheck(check, effectiveGlobalPrompt);
    }
    return { outcome: 'error', summary: `Unsupported heartbeat check type: ${check.type}` };
  }

  async runTick() {
    this.trace('runTick.start');
    const now = new Date();
    const templates = this.loadTemplatesWithChecks();
    this.trace('templates.loaded', { count: templates.length });
    const checks = this.flattenChecks(templates);
    this.trace('checks.flattened', { count: checks.length });
    const state = this.loadState();
    this.trace('state.loaded', {
      keys: Object.keys(state.lastChecks || {}).length
    });

    await this.emitHook('heartbeat_tick', {
      workspace: this.workspaceRoot,
      check_count: checks.length,
      timestamp: now.toISOString()
    });

    if (checks.length === 0) {
      this.trace('branch.no_checks');
      await this.emitHook('heartbeat_result', {
        outcome: 'ok',
        summary: 'HEARTBEAT_OK',
        check_id: null,
        duration_ms: 0
      });
      this.output('ok', { summary: 'HEARTBEAT_OK' });
      return { code: 0 };
    }

    const selected = this.selectMostOverdueCheck(checks, state, now);
    if (!selected) {
      this.trace('branch.no_eligible_check');
      await this.emitHook('heartbeat_result', {
        outcome: 'ok',
        summary: 'HEARTBEAT_OK',
        check_id: null,
        duration_ms: 0
      });
      this.output('ok', { summary: 'HEARTBEAT_OK' });
      return { code: 0 };
    }

    const effectiveGlobalPrompt = await this.buildEffectiveGlobalHeartbeatPrompt(templates);
    const { check, overdueMs } = selected;
    this.trace('check.selected', {
      template: check.templateName,
      check_id: check.id,
      type: check.type,
      overdue_ms: Math.max(0, Math.floor(overdueMs))
    });

    await this.emitHook('heartbeat_check_selected', {
      check_id: check.id,
      template: check.templateName,
      overdue_ms: Math.max(0, Math.floor(overdueMs)),
      state_snapshot: state
    });

    const started = Date.now();
    this.trace('check.execute.start', {
      template: check.templateName,
      check_id: check.id,
      type: check.type
    });
    const result = await this.executeCheck(check, effectiveGlobalPrompt);
    const durationMs = Date.now() - started;
    this.trace('check.execute.end', {
      check_id: check.id,
      outcome: result.outcome,
      duration_ms: durationMs
    });
    const key = this.checkStateKey(check);

    state.lastChecks[key] = Date.now();
    state.lastOutcome[key] = result.outcome;
    this.saveState(state);
    this.trace('state.saved', { key, outcome: result.outcome });

    await this.emitHook('heartbeat_result', {
      outcome: result.outcome,
      summary: result.summary,
      check_id: check.id,
      template: check.templateName,
      duration_ms: durationMs
    });

    if (result.outcome === 'attention') {
      this.trace('branch.attention', {
        template: check.templateName,
        check_id: check.id
      });
      await this.emitHook('heartbeat_attention', {
        check_id: check.id,
        template: check.templateName,
        summary: result.summary
      });
      await this.maybeRunAttentionAgent(check, result.summary);
    }

    this.output(result.outcome, {
      workspace: this.workspaceRoot,
      check_id: check.id,
      template: check.templateName,
      duration_ms: durationMs,
      summary: result.summary
    });
    this.trace('runTick.end', {
      check_id: check.id,
      outcome: result.outcome
    });

    return { code: result.outcome === 'error' ? 1 : 0 };
  }

  async runOnce() {
    const result = await this.runTick();
    return result.code;
  }

  acquireWatchLock() {
    const dir = path.dirname(this.lockFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(this.lockFilePath, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    return fd;
  }

  releaseWatchLock(fd) {
    try {
      if (typeof fd === 'number') fs.closeSync(fd);
    } catch {}
    try {
      if (fs.existsSync(this.lockFilePath)) fs.unlinkSync(this.lockFilePath);
    } catch {}
  }

  async runWatch() {
    let lockFd;
    try {
      lockFd = this.acquireWatchLock();
    } catch {
      throw new Error('subd cron watch is already running (lock exists)');
    }

    let stopped = false;
    let runningTick = false;

    const onSignal = () => {
      stopped = true;
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.on('SIGQUIT', onSignal);

    try {
      while (!stopped) {
        if (!runningTick) {
          runningTick = true;
          try {
            await this.runTick();
          } finally {
            runningTick = false;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, this.watchTickMs));
      }
      return 0;
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.off('SIGQUIT', onSignal);
      this.releaseWatchLock(lockFd);
    }
  }
}
