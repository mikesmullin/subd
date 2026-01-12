import { globals } from '../../common/globals.mjs';
import { Utils } from '../../common/utils.mjs';
import { HumanPlugin } from '../human/index.mjs';
import { ApprovalModel } from '../human/models/approval.mjs';
import { bridge, ToolExecutionStatus } from '../agent/controllers/host-container-bridge.mjs';
import { exec } from 'child_process';
import util from 'util';
import { ptyManager } from './pty-manager.mjs';
import { checkCommand } from './terminal-allowlist.mjs';

const execAsync = util.promisify(exec);

export class ShellPlugin {
  constructor() {
    globals.pluginsRegistry.set('shell', this);
    this.registerTools();
  }

  /**
   * @deprecated - No longer used. FSM pattern handles approval flow in executeShell()
   */
  async checkApproval(command, context) {
      // Check allowlist
      const check = await checkCommand(command);
      if (check.approved) {
          Utils.logInfo(`Command auto-approved: ${check.reason}`);
          return { approved: true, command };
      }
      
      // If no session context (e.g. direct CLI use), allow it (user is the human)
      if (!context || !context.sessionId) return { approved: true, command };

      // Check for unattended mode (auto-reject when no human operator)
      const unattended = globals.getConfig('unattended') === true;
      if (unattended) {
          Utils.logWarn(`Command rejected by unattended mode security policy: ${command}`);
          Utils.logWarn(`Reason: ${check.reason}`);
          return { approved: false, error: `Command execution rejected by unattended mode security policy. Reason: ${check.reason}. Enable human approval by setting unattended to false.` };
      }

      // Check if already approved (Recovery Scenario)
      if (context.toolCallId) {
          const existing = ApprovalModel.list().find(a => 
              a.toolCallId === context.toolCallId && 
              a.sessionId === context.sessionId &&
              (a.status === 'approve' || a.status === 'modify')
          );
          
          if (existing) {
              Utils.logInfo(`Found existing approval for tool call ${context.toolCallId}`);
              if (existing.status === 'modify') {
                  // MODIFY means rejection with guidance, not command modification
                  return { 
                    approved: false, 
                    error: `Command rejected. Human guidance: ${existing.response}` 
                  };
              }
              return { approved: true, command };
          }
      }

      // Request approval via shared tool execution path (automatic host routing)
      const description = `Execute shell command: ${command}\nReason: ${check.reason}`;
      
      let result;
      try {
        // Utils.executeTool will automatically route to host because 
        // human__approval__request has requiresHostExecution: true
        result = await Utils.executeTool('human__approval__request', {
          sessionId: context.sessionId,
          type: 'shell_execution',
          description: description,
          toolCallId: context.toolCallId
        }, context);
      } catch (e) {
        Utils.logError(`Approval request failed: ${e.message}`);
        return { approved: false, error: `Approval request failed: ${e.message}` };
      }
      
      if (result.choice === 'APPROVE') {
        return { approved: true, command };
      }
      
      // For REJECT and MODIFY, return error with guidance
      const guidance = result.explanation || 'Human denied request.';
      return { 
        approved: false, 
        error: `Command rejected. Human guidance: ${guidance}` 
      };
  }

  registerTools() {
    globals.dslRegistry.set('shell__execute', this.executeShell.bind(this));
    globals.dslRegistry.set('shell__pty__create', this.createPtty.bind(this));
    globals.dslRegistry.set('shell__pty__execute', this.sendTextToPtty.bind(this));
    globals.dslRegistry.set('shell__pty__read', this.readPtty.bind(this));
    globals.dslRegistry.set('shell__pty__snapshot', this.snapshotPtty.bind(this));
    globals.dslRegistry.set('shell__pty__list', this.listPttySessions.bind(this));
    globals.dslRegistry.set('shell__pty__delete', this.closePtty.bind(this));
  }

  get definition() {
    return [
      {
        type: "function",
        function: {
          name: "shell__execute",
          description: "Execute a shell command (requires human approval for dangerous commands).",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "The command to execute." }
            },
            required: ["command"]
          }
        },
        metadata: { 
          help: "shell exec <command>",
          alias: (args) => {
            if (args[0] === 'shell' && /^(exec|execute)$/.test(args[1])) {
              return { name: 'shell__execute', args: { command: args.slice(2).join(' ') } };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "shell__pty__create",
          description: "Create a new persistent pseudo-terminal session.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "Optional ID for the PTY session." }
            }
          }
        },
        metadata: { 
          help: "pty create [id]",
          alias: (args) => {
            if (args[0] === 'pty' && args[1] === 'create') {
              return { name: 'shell__pty__create', args: { id: args[2] } };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "shell__pty__execute",
          description: "Send text to an existing PTY session.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "The ID of the PTY session." },
              text: { type: "string", description: "The text to send." }
            },
            required: ["id", "text"]
          }
        },
        metadata: { 
          help: "pty exec <id> <text>",
          alias: (args) => {
            if (args[0] === 'pty' && /^(exec|execute)$/.test(args[1])) {
              return { name: 'shell__pty__execute', args: { id: args[2], text: args.slice(3).join(' ') } };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "shell__pty__read",
          description: "Read output from a PTY session buffer.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "The ID of the PTY session." }
            },
            required: ["id"]
          }
        },
        metadata: { 
          help: "pty read <id>",
          alias: (args) => {
            if (args[0] === 'pty' && args[1] === 'read') {
              return { name: 'shell__pty__read', args: { id: args[2] } };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "shell__pty__snapshot",
          description: "Get a snapshot of the PTY screen without advancing the read pointer.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "The ID of the PTY session." }
            },
            required: ["id"]
          }
        },
        metadata: { 
          help: "pty snap <id>",
          alias: (args) => {
            if (args[0] === 'pty' && (args[1] === 'snap' || args[1] === 'snapshot')) {
              return { name: 'shell__pty__snapshot', args: { id: args[2] } };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "shell__pty__list",
          description: "List all active PTY sessions.",
          parameters: {
            type: "object",
            properties: {}
          }
        },
        metadata: { 
          help: "pty list",
          alias: (args) => {
            if (args[0] === 'pty' && (args[1] === 'list' || args[1] === 'ls')) {
              return { name: 'shell__pty__list', args: {} };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "shell__pty__delete",
          description: "Close a PTY session and release its resources.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "The ID of the PTY session." }
            },
            required: ["id"]
          }
        },
        metadata: { 
          help: "pty delete <id>",
          alias: (args) => {
            if (args[0] === 'pty' && (args[1] === 'delete' || args[1] === 'close' || args[1] === 'rm')) {
              return { name: 'shell__pty__delete', args: { id: args[2] } };
            }
            return false;
          }
        }
      }
    ];
  }

  async executeShell(args, context = {}) {
      let command;
      if (Array.isArray(args)) {
          command = args.join(' ');
      } else {
          command = args.command;
      }

      // Get current state (if resuming from approval)
      const state = context.state || {};
      const phase = state.phase || 'initial';
      const externalData = context.externalData || {};
      
      // Check for session-specific tool options (allowlist override)
      const toolOptions = globals.sessionToolOptions?.get('shell__execute');
      const sessionAllowlist = toolOptions?.allowlist;
      
      // FSM State Machine
      switch (phase) {
        case 'initial':
          // Phase 1: Check approval requirements
          // If session has a custom allowlist, use it exclusively
          const checkOptions = sessionAllowlist ? { allowlist: sessionAllowlist } : {};
          const check = await checkCommand(command, checkOptions);
          
          // Auto-approved (allowlist or no session context)
          if (check.approved || !context.sessionId) {
            Utils.logInfo(`Command auto-approved: ${check.reason || 'no session context'}`);
            return this.executeCommand(command);
          }
          
          // Check for unattended mode (auto-reject when no human operator)
          const unattended = globals.getConfig('unattended') === true;
          if (unattended) {
            Utils.logWarn(`Command rejected by unattended mode security policy: ${command}`);
            Utils.logWarn(`Reason: ${check.reason}`);
            
            // If rejected due to allowlist, include the allowed commands in the error message
            let errorMsg = `Command execution rejected by unattended mode security policy. Reason: ${check.reason}.`;
            if (sessionAllowlist) {
              const allowedCommands = Object.keys(sessionAllowlist).filter(k => sessionAllowlist[k] === true);
              if (allowedCommands.length > 0) {
                errorMsg += ` Allowed commands: ${allowedCommands.join(', ')}.`;
              }
            }
            errorMsg += ` Enable human approval by setting unattended to false.`;
            
            return {
              status: ToolExecutionStatus.FAILURE,
              error: errorMsg
            };
          }
          
          // Check if already approved (Recovery Scenario)
          if (context.toolCallId) {
            const existing = ApprovalModel.list().find(a => 
              a.toolCallId === context.toolCallId && 
              a.sessionId === context.sessionId &&
              (a.status === 'approve' || a.status === 'modify')
            );
            
            if (existing) {
              Utils.logInfo(`Found existing approval for tool call ${context.toolCallId}`);
              if (existing.status === 'modify') {
                // MODIFY means rejection with guidance, not command modification
                return {
                  status: ToolExecutionStatus.FAILURE,
                  error: `Command rejected. Human guidance: ${existing.response}`
                };
              }
              // Approved - execute immediately
              return this.executeCommand(command);
            }
          }
          
          // Need approval - send request and transition to awaiting_approval phase
          Utils.logInfo(`Requesting approval for command: ${command}`);
          
          // Send approval request via bridge (this will pause session)
          await bridge.route({
            type: 'approval_request',
            sessionId: context.sessionId,
            toolCallId: context.toolCallId,
            description: `Execute shell command: ${command}\nReason: ${check.reason}`,
            approvalType: 'shell_execution'
          }, context);
          
          // Return RUNNING status with state for next invocation
          return {
            status: ToolExecutionStatus.RUNNING,
            state: { phase: 'awaiting_approval', command }
          };
        
        case 'awaiting_approval':
          // Phase 2: Process approval response
          if (!externalData.approvalReceived) {
            Utils.logWarn(`Tool call ${context.toolCallId} re-invoked but no approval yet`);
            return {
              status: ToolExecutionStatus.RUNNING,
              state: { phase: 'awaiting_approval', command: state.command }
            };
          }
          
          const choice = externalData.choice;
          const explanation = externalData.explanation;
          
          if (choice === 'APPROVE') {
            Utils.logInfo(`Approval received for command: ${state.command}`);
            return this.executeCommand(state.command);
          } else {
            // REJECT or MODIFY
            Utils.logWarn(`Command rejected by human: ${state.command}`);
            return {
              status: ToolExecutionStatus.FAILURE,
              error: `Command rejected. Human guidance: ${explanation || 'Human denied request.'}`
            };
          }
        
        default:
          return {
            status: ToolExecutionStatus.FAILURE,
            error: `Unknown FSM phase: ${state.phase}`
          };
      }
  }
  
  async executeCommand(command) {
    // Helper method for actual command execution
    // Utils.logInfo(`Executing: ${command}`);
    try {
      const { stdout, stderr } = await execAsync(command);
      // if (stdout) Utils.logInfo(stdout.trim());
      // if (stderr) Utils.logWarn(stderr.trim());
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: stdout || stderr || 'Command executed. Exit code: 0'
      };
    } catch (e) {
      // execAsync errors include stdout/stderr from the failed command
      const errorDetails = e.stderr || e.stdout || e.message;
      Utils.logError(`Shell Error: ${e.message}`);
      if (e.stderr) Utils.logError(`stderr: ${e.stderr.trim()}`);
      if (e.stdout) Utils.logInfo(`stdout: ${e.stdout.trim()}`);
      return {
        status: ToolExecutionStatus.FAILURE,
        error: `Error: ${errorDetails}. Exit code: ${e.code || 'unknown'}`
      };
    }
  }

  async createPtty(args, context = {}) {
      let ptyId;
      if (Array.isArray(args)) {
          ptyId = args[0];
      } else {
          ptyId = args.id;
      }

      const sessionId = context.sessionId || 'default'; 
      const session = ptyManager.createSession(sessionId, { id: ptyId });
      Utils.logInfo(`Created PTY session: ${session.id}`);
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: `Created PTY ${session.id}`
      };
  }

  _writeToPtty(sessionId, ptyId, text) {
      sessionId = sessionId || 'default';
      const session = ptyManager.getSession(sessionId, ptyId);
      if (session) {
          session.write(text + '\n');
          const msg = `Submitted line to pty ${ptyId}.`;
          Utils.logInfo(msg);
          return {
            status: ToolExecutionStatus.SUCCESS,
            result: msg
          };
      } else {
          return {
            status: ToolExecutionStatus.FAILURE,
            error: `PTY ${ptyId} not found`
          };
      }
  }

  async sendTextToPtty(args, context) {
      let ptyId, text;
      if (Array.isArray(args)) {
          ptyId = args[0];
          text = args.slice(1).join(' ');
      } else {
          ptyId = args.id;
          text = args.text;
      }

      // Get current state (if resuming from approval)
      const state = context.state || {};
      const phase = state.phase || 'initial';
      const externalData = context.externalData || {};

      // FSM State Machine
      switch (phase) {
        case 'initial':
          // Phase 1: Check approval requirements
          // Note: PTY is tricky because 'text' might not be a full command, but we treat it as one for safety
          const check = await checkCommand(text);
          
          // Auto-approved (allowlist or no session context)
          if (check.approved || !context.sessionId) {
            Utils.logInfo(`Command auto-approved: ${check.reason || 'no session context'}`);
            return this._writeToPtty(context.sessionId, ptyId, text);
          }
          
          // Check for unattended mode
          const unattended = globals.getConfig('unattended') === true;
          if (unattended) {
            Utils.logWarn(`Command rejected by unattended mode security policy: ${text}`);
            Utils.logWarn(`Reason: ${check.reason}`);
            return {
              status: ToolExecutionStatus.FAILURE,
              error: `Command execution rejected by unattended mode security policy. Reason: ${check.reason}. Enable human approval by setting unattended to false.`
            };
          }
          
          // Check if already approved (Recovery Scenario)
          if (context.toolCallId) {
            const existing = ApprovalModel.list().find(a => 
              a.toolCallId === context.toolCallId && 
              a.sessionId === context.sessionId &&
              (a.status === 'approve' || a.status === 'modify')
            );
            
            if (existing) {
              if (existing.status === 'modify') {
                return {
                  status: ToolExecutionStatus.FAILURE,
                  error: `Command rejected. Human guidance: ${existing.response}`
                };
              }
              return this._writeToPtty(context.sessionId, ptyId, text);
            }
          }
          
          // Need approval
          Utils.logInfo(`Requesting approval for PTY command: ${text}`);
          
          await bridge.route({
            type: 'approval_request',
            sessionId: context.sessionId,
            toolCallId: context.toolCallId,
            description: `Execute PTY command: ${text}\nReason: ${check.reason}`,
            approvalType: 'shell_execution'
          }, context);
          
          return {
            status: ToolExecutionStatus.RUNNING,
            state: { phase: 'awaiting_approval', ptyId, text }
          };
        
        case 'awaiting_approval':
          if (!externalData.approvalReceived) {
            return {
              status: ToolExecutionStatus.RUNNING,
              state: { phase: 'awaiting_approval', ptyId: state.ptyId, text: state.text }
            };
          }
          
          if (externalData.choice === 'APPROVE') {
            return this._writeToPtty(context.sessionId, state.ptyId, state.text);
          } else {
            return {
              status: ToolExecutionStatus.FAILURE,
              error: `Command rejected. Human guidance: ${externalData.explanation || 'Human denied request.'}`
            };
          }
          
        default:
          return {
            status: ToolExecutionStatus.FAILURE,
            error: `Unknown FSM phase: ${state.phase}`
          };
      }
  }
  
  async readPtty(args, context = {}) {
      let ptyId;
      if (Array.isArray(args)) {
          ptyId = args[0];
      } else {
          ptyId = args.id;
      }

      const sessionId = context.sessionId || 'default';
      const session = ptyManager.getSession(sessionId, ptyId);
      if (session) {
          const result = session.read({ sinceLastRead: true });
          const output = result.content || '(no new output)';
          Utils.logInfo(`PTY ${ptyId} output:\n${output}`);
          return {
            status: ToolExecutionStatus.SUCCESS,
            result: output
          };
      } else {
          Utils.logError(`PTY ${ptyId} not found`);
          return {
            status: ToolExecutionStatus.FAILURE,
            error: `PTY ${ptyId} not found`
          };
      }
  }

  async listPttySessions(args) {
      // List all sessions from all agents
      let sessions = [];
      for (const [key, session] of ptyManager.sessions.entries()) {
          sessions.push(session.getInfo());
      }
      
      if (sessions.length === 0) {
          const msg = '(no active PTY sessions)';
          Utils.logInfo(msg);
          return { status: ToolExecutionStatus.SUCCESS, result: msg };
      }

      const rows = sessions.map(s => {
          // Get last line from buffer for preview
          const session = ptyManager.getSession(s.agentSessionId, s.id);
          let lastLine = '';
          if (session && session.buffer.length > 0) {
              lastLine = session.buffer[session.buffer.length - 1].trim();
          }

          return {
              'PTY Id': s.id,
              'Session Id': s.agentSessionId,
              'Last line': lastLine || '(empty)'
          };
      });

      const output = Utils.outputAs('table', rows);
      Utils.logInfo(output);
      return { status: ToolExecutionStatus.SUCCESS, result: output };
  }

  async closePtty(args, context = {}) {
      let ptyId;
      if (Array.isArray(args)) {
          ptyId = args[0];
      } else {
          ptyId = args.id;
      }

      const sessionId = context.sessionId || 'default';
      ptyManager.closeSession(sessionId, ptyId);
      return { status: ToolExecutionStatus.SUCCESS, result: `Closed PTY ${ptyId}` };
  }

  async snapshotPtty(args, context = {}) {
      let ptyId;
      if (Array.isArray(args)) {
          ptyId = args[0];
      } else {
          ptyId = args.id;
      }

      // Use session context if provided, otherwise default to 'default'
      const sessionId = context.sessionId || 'default';
      const session = ptyManager.getSession(sessionId, ptyId);
      
      if (!session) {
          const msg = `PTY session ${ptyId} not found in sessionId=${sessionId}.`;
          Utils.logError(msg);
          return { status: ToolExecutionStatus.FAILURE, error: msg };
      }

      const content = session.snapshot();
      Utils.logInfo(`[PTY ${ptyId} Snapshot]\n${content}`);
      return { status: ToolExecutionStatus.SUCCESS, result: content };
  }

  // Legacy handler removed
}

export const shellPlugin = new ShellPlugin();
