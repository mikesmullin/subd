import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import yaml from 'js-yaml';
import { spawn } from 'child_process';
import os from 'os';
import { globals } from '../../common/globals.mjs';
import { SessionModel } from '../agent/models/session.mjs';

function toIsoNow() {
  return new Date().toISOString();
}

function normalizeTeamId(input) {
  if (typeof input === 'string' && input.trim()) return input.trim();
  return `team_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function safeString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function safeNumber(value, fallback = null) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return value;
}

const MIN_WORKER_TURN_LIMIT = 20;

function normalizeSandboxVolumes(rawSpecs = []) {
  const specs = Array.isArray(rawSpecs) ? rawSpecs : [rawSpecs];
  const normalized = [];

  for (const raw of specs) {
    if (typeof raw !== 'string') continue;
    const spec = raw.trim();
    if (!spec) continue;
    normalized.push(spec);
  }

  return [...new Set(normalized)];
}

export class TeamPlugin {
  constructor() {
    globals.pluginsRegistry.set('team', this);
    this.registerTools();
  }

  registerTools() {
    globals.dslRegistry.set('team__create', this.createTeam.bind(this));
    globals.dslRegistry.set('team__destroy', this.destroyTeam.bind(this));
  }

  get definition() {
    return [
      {
        type: 'function',
        function: {
          name: 'team__create',
          description: 'Create a team and launch workers asynchronously in bulk using subd.',
          parameters: {
            type: 'object',
            properties: {
              team_id: { type: 'string' },
              workers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    session_id: { type: 'string' },
                    template: { type: 'string' },
                    prompt: { type: 'string' },
                    data: { type: 'string' },
                    output: { type: 'string' },
                    turn_limit: { type: 'number' },
                    verbose: { type: 'boolean' },
                    jsonl: { type: 'boolean' },
                    strict: { type: 'boolean' },
                    read_stdin: { type: 'boolean' },
                    sandbox: { type: 'boolean' },
                    sandbox_volumes: { type: 'array', items: { type: 'string' } },
                    args: { type: 'array', items: { type: 'string' } }
                  }
                }
              },
              sandbox_volumes: { type: 'array', items: { type: 'string' } }
            },
            required: ['workers']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'team__destroy',
          description: 'Gracefully stop all team worker processes by team id.',
          parameters: {
            type: 'object',
            properties: {
              team_id: { type: 'string' },
              signal: { type: 'string' },
              force_after_ms: { type: 'number' },
              remove_file: { type: 'boolean' }
            },
            required: ['team_id']
          }
        }
      }
    ];
  }

  getWorkspaceRoot() {
    return path.resolve(process.cwd());
  }

  resolveWorkspacePath(inputPath) {
    const workspaceRoot = this.getWorkspaceRoot();
    const resolved = path.resolve(workspaceRoot, inputPath || '.');
    const relative = path.relative(workspaceRoot, resolved);
    const withinWorkspace = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    if (!withinWorkspace) {
      throw new Error(`Permission denied: Path is outside current working directory: ${inputPath}`);
    }
    return resolved;
  }

  getTeamsDir() {
    return this.resolveWorkspacePath('agent/msgq/teams');
  }

  ensureDirectories() {
    fs.mkdirSync(this.getTeamsDir(), { recursive: true });
  }

  teamFilePath(teamId) {
    const safeId = safeString(teamId).replace(/\.ya?ml$/i, '');
    return path.join(this.getTeamsDir(), `${safeId}.yml`);
  }

  writeYaml(filePath, data) {
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, yaml.dump(data, { noRefs: true, lineWidth: -1 }), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  readYaml(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = yaml.load(raw) || {};
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  }

  async routeToHostIfNeeded(toolName, args, context = {}) {
    if (!globals.subdContext?.agentMode) return null;
    if (context?.__hostRouted) return null;
    if (typeof globals.subdContext.requestToolCallFromHost !== 'function') return null;

    const inheritedVolumes = normalizeSandboxVolumes(globals.subdContext?.sandboxVolumeSpecs || []);

    return await globals.subdContext.requestToolCallFromHost({
      toolName,
      args,
      context: { ...context, __hostRouted: true, __sandboxVolumes: inheritedVolumes }
    });
  }

  buildSubdArgs(worker = {}, sessionId, teamId, options = {}) {
    const inheritedVolumes = normalizeSandboxVolumes(options?.defaultSandboxVolumes || []);
    const workerVolumes = normalizeSandboxVolumes(worker?.sandbox_volumes || []);
    const effectiveVolumes = workerVolumes.length > 0 ? workerVolumes : inheritedVolumes;
    const requestedTurnLimit = Number.isFinite(Number(worker.turn_limit)) ? Number(worker.turn_limit) : null;
    const effectiveTurnLimit = requestedTurnLimit === null ? null : Math.max(MIN_WORKER_TURN_LIMIT, Math.trunc(requestedTurnLimit));

    if (Array.isArray(worker.args) && worker.args.length > 0) {
      const base = worker.args.map(String);
      if (!base.includes('--session-id')) {
        base.unshift(String(sessionId));
        base.unshift('--session-id');
      }
      if (!base.includes('--team-id')) {
        base.unshift(String(teamId));
        base.unshift('--team-id');
      }

      const sandboxEnabled = base.includes('-s');
      const hasVolumeArg = base.includes('--sandbox-volume');
      if (sandboxEnabled && !hasVolumeArg && effectiveVolumes.length > 0) {
        for (const spec of effectiveVolumes) {
          base.push('--sandbox-volume', spec);
        }
      }

      return base;
    }

    if (!worker.template || !worker.prompt) {
      throw new Error('team__create worker requires either args[] or both template and prompt');
    }

    const built = ['-t', String(worker.template), '--session-id', String(sessionId), '--team-id', String(teamId)];

    if (worker.data !== undefined) built.push('-d', String(worker.data));
    if (worker.output !== undefined) built.push('-o', String(worker.output));
    if (worker.verbose === true) built.push('-v');
    if (worker.jsonl === true) built.push('-j');
    if (worker.strict === true) built.push('--strict');
    if (worker.read_stdin === true) built.push('-i');
    if (effectiveTurnLimit !== null) built.push('-l', String(effectiveTurnLimit));
    if (worker.sandbox === true) built.push('-s');
    if (worker.sandbox === true && effectiveVolumes.length > 0) {
      for (const spec of effectiveVolumes) {
        built.push('--sandbox-volume', spec);
      }
    }

    built.push(String(worker.prompt));
    return built;
  }

  templateExists(templateName) {
    if (!templateName || typeof templateName !== 'string') return false;
    const templateFile = path.extname(templateName) ? templateName : `${templateName}.yaml`;
    const candidatePaths = [
      path.resolve(process.cwd(), '.agent/templates', templateFile),
      path.resolve(os.homedir(), '.config/daemon/agent/templates', templateFile),
      path.resolve(globals.dbPaths.templates, templateFile)
    ];
    return candidatePaths.some((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile());
  }

  launchLocalBackground(forwardArgs) {
    const cliPath = `${globals.PROJECT_ROOT}/cli.mjs`;
    const child = spawn(process.execPath, [cliPath, ...forwardArgs], {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: 'ignore'
    });

    child.unref();

    return {
      pid: child.pid ?? null,
      runId: `team_run_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`
    };
  }

  processAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async createTeam(args = {}, context = {}) {
    const routed = await this.routeToHostIfNeeded('team__create', args, context);
    if (routed) return routed;

    try {
      this.ensureDirectories();
      const workers = Array.isArray(args.workers) ? args.workers : [];
      if (workers.length === 0) {
        return { status: 'failure', error: 'team__create requires workers[]' };
      }

      const teamId = normalizeTeamId(args.team_id);
      const teamSandboxVolumes = normalizeSandboxVolumes(
        args.sandbox_volumes || context?.__sandboxVolumes || globals.subdContext?.sandboxVolumeSpecs || []
      );
      const now = toIsoNow();
      const members = [];
      const launchErrors = [];

      for (let index = 0; index < workers.length; index++) {
        const worker = workers[index] || {};
        const sessionId = SessionModel.generateId();
        const requestedSessionId = safeString(worker.session_id, '');

        if (!this.templateExists(worker.template)) {
          launchErrors.push({
            index,
            session_id: sessionId,
            error: `Template not found: ${safeString(worker.template, '<missing>')}`
          });
          members.push({
            index,
            session_id: sessionId,
            requested_session_id: requestedSessionId || null,
            run_id: null,
            pid: null,
            template: safeString(worker.template, null),
            output: safeString(worker.output, null),
            status: 'failed_template_not_found',
            launched_at: null
          });
          continue;
        }

        const forwardArgs = this.buildSubdArgs(worker, sessionId, teamId, {
          defaultSandboxVolumes: teamSandboxVolumes
        });

        if (globals.subdContext?.agentMode && typeof globals.subdContext.requestSpawnSubdFromHost === 'function') {
          const spawnArgs = [...forwardArgs];
          if (!spawnArgs.includes('-s')) {
            spawnArgs.unshift('-s');
          }

          const response = await globals.subdContext.requestSpawnSubdFromHost(spawnArgs, { wait: false });
          if (!response?.ok) {
            launchErrors.push({ index, session_id: sessionId, error: response?.error || response?.stderr || 'Host launch failed' });
            members.push({
              index,
              session_id: sessionId,
              requested_session_id: requestedSessionId || null,
              run_id: null,
              pid: null,
              template: safeString(worker.template, null),
              output: safeString(worker.output, null),
              status: 'failed_launch',
              launched_at: null
            });
            continue;
          }

          const pid = response.pid ?? null;
          let fastFailed = false;
          if (Number.isInteger(pid) && pid > 0) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            fastFailed = !this.processAlive(pid);
          }

          if (fastFailed) {
            launchErrors.push({ index, session_id: sessionId, error: `Worker exited immediately after launch (pid=${pid})` });
          }

          members.push({
            index,
            session_id: sessionId,
            requested_session_id: requestedSessionId || null,
            run_id: `host_run_${Date.now()}_${index}`,
            pid,
            template: safeString(worker.template, null),
            output: safeString(worker.output, null),
            status: fastFailed ? 'failed_fast' : 'launched',
            launched_at: toIsoNow()
          });
          continue;
        }

        try {
          const launched = this.launchLocalBackground(forwardArgs);
          let fastFailed = false;
          if (Number.isInteger(launched.pid) && launched.pid > 0) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            fastFailed = !this.processAlive(launched.pid);
          }

          if (fastFailed) {
            launchErrors.push({ index, session_id: sessionId, error: `Worker exited immediately after launch (pid=${launched.pid})` });
          }

          members.push({
            index,
            session_id: sessionId,
            requested_session_id: requestedSessionId || null,
            run_id: launched.runId,
            pid: launched.pid,
            template: safeString(worker.template, null),
            output: safeString(worker.output, null),
            status: fastFailed ? 'failed_fast' : 'launched',
            launched_at: toIsoNow()
          });
        } catch (error) {
          launchErrors.push({ index, session_id: sessionId, error: error.message });
          members.push({
            index,
            session_id: sessionId,
            requested_session_id: requestedSessionId || null,
            run_id: null,
            pid: null,
            template: safeString(worker.template, null),
            output: safeString(worker.output, null),
            status: 'failed_launch',
            launched_at: null
          });
        }
      }

      const teamDoc = {
        id: teamId,
        status: launchErrors.length > 0 ? 'partial' : 'active',
        created_at: now,
        updated_at: toIsoNow(),
        sandbox_volumes: teamSandboxVolumes,
        members,
        launch_errors: launchErrors
      };

      const filePath = this.teamFilePath(teamId);
      this.writeYaml(filePath, teamDoc);

      return {
        status: 'success',
        result: {
          team_id: teamId,
          status: teamDoc.status,
          path: path.relative(this.getWorkspaceRoot(), filePath),
          launched_count: members.length,
          failed_count: launchErrors.length,
          members,
          launch_errors: launchErrors
        }
      };
    } catch (error) {
      return { status: 'failure', error: error.message };
    }
  }

  lookupSessionPid(sessionId) {
    const sessionsDir = globals.dbPaths.sessions;
    const filePath = path.join(sessionsDir, `${sessionId}.yml`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const session = this.readYaml(filePath);
      const pid = safeNumber(session?.metadata?.last_pid, null);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  async destroyTeam(args = {}, context = {}) {
    const routed = await this.routeToHostIfNeeded('team__destroy', args, context);
    if (routed) return routed;

    try {
      this.ensureDirectories();
      const teamId = safeString(args.team_id).trim();
      if (!teamId) {
        return { status: 'failure', error: 'team__destroy requires team_id' };
      }

      const filePath = this.teamFilePath(teamId);
      if (!fs.existsSync(filePath)) {
        return { status: 'failure', error: `Team not found: ${teamId}` };
      }

      const signal = safeString(args.signal, 'SIGQUIT');
      const forceAfterMs = Math.max(0, safeNumber(args.force_after_ms, 1500));
      const removeFile = args.remove_file === true;

      const teamDoc = this.readYaml(filePath);
      const members = Array.isArray(teamDoc.members) ? teamDoc.members : [];
      const results = [];

      for (const member of members) {
        const sessionId = safeString(member.session_id, '');
        let pid = safeNumber(member.pid, null);
        if (!Number.isInteger(pid) || pid <= 0) {
          pid = this.lookupSessionPid(sessionId);
        }

        if (!Number.isInteger(pid) || pid <= 0) {
          results.push({ session_id: sessionId, pid: null, status: 'missing_pid' });
          member.status = 'missing_pid';
          continue;
        }

        try {
          process.kill(pid, signal);
          let escalated = false;

          if (forceAfterMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, forceAfterMs));
            if (this.processAlive(pid)) {
              try {
                process.kill(pid, 'SIGKILL');
                escalated = true;
              } catch {}
            }
          }

          const aliveAfter = this.processAlive(pid);
          results.push({
            session_id: sessionId,
            pid,
            status: aliveAfter ? 'signal_sent_still_alive' : 'stopped',
            signal,
            escalated
          });
          member.status = aliveAfter ? 'stopping' : 'stopped';
          member.stopped_at = toIsoNow();
        } catch (error) {
          const status = error?.code === 'ESRCH' ? 'not_found' : 'error';
          results.push({ session_id: sessionId, pid, status, error: error.message, signal });
          member.status = status;
          member.stopped_at = toIsoNow();
        }
      }

      teamDoc.updated_at = toIsoNow();
      teamDoc.destroyed_at = toIsoNow();
      teamDoc.status = 'destroyed';

      if (removeFile) {
        fs.unlinkSync(filePath);
      } else {
        this.writeYaml(filePath, teamDoc);
      }

      const stopped = results.filter((r) => r.status === 'stopped').length;
      const failed = results.filter((r) => !['stopped', 'not_found', 'missing_pid'].includes(r.status)).length;

      return {
        status: 'success',
        result: {
          team_id: teamId,
          signal,
          remove_file: removeFile,
          stopped,
          failed,
          results
        }
      };
    } catch (error) {
      return { status: 'failure', error: error.message };
    }
  }
}
