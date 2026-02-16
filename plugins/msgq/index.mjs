import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import yaml from 'js-yaml';
import { globals } from '../../common/globals.mjs';
import { ToolExecutionStatus } from '../agent/controllers/host-container-bridge.mjs';

const PRIORITY_SCORE = { low: 1, normal: 2, high: 3 };

function toIsoNow() {
  return new Date().toISOString();
}

function normalizeId(input) {
  if (typeof input === 'string' && input.trim()) return input.trim();
  return `msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function ensureArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function coerceString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function priorityValue(value) {
  return PRIORITY_SCORE[String(value || 'normal').toLowerCase()] || PRIORITY_SCORE.normal;
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---\n')) {
    return { meta: {}, body: raw || '' };
  }

  const end = raw.indexOf('\n---\n', 4);
  if (end < 0) {
    return { meta: {}, body: raw || '' };
  }

  const frontmatterText = raw.slice(4, end);
  const body = raw.slice(end + 5);
  const meta = yaml.load(frontmatterText) || {};
  return { meta: typeof meta === 'object' && !Array.isArray(meta) ? meta : {}, body };
}

function stringifyFrontmatter(meta, body = '') {
  const yamlText = yaml.dump(meta, { lineWidth: -1, noRefs: true }).trimEnd();
  const normalizedBody = body || '';
  return `---\n${yamlText}\n---\n${normalizedBody.startsWith('\n') ? '' : '\n'}${normalizedBody}`;
}

export class MsgqPlugin {
  constructor() {
    globals.pluginsRegistry.set('msgq', this);
    this.registerTools();
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

  getBusRoot() {
    return this.resolveWorkspacePath('agent/msgq');
  }

  stateDir(state) {
    const normalized = state || 'pending';
    if (!['pending', 'assigned', 'archive'].includes(normalized)) {
      throw new Error(`Invalid queue state: ${normalized}`);
    }
    return this.resolveWorkspacePath(path.join('agent/msgq', normalized));
  }

  ensureDirectories() {
    const busRoot = this.getBusRoot();
    const dirs = ['pending', 'assigned', 'archive', 'teams'];
    for (const dir of dirs) {
      fs.mkdirSync(path.join(busRoot, dir), { recursive: true });
    }
  }

  messagePath(state, id) {
    const safeId = coerceString(id).replace(/\.md$/i, '');
    return path.join(this.stateDir(state), `${safeId}.md`);
  }

  readMessage(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = parseFrontmatter(raw);
    return { meta: parsed.meta || {}, body: parsed.body || '' };
  }

  writeMessage(filePath, meta, body) {
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, stringifyFrontmatter(meta, body), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  withDefaults(args = {}) {
    const now = toIsoNow();
    return {
      id: normalizeId(args.id),
      type: coerceString(args.type || 'note', 'note'),
      created_at: coerceString(args.created_at || now, now),
      sender: coerceString(args.sender || 'agent:unknown', 'agent:unknown'),
      recipient: coerceString(args.recipient || 'broadcast', 'broadcast'),
      priority: coerceString(args.priority || 'normal', 'normal'),
      importance: args.importance ?? null,
      urgency: args.urgency ?? null,
      blockedBy: ensureArray(args.blockedBy),
      status: coerceString(args.status || 'pending', 'pending'),
      assignee: args.assignee ?? null,
      claimed_at: args.claimed_at ?? null,
      updated_at: args.updated_at ?? null,
      payload: (args.payload && typeof args.payload === 'object') ? args.payload : {},
      history: ensureArray(args.history)
    };
  }

  isBlocked(meta) {
    const blockedBy = ensureArray(meta.blockedBy).filter(Boolean);
    if (blockedBy.length === 0) return false;

    const archiveDir = this.stateDir('archive');
    for (const dependencyId of blockedBy) {
      const dependencyPath = path.join(archiveDir, `${dependencyId}.md`);
      if (!fs.existsSync(dependencyPath)) return true;
    }
    return false;
  }

  async routeToHostIfNeeded(toolName, args, context = {}) {
    if (!globals.subdContext?.agentMode) return null;
    if (context?.__hostRouted) return null;
    if (typeof globals.subdContext.requestToolCallFromHost !== 'function') return null;

    return await globals.subdContext.requestToolCallFromHost({
      toolName,
      args,
      context: { ...context, __hostRouted: true }
    });
  }

  async runHook(event, payload, { blocking = false } = {}) {
    if (!globals.hooksRuntime) return { ok: true, blocked: false };
    return await globals.hooksRuntime.trigger(event, payload, { blocking });
  }

  registerTools() {
    globals.dslRegistry.set('msgq__append', this.append.bind(this));
    globals.dslRegistry.set('msgq__claim', this.claim.bind(this));
    globals.dslRegistry.set('msgq__list', this.list.bind(this));
    globals.dslRegistry.set('msgq__await', this.awaitMessages.bind(this));
    globals.dslRegistry.set('msgq__update', this.update.bind(this));
    globals.dslRegistry.set('msgq__archive', this.archive.bind(this));
    globals.dslRegistry.set('msgq__bcast', this.broadcast.bind(this));
  }

  get definition() {
    return [
      {
        type: 'function',
        function: {
          name: 'msgq__append',
          description: 'Append a new message/task to pending queue.',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string' },
              sender: { type: 'string' },
              recipient: { type: 'string' },
              priority: { type: 'string' },
              blockedBy: { type: 'array', items: { type: 'string' } },
              payload: { type: 'object' },
              body: { type: 'string' }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'msgq__claim',
          description: 'Claim one pending message by id or next eligible by priority/time.',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              assignee: { type: 'string' },
              recipient: { type: 'string' },
              type: { type: 'string' }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'msgq__list',
          description: 'List queue messages with filters.',
          parameters: {
            type: 'object',
            properties: {
              state: { type: 'string' },
              recipient: { type: 'string' },
              assignee: { type: 'string' },
              type: { type: 'string' },
              limit: { type: 'number' }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'msgq__await',
          description: 'Poll queue messages until filters change or minimum count is reached.',
          parameters: {
            type: 'object',
            properties: {
              state: { type: 'string' },
              recipient: { type: 'string' },
              assignee: { type: 'string' },
              type: { type: 'string' },
              limit: { type: 'number' },
              min_count: { type: 'number' },
              timeout_ms: { type: 'number' },
              poll_ms: { type: 'number' }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'msgq__update',
          description: 'Update an assigned message and append history.',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              assignee: { type: 'string' },
              status: { type: 'string' },
              payload: { type: 'object' },
              body_append: { type: 'string' },
              history_event: { type: 'string' }
            },
            required: ['id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'msgq__archive',
          description: 'Archive a message as completed/failed/cancelled.',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              from_state: { type: 'string' },
              assignee: { type: 'string' },
              resolution: { type: 'string' },
              final_payload: { type: 'object' }
            },
            required: ['id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'msgq__bcast',
          description: 'Broadcast one payload to multiple recipients as individual pending messages.',
          parameters: {
            type: 'object',
            properties: {
              recipients: { type: 'array', items: { type: 'string' } },
              sender: { type: 'string' },
              type: { type: 'string' },
              priority: { type: 'string' },
              payload: { type: 'object' },
              body: { type: 'string' }
            },
            required: ['recipients']
          }
        }
      }
    ];
  }

  queryMessages(args = {}) {
    const state = args.state || 'pending';
    const dir = this.stateDir(state);
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
    const limit = Number(args.limit || 100);

    const items = [];
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const { meta } = this.readMessage(fullPath);

      if (args.type && meta.type !== args.type) continue;
      if (args.recipient && meta.recipient !== args.recipient) continue;
      if (args.assignee && meta.assignee !== args.assignee) continue;

      items.push({
        id: meta.id || file.replace(/\.md$/, ''),
        type: meta.type || 'note',
        status: meta.status || state,
        sender: meta.sender || 'agent:unknown',
        recipient: meta.recipient || 'broadcast',
        assignee: meta.assignee || null,
        priority: meta.priority || 'normal',
        created_at: meta.created_at || null,
        updated_at: meta.updated_at || null,
        path: path.relative(this.getWorkspaceRoot(), fullPath)
      });

      if (items.length >= limit) break;
    }

    return items;
  }

  signatureFor(items = []) {
    return items
      .map((item) => `${item.id}:${item.status}:${item.updated_at || ''}:${item.path}`)
      .join('|');
  }

  async append(args = {}, context = {}) {
    const routed = await this.routeToHostIfNeeded('msgq__append', args, context);
    if (routed) return routed;

    try {
      this.ensureDirectories();
      const message = this.withDefaults(args);
      const body = coerceString(args.body || '', '');

      const preSend = await this.runHook('message_sending', {
        session_id: context?.sessionId,
        message_id: message.id,
        message_type: message.type,
        recipient: message.recipient,
        payload: message.payload
      }, { blocking: true });

      if (preSend.blocked) {
        return { status: ToolExecutionStatus.FAILURE, error: preSend.reason || 'message_sending blocked by hook' };
      }

      const targetPath = this.messagePath('pending', message.id);
      if (fs.existsSync(targetPath)) {
        return { status: ToolExecutionStatus.FAILURE, error: `Message already exists: ${message.id}` };
      }

      this.writeMessage(targetPath, message, body);

      await this.runHook('message_sent', {
        session_id: context?.sessionId,
        message_id: message.id,
        message_type: message.type,
        recipient: message.recipient,
        payload: message.payload
      });

      await this.runHook('msgq_appended', {
        session_id: context?.sessionId,
        message_id: message.id,
        message_type: message.type,
        sender: message.sender,
        recipient: message.recipient,
        payload: message.payload,
        pending_path: targetPath
      });

      return {
        status: ToolExecutionStatus.SUCCESS,
        result: {
          id: message.id,
          state: 'pending',
          path: path.relative(this.getWorkspaceRoot(), targetPath)
        }
      };
    } catch (error) {
      return { status: ToolExecutionStatus.FAILURE, error: error.message };
    }
  }

  async list(args = {}, context = {}) {
    const routed = await this.routeToHostIfNeeded('msgq__list', args, context);
    if (routed) return routed;

    try {
      this.ensureDirectories();
      const items = this.queryMessages(args);
      return { status: ToolExecutionStatus.SUCCESS, result: items };
    } catch (error) {
      return { status: ToolExecutionStatus.FAILURE, error: error.message };
    }
  }

  async awaitMessages(args = {}, context = {}) {
    const routed = await this.routeToHostIfNeeded('msgq__await', args, context);
    if (routed) return routed;

    try {
      this.ensureDirectories();

      const pollMs = Math.max(100, Number(args.poll_ms || 500));
      const timeoutMs = Math.max(0, Number(args.timeout_ms || 0));
      const minCountRaw = args.min_count;
      const minCount = minCountRaw === undefined || minCountRaw === null ? null : Math.max(0, Number(minCountRaw));

      const startedAt = Date.now();
      let initialItems = this.queryMessages(args);
      let initialSignature = this.signatureFor(initialItems);

      if (minCount !== null && initialItems.length >= minCount) {
        return {
          status: ToolExecutionStatus.SUCCESS,
          result: {
            state: args.state || 'pending',
            count: initialItems.length,
            min_count: minCount,
            elapsed_ms: 0,
            timed_out: false,
            reason: 'min_count_reached',
            items: initialItems
          }
        };
      }

      if (minCount === null && initialItems.length > 0) {
        return {
          status: ToolExecutionStatus.SUCCESS,
          result: {
            state: args.state || 'pending',
            count: initialItems.length,
            elapsed_ms: 0,
            timed_out: false,
            reason: 'items_available',
            items: initialItems
          }
        };
      }

      while (true) {
        if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
          const timedOutItems = this.queryMessages(args);
          return {
            status: ToolExecutionStatus.SUCCESS,
            result: {
              state: args.state || 'pending',
              count: timedOutItems.length,
              min_count: minCount,
              elapsed_ms: Date.now() - startedAt,
              timed_out: true,
              reason: 'timeout',
              items: timedOutItems
            }
          };
        }

        await new Promise((resolve) => setTimeout(resolve, pollMs));

        const currentItems = this.queryMessages(args);
        if (minCount !== null) {
          if (currentItems.length >= minCount) {
            return {
              status: ToolExecutionStatus.SUCCESS,
              result: {
                state: args.state || 'pending',
                count: currentItems.length,
                min_count: minCount,
                elapsed_ms: Date.now() - startedAt,
                timed_out: false,
                reason: 'min_count_reached',
                items: currentItems
              }
            };
          }
          continue;
        }

        const currentSignature = this.signatureFor(currentItems);
        if (currentSignature !== initialSignature) {
          return {
            status: ToolExecutionStatus.SUCCESS,
            result: {
              state: args.state || 'pending',
              count: currentItems.length,
              elapsed_ms: Date.now() - startedAt,
              timed_out: false,
              reason: 'queue_changed',
              items: currentItems
            }
          };
        }

        initialItems = currentItems;
        initialSignature = currentSignature;
      }
    } catch (error) {
      return { status: ToolExecutionStatus.FAILURE, error: error.message };
    }
  }

  async claim(args = {}, context = {}) {
    const routed = await this.routeToHostIfNeeded('msgq__claim', args, context);
    if (routed) return routed;

    try {
      this.ensureDirectories();
      const assignee = coerceString(args.assignee || 'agent:unknown', 'agent:unknown');
      const pendingDir = this.stateDir('pending');

      let candidate = null;

      if (args.id) {
        const filePath = this.messagePath('pending', args.id);
        if (!fs.existsSync(filePath)) {
          return { status: ToolExecutionStatus.FAILURE, error: `Pending message not found: ${args.id}` };
        }
        const { meta } = this.readMessage(filePath);
        if (this.isBlocked(meta)) {
          return { status: ToolExecutionStatus.FAILURE, error: `Message is blocked by unresolved dependencies: ${args.id}` };
        }
        candidate = { filePath, file: path.basename(filePath) };
      } else {
        const files = fs.readdirSync(pendingDir).filter((name) => name.endsWith('.md'));
        const scored = [];

        for (const file of files) {
          const filePath = path.join(pendingDir, file);
          const { meta } = this.readMessage(filePath);
          if (args.type && meta.type !== args.type) continue;
          if (args.recipient && meta.recipient !== args.recipient) continue;
          if (this.isBlocked(meta)) continue;

          const createdAt = Number.isFinite(Date.parse(meta.created_at || '')) ? Date.parse(meta.created_at) : Number.MAX_SAFE_INTEGER;
          scored.push({
            filePath,
            file,
            priority: priorityValue(meta.priority),
            createdAt
          });
        }

        scored.sort((a, b) => {
          if (b.priority !== a.priority) return b.priority - a.priority;
          return a.createdAt - b.createdAt;
        });

        candidate = scored[0] || null;
      }

      if (!candidate) {
        return { status: ToolExecutionStatus.FAILURE, error: 'No eligible pending message available to claim' };
      }

      const pendingMessage = this.readMessage(candidate.filePath);
      const messageId = pendingMessage.meta.id || candidate.file.replace(/\.md$/, '');

      const claimHook = await this.runHook('message_claimed', {
        session_id: context?.sessionId,
        message_id: messageId,
        message_type: pendingMessage.meta.type || 'note',
        claimed_by: assignee,
        payload: pendingMessage.meta.payload || {},
        assigned_path: path.relative(this.getWorkspaceRoot(), this.messagePath('assigned', messageId))
      }, { blocking: true });

      if (claimHook.blocked) {
        return { status: ToolExecutionStatus.FAILURE, error: claimHook.reason || 'message_claimed blocked by hook' };
      }

      const assignedPath = this.messagePath('assigned', messageId);
      try {
        fs.renameSync(candidate.filePath, assignedPath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return {
            status: ToolExecutionStatus.FAILURE,
            error: `Claim lost: message '${messageId}' was already claimed by another agent`
          };
        }
        return {
          status: ToolExecutionStatus.FAILURE,
          error: `Failed to claim message '${messageId}': ${error.message}`
        };
      }

      const claimed = this.readMessage(assignedPath);
      claimed.meta.id = messageId;
      claimed.meta.status = 'assigned';
      claimed.meta.assignee = assignee;
      claimed.meta.claimed_at = toIsoNow();
      claimed.meta.updated_at = toIsoNow();
      claimed.meta.history = ensureArray(claimed.meta.history);
      claimed.meta.history.push({ at: toIsoNow(), event: 'claimed', by: assignee });
      this.writeMessage(assignedPath, claimed.meta, claimed.body);

      await this.runHook('msgq_claimed', {
        session_id: context?.sessionId,
        message_id: messageId,
        message_type: claimed.meta.type || 'note',
        claimed_by: assignee,
        payload: claimed.meta.payload || {},
        pending_path: path.relative(this.getWorkspaceRoot(), candidate.filePath),
        assigned_path: path.relative(this.getWorkspaceRoot(), assignedPath)
      });

      return {
        status: ToolExecutionStatus.SUCCESS,
        result: {
          id: messageId,
          assignee,
          state: 'assigned',
          path: path.relative(this.getWorkspaceRoot(), assignedPath)
        }
      };
    } catch (error) {
      return { status: ToolExecutionStatus.FAILURE, error: error.message };
    }
  }

  async update(args = {}, context = {}) {
    const routed = await this.routeToHostIfNeeded('msgq__update', args, context);
    if (routed) return routed;

    try {
      this.ensureDirectories();
      const id = coerceString(args.id).trim();
      if (!id) {
        return { status: ToolExecutionStatus.FAILURE, error: 'msgq__update requires id' };
      }

      const assignedPath = this.messagePath('assigned', id);
      if (!fs.existsSync(assignedPath)) {
        return { status: ToolExecutionStatus.FAILURE, error: `Assigned message not found: ${id}` };
      }

      const message = this.readMessage(assignedPath);
      const assignee = coerceString(args.assignee || context?.agentId || 'agent:unknown', 'agent:unknown');

      if (message.meta.assignee && message.meta.assignee !== assignee) {
        return { status: ToolExecutionStatus.FAILURE, error: `Only assignee '${message.meta.assignee}' can update this message` };
      }

      const status = coerceString(args.status || message.meta.status || 'assigned', 'assigned');
      if (!['assigned', 'in_progress'].includes(status) && status !== message.meta.status) {
        return { status: ToolExecutionStatus.FAILURE, error: `Invalid update status for assigned item: ${status}` };
      }

      const payloadCandidate = args.payload && typeof args.payload === 'object' ? args.payload : message.meta.payload || {};
      const updateHook = await this.runHook('message_updated', {
        session_id: context?.sessionId,
        message_id: id,
        message_type: message.meta.type || 'note',
        updated_by: assignee,
        new_payload: payloadCandidate,
        diff: args.history_event || 'update'
      }, { blocking: true });

      if (updateHook.blocked) {
        return { status: ToolExecutionStatus.FAILURE, error: updateHook.reason || 'message_updated blocked by hook' };
      }

      message.meta.status = status;
      message.meta.assignee = assignee;
      message.meta.updated_at = toIsoNow();
      if (args.payload && typeof args.payload === 'object') {
        message.meta.payload = args.payload;
      }
      message.meta.history = ensureArray(message.meta.history);
      message.meta.history.push({
        at: toIsoNow(),
        event: args.history_event || 'updated',
        by: assignee,
        status
      });

      const bodyAppend = coerceString(args.body_append || '', '');
      const updatedBody = bodyAppend ? `${message.body || ''}\n${bodyAppend}` : message.body;
      this.writeMessage(assignedPath, message.meta, updatedBody);

      await this.runHook('msgq_updated', {
        session_id: context?.sessionId,
        message_id: id,
        message_type: message.meta.type || 'note',
        updated_by: assignee,
        new_payload: message.meta.payload || {},
        diff: args.history_event || 'update',
        assigned_path: path.relative(this.getWorkspaceRoot(), assignedPath)
      });

      return {
        status: ToolExecutionStatus.SUCCESS,
        result: {
          id,
          state: 'assigned',
          status,
          updated_at: message.meta.updated_at,
          path: path.relative(this.getWorkspaceRoot(), assignedPath)
        }
      };
    } catch (error) {
      return { status: ToolExecutionStatus.FAILURE, error: error.message };
    }
  }

  async archive(args = {}, context = {}) {
    const routed = await this.routeToHostIfNeeded('msgq__archive', args, context);
    if (routed) return routed;

    try {
      this.ensureDirectories();
      const id = coerceString(args.id).trim();
      if (!id) {
        return { status: ToolExecutionStatus.FAILURE, error: 'msgq__archive requires id' };
      }

      const fromState = args.from_state || (fs.existsSync(this.messagePath('assigned', id)) ? 'assigned' : 'pending');
      const sourcePath = this.messagePath(fromState, id);
      if (!fs.existsSync(sourcePath)) {
        return { status: ToolExecutionStatus.FAILURE, error: `Message not found: ${id}` };
      }

      const message = this.readMessage(sourcePath);
      const assignee = coerceString(args.assignee || context?.agentId || message.meta.assignee || 'agent:unknown', 'agent:unknown');
      if (fromState === 'assigned' && message.meta.assignee && message.meta.assignee !== assignee) {
        return { status: ToolExecutionStatus.FAILURE, error: `Only assignee '${message.meta.assignee}' can archive this message` };
      }

      const resolution = coerceString(args.resolution || 'completed', 'completed');
      const archiveHook = await this.runHook('message_archived', {
        session_id: context?.sessionId,
        message_id: id,
        message_type: message.meta.type || 'note',
        resolution,
        final_payload: args.final_payload && typeof args.final_payload === 'object' ? args.final_payload : (message.meta.payload || {})
      }, { blocking: true });

      if (archiveHook.blocked) {
        return { status: ToolExecutionStatus.FAILURE, error: archiveHook.reason || 'message_archived blocked by hook' };
      }

      if (resolution === 'completed') {
        const taskHook = await this.runHook('task_completed', {
          session_id: context?.sessionId,
          task_id: id,
          task_type: message.meta.type || 'task',
          result_summary: coerceString(args.summary || '', ''),
          files_changed: ensureArray(args.files_changed)
        }, { blocking: true });

        if (taskHook.blocked) {
          return { status: ToolExecutionStatus.FAILURE, error: taskHook.reason || 'task_completed blocked by hook' };
        }
      }

      const archivePath = this.messagePath('archive', id);
      fs.renameSync(sourcePath, archivePath);

      const archived = this.readMessage(archivePath);
      archived.meta.status = resolution;
      archived.meta.updated_at = toIsoNow();
      archived.meta.assignee = archived.meta.assignee || assignee;
      if (args.final_payload && typeof args.final_payload === 'object') {
        archived.meta.payload = args.final_payload;
      }
      archived.meta.history = ensureArray(archived.meta.history);
      archived.meta.history.push({ at: toIsoNow(), event: 'archived', by: assignee, resolution });
      this.writeMessage(archivePath, archived.meta, archived.body);

      await this.runHook('msgq_archived', {
        session_id: context?.sessionId,
        message_id: id,
        message_type: archived.meta.type || 'note',
        archived_by: assignee,
        final_payload: archived.meta.payload || {},
        archive_path: path.relative(this.getWorkspaceRoot(), archivePath),
        archive_reason: resolution
      });

      return {
        status: ToolExecutionStatus.SUCCESS,
        result: {
          id,
          state: 'archive',
          resolution,
          path: path.relative(this.getWorkspaceRoot(), archivePath)
        }
      };
    } catch (error) {
      return { status: ToolExecutionStatus.FAILURE, error: error.message };
    }
  }

  async broadcast(args = {}, context = {}) {
    const routed = await this.routeToHostIfNeeded('msgq__bcast', args, context);
    if (routed) return routed;

    const recipients = ensureArray(args.recipients).map((value) => String(value)).filter(Boolean);
    if (recipients.length === 0) {
      return { status: ToolExecutionStatus.FAILURE, error: 'msgq__bcast requires recipients[]' };
    }

    const created = [];
    for (const recipient of recipients) {
      const appendResult = await this.append({
        ...args,
        id: `${normalizeId(args.id)}_${recipient.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        recipient
      }, context);

      if (appendResult.status !== ToolExecutionStatus.SUCCESS) {
        return appendResult;
      }

      created.push(appendResult.result);
    }

    return { status: ToolExecutionStatus.SUCCESS, result: created };
  }
}
