import { globals } from '../../../common/globals.mjs';
import { Utils } from '../../../common/utils.mjs';
import { SessionModel } from '../models/session.mjs';
import { TemplateModel } from '../models/template.mjs';
import { GroupModel } from '../models/group.mjs';
import { WorkspaceManager } from './workspace.mjs';
import { SessionTools } from './session-tools.mjs';
import { GroupTools } from './group-tools.mjs';
import { toolsDefinition } from './tools-definition.mjs';
import { ToolExecutionStatus } from './host-container-bridge.mjs';
import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import net from 'net';
import ejs from 'ejs';
import os from 'os';

export class AgentPlugin {
  constructor() {
    this.activeContainers = new Set();
    this.containerSockets = new Map();
    this.sessionTools = new SessionTools(this);
    this.groupTools = new GroupTools(this);
    
    this.registerCommands();
    this.registerTools();
    this.registerWidgets();
    globals.pluginsRegistry.set('agent', this);
    globals.eventBus.on('stopped', this.onShutdown.bind(this));
    globals.eventBus.on('started', this.recoverSessions.bind(this));
  }

  registerCommands() {
    // No top-level commands registered. 
    // All access is via tools or generic CLI resolution (e.g. "agent templates list" -> "agent.templates.list")
  }

  registerWidgets() {
    // Widget: agent.sessions - Shows active sessions summary
    globals.widgetRegistry.set('agent.sessions', {
      plugin: 'agent',
      render: async () => {
        const sessions = SessionModel.list();
        if (sessions.length === 0) {
          return '┌─ Sessions ────────────────┐\n│ (no active sessions)     │\n└───────────────────────────┘';
        }
        
        let output = '┌─ Sessions ────────────────┐\n';
        for (const id of sessions.slice(0, 5)) {  // Show max 5
          const session = SessionModel.load(id);
          const state = session?.state || 'unknown';
          const template = session?.template?.name || 'unknown';
          output += `│ ${id}: ${template} [${state}]`.padEnd(28) + '│\n';
        }
        if (sessions.length > 5) {
          output += `│ ... and ${sessions.length - 5} more`.padEnd(28) + '│\n';
        }
        output += '└───────────────────────────┘';
        return output;
      }
    });
  }

  registerTools() {
    // Register all tools defined in definition
    for (const tool of this.definition) {
      const name = tool.function.name;
      const methodName = this._getMethodName(name);
      
      // Determine which delegate to use based on tool name prefix
      const parts = name.split('__');
      const isGroupTool = parts[1] === 'group' || parts[1] === 'groups';
      const isSessionTool = parts[1] === 'session' || parts[1] === 'sessions';
      
      // Check if method exists on this or delegates
      let handler;
      if (this[methodName]) {
        handler = this[methodName].bind(this);
      } else if (isGroupTool && this.groupTools[methodName]) {
        handler = this.groupTools[methodName].bind(this.groupTools);
      } else if (isSessionTool && this.sessionTools[methodName]) {
        handler = this.sessionTools[methodName].bind(this.sessionTools);
      } else if (this.sessionTools[methodName]) {
        handler = this.sessionTools[methodName].bind(this.sessionTools);
      } else if (this.groupTools[methodName]) {
        handler = this.groupTools[methodName].bind(this.groupTools);
      }

      if (handler) {
        globals.dslRegistry.set(name, handler);
      } else {
        console.warn(`Method ${methodName} not found for tool ${name}`);
      }
    }
  }

  _getMethodName(toolName) {
    if (toolName === 'agent__templates__list') return 'listAgents';
    if (toolName === 'agent__session__new') return 'createAgent';
    if (toolName === 'agent__sleep') return 'sleep';
    
    const parts = toolName.split('__');
    // e.g. agent__session__chat
    
    if (parts[0] === 'agent') {
        if (parts[1] === 'session' || parts[1] === 'sessions') {
            // agent__session__chat -> chat
            // agent__sessions__list -> list
            return parts[2];
        }
        if (parts[1] === 'group' || parts[1] === 'groups') {
            // agent__group__new -> create
            if (parts[2] === 'new') return 'create';
            return parts[2];
        }
    }
    return toolName;
  }

  _capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  get definition() {
    return toolsDefinition;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Agent Tools (Kept here as they are core)
  // ───────────────────────────────────────────────────────────────────────────

  async sleep(args) {
    const ms = Array.isArray(args) ? parseInt(args[0]) : parseInt(args.ms);
    
    if (isNaN(ms) || ms < 0) {
      return {
        status: ToolExecutionStatus.FAILURE,
        error: `Invalid sleep duration: ${args}. Must be a positive number.`
      };
    }
    
    if (ms > 300000) {
      return {
        status: ToolExecutionStatus.FAILURE,
        error: `Sleep duration too long: ${ms}ms. Maximum is 300000ms (5 minutes).`
      };
    }
    
    Utils.logInfo(`Sleeping for ${ms}ms...`);
    await new Promise(resolve => setTimeout(resolve, ms));
    Utils.logInfo(`Woke up after ${ms}ms`);
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: `Slept for ${ms}ms`
    };
  }

  async listAgents(args) {
    // Parse args to check for 'all' flag
    let showAll = false;
    if (Array.isArray(args)) {
        showAll = args.includes('all') || args.includes('--all');
    } else {
        showAll = args.all === true || args.all === 'true';
    }

    const templates = TemplateModel.list();
    const rows = [];
    
    for (const name of templates) {
        const tmpl = TemplateModel.load(name);
        const labels = tmpl?.metadata?.labels || [];
        if (labels.includes('require_human') && !showAll) {
            continue;
        }
        
        const meta = tmpl?.metadata || {};
        let description = meta.description || '';
        // Truncate description at 50 chars
        if (description.length > 50) {
            description = description.substring(0, 47) + '...';
        }

        rows.push({
            Name: name,
            Model: meta.model || '',
            Description: description,
            Labels: labels.join(',')
        });
    }

    if (rows.length === 0) {
        const msg = '(no templates found)';
        Utils.logInfo(msg);
        return {
            status: ToolExecutionStatus.SUCCESS,
            result: msg
        };
    }

    const output = Utils.outputAs('table', rows);
    Utils.logInfo(output);
    return {
        status: ToolExecutionStatus.SUCCESS,
        result: output
    };
  }

  async createAgent(args, context) {
    Utils.logTrace(`[agent.mjs] [TRACE] ${new Date().toISOString()} createAgent called`);
    let templateName, prompt;
    if (Array.isArray(args)) {
        templateName = args[0];
        prompt = args.slice(1).join(' ');
    } else {
        templateName = args.template;
        prompt = args.prompt;
    }
    
    if (!templateName) {
        const err = 'Usage: agent__session__new <template> [prompt]';
        Utils.logError(err);
        return {
            status: ToolExecutionStatus.FAILURE,
            error: err
        };
    }
    
    const template = TemplateModel.load(templateName);
    if (!template) {
        const err = `Template '${templateName}' not found.`;
        Utils.logError(err);
        return {
            status: ToolExecutionStatus.FAILURE,
            error: err
        };
    }
    
    // Check for require_human constraint
    const labels = template.metadata?.labels || [];
    if (labels.includes('require_human')) {
        // Check if called by an agent (context.sessionId present)
        if (context && context.sessionId) {
            const err = `Access Denied: Template '${templateName}' requires human interaction and cannot be spawned by an agent.`;
            Utils.logError(err);
            return {
                status: ToolExecutionStatus.FAILURE,
                error: err
            };
        }
    }
    
    // MOVED: EJS template evaluation now happens in container on startup (agent-loop.mjs)
    // to ensure evaluation happens in the container environment, not host environment
    // System prompt is copied verbatim from template, no evaluation on host
    
    const sessionId = SessionModel.generateId();
    const session = SessionModel.create(sessionId, {
        template: template,
        name: templateName,
        messages: prompt ? [{ role: 'user', content: prompt, timestamp: new Date().toISOString() }] : []
    }, { persist: false });
    
    Utils.logInfo(`Created session ${sessionId} from ${templateName}`);
    
    this.spawnAgentContainer(sessionId, session);

    if (prompt) {
        Utils.logInfo(`Initial prompt: ${prompt}`);
    }
    return {
        status: ToolExecutionStatus.SUCCESS,
        result: sessionId.toString()
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Recovery
  // ───────────────────────────────────────────────────────────────────────────

  async recoverSessions() {
    const sessions = SessionModel.list();
    
    for (const id of sessions) {
      const session = SessionModel.load(id);
      if (!session) continue;
      
      const status = session.metadata?.status;
      // Recover active states
      if (['pending', 'running', 'paused'].includes(status)) {
        const containerId = session.metadata.containerId;
        
        const containerStatus = this.getContainerStatus(containerId);
        
        if (containerStatus === 'running') {
             this.activeContainers.add(containerId);
        } else {
             if (containerStatus === 'stopped') {
                 // Remove stale container so we can reuse the name
                 this.cleanupContainerById(containerId);
             }
             
             Utils.logInfo(`Recovering session ${id} (status: ${status})...`);
             this.spawnAgentContainer(id, session);
             
             // If it was stopped, we should probably transition it to running so the loop doesn't exit immediately
             if (status === 'stopped') {
                 SessionModel.transition(id, 'run'); // stopped -> running
             }
        }
      }
    }
  }

  getContainerStatus(containerId) {
    try {
      const res = spawnSync(globals.containerRuntime, ['inspect', containerId], { encoding: 'utf8' });
      if (res.status !== 0) return 'missing';
      
      const info = JSON.parse(res.stdout);
      return info[0]?.State?.Running ? 'running' : 'stopped';
    } catch (e) {
      return 'missing';
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle & Helpers
  // ───────────────────────────────────────────────────────────────────────────

  async handlePauseCommand(args) {
    await this.handleLifecycleCommand(args, 'pause', 'SIGUSR1');
  }

  async handleResumeCommand(args) {
    await this.handleLifecycleCommand(args, 'resume');
  }

  async handleStopCommand(args) {
    await this.handleLifecycleCommand(args, 'stop', 'SIGUSR2');
  }

  async handleRunCommand(args) {
    await this.handleLifecycleCommand(args, 'run', null, (id) => {
      const session = SessionModel.load(id);
      this.spawnAgentContainer(id, session);
    });
  }

  async handleLifecycleCommand(args, action, signal = null, onSuccess = null) {
    const target = args[0];
    if (!target) {
      Utils.logError(`Usage: ${action} <session_id|@group_name|all>`);
      return;
    }

    const sessionIds = this.resolveTargetSessions(target);
    for (const id of sessionIds) {
      const result = await this.transitionSession(id, action, signal);
      if (result.success && onSuccess) {
        onSuccess(id);
      }
    }
  }

  resolveTargetSessions(target) {
    if (target === 'all') {
      return SessionModel.list();
    }

    if (target.startsWith('@')) {
      const groupName = target.substring(1);
      const group = GroupModel.load(groupName);
      if (!group) {
        Utils.logError(`Group '${groupName}' not found.`);
        return [];
      }
      return group.members || [];
    }

    return [target];
  }

  async transitionSession(sessionId, action, signal = null) {
    const result = SessionModel.transition(sessionId, action);
    if (!result.success) {
      Utils.logError(result.error);
      return result;
    }
    
    if (action === 'pause' || action === 'stop') {
      const controller = globals.activeToolCalls.get(sessionId);
      if (controller) {
        controller.abort();
        globals.activeToolCalls.delete(sessionId);
        Utils.logDebug(`Aborted active tool calls for session ${sessionId}`);
      }
    }
    
    if (signal) {
      const session = SessionModel.load(sessionId);
      const containerId = session?.metadata?.containerId;
      if (containerId) {
        try {
          spawnSync(globals.containerRuntime, ['kill', '--signal', signal, containerId], { stdio: 'ignore' });
          Utils.logDebug(`Sent ${signal} to container ${containerId}`);
        } catch (e) {
          Utils.logDebug(`Failed to send signal to container: ${e.message}`);
        }
      }
    }
    
    Utils.logInfo(`Session ${sessionId}: ${result.oldState} -> ${result.newState}`);
    return result;
  }

  spawnAgentContainer(sessionId, session) {
      Utils.logTrace(`[agent.mjs] [TRACE] ${new Date().toISOString()} spawnAgentContainer called for session ${sessionId}`);
      if (!session) {
          Utils.logError(`No session data provided for ${sessionId}, cannot spawn container.`);
          return;
      }
      
      const workspacePath = WorkspaceManager.create(sessionId);
      WorkspaceManager.writeSession(sessionId, session);
      
      const containerId = session.metadata.containerId;
      
      // Ensure any existing container with this name is removed
      this.cleanupContainerById(containerId);

      // Create socket for this container and start listening
      this.createContainerSocket(sessionId);

      this.activeContainers.add(containerId);
      
      const args = [
          'run', '-d', '--init',
          '--userns=keep-id', // ensure node_modules/ is writable
          '--name', containerId,
          '-v', `${workspacePath}:/app`,
          globals.containerImage,
          '--session', sessionId
      ];
      
      Utils.logTrace(`[agent.mjs] [TRACE] ${new Date().toISOString()} Spawning container with args: ${args.join(' ')}`);
      const child = spawn(globals.containerRuntime, args);
      Utils.logTrace(`[agent.mjs] [TRACE] ${new Date().toISOString()} Container spawned`);
      
      child.on('error', (err) => {
          Utils.logError(`Failed to spawn container ${containerId}: ${err.message}. Is ${globals.containerRuntime} installed?`);
      });
      
      child.stdout.on('data', (data) => {
          Utils.logDebug(`[Container ${containerId}] run stdout: ${data}`);
      });
      
      child.stderr.on('data', (data) => {
          Utils.logDebug(`[Container ${containerId}] run stderr: ${data}`);
      });
  }

  createContainerSocket(sessionId) {
      const socketPath = path.join(globals.dbPaths.workspaces, sessionId, `db/sockets/${sessionId}.sock`);

      // Check if socket already exists for this session
      if (this.containerSockets && this.containerSockets.has(sessionId)) {
          // Verify the socket file actually exists on disk
          if (fs.existsSync(socketPath)) {
              Utils.logDebug(`Socket already exists for session ${sessionId}`);
              return;
          }
          // If file is missing (e.g. deleted by clean), close stale server and recreate
          Utils.logWarn(`Socket file missing for session ${sessionId}, recreating server...`);
          try {
              this.containerSockets.get(sessionId).close();
          } catch (e) { /* ignore */ }
          this.containerSockets.delete(sessionId);
      }

      if (!this.containerSockets) {
          this.containerSockets = new Map();
      }

      const socketDir = path.dirname(socketPath);
      
      // Ensure directory exists
      if (!fs.existsSync(socketDir)) {
          fs.mkdirSync(socketDir, { recursive: true });
      }
      
      // Remove existing socket file if any
      if (fs.existsSync(socketPath)) {
          fs.unlinkSync(socketPath);
      }

      const server = net.createServer((socket) => {
          Utils.logDebug(`[agent.mjs:server.on('connection')] NEW CONNECTION RECEIVED - sessionId: ${sessionId}`);
          
          // Register connection with bridge for outbound messages
          import('./host-container-bridge.mjs').then(({ bridge }) => {
              Utils.logDebug(`[agent.mjs:server.on('connection')] Bridge imported, registering connection - sessionId: ${sessionId} (type: ${typeof sessionId})`);
              bridge.registerConnection(sessionId, socket);
              Utils.logDebug(`[agent.mjs:server.on('connection')] Bridge.registerConnection() call completed`);
          });

          let buffer = '';
          socket.on('data', async (data) => {
              Utils.logDebug(`[agent.mjs:socket.on('data')] Received data from container for sessionId: ${sessionId}, bytes: ${data.length}`);
              buffer += data.toString();
              const lines = buffer.split('\n');
              buffer = lines.pop(); // Keep incomplete line
              Utils.logDebug(`[agent.mjs:socket.on('data')] Parsed ${lines.length} complete lines`);
              
              for (const line of lines) {
                  if (!line.trim()) continue;
                  Utils.logDebug(`[agent.mjs:socket.on('data')] Processing line: ${line.substring(0, 100)}...`);
                  try {
                      const request = JSON.parse(line);
                      Utils.logDebug(`[agent.mjs:socket.on('data')] Parsed JSON - messageId: ${request.messageId}, type: ${request.type}`);
                      
                      // Import bridge for routing
                      const { bridge } = await import('./host-container-bridge.mjs');
                      
                      // If it's a command_response, resolve pending message directly without routing
                      if (request.type === 'command_response' && request.messageId && bridge.pendingMessages && bridge.pendingMessages.has(request.messageId)) {
                          Utils.logDebug(`[agent.mjs:socket.on('data')] Received command_response for messageId: ${request.messageId}, resolving pending message`);
                          const { resolve, timeout } = bridge.pendingMessages.get(request.messageId);
                          clearTimeout(timeout);
                          bridge.pendingMessages.delete(request.messageId);
                          resolve(request);
                          continue;
                      }
                      
                      try {
                          Utils.logDebug(`[agent.mjs:socket.on('data')] Calling bridge.route() for messageId: ${request.messageId}`);
                          const result = await bridge.route(request, { sessionId: request.sessionId || sessionId });
                          Utils.logDebug(`[agent.mjs:socket.on('data')] bridge.route() completed, result keys: ${Object.keys(result).join(', ')}`);
                          
                          // If request has messageId, send response
                          if (request.messageId) {
                              const response = {
                                  ...result,
                                  messageId: request.messageId
                              };
                              Utils.logDebug(`[agent.mjs:socket.on('data')] Sending response for messageId: ${request.messageId}`);
                              socket.write(JSON.stringify(response) + '\n');
                          } else {
                          }
                      } catch (e) {
                          Utils.logError(`[Host Socket ${sessionId}] Bridge routing failed: ${e.message}`);
                          if (request.messageId) {
                              socket.write(JSON.stringify({ success: false, error: e.message, messageId: request.messageId }) + '\n');
                          }
                      }
                  } catch (e) {
                      // JSON parse error or other
                      Utils.logError(`[Host Socket ${sessionId}] Error processing data: ${e.message}`);
                  }
              }
          });
          
          socket.on('error', (err) => {
              Utils.logError(`[Socket ${sessionId}] Error: ${err.message}`);
          });
      });

      server.listen(socketPath, () => {
          Utils.logDebug(`[agent.mjs:socketServer] Socket server listening at ${socketPath} for sessionId: ${sessionId} (type: ${typeof sessionId})`);
      });

      server.on('error', (err) => {
          Utils.logError(`[Socket Server ${sessionId}] Error: ${err.message}`);
      });

      this.containerSockets.set(sessionId, server);
  }

  cleanupContainer(sessionId) {
      const session = SessionModel.load(sessionId);
      const containerId = session?.metadata?.containerId;
      if (!containerId) {
          return;
      }
      
      try {
          spawnSync(globals.containerRuntime, ['rm', '-f', containerId], { stdio: 'ignore' });
          this.activeContainers.delete(containerId);
      } catch (e) {
          Utils.logError(`Failed to remove container ${containerId}: ${e.message}`);
      }
      
      // Clean up socket server
      this.cleanupContainerSocket(sessionId);
      
      WorkspaceManager.cleanup(sessionId);
  }

  cleanupContainerSocket(sessionId) {
      const server = this.containerSockets.get(sessionId);
      if (server) {
          server.close();
          
          // Remove host socket file from disk
          const socketPath = path.join(globals.dbPaths.workspaces, sessionId, `db/sockets/${sessionId}.sock`);
          if (fs.existsSync(socketPath)) {
              fs.unlinkSync(socketPath);
          }

          // Remove agent socket file from disk (if it exists)
          const agentSocketPath = path.join(globals.dbPaths.workspaces, sessionId, `db/sockets/${sessionId}.agent.sock`);
          if (fs.existsSync(agentSocketPath)) {
              fs.unlinkSync(agentSocketPath);
          }
          
          // Remove from map after cleanup is done
          this.containerSockets.delete(sessionId);
      }
  }

  cleanupContainerById(containerId) {
      try {
          spawnSync(globals.containerRuntime, ['rm', '-f', containerId], { stdio: 'ignore' });
          this.activeContainers.delete(containerId);
      } catch (e) {
          Utils.logError(`Failed to remove container ${containerId}: ${e.message}`);
      }
  }

  onShutdown() {
      if (this.activeContainers.size === 0) return;
      
      const containers = Array.from(this.activeContainers);
      for (const containerId of containers) {
          this.cleanupContainerById(containerId);
      }
  }
}

export const agentPlugin = new AgentPlugin();
