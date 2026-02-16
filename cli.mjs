#!/usr/bin/env bun
import fs from 'fs';
import path from 'path';
import ejs from 'ejs';
import yaml from 'js-yaml';
import os from 'os';
import net from 'net';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { globals } from './common/globals.mjs';
import { Utils } from './common/utils.mjs';
import { HooksRuntime } from './common/hooks-runtime.mjs';
import { createPromptIncludeFn } from './common/prompt-includes.mjs';
import { checkCmdProxyCommand, loadCmdProxyAllowlist } from './plugins/shell/cmd-proxy-allowlist.mjs';
import { SessionModel, SessionState } from './plugins/agent/models/session.mjs';
import { TemplateModel } from './plugins/agent/models/template.mjs';
import { HeartbeatRuntime } from './plugins/heartbeat/index.mjs';

// Provider registry
const providerRegistry = {
  'xai': async () => (await import('./plugins/agent/models/providers/xai.mjs')).XAIProvider,
  'ollama': async () => (await import('./plugins/agent/models/providers/ollama.mjs')).OllamaProvider,
  'llamacpp': async () => (await import('./plugins/agent/models/providers/llamacpp.mjs')).LlamaCppProvider,
  'copilot': async () => (await import('./plugins/agent/models/providers/copilot.mjs')).CopilotProvider,
};

async function getProviderForModel(modelStr) {
  if (!modelStr || !modelStr.includes(':')) {
    // Default to xai if no prefix
    const DefaultProvider = await providerRegistry.xai();
    return { provider: new DefaultProvider(), modelName: modelStr || 'grok-3' };
  }
  
  const parts = modelStr.split(':');
  const providerName = parts[0].toLowerCase();
  const modelName = parts.slice(1).join(':').split('#')[0].trim();
  
  const providerLoader = providerRegistry[providerName];
  if (!providerLoader) {
    throw new Error(`Unknown provider: ${providerName}. Available: ${Object.keys(providerRegistry).join(', ')}`);
  }

  const ProviderClass = await providerLoader();
  
  return { provider: new ProviderClass(), modelName };
}

// Load Plugins
import { CorePlugin } from './plugins/core/index.mjs';
import { FsPlugin } from './plugins/fs/index.mjs';
import { ShellPlugin } from './plugins/shell/index.mjs';
import { MsgqPlugin } from './plugins/msgq/index.mjs';
import { TeamPlugin } from './plugins/team/index.mjs';
import { AgentPlugin } from './plugins/agent/controllers/agent.mjs';

const INTERNAL_FLAGS = new Set(['-a', '--sandbox-host', '--sandbox-port', '--sandbox-token']);

function parseSandboxVolumes(rawSpecs = []) {
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

function parseVolumeSpec(spec) {
  const firstSep = spec.indexOf(':');
  if (firstSep <= 0) return null;
  const secondSep = spec.indexOf(':', firstSep + 1);

  if (secondSep < 0) {
    return {
      hostPath: spec.slice(0, firstSep),
      containerPath: spec.slice(firstSep + 1),
      options: ''
    };
  }

  return {
    hostPath: spec.slice(0, firstSep),
    containerPath: spec.slice(firstSep + 1, secondSep),
    options: spec.slice(secondSep + 1)
  };
}

function formatVolumeSpec({ hostPath, containerPath, options }) {
  if (!options) return `${hostPath}:${containerPath}`;
  return `${hostPath}:${containerPath}:${options}`;
}

function addSandboxVolumeAliases(specs = []) {
  const out = [...specs];
  const seen = new Set(specs);

  for (const spec of specs) {
    const parsed = parseVolumeSpec(spec);
    if (!parsed) continue;

    const { hostPath, containerPath, options } = parsed;
    if (!containerPath.startsWith('/workspace/subd/')) continue;

    const suffix = containerPath.slice('/workspace/subd/'.length);
    const aliasContainerPath = `/app/${suffix}`;
    const aliasSpec = formatVolumeSpec({ hostPath, containerPath: aliasContainerPath, options });
    if (!seen.has(aliasSpec)) {
      seen.add(aliasSpec);
      out.push(aliasSpec);
    }
  }

  return out;
}

function parseSandboxVolumesEnv(rawEnv) {
  if (typeof rawEnv !== 'string' || !rawEnv.trim()) return [];
  const parts = rawEnv
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  return parseSandboxVolumes(parts);
}

function sanitizeForwardArgs(rawArgs = []) {
  const sanitized = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (INTERNAL_FLAGS.has(arg)) {
      if (arg === '--sandbox-host' || arg === '--sandbox-port' || arg === '--sandbox-token') i++;
      continue;
    }
    sanitized.push(arg);
  }
  return sanitized;
}

function spawnSubdOnHost(forwardArgs, options = {}) {
  const wait = options.wait !== false;
  const cliPath = path.resolve(import.meta.dirname, 'cli.mjs');

  if (!wait) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [cliPath, ...forwardArgs], {
        cwd: process.cwd(),
        env: process.env,
        detached: true,
        stdio: 'ignore'
      });

      child.on('error', (error) => {
        resolve({
          ok: false,
          error: error.message,
          exitCode: 1,
          stdout: '',
          stderr: ''
        });
      });

      child.unref();
      resolve({
        ok: true,
        started: true,
        pid: child.pid ?? null,
        exitCode: null,
        stdout: '',
        stderr: ''
      });
    });
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...forwardArgs], {
      cwd: process.cwd(),
      env: process.env
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      resolve({
        ok: false,
        error: error.message,
        exitCode: 1,
        stdout,
        stderr
      });
    });

    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function ensureSandboxDirs() {
  const dirs = [
    path.resolve(process.cwd(), 'tmp'),
    path.resolve(process.cwd(), 'tmp/guinea-site')
  ];

  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      Utils.logWarn(`Failed to prepare sandbox directory ${dir}: ${error.message}`);
    }
  }
}

function getSandboxRuntimeArgs() {
  const runtime = String(globals.containerRuntime || '').toLowerCase();
  if (!runtime.includes('podman')) return [];

  const args = ['--userns=keep-id'];
  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    args.push('--user', `${process.getuid()}:${process.getgid()}`);
  }
  return args;
}

async function executeToolOnHost(toolName, args, context = {}, toolOptions = null) {
  const handler = globals.dslRegistry.get(toolName);
  if (!handler) {
    return { status: 'failure', error: `Tool ${toolName} not found` };
  }

  const previousToolOptions = globals.sessionToolOptions;
  if (toolOptions && typeof toolOptions === 'object') {
    globals.sessionToolOptions = new Map([[toolName, toolOptions]]);
  }

  try {
    const result = await handler(args, context);
    return result;
  } catch (error) {
    return { status: 'failure', error: error.message };
  } finally {
    globals.sessionToolOptions = previousToolOptions;
  }
}

async function resolveCmdProxyAllowlist(templatePath) {
  if (templatePath) {
    const resolvedPath = resolveTemplatePath(templatePath);
    if (resolvedPath) {
      try {
        const content = fs.readFileSync(resolvedPath, 'utf8');
        const template = yaml.load(content) || {};
        const templateAllowlist = template?.metadata?.cmd_proxy?.allowlist;
        if (templateAllowlist && typeof templateAllowlist === 'object') {
          return templateAllowlist;
        }
      } catch (error) {
        Utils.logWarn(`Failed to parse template cmd_proxy allowlist from ${resolvedPath}: ${error.message}`);
      }
    }
  }

  return await loadCmdProxyAllowlist();
}

const providerInstanceCache = new Map();
async function createChatCompletionOnHost(modelStr, messages, tools) {
  let cached = providerInstanceCache.get(modelStr);
  if (!cached) {
    const { provider, modelName } = await getProviderForModel(modelStr);
    await provider.init();
    cached = { provider, modelName };
    providerInstanceCache.set(modelStr, cached);
  }

  return await cached.provider.createChatCompletion({
    model: cached.modelName,
    messages,
    tools
  });
}

async function startSandboxTcpServer(authToken, options = {}) {
  const cmdProxyAllowlist = options.cmdProxyAllowlist || await loadCmdProxyAllowlist();
  const sandboxSessionIdMap = new Map();

  const server = net.createServer((socket) => {
    let buffer = '';
    const proxyProcesses = new Map();

    const killProxyProcess = (requestId) => {
      const child = proxyProcesses.get(requestId);
      if (!child) return;
      proxyProcesses.delete(requestId);
      try {
        child.kill('SIGTERM');
      } catch {}
    };

    const sendSocketMessage = (payload) => {
      try {
        socket.write(JSON.stringify(payload) + '\n');
      } catch {}
    };

    const cleanupProxyProcesses = () => {
      for (const requestId of proxyProcesses.keys()) {
        killProxyProcess(requestId);
      }
    };

    socket.on('close', cleanupProxyProcesses);
    socket.on('error', cleanupProxyProcesses);

    socket.on('data', async (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        let request;
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }

        if (request?.token !== authToken) {
          sendSocketMessage({
            id: request?.id,
            ok: false,
            error: 'Unauthorized sandbox bridge request'
          });
          continue;
        }

        try {
          if (request?.type === 'spawn_subd') {
            const forwardArgs = sanitizeForwardArgs(Array.isArray(request.args) ? request.args.map(String) : []);
            const wait = request?.wait !== false;
            const result = await spawnSubdOnHost(forwardArgs, { wait });
            sendSocketMessage({ id: request.id, ...result });
          } else if (request?.type === 'resolve_template') {
            const resolvedPath = resolveTemplatePath(request.templatePath);
            if (!resolvedPath) {
              sendSocketMessage({
                id: request.id,
                ok: false,
                error: `Template not found: ${request.templatePath}`
              });
            } else {
              const content = fs.readFileSync(resolvedPath, 'utf8');
              sendSocketMessage({ id: request.id, ok: true, resolvedPath, content });
            }
          } else if (request?.type === 'ai_completion') {
            const response = await createChatCompletionOnHost(request.modelStr, request.messages || [], request.tools);
            sendSocketMessage({ id: request.id, ok: true, response });
          } else if (request?.type === 'tool_call') {
            const result = await executeToolOnHost(
              request.toolName,
              request.args || {},
              request.context || {},
              request.toolOptions || null
            );
            sendSocketMessage({ id: request.id, ok: true, result });
          } else if (request?.type === 'session_save') {
            const requestedSessionId = request?.sessionId ? String(request.sessionId) : null;
            const sessionData = request?.sessionData;
            if (!requestedSessionId || !sessionData || typeof sessionData !== 'object') {
              sendSocketMessage({ id: request.id, ok: false, error: 'Invalid session_save payload' });
              continue;
            }

            let sessionId = requestedSessionId;
            if (!SessionModel.isCanonicalId(sessionId)) {
              if (!sandboxSessionIdMap.has(sessionId)) {
                sandboxSessionIdMap.set(sessionId, SessionModel.generateId());
              }
              sessionId = sandboxSessionIdMap.get(sessionId);
            }

            if (!sessionData.metadata || typeof sessionData.metadata !== 'object') {
              sessionData.metadata = {};
            }
            sessionData.metadata.id = sessionId;
            if (sessionId !== requestedSessionId) {
              const currentContainerId = typeof sessionData.metadata.containerId === 'string'
                ? sessionData.metadata.containerId
                : '';
              if (currentContainerId.startsWith(`${requestedSessionId}_`)) {
                const suffix = currentContainerId.slice(requestedSessionId.length + 1);
                sessionData.metadata.containerId = `${sessionId}_${suffix}`;
              }
            }

            SessionModel.save(sessionId, sessionData);
            sendSocketMessage({ id: request.id, ok: true, sessionId });
          } else if (request?.type === 'cmd_proxy_exec_start') {
            const command = typeof request.command === 'string' ? request.command.trim() : '';
            const commandArgs = Array.isArray(request.args) ? request.args.map(String) : [];

            if (!command) {
              sendSocketMessage({ id: request.id, ok: false, error: 'Missing command for cmd_proxy execution' });
              continue;
            }

            const commandLine = [command, ...commandArgs].join(' ');
            const allowCheck = await checkCmdProxyCommand(commandLine, { allowlist: cmdProxyAllowlist });
            if (!allowCheck.approved) {
              sendSocketMessage({ id: request.id, ok: false, error: `cmd_proxy command rejected: ${allowCheck.reason}` });
              continue;
            }

            const child = spawn(command, commandArgs, {
              cwd: process.cwd(),
              env: process.env,
              stdio: ['pipe', 'pipe', 'pipe']
            });
            proxyProcesses.set(request.id, child);

            child.stdout.on('data', (chunk) => {
              sendSocketMessage({
                id: request.id,
                ok: true,
                stream: 'stdout',
                chunk: Buffer.from(chunk).toString('base64')
              });
            });

            child.stderr.on('data', (chunk) => {
              sendSocketMessage({
                id: request.id,
                ok: true,
                stream: 'stderr',
                chunk: Buffer.from(chunk).toString('base64')
              });
            });

            child.on('error', (error) => {
              proxyProcesses.delete(request.id);
              sendSocketMessage({ id: request.id, ok: false, error: `cmd_proxy execution failed: ${error.message}` });
            });

            child.on('close', (code) => {
              proxyProcesses.delete(request.id);
              sendSocketMessage({
                id: request.id,
                ok: true,
                event: 'exit',
                exitCode: code ?? 1
              });
            });

            sendSocketMessage({ id: request.id, ok: true, event: 'started' });
          } else if (request?.type === 'cmd_proxy_stdin') {
            const child = proxyProcesses.get(request.id);
            if (!child) {
              sendSocketMessage({ id: request.id, ok: false, error: 'No active cmd_proxy process for stdin chunk' });
              continue;
            }

            const chunk = typeof request.chunk === 'string' ? request.chunk : '';
            if (chunk) {
              try {
                child.stdin.write(Buffer.from(chunk, 'base64'));
              } catch (error) {
                sendSocketMessage({ id: request.id, ok: false, error: `Failed to write stdin chunk: ${error.message}` });
              }
            }
          } else if (request?.type === 'cmd_proxy_stdin_end') {
            const child = proxyProcesses.get(request.id);
            if (child) {
              try {
                child.stdin.end();
              } catch {}
            }
          } else {
            sendSocketMessage({
              id: request?.id,
              ok: false,
              error: `Unsupported request type: ${request?.type || 'unknown'}`
            });
          }
        } catch (error) {
          sendSocketMessage({
            id: request?.id,
            ok: false,
            error: error.message
          });
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  if (!port) {
    throw new Error('Failed to allocate sandbox TCP port');
  }

  return { server, port };
}

async function requestSpawnSubdFromHost(bridgeConfig, forwardArgs, options = {}) {
  if (!bridgeConfig?.host || !bridgeConfig?.port || !bridgeConfig?.token) {
    throw new Error('Sandbox bridge is not configured');
  }

  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: bridgeConfig.host, port: bridgeConfig.port });
    let buffer = '';

    socket.on('connect', () => {
      const request = {
        id,
        token: bridgeConfig.token,
        type: 'spawn_subd',
        args: sanitizeForwardArgs(forwardArgs),
        wait: options.wait !== false
      };
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === id) {
            socket.end();
            resolve(message);
            return;
          }
        } catch {
          // Ignore malformed messages
        }
      }
    });

    socket.on('error', (err) => {
      reject(err);
    });
  });
}

async function sendSocketRequestToHost(bridgeConfig, payload) {
  if (!bridgeConfig?.host || !bridgeConfig?.port || !bridgeConfig?.token) {
    throw new Error('Sandbox bridge is not configured');
  }

  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: bridgeConfig.host, port: bridgeConfig.port });
    let buffer = '';

    socket.on('connect', () => {
      socket.write(JSON.stringify({ id, token: bridgeConfig.token, ...payload }) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === id) {
            socket.end();
            resolve(message);
            return;
          }
        } catch {
          // Ignore malformed messages
        }
      }
    });

    socket.on('error', (err) => reject(err));
  });
}

async function requestAICompletionFromHost(bridgeConfig, payload) {
  const response = await sendSocketRequestToHost(bridgeConfig, {
    type: 'ai_completion',
    ...payload
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'Host AI completion request failed');
  }

  return response.response;
}

async function requestTemplateFromHost(bridgeConfig, templatePath) {
  const response = await sendSocketRequestToHost(bridgeConfig, {
    type: 'resolve_template',
    templatePath
  });

  if (!response?.ok) {
    throw new Error(response?.error || `Template not found: ${templatePath}`);
  }

  return response;
}

async function requestToolCallFromHost(bridgeConfig, payload) {
  const response = await sendSocketRequestToHost(bridgeConfig, {
    type: 'tool_call',
    ...payload
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'Host tool call request failed');
  }

  return response.result;
}

async function requestSessionSaveFromHost(bridgeConfig, payload) {
  const response = await sendSocketRequestToHost(bridgeConfig, {
    type: 'session_save',
    ...payload
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'Host session save request failed');
  }

  return response;
}

// Handle subcommands
const args = process.argv.slice(2);
if (args[0] === 'clean') {
  const projectRoot = path.resolve(import.meta.dirname);
  const summary = {
    sessionFiles: 0,
    queueFiles: 0
  };

  const sessionsDir = path.join(projectRoot, 'agent/sessions');
  if (fs.existsSync(sessionsDir)) {
    const sessionFiles = fs.readdirSync(sessionsDir).filter((name) => name.endsWith('.yml'));
    for (const file of sessionFiles) {
      fs.unlinkSync(path.join(sessionsDir, file));
      summary.sessionFiles += 1;
    }
  }

  const queueStates = ['pending', 'assigned', 'archive', 'teams'];
  for (const state of queueStates) {
    const stateDir = path.join(projectRoot, 'agent/msgq', state);
    if (!fs.existsSync(stateDir)) continue;
    const queueFiles = fs.readdirSync(stateDir).filter((name) => name.endsWith('.md') || name.endsWith('.yml') || name.includes('.tmp-'));
    for (const file of queueFiles) {
      fs.unlinkSync(path.join(stateDir, file));
      summary.queueFiles += 1;
    }
  }

  const totalRemoved = summary.sessionFiles + summary.queueFiles;
  console.log(`Cleaned agent runtime artifacts: ${totalRemoved} item(s) removed (${summary.sessionFiles} sessions, ${summary.queueFiles} queue files).`);
  process.exit(0);
}

if (args[0] === 'cron') {
  const mode = args[1];
  const cronArgs = args.slice(2);
  const jsonlMode = cronArgs.includes('-j') || cronArgs.includes('--jsonl');
  const verbose = cronArgs.includes('-v') || cronArgs.includes('--verbose');

  if (!mode || !['watch', 'once'].includes(mode)) {
    console.error('Usage: subd cron <watch|once> [-j|--jsonl] [-v|--verbose]');
    process.exit(1);
  }

  Utils.setLogLevel(verbose ? 'debug' : 'warn');
  Utils.setLogHandler((level, message) => {
    if (Utils.shouldLog(level)) {
      if (jsonlMode) {
        const obj = { type: 'log', timestamp: new Date().toISOString(), level, message };
        console.error(JSON.stringify(obj));
      } else {
        console.error(message);
      }
    }
  });

  const hooksRuntime = new HooksRuntime({
    template: {},
    cliPath: path.resolve(import.meta.dirname, 'cli.mjs')
  });
  await hooksRuntime.init();

  const heartbeatRuntime = new HeartbeatRuntime({
    cliPath: path.resolve(import.meta.dirname, 'cli.mjs'),
    hooksRuntime,
    jsonlMode,
    verbose
  });

  try {
    if (mode === 'once') {
      const exitCode = await heartbeatRuntime.runOnce();
      process.exit(exitCode);
    }

    const exitCode = await heartbeatRuntime.runWatch();
    process.exit(exitCode);
  } catch (error) {
    if (jsonlMode) {
      const obj = { type: 'heartbeat', timestamp: new Date().toISOString(), outcome: 'error', summary: error.message };
      console.log(JSON.stringify(obj));
    } else {
      console.error(`ERROR: ${error.message}`);
    }
    process.exit(1);
  }
}

// Parse Args
let templatePath = null;
let dataYaml = null;
let outputPath = null;
let verbose = false;
let strict = false;
let jsonlMode = false;
let turnLimit = null;
let readStdinFlag = false;
let sandboxMode = false;
let agentMode = false;
let sandboxHostArg = null;
let sandboxPortArg = null;
let sandboxTokenArg = null;
let sessionIdArg = null;
let teamIdArg = null;
let sandboxVolumeSpecs = [];
let promptParts = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '-t') {
    templatePath = args[++i];
  } else if (args[i] === '-d') {
    dataYaml = args[++i];
  } else if (args[i] === '-o') {
    outputPath = args[++i];
  } else if (args[i] === '-v') {
    verbose = true;
  } else if (args[i] === '--strict') {
    strict = true;
  } else if (args[i] === '-j') {
    jsonlMode = true;
  } else if (args[i] === '-l') {
    turnLimit = parseInt(args[++i], 10);
  } else if (args[i] === '-i') {
    readStdinFlag = true;
  } else if (args[i] === '-s') {
    sandboxMode = true;
  } else if (args[i] === '-a') {
    agentMode = true;
  } else if (args[i] === '--sandbox-host') {
    sandboxHostArg = args[++i];
  } else if (args[i] === '--sandbox-port') {
    sandboxPortArg = args[++i];
  } else if (args[i] === '--sandbox-token') {
    sandboxTokenArg = args[++i];
  } else if (args[i] === '--session-id') {
    sessionIdArg = args[++i];
  } else if (args[i] === '--team-id') {
    teamIdArg = args[++i];
  } else if (args[i] === '--volume' || args[i] === '--sandbox-volume' || args[i] === '-V') {
    sandboxVolumeSpecs.push(args[++i]);
  } else {
    promptParts.push(args[i]);
  }
}

sandboxVolumeSpecs = parseSandboxVolumes([
  ...parseSandboxVolumesEnv(process.env.SUBD_SANDBOX_VOLUMES),
  ...sandboxVolumeSpecs
]);
sandboxVolumeSpecs = addSandboxVolumeAliases(sandboxVolumeSpecs);

const sandboxBridgeConfig = {
  host: sandboxHostArg || process.env.SUBD_SANDBOX_HOST || null,
  port: sandboxPortArg ? parseInt(sandboxPortArg, 10) : (process.env.SUBD_SANDBOX_PORT ? parseInt(process.env.SUBD_SANDBOX_PORT, 10) : null),
  token: sandboxTokenArg || process.env.SUBD_SANDBOX_TOKEN || null
};

globals.subdContext = {
  sandboxMode,
  agentMode,
  sandboxVolumeSpecs,
  sandboxBridgeConfig,
  requestSpawnSubdFromHost: (forwardArgs, options) => requestSpawnSubdFromHost(sandboxBridgeConfig, forwardArgs, options),
  requestTemplateFromHost: (requestedTemplatePath) => requestTemplateFromHost(sandboxBridgeConfig, requestedTemplatePath),
  requestAICompletionFromHost: (payload) => requestAICompletionFromHost(sandboxBridgeConfig, payload),
  requestToolCallFromHost: (payload) => requestToolCallFromHost(sandboxBridgeConfig, payload),
  requestSessionSaveFromHost: (payload) => requestSessionSaveFromHost(sandboxBridgeConfig, payload)
};

// Helper for templates to read stdin (only if -i flag was passed)
let stdinCache = null;
async function readStdin() {
  if (!readStdinFlag) return '';
  if (stdinCache !== null) return stdinCache;
  stdinCache = await Bun.stdin.text();
  return stdinCache;
}

// JSONL output helper for machine-parseable output
// Types: system_prompt, user_prompt, assistant, tool_call, tool_result, thoughts, perf, error, info, final
function jsonlOut(type, data, stream = 'stdout') {
  const obj = { type, timestamp: new Date().toISOString(), ...data };
  const line = JSON.stringify(obj);
  if (stream === 'stderr') {
    console.error(line);
  } else {
    console.log(line);
  }
}

// Initialize Logger
Utils.setLogLevel(verbose ? 'debug' : 'warn');
Utils.setLogHandler((level, message) => {
  // Send all logs to stderr so stdout can be used for the final response
  if (Utils.shouldLog(level)) {
    if (jsonlMode) {
      jsonlOut('log', { level, message }, 'stderr');
    } else {
      console.error(message);
    }
  }
});

// Performance tracking
const processStartTime = Date.now();
function logPerf(label, stats) {
  if (!verbose) return;
  if (jsonlMode) {
    jsonlOut('perf', { label, stats }, 'stderr');
  } else {
    const parts = Object.entries(stats).map(([k, v]) => {
      if (typeof v === 'number') return `${k}=${v.toFixed(3)}`;
      return `${k}=${v}`;
    });
    console.error(`\x1b[95m[PERF] ${label}: ${parts.join(' ')}\x1b[0m`);
  }
}

function unwrapSingleCodeFence(text) {
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  const match = trimmed.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (!match) {
    return text;
  }
  return match[1];
}

// Colored output helpers for verbose mode
function logThoughts(text) {
  if (!verbose || !text) return;
  if (jsonlMode) {
    jsonlOut('thoughts', { content: text }, 'stderr');
  } else {
    console.error(`\x1b[90m[THOUGHTS] ${text}\x1b[0m`); // Grey
  }
}

function logAssistant(text) {
  if (!verbose || !text) return;
  if (jsonlMode) {
    jsonlOut('assistant', { content: text }, 'stderr');
  } else {
    console.error(`\x1b[33m[ASSISTANT] ${text}\x1b[0m`); // Yellow
  }
}

async function triggerHook(event, payload = {}, { blocking = false } = {}) {
  if (!globals.hooksRuntime) return { ok: true, blocked: false };
  try {
    return await globals.hooksRuntime.trigger(event, payload, { blocking });
  } catch (error) {
    if (blocking) {
      return { ok: false, blocked: true, reason: error.message };
    }
    return { ok: true, blocked: false };
  }
}

const userPrompt = promptParts.join(' ');

if (!templatePath || !userPrompt) {
  console.error('Usage: subd -t <template.yaml> [-d <yaml_data>] [-o output.log] [-v] [-j] [-i] [-l <turns>] [-s] [-V <host_path:container_path[:options]> ...] [--volume <host_path:container_path[:options]> ...] [--session-id <id>] [--team-id <team>] <prompt...>');
  process.exit(1);
}

if (sandboxMode && !agentMode) {
  const runId = `sandbox-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const containerName = `subd-${runId}`;
  const sandboxToken = crypto.randomBytes(32).toString('hex');
  const sandboxHost = process.env.SUBD_SANDBOX_HOST_FOR_CONTAINER || 'host.containers.internal';
  let sandboxServer = null;
  let sandboxPort = null;

  try {
    const sandboxCmdProxyAllowlist = await resolveCmdProxyAllowlist(templatePath);

    // Initialize tool registry on host so socket-routed tool calls can execute here.
    globals.config.unattended = true;
    new CorePlugin();
    new FsPlugin();
    new ShellPlugin();
    new MsgqPlugin();
    new TeamPlugin();
    new AgentPlugin();

    const started = await startSandboxTcpServer(sandboxToken, {
      cmdProxyAllowlist: sandboxCmdProxyAllowlist
    });
    sandboxServer = started.server;
    sandboxPort = started.port;

    const forwardedArgs = sanitizeForwardArgs(args);
    const volumeArgs = sandboxVolumeSpecs.flatMap((spec) => ['-v', spec]);
    ensureSandboxDirs();
    const runtimeArgs = getSandboxRuntimeArgs();
    const containerArgs = [
      'run', '--rm', '--init',
      ...runtimeArgs,
      '--name', containerName,
      '--label', `subd.sandbox.run=${runId}`,
      '-e', `SUBD_SANDBOX_HOST=${sandboxHost}`,
      '-e', `SUBD_SANDBOX_PORT=${sandboxPort}`,
      '-e', `SUBD_SANDBOX_TOKEN=${sandboxToken}`,
      '-e', `SUBD_SANDBOX_VOLUMES=${sandboxVolumeSpecs.join('\n')}`,
      ...volumeArgs,
      globals.containerImage,
      'subd',
      ...forwardedArgs,
      '-a',
      '--sandbox-host', sandboxHost,
      '--sandbox-port', `${sandboxPort}`,
      '--sandbox-token', sandboxToken
    ];

    const child = spawn(globals.containerRuntime, containerArgs, {
      stdio: 'inherit'
    });

    const signalHandlers = [];
    let shutdownRequested = false;

    const tryStopSandboxContainer = (signal = 'SIGTERM') => {
      try {
        spawnSync(globals.containerRuntime, ['stop', '--ignore', '--time', '2', '--signal', signal, containerName], {
          stdio: 'ignore'
        });
      } catch {}

      try {
        spawnSync(globals.containerRuntime, ['kill', '--signal', 'KILL', containerName], {
          stdio: 'ignore'
        });
      } catch {}
    };

    const handleSignal = (signal) => {
      if (shutdownRequested) return;
      shutdownRequested = true;

      try {
        child.kill(signal);
      } catch {}

      const timer = setTimeout(() => {
        tryStopSandboxContainer(signal);
      }, 1500);
      if (typeof timer?.unref === 'function') {
        timer.unref();
      }
    };

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT']) {
      const listener = () => handleSignal(signal);
      process.on(signal, listener);
      signalHandlers.push([signal, listener]);
    }

    const exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    });

    for (const [signal, listener] of signalHandlers) {
      process.off(signal, listener);
    }

    process.exit(exitCode);
  } catch (e) {
    console.error(`Sandbox launch failed: ${e.message}`);
    process.exit(1);
  } finally {
    if (sandboxServer) {
      try { sandboxServer.close(); } catch {}
    }
  }
}

// Resolve template path
// Search order:
//   1. cwd/.agent/templates/<template_file>
//   2. ~/.config/daemon/agent/templates/<template_file>
//   3. <workspace>/agent/templates/<template_file>
// If template_file has no extension, .yaml is appended
function resolveTemplatePath(p) {
  // Normalize: append .yaml if no extension provided
  const templateFile = path.extname(p) ? p : p + '.yaml';
  
  const searchPaths = [
    // Current directory (where process is running)
    path.resolve(process.cwd(), '.agent/templates', templateFile),
    // Home directory config
    path.resolve(os.homedir(), '.config/daemon/agent/templates', templateFile),
    // Workspace directory (where the .mjs files are located)
    path.resolve(globals.dbPaths.templates, templateFile)
  ];

  for (const sp of searchPaths) {
    if (fs.existsSync(sp) && fs.statSync(sp).isFile()) {
      return sp;
    }
  }
  return null;
}

let fullTemplatePath = null;
let templateContent = null;

if (agentMode) {
  try {
    const resolved = await globals.subdContext.requestTemplateFromHost(templatePath);
    fullTemplatePath = resolved.resolvedPath || templatePath;
    templateContent = resolved.content;
  } catch (e) {
    console.error(e.message || `Template not found: ${templatePath}`);
    process.exit(1);
  }
} else {
  fullTemplatePath = resolveTemplatePath(templatePath);

  if (!fullTemplatePath) {
    console.error(`Template not found: ${templatePath}`);
    process.exit(1);
  }

  templateContent = fs.readFileSync(fullTemplatePath, 'utf8');
}

// Load Template
const template = yaml.load(templateContent);
const hooksRuntime = new HooksRuntime({
  template,
  cliPath: path.resolve(import.meta.dirname, 'cli.mjs')
});
await hooksRuntime.init();
globals.hooksRuntime = hooksRuntime;

// Load Data
let data = {};
if (dataYaml) {
  try {
    data = yaml.load(dataYaml);
  } catch (e) {
    console.error(`Failed to parse data YAML: ${e.message}`);
    process.exit(1);
  }
}

// Extract validate function from template metadata
const validateFn = template.metadata?.validate || null;

// Extract loop control limits from template metadata
const maxTurns = template.metadata?.max_turns || null;
const maxValidationFails = template.metadata?.max_validation_fails || null;

// Render System Prompt
if (template.spec && template.spec.system_prompt) {
  try {
    const includePrompt = createPromptIncludeFn({ rootDir: process.cwd(), maxDepth: 10 });

    template.spec.system_prompt = await ejs.render(template.spec.system_prompt, {
      ...data,
      process,
      os,
      readStdin,
      includePrompt
    }, { async: true });
  } catch (e) {
    console.error(`Failed to render system prompt: ${e.message}`);
    process.exit(1);
  }
}

// Append validation prompt if validate function is present
if (validateFn) {
  const validationPrompt = `\n\nYour reply must cause the following function to return truthy:\n\`\`\`js\n${validateFn}\`\`\``;
  template.spec.system_prompt = (template.spec.system_prompt || '') + validationPrompt;
}

// Log final system prompt in verbose mode
if (verbose && template.spec?.system_prompt) {
  if (jsonlMode) {
    jsonlOut('system_prompt', { content: template.spec.system_prompt }, 'stderr');
  } else {
    console.error(`\x1b[94m[SYSTEM PROMPT]\n${template.spec.system_prompt}\x1b[0m`);
  }
}

// Initialize Plugins
globals.config.unattended = true;
new CorePlugin();
new FsPlugin();
new ShellPlugin();
new MsgqPlugin();
new TeamPlugin();
new AgentPlugin();

async function persistSession(sessionId, sessionData) {
  if (agentMode) {
    SessionModel.collection.set(sessionId, sessionData);
    await globals.subdContext.requestSessionSaveFromHost({
      sessionId,
      sessionData
    });
    return;
  }

  SessionModel.save(sessionId, sessionData);
}

async function appendMaxTurnsPolicyMessage(sessionId, effectiveTurnLimit) {
  const currentSession = SessionModel.load(sessionId);
  if (!currentSession?.spec?.messages) return;

  const note = `unable to continue; max turns policy exceeded (limit=${effectiveTurnLimit})`;
  const alreadyPresent = currentSession.spec.messages.some(
    (message) => message?.role === 'user' && typeof message?.content === 'string' && message.content.includes(note)
  );
  if (alreadyPresent) return;

  currentSession.spec.messages.push({
    role: 'user',
    content: note,
    timestamp: new Date().toISOString()
  });

  await persistSession(sessionId, currentSession);
}

// Create Session
let sessionId;
try {
  sessionId = SessionModel.ensureCanonicalId(sessionIdArg || null);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const templateName = path.basename(fullTemplatePath, path.extname(fullTemplatePath));
Utils.logInfo(`Creating session ${sessionId}...`);

const sessionStartHook = await triggerHook('session_start', {
  session_id: sessionId,
  initial_prompt: userPrompt,
  previous_session_id: null,
  team_id: teamIdArg || null
}, { blocking: true });

if (sessionStartHook.blocked) {
  const errorMsg = `Session blocked by hook policy: ${sessionStartHook.reason || 'session_start rejected'}`;
  if (jsonlMode) {
    jsonlOut('error', { message: errorMsg, code: 'HOOK_SESSION_START_BLOCKED' }, 'stderr');
  } else {
    console.error(errorMsg);
  }
  process.exit(1);
}

const session = SessionModel.create(sessionId, { template, name: templateName });
if (teamIdArg) {
  session.metadata.team_id = teamIdArg;
}

const promptSubmitHook = await triggerHook('user_prompt_submit', {
  session_id: sessionId,
  user_message: userPrompt,
  channel: 'cli'
}, { blocking: true });

if (promptSubmitHook.blocked) {
  const errorMsg = `User prompt blocked by hook policy: ${promptSubmitHook.reason || 'user_prompt_submit rejected'}`;
  if (jsonlMode) {
    jsonlOut('error', { message: errorMsg, code: 'HOOK_USER_PROMPT_BLOCKED' }, 'stderr');
  } else {
    console.error(errorMsg);
  }
  await persistSession(sessionId, session);
  process.exit(1);
}

session.spec.messages = [{ role: 'user', content: userPrompt, timestamp: new Date().toISOString() }];
await persistSession(sessionId, session);

// Log user prompt in JSONL mode
if (jsonlMode) {
  jsonlOut('user_prompt', { content: userPrompt }, 'stderr');
}

// Initialize Provider based on model string from template
const modelStr = template.metadata?.model || 'xai:grok-3';
let provider = null;
let modelName = null;
if (!agentMode) {
  const resolved = await getProviderForModel(modelStr);
  provider = resolved.provider;
  modelName = resolved.modelName;
  await provider.init();
}

// Tool Call Loop
async function getChatMessages(sessionId) {
  const currentSession = SessionModel.load(sessionId);
  if (!currentSession) {
    throw new Error(`Session ${sessionId} not found`);
  }
  const messages = [];
  if (currentSession.spec.system_prompt) {
    messages.push({ role: 'system', content: currentSession.spec.system_prompt });
  }
  messages.push(...currentSession.spec.messages);
  return messages;
}

// Parse tool options from session metadata
// Format: tools: ["tool_name", { "tool_name": { allowlist: {...} } }]
// Returns: { allowedTools: Set or null (null means no restriction), toolOptions: Map }
function parseToolOptions(sessionTools) {
  const toolOptions = new Map();
  
  // If tools key is not present (undefined), allow all tools
  if (sessionTools === undefined) {
    return { allowedTools: null, toolOptions };
  }
  
  // If tools is an empty array, allow no tools
  const allowedTools = new Set();
  if (!Array.isArray(sessionTools)) {
    return { allowedTools, toolOptions };
  }
  
  for (const item of sessionTools) {
    if (typeof item === 'string') {
      allowedTools.add(item);
    } else if (typeof item === 'object' && item !== null) {
      // Format: { tool_name: { allowlist: {...} } }
      for (const [toolName, options] of Object.entries(item)) {
        allowedTools.add(toolName);
        if (options && typeof options === 'object') {
          toolOptions.set(toolName, options);
        }
      }
    }
  }
  
  return { allowedTools, toolOptions };
}

// Store tool options globally for access by tool handlers
globals.sessionToolOptions = new Map();

async function getTools(sessionId) {
  const currentSession = SessionModel.load(sessionId);
  const tools = [];
  const { allowedTools, toolOptions } = parseToolOptions(currentSession.metadata?.tools);
  
  // Store tool options globally for tool handlers to access
  globals.sessionToolOptions = toolOptions;
  
  // If allowedTools is null, no restriction - load all tools
  // If allowedTools is a Set, only load tools in the set
  for (const plugin of globals.pluginsRegistry.values()) {
    const def = plugin.definition;
    if (Array.isArray(def)) {
      for (const tool of def) {
        if (allowedTools === null || allowedTools.has(tool.function.name)) {
          tools.push({
            type: tool.type,
            function: tool.function
          });
        }
      }
    }
  }
  return tools.length > 0 ? tools : undefined;
}

async function executeSingleTool(sessionId, toolCall) {
  const toolName = toolCall.function.name;
  const argsStr = toolCall.function.arguments;
  let cmdArgs = {};
  try { cmdArgs = JSON.parse(argsStr); } catch (e) {}

  const preToolHook = await triggerHook('pre_tool_call', {
    session_id: sessionId,
    tool_name: toolName,
    tool_input: cmdArgs,
    raw_tool_call: toolCall
  }, { blocking: true });

  if (preToolHook.blocked) {
    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      name: toolName,
      content: `Error: Tool invocation blocked by hook policy: ${preToolHook.reason || 'pre_tool_call rejected'}`,
      timestamp: new Date().toISOString()
    };
  }
  
  if (jsonlMode) {
    jsonlOut('tool_call', { name: toolName, arguments: cmdArgs, tool_call_id: toolCall.id }, 'stderr');
  } else {
    Utils.logInfo(`Tool Call: ${toolName}(${argsStr})`);
  }
  const handler = globals.dslRegistry.get(toolName);
  if (!handler) return { role: 'tool', tool_call_id: toolCall.id, name: toolName, content: `Error: Tool ${toolName} not found`, timestamp: new Date().toISOString() };

  const toolStartTime = Date.now();
  try {
    const result = await handler(cmdArgs, { sessionId, toolCallId: toolCall.id });
    const toolDuration = (Date.now() - toolStartTime) / 1000;
    
    let content = result.status === 'success' 
      ? (typeof result.result === 'string' ? result.result : JSON.stringify(result.result))
      : (result.status === 'failure' ? `Error: ${result.error}` : JSON.stringify(result));

    // Log tool result in verbose mode (cyan color)
    if (verbose) {
      if (jsonlMode) {
        jsonlOut('tool_result', { name: toolName, tool_call_id: toolCall.id, content, status: result.status || 'success' }, 'stderr');
      } else {
        console.error(`\x1b[36m[TOOL RESULT] ${content.substring(0, 500)}${content.length > 500 ? '...' : ''}\x1b[0m`);
      }
    }

    logPerf(`tool:${toolName}`, { 'duration(s)': toolDuration });

    if (result.status === 'success') {
      await triggerHook('post_tool_call', {
        session_id: sessionId,
        tool_name: toolName,
        tool_input: cmdArgs,
        tool_output: result.result,
        duration_ms: Math.round((Date.now() - toolStartTime))
      });
    } else {
      await triggerHook('post_tool_failure', {
        session_id: sessionId,
        tool_name: toolName,
        tool_input: cmdArgs,
        error_message: result.error || 'unknown tool failure',
        exit_code: 1
      });
    }

    return { role: 'tool', tool_call_id: toolCall.id, name: toolName, content, timestamp: new Date().toISOString() };
  } catch (e) {
    const toolDuration = (Date.now() - toolStartTime) / 1000;
    logPerf(`tool:${toolName}`, { 'duration(s)': toolDuration, error: true });
    const content = `Exception: ${e.message}`;
    if (verbose) {
      if (jsonlMode) {
        jsonlOut('tool_result', { name: toolName, tool_call_id: toolCall.id, content, status: 'error' }, 'stderr');
      } else {
        console.error(`\x1b[36m[TOOL RESULT] ${content}\x1b[0m`);
      }
    }

    await triggerHook('post_tool_failure', {
      session_id: sessionId,
      tool_name: toolName,
      tool_input: cmdArgs,
      error_message: e.message,
      exit_code: 1
    });

    return { role: 'tool', tool_call_id: toolCall.id, name: toolName, content, timestamp: new Date().toISOString() };
  }
}

async function handleToolCalls(sessionId, toolCalls) {
  const currentSession = SessionModel.load(sessionId);
  for (const toolCall of toolCalls) {
    const toolResultMessage = await executeSingleTool(sessionId, toolCall);
    currentSession.spec.messages.push(toolResultMessage);
  }
  await persistSession(sessionId, currentSession);
}

async function runLoop() {
  let running = true;
  let lastAssistantContent = '';
  let turnCount = 0;
  let validationFailCount = 0;
  
  // Effective turn limit: CLI -l flag takes precedence, then template max_turns
  const effectiveTurnLimit = turnLimit || maxTurns;
  
  while (running) {
    const messages = await getChatMessages(sessionId);
    const tools = await getTools(sessionId);

    const beforeAgentHook = await triggerHook('before_agent_start', {
      session_id: sessionId,
      full_context_preview: JSON.stringify(messages).slice(0, 2000),
      model_being_used: modelStr
    }, { blocking: true });

    if (beforeAgentHook.blocked) {
      const currentSession = SessionModel.load(sessionId);
      currentSession.spec.messages.push({
        role: 'user',
        content: `Turn blocked by hook policy: ${beforeAgentHook.reason || 'before_agent_start rejected'}`,
        timestamp: new Date().toISOString()
      });
      await persistSession(sessionId, currentSession);
      Utils.logWarn('before_agent_start blocked current turn; waiting for next turn.');
      continue;
    }

    Utils.logInfo(`Calling AI with ${tools?.length || 0} tools...${effectiveTurnLimit ? ` (turn ${turnCount + 1}/${effectiveTurnLimit})` : ''}`);
    turnCount++;
    
    const apiStartTime = Date.now();
    const response = globals.subdContext?.agentMode
      ? await globals.subdContext.requestAICompletionFromHost({
          modelStr,
          messages,
          tools
        })
      : await provider.createChatCompletion({
          model: modelName,
          messages,
          tools
        });
    const apiEndTime = Date.now();
    const apiDuration = (apiEndTime - apiStartTime) / 1000;
    
    // Log API request performance
    const tokenCount = response.usage?.completion_tokens || 0;
    const ttft = response.metrics?.time_to_first_token_ms ? response.metrics.time_to_first_token_ms / 1000 : apiDuration;
    const tokensPerSec = apiDuration > 0 ? tokenCount / apiDuration : 0;
    logPerf('api-request', {
      'ttft(s)': ttft,
      'tokens': tokenCount,
      'duration(s)': apiDuration,
      'tokens/s': tokensPerSec
    });

    const combinedMessage = { role: 'assistant', content: '', tool_calls: [] };
    let finishReason = 'stop'; // Default to stop if not specified
    let reasoning = '';
    
    for (const choice of response.choices) {
      // Extract reasoning/thinking if present (various provider formats)
      if (choice.message.reasoning) reasoning += choice.message.reasoning;
      if (choice.message.reasoning_content) reasoning += choice.message.reasoning_content;
      if (choice.message.thinking) reasoning += choice.message.thinking;
      
      if (choice.message.content) combinedMessage.content += choice.message.content;
      if (choice.message.tool_calls) combinedMessage.tool_calls.push(...choice.message.tool_calls);
      // Use 'tool_calls' finish_reason if any choice has it, otherwise use last choice's reason
      if (choice.finish_reason === 'tool_calls') {
        finishReason = 'tool_calls';
      } else if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }
    
    // Log thoughts/reasoning in purple (verbose mode)
    if (reasoning) logThoughts(reasoning);
    
    combinedMessage.timestamp = new Date().toISOString();
    combinedMessage.finish_reason = finishReason;

    const assistantEmitHook = await triggerHook('assistant_response_emit', {
      session_id: sessionId,
      assistant_message: combinedMessage.content,
      assistant_message_id: combinedMessage.timestamp,
      response_channel: 'cli',
      rejection_prompt_template: 'assistant_response_rejected'
    }, { blocking: true });

    if (assistantEmitHook.blocked) {
      const currentSession = SessionModel.load(sessionId);
      currentSession.spec.messages.push({
        role: 'user',
        content: `Assistant response rejected by hook policy: ${assistantEmitHook.reason || 'assistant_response_emit rejected'}`,
        timestamp: new Date().toISOString()
      });
      await persistSession(sessionId, currentSession);
      Utils.logWarn('assistant_response_emit blocked assistant output; injected rejection prompt and continuing.');
      continue;
    }
    
    const currentSession = SessionModel.load(sessionId);
    currentSession.spec.messages.push(combinedMessage);
    await persistSession(sessionId, currentSession);

    if (combinedMessage.tool_calls && combinedMessage.tool_calls.length > 0) {
      // Has tool calls - log content in verbose mode and continue
      if (combinedMessage.content) logAssistant(combinedMessage.content);
      await handleToolCalls(sessionId, combinedMessage.tool_calls);
      
      // Check turn limit after processing tool calls
      if (effectiveTurnLimit && turnCount >= effectiveTurnLimit) {
        const errorMsg = `No answer could be returned; max turns (${effectiveTurnLimit}) reached.`;
        await appendMaxTurnsPolicyMessage(sessionId, effectiveTurnLimit);
        if (jsonlMode) {
          jsonlOut('error', { message: errorMsg, code: 'MAX_TURNS_REACHED' }, 'stderr');
        } else {
          console.error(errorMsg);
        }
        process.exit(1);
      }
    } else {
      // No tool calls - check finish_reason to determine if session is complete
      // Track the last assistant content for final output
      if (combinedMessage.content) {
        lastAssistantContent = combinedMessage.content;
      }
      
      // Only terminate when finish_reason indicates completion
      if (finishReason === 'stop' || finishReason === 'end_turn') {
        const stopHook = await triggerHook('agent_terminated_stop', {
          session_id: sessionId,
          final_decision: 'stop',
          next_action_hint: ''
        }, { blocking: true });

        if (stopHook.blocked) {
          const currentSession = SessionModel.load(sessionId);
          currentSession.spec.messages.push({
            role: 'user',
            content: `Stop denied by hook policy: ${stopHook.reason || 'agent_terminated_stop rejected'}`,
            timestamp: new Date().toISOString()
          });
          await persistSession(sessionId, currentSession);
          Utils.logWarn('agent_terminated_stop blocked termination; continuing loop.');
          continue;
        }

        // If validate function is present, eval it against the response
        if (validateFn) {
          let validationResult;
          let matchedPortion = null;
          try {
            // Create a function that evaluates the validate code and passes the reply
            // We intercept String.prototype.match to capture what the validator matched on
            const validateCode = `
              const reply = arguments[0];
              const captureMatch = arguments[1];
              const originalMatch = String.prototype.match;
              String.prototype.match = function(regex) {
                const result = originalMatch.call(this, regex);
                if (result && result[0]) captureMatch(result[0]);
                return result;
              };
              try {
                ${validateFn}
              } finally {
                String.prototype.match = originalMatch;
              }
            `;
            const fn = new Function(validateCode);
            validationResult = fn(lastAssistantContent, (m) => { matchedPortion = m; });
          } catch (e) {
            validationResult = `Validation error: ${e.message}`;
          }
          
          if (!validationResult) {
            validationFailCount++;
            Utils.logInfo(`Validation failed (${validationFailCount}${maxValidationFails ? '/' + maxValidationFails : ''}), result: ${JSON.stringify(validationResult)}`);
            
            // Check max validation fails limit
            if (maxValidationFails && validationFailCount >= maxValidationFails) {
              const errorMsg = `No answer could be returned; the LLM failed to construct an answer that could pass validation in (${maxValidationFails}) attempts.`;
              if (jsonlMode) {
                jsonlOut('error', { message: errorMsg, code: 'MAX_VALIDATION_FAILS' }, 'stderr');
              } else {
                console.error(errorMsg);
              }
              process.exit(1);
            }
            
            // Check turn limit before continuing
            if (effectiveTurnLimit && turnCount >= effectiveTurnLimit) {
              const errorMsg = `No answer could be returned; max turns (${effectiveTurnLimit}) reached.`;
              await appendMaxTurnsPolicyMessage(sessionId, effectiveTurnLimit);
              if (jsonlMode) {
                jsonlOut('error', { message: errorMsg, code: 'MAX_TURNS_REACHED' }, 'stderr');
              } else {
                console.error(errorMsg);
              }
              process.exit(1);
            } else {
              // Add validation failure message and continue loop
              const validationMsg = `Your reply failed validation because the validation function returned: ${JSON.stringify(validationResult)}. Please review the javascript validation function code provided, and adapt your reply to conform strictly.`;
              const currentSession = SessionModel.load(sessionId);
              currentSession.spec.messages.push({
                role: 'user',
                content: validationMsg,
                timestamp: new Date().toISOString()
              });
              await persistSession(sessionId, currentSession);
              Utils.logInfo(`Sent validation correction prompt, continuing...`);
            }
          } else {
            // Validation passed
            Utils.logInfo(`Session complete (finish_reason: ${finishReason}, validation passed)`);
            const overallDuration = (Date.now() - processStartTime) / 1000;
            logPerf('process-end', { 'overall(s)': overallDuration });
            
            // Serialize validation result to YAML
            const yamlOutput = yaml.dump(validationResult);
            
            let finalOutput;
            if (strict) {
              // Strict mode: only output the validated YAML
              finalOutput = yamlOutput;
            } else {
              // Default: replace matched portion with --- separator + YAML
              if (matchedPortion && lastAssistantContent.includes(matchedPortion)) {
                finalOutput = lastAssistantContent.replace(matchedPortion, '---\n' + yamlOutput);
              } else {
                // Fallback if no match captured: append separator + YAML
                finalOutput = lastAssistantContent + '\n---\n' + yamlOutput;
              }
            }
            
            if (outputPath) {
              fs.writeFileSync(outputPath, finalOutput);
            } else {
              if (jsonlMode) {
                jsonlOut('final', { content: finalOutput, validated: true });
              } else {
                process.stdout.write(finalOutput);
              }
            }
            await triggerHook('session_end', {
              session_id: sessionId,
              exit_code: 0,
              duration_seconds: Number(((Date.now() - processStartTime) / 1000).toFixed(3)),
              final_token_count: response?.usage?.completion_tokens || 0
            });
            running = false;
          }
        } else {
          // No validation - proceed as before
          Utils.logInfo(`Session complete (finish_reason: ${finishReason})`);
          // Log overall process time
          const overallDuration = (Date.now() - processStartTime) / 1000;
          logPerf('process-end', { 'overall(s)': overallDuration });

          const normalizedFinalOutput = unwrapSingleCodeFence(lastAssistantContent);
          
          // Output the final response
          if (outputPath) {
            fs.writeFileSync(outputPath, normalizedFinalOutput);
          } else {
            if (jsonlMode) {
              jsonlOut('final', { content: normalizedFinalOutput });
            } else {
              process.stdout.write(normalizedFinalOutput + '\n');
            }
          }
          await triggerHook('session_end', {
            session_id: sessionId,
            exit_code: 0,
            duration_seconds: Number(((Date.now() - processStartTime) / 1000).toFixed(3)),
            final_token_count: response?.usage?.completion_tokens || 0
          });
          running = false;
        }
      } else {
        // AI returned content but didn't signal termination - continue loop
        // Log intermediate responses in verbose mode
        if (lastAssistantContent) logAssistant(lastAssistantContent);
        Utils.logInfo(`AI returned content with finish_reason: ${finishReason}, continuing...`);
      }
    }
  }
}

try {
    await runLoop();
} catch (e) {
    if (jsonlMode) {
      jsonlOut('error', { message: e.message, code: 'FATAL_ERROR', stack: e.stack }, 'stderr');
    } else {
      Utils.logError(`Fatal Error: ${e.message}`);
    }
    process.exit(1);
}
