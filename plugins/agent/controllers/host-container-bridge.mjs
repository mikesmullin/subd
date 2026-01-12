import { globals } from '../../../common/globals.mjs';
import { Utils } from '../../../common/utils.mjs';
import { SessionModel } from '../models/session.mjs';
import { HumanPlugin } from '../../human/index.mjs';
import { ApprovalModel } from '../../human/models/approval.mjs';
import net from 'net';
import fs from 'fs';
import path from 'path';

// Tool execution states (inspired by Behavior Trees)
export const ToolExecutionStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILURE: 'failure'
};

/**
 * Host-Container Bridge
 * 
 * Centralized bidirectional communication layer between CLI, host daemon, and container processes.
 * Routes messages between three execution contexts using session-specific Unix domain sockets.
 * 
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                    Message Routing Flow                         │
 * └─────────────────────────────────────────────────────────────────┘
 * 
 * 1. CLI Commands (ie. `d shell exec cat /etc/hostname`):
 *    CLI (client) --requestId--> Daemon (server at cli.sock)
 *      → bridge.route(message) applies "current" config context
 *      → handleCommand() resolves which context should execute:
 *        - If sessionId=0 (host): Execute locally, return output
 *        - If sessionId>0 (container): Forward via host->container socket
 *          → forwardToContainer() sends command with messageId
 *          → Container executes, sends response with messageId
 *          → Host adds original requestId back to response
 *          → CLI matches response by requestId, displays output
 *      → Response flows back to CLI with requestId for sync-like behavior
 * 
 * 2. Tool Calls (AI model execution):
 *    Container (agent-loop) --tool_call--> Host (via container socket)
 *      → bridge.route() checks requiresHostExecution metadata
 *      → If true: Execute on host, send result back to container
 *      → If false: Execute in container, agent-loop processes result
 * 
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                    CLI Return Paths (3 modes)                   │
 * └─────────────────────────────────────────────────────────────────┘
 * 
 * Mode 1: REPL (`d` launches interactive shell)
 *   - Output: Utils.logInfo() appears in REPL + daemon.log
 *   - Async execution: Commands don't block REPL input
 *   - User interaction: Direct console feedback
 * 
 * Mode 2a: Non-REPL Sync (`d -d` then e.g., `d shell exec cat /etc/hostname`)
 *   - Behavior: CLI blocks until command response received
 *   - Output: Response printed to stdout via requestId matching
 *   - Exit: process.exit(0) only after response matched and output streamed
 *   - Use case: Commands where user expects immediate feedback
 * 
 * Mode 2b: Non-REPL Async (`d -d` then e.g., `d questions`, later `d answer`)
 *   - Behavior: CLI enqueues command and exits immediately
 *   - Output: "Command enqueued" confirmation message
 *   - Exit: process.exit(0) without waiting for result
 *   - Use case: Long-running ops (AI prompts, approval waits) checked via follow-up commands
 * 
 * Critical Path (all 3 modes):
 * ───────────────────────────
 * All commands flow through bridge.route() which generates requestId for tracking.
 * In Mode 2a (blocking), CLI waits for response with matching requestId before exit.
 * In Mode 1/2b (non-blocking), responses stream asynchronously via Utils.logInfo().
 * This unified path enables consistent async execution with selective sync-wait behavior.
 * 
 * Network Architecture:
 * ────────────────────
 * Socket 1: CLI <-> Daemon (`./cli.sock`)
 *   - Transient connections for CLI commands
 *   - Each CLI invocation connects, sends command, waits for response with matching requestId
 * 
 * Socket 2: Host <-> Container (`db/sockets/{sessionId}.sock`)
 *   - Persistent bidirectional channel per session
 *   - Host: Server (listens), Container: Client (connects on startup)
 *   - Message types: command, command_response, tool_call, approval_request/response, ai_prompt_request
 *   - Request/Response pattern: messageId tracks individual requests, requestId tracks CLI origins
 * 
 * Stateful module pattern (singleton).
 */
class Bridge {
  constructor() {
    this.hostConnections = new Map(); // sessionId -> socket (Host side)
    this.containerSocket = null;      // socket (Container side)
    this.pendingMessages = new Map(); // messageId -> { resolve, reject, timeout }
    this.requestIdMap = new Map();    // command -> requestId (for matching responses)
    this.messageCounter = 0;
    
    // Detect if we're running inside a container (vs on host)
    // Container processes are started with --session argument
    this.isContainer = process.argv.includes('--session');
  }

  /**
   * Connect to host (called by AgentLoop in container)
   */
  async connectToHost(sessionId) {
    Utils.logDebug(`[Bridge.connectToHost] START - sessionId: ${sessionId} (type: ${typeof sessionId})`);
    const socketPath = this.isContainer 
      ? `./db/sockets/${sessionId}.sock`
      : path.join(globals.dbPaths.workspaces, sessionId, `db/sockets/${sessionId}.sock`);
    
    return new Promise((resolve, reject) => {
      Utils.logDebug(`[Bridge.connectToHost] Creating connection to socket: ${socketPath}`);
      Utils.logInfo(`[Bridge] Connecting to host socket: ${socketPath}`);
      
      const client = net.createConnection({ path: socketPath }, () => {
        Utils.logDebug(`[Bridge.connectToHost] Connection successful to ${socketPath}`);
        this.containerSocket = client;
        resolve();
      });

      let buffer = '';
      client.on('data', async (data) => {
        Utils.logDebug(`[Bridge.connectToHost.on('data')] Container received data from host, bytes: ${data.length}`);
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line
        Utils.logDebug(`[Bridge.connectToHost.on('data')] Parsed ${lines.length} complete lines`);
        
        for (const line of lines) {
          if (!line.trim()) continue;
          Utils.logDebug(`[Bridge.connectToHost.on('data')] Processing line: ${line.substring(0, 100)}...`);
          try {
            const message = JSON.parse(line);
            Utils.logDebug(`[Bridge.connectToHost.on('data')] Parsed JSON - messageId: ${message.messageId}, type: ${message.type}`);
            
            // If it's a response to a pending request
            if (message.messageId && this.pendingMessages.has(message.messageId)) {
              Utils.logDebug(`[Bridge.connectToHost.on('data')] Found pending message for messageId: ${message.messageId}, resolving`);
              const { resolve, timeout } = this.pendingMessages.get(message.messageId);
              clearTimeout(timeout);
              this.pendingMessages.delete(message.messageId);
              resolve(message);
            } else {
              // It's a new request from Host (e.g. approval_response)
              Utils.logDebug(`[Bridge.connectToHost.on('data')] New request from host, messageId: ${message.messageId}, type: ${message.type}`);
              await this.route(message, { sessionId });
            }
          } catch (e) {
            Utils.logError(`[Bridge] Error processing message: ${e.message}`);
          }
        }
      });

      client.on('error', (err) => {
        Utils.logError(`[Bridge] Connection error: ${err.message}`);
        this.containerSocket = null;
        reject(err);
      });

      client.on('close', () => {
        this.containerSocket = null;
      });
    });
  }

  /**
   * Register a connection from a container (called by AgentPlugin on host)
   */
  registerConnection(sessionId, socket) {
    Utils.logTrace(`[Bridge.registerConnection] START - raw sessionId: ${sessionId} (type: ${typeof sessionId})`);
    const originalSessionId = sessionId;
    sessionId = parseInt(sessionId, 10);
    Utils.logTrace(`[Bridge.registerConnection] Converted sessionId to: ${sessionId} (type: ${typeof sessionId})`);
    Utils.logDebug(`[registerConnection] Received sessionId: ${originalSessionId} (type: ${typeof originalSessionId}), converted to: ${sessionId} (type: ${typeof sessionId})`);
    Utils.logDebug(`[registerConnection] Registering socket for session ${sessionId}`);
    this.hostConnections.set(sessionId, socket);
    Utils.logTrace(`[Bridge.registerConnection] Set connection in hostConnections map`);
    Utils.logDebug(`[registerConnection] Registered. Total connections: ${this.hostConnections.size}`);
    Utils.logDebug(`[registerConnection] All keys in hostConnections: [${Array.from(this.hostConnections.keys()).map(k => `${k}(${typeof k})`).join(', ')}]`);
    
    socket.on('close', () => {
      Utils.logTrace(`[Bridge.registerConnection] Socket close event - sessionId=${sessionId}`);
      Utils.logDebug(`[registerConnection] Socket closed for session ${sessionId}`);
      this.hostConnections.delete(sessionId);
      Utils.logTrace(`[Bridge.registerConnection] Connection deleted from hostConnections`);
    });
    
    Utils.logTrace(`[Bridge.registerConnection] COMPLETE - totalConnections=${this.hostConnections.size}`);
  }

  /**
   * Main routing function - handles all message types
   */
  async route(message, context = {}) {
    // Apply current session context from config (unless already in a container context)
    Utils.logDebug(`[Bridge.route] START - context.sessionId: ${context.sessionId} (type: ${typeof context.sessionId}), message.type: ${message.type}`);
    
    if (!context.sessionId || context.sessionId === 0) {
      const configCurrent = globals.getConfig('current');
      Utils.logDebug(`[Bridge.route] Config current value: ${configCurrent} (type: ${typeof configCurrent})`);
      const currentSessionId = parseInt(configCurrent || 0, 10);
      Utils.logDebug(`[Bridge.route] Applying current session context: ${currentSessionId} (converted type: ${typeof currentSessionId})`);
      context = { ...context, sessionId: currentSessionId };
      Utils.logDebug(`[Bridge.route] Updated context.sessionId: ${context.sessionId} (type: ${typeof context.sessionId})`);
    } else {
      Utils.logDebug(`[Bridge.route] Keeping existing context.sessionId: ${context.sessionId} (type: ${typeof context.sessionId})`);
    }

    switch (message.type) {
      case 'tool_call':
        return this.handleToolCall(message, context);
      case 'approval_request':
        return this.handleApprovalRequest(message, context);
      case 'approval_response':
        return this.handleApprovalResponse(message, context);
      case 'question_request':
        return this.handleQuestionRequest(message, context);
      case 'question_response':
        return this.handleQuestionResponse(message, context);
      case 'ai_prompt_request':
        return this.handleAIPromptRequest(message, context);
      case 'command':
        return this.handleCommand(message, context);
      case 'command_response':
        // Response from container back to host for a forwarded command
        // This shouldn't normally reach route() as it should be intercepted by pendingMessages handler
        // But if it does, just return it as-is
        Utils.logDebug(`[Bridge.route] Received command_response with messageId: ${message.messageId}`);
        return message;
      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
  }

  /**
   * Handle tool call execution with state management
   */
  async handleToolCall(message, context = {}) {
    const { toolCallId, toolName, args, sessionId } = message;
    
    // Get or create tool call state (stored in globals)
    let toolCallEntry = globals.toolCallStates.get(toolCallId);
    if (!toolCallEntry) {
      toolCallEntry = {
        status: ToolExecutionStatus.IDLE,
        state: {},
        context: { sessionId, toolCallId }
      };
      globals.toolCallStates.set(toolCallId, toolCallEntry);
    }
    
    // Find tool definition to check requiresHostExecution
    const toolDef = this.findToolDefinition(toolName);
    const requiresHost = toolDef?.metadata?.requiresHostExecution === true;
    
    // Determine execution location
    // If we are in a container, and the tool requires host execution, we must send it to host.
    // If we are ON THE HOST, we should execute it locally.
    
    if (this.isContainer && requiresHost) {
      // Send to host via socket
      return this.sendToHost(message);
    } else {
      // Execute locally - ensure toolCallId and sessionId are in context
      return this.executeToolLocally(toolName, args, {
        ...context,
        sessionId,
        toolCallId,
        state: toolCallEntry.state,
        externalData: toolCallEntry.externalData
      });
    }
  }

  /**
   * Execute tool in current process
   */
  async executeToolLocally(toolName, args, context) {
    const handler = globals.dslRegistry.get(toolName);
    if (!handler) {
      return { 
        status: ToolExecutionStatus.FAILURE, 
        error: `Tool ${toolName} not found` 
      };
    }
    
    try {
      const result = await handler(args, context);
      
      // Tool returns one of:
      // { status: 'running', state: {...} } - continue later
      // { status: 'success', result: string } - done
      // { status: 'failure', error: string } - failed
      
      if (result.status === ToolExecutionStatus.RUNNING) {
        // Save state, don't yield yet
        const toolCallEntry = globals.toolCallStates.get(context.toolCallId);
        if (toolCallEntry) {
          toolCallEntry.state = result.state || toolCallEntry.state;
          toolCallEntry.status = ToolExecutionStatus.RUNNING;
        }
      } else {
        // Cleanup state on completion
        globals.toolCallStates.delete(context.toolCallId);
      }
      
      return result;
    } catch (e) {
      // Unexpected error - cleanup and fail
      globals.toolCallStates.delete(context.toolCallId);
      return {
        status: ToolExecutionStatus.FAILURE,
        error: `Tool execution error: ${e.message}`
      };
    }
  }

  /**
   * Handle approval request (from shell tool)
   */
  async handleApprovalRequest(message, context = {}) {
    Utils.logTrace(`[Bridge.handleApprovalRequest] START - sessionId=${message.sessionId}, toolCallId=${message.toolCallId}`);
    const { sessionId, toolCallId, description, approvalType } = message;
    
    // Store external data for tool call
    Utils.logTrace(`[Bridge.handleApprovalRequest] Looking up toolCallId=${toolCallId} in globals.toolCallStates`);
    const toolCallEntry = globals.toolCallStates.get(toolCallId);
    Utils.logTrace(`[Bridge.handleApprovalRequest] toolCallEntry lookup: ${toolCallEntry ? 'found' : 'not found'}`);
    if (toolCallEntry) {
      Utils.logTrace(`[Bridge.handleApprovalRequest] Setting externalData.awaitingApproval=true`);
      toolCallEntry.externalData = { awaitingApproval: true };
    }
    
    // Pause session
    Utils.logTrace(`[Bridge.handleApprovalRequest] Pausing session ${sessionId}`);
    const transitionResult = SessionModel.transition(sessionId, 'pause');
    Utils.logTrace(`[Bridge.handleApprovalRequest] SessionModel.transition result: ${JSON.stringify(transitionResult)}`);
    
    // CRITICAL: Explicitly save session state to disk before pausing
    // The AgentLoop returns early when paused, so the auto-save won't run
    if (transitionResult.success) {
      Utils.logTrace(`[Bridge.handleApprovalRequest] Saving session to disk`);
      SessionModel.collection.save();
      Utils.logTrace(`[Bridge.handleApprovalRequest] Session saved`);
    }
    
    // Check if we're running inside a container
    // If so, send request to host via socket
    if (this.isContainer) {
      Utils.logTrace(`[Bridge.handleApprovalRequest] Running in container, forwarding to host`);
      // Send to host - host will create approval record and return immediately
      const result = await this.sendToHost({
        type: 'approval_request',
        sessionId,
        toolCallId,
        description,
        approvalType
      });
      Utils.logTrace(`[Bridge.handleApprovalRequest] sendToHost returned: ${JSON.stringify(result)}`);
      return result;
    }
    
    // We're on the host - create approval record and return immediately (non-blocking)
    // Don't wait for human response - that will come via CLI later
    Utils.logTrace(`[Bridge.handleApprovalRequest] On host, creating approval record`);
    Utils.logInfo(`[APPROVAL NEEDED] ${description}`);
    
    try {
      const id = (++globals.humanApprovalsCounter).toString();
      Utils.logTrace(`[Bridge.handleApprovalRequest] Generated approval id=${id}`);
      
      Utils.logTrace(`[Bridge.handleApprovalRequest] Creating ApprovalModel with: id=${id}, sessionId=${sessionId}, toolCallId=${toolCallId}`);
      ApprovalModel.create({
        id,
        sessionId,
        type: approvalType,
        description,
        status: 'pending',
        toolCallId,
        timestamp: new Date().toISOString()
      });
      Utils.logTrace(`[Bridge.handleApprovalRequest] ApprovalModel.create completed`);
      
      // Ring bell if in REPL mode
      if (globals.isRepl) {
        Utils.logTrace(`[Bridge.handleApprovalRequest] In REPL mode, ringing bell`);
        process.stdout.write('\x07');
      }
      
      // Return success immediately - approval will be processed asynchronously
      const result = { 
        success: true, 
        message: `Approval request created (ID: ${id})` 
      };
      Utils.logTrace(`[Bridge.handleApprovalRequest] Returning success: ${JSON.stringify(result)}`);
      return result;
    } catch (e) {
      Utils.logError(`[Bridge.handleApprovalRequest] Failed to create approval: ${e.message}`);
      Utils.logError(e.stack);
      Utils.logTrace(`[Bridge.handleApprovalRequest] ERROR: ${e.message}`);
      return {
        success: false,
        error: `Failed to create approval: ${e.message}`
      };
    }
  }

  /**
   * Handle approval response (resume tool call)
   */
  async handleApprovalResponse(message, context = {}) {
    Utils.logTrace(`[Bridge.handleApprovalResponse] START - message: ${JSON.stringify(message)}, isContainer: ${this.isContainer}`);
    const { toolCallId, choice, explanation, sessionId } = message;
    
    // If we're on the host, forward to container where the tool state lives
    if (!this.isContainer) {
      Utils.logTrace(`[Bridge.handleApprovalResponse] On host, forwarding to container sessionId=${sessionId}`);
      const result = await this.sendToContainer(sessionId, {
        type: 'approval_response',
        toolCallId,
        choice,
        explanation
      });
      Utils.logTrace(`[Bridge.handleApprovalResponse] sendToContainer returned: ${JSON.stringify(result)}`);
      return result;
    }
    
    // We're in the container - update tool state
    Utils.logTrace(`[Bridge.handleApprovalResponse] In container, looking up toolCallId=${toolCallId} in globals.toolCallStates`);
    const toolCallEntry = globals.toolCallStates.get(toolCallId);
    Utils.logTrace(`[Bridge.handleApprovalResponse] toolCallEntry lookup result: ${toolCallEntry ? 'found' : 'NOT FOUND'}`);
    if (!toolCallEntry) {
      Utils.logWarn(`[Bridge.handleApprovalResponse] Tool call ${toolCallId} not found in state map`);
      return;
    }
    
    Utils.logTrace(`[Bridge.handleApprovalResponse] Setting externalData on toolCallEntry: choice=${choice}, explanation=${explanation}`);
    toolCallEntry.externalData = {
      approvalReceived: true,
      choice,
      explanation
    };
    
    // Resume session
    Utils.logTrace(`[Bridge.handleApprovalResponse] Calling SessionModel.transition(${toolCallEntry.context.sessionId}, 'resume')`);
    const result = SessionModel.transition(toolCallEntry.context.sessionId, 'resume');
    Utils.logTrace(`[Bridge.handleApprovalResponse] SessionModel.transition returned: ${JSON.stringify(result)}`);
    if (result.success) {
      Utils.logInfo(`[Bridge.handleApprovalResponse] Session ${sessionId} resumed after approval`);
    }
    
    Utils.logTrace(`[Bridge.handleApprovalResponse] COMPLETE`);
    // Tool will be re-invoked by AgentLoop on next tick
    // It will see externalData and continue from awaiting_approval phase
  }

  /**
   * Handle question request (from human__ask tool)
   */
  async handleQuestionRequest(message, context = {}) {
    Utils.logTrace(`[Bridge.handleQuestionRequest] START - sessionId=${message.sessionId}, toolCallId=${message.toolCallId}`);
    const { sessionId, toolCallId, question } = message;
    
    // Store external data for tool call
    Utils.logTrace(`[Bridge.handleQuestionRequest] Looking up toolCallId=${toolCallId} in globals.toolCallStates`);
    const toolCallEntry = globals.toolCallStates.get(toolCallId);
    Utils.logTrace(`[Bridge.handleQuestionRequest] toolCallEntry lookup: ${toolCallEntry ? 'found' : 'not found'}`);
    if (toolCallEntry) {
      Utils.logTrace(`[Bridge.handleQuestionRequest] Setting externalData.awaitingAnswer=true`);
      toolCallEntry.externalData = { awaitingAnswer: true };
    }
    
    // Pause session
    Utils.logTrace(`[Bridge.handleQuestionRequest] Pausing session ${sessionId}`);
    const transitionResult = SessionModel.transition(sessionId, 'pause');
    Utils.logTrace(`[Bridge.handleQuestionRequest] SessionModel.transition result: ${JSON.stringify(transitionResult)}`);
    
    // CRITICAL: Explicitly save session state to disk before pausing
    // The AgentLoop returns early when paused, so the auto-save won't run
    if (transitionResult.success) {
      Utils.logTrace(`[Bridge.handleQuestionRequest] Saving session to disk`);
      SessionModel.collection.save();
      Utils.logTrace(`[Bridge.handleQuestionRequest] Session saved`);
    }
    
    // Check if we're running inside a container
    // If so, send request to host via socket
    if (this.isContainer) {
      Utils.logTrace(`[Bridge.handleQuestionRequest] Running in container, forwarding to host`);
      // Send to host - host will create question record and return immediately
      const result = await this.sendToHost({
        type: 'question_request',
        sessionId,
        toolCallId,
        question
      });
      Utils.logTrace(`[Bridge.handleQuestionRequest] sendToHost returned: ${JSON.stringify(result)}`);
      return result;
    }
    
    // We're on the host - create question record and return immediately (non-blocking)
    // Don't wait for human response - that will come via CLI later
    Utils.logTrace(`[Bridge.handleQuestionRequest] On host, creating question record`);
    Utils.logInfo(`[HUMAN REQUEST] ${question}`);
    
    try {
      const { QuestionModel } = await import('../../human/models/question.mjs');
      const id = (++globals.humanQuestionsCounter).toString();
      Utils.logTrace(`[Bridge.handleQuestionRequest] Generated question id=${id}`);
      
      Utils.logTrace(`[Bridge.handleQuestionRequest] Creating QuestionModel with: id=${id}, sessionId=${sessionId}, toolCallId=${toolCallId}`);
      QuestionModel.create({
        id,
        question,
        sessionId,
        toolCallId,
        status: 'pending'
      });
      Utils.logTrace(`[Bridge.handleQuestionRequest] QuestionModel.create completed`);
      
      // Ring bell if in REPL mode
      if (globals.isRepl) {
        Utils.logTrace(`[Bridge.handleQuestionRequest] In REPL mode, ringing bell`);
        process.stdout.write('\x07');
      }
      
      // Return success immediately - question will be processed asynchronously
      const result = { 
        success: true, 
        message: `Question created (ID: ${id})` 
      };
      Utils.logTrace(`[Bridge.handleQuestionRequest] Returning success: ${JSON.stringify(result)}`);
      return result;
    } catch (e) {
      Utils.logError(`[Bridge.handleQuestionRequest] Failed to create question: ${e.message}`);
      Utils.logError(e.stack);
      Utils.logTrace(`[Bridge.handleQuestionRequest] ERROR: ${e.message}`);
      return {
        success: false,
        error: `Failed to create question: ${e.message}`
      };
    }
  }

  /**
   * Handle question response (resume tool call with answer)
   */
  async handleQuestionResponse(message, context = {}) {
    Utils.logTrace(`[Bridge.handleQuestionResponse] START - message: ${JSON.stringify(message)}, isContainer: ${this.isContainer}`);
    const { toolCallId, answer, sessionId } = message;
    
    // If we're on the host, forward to container where the tool state lives
    if (!this.isContainer) {
      Utils.logTrace(`[Bridge.handleQuestionResponse] On host, forwarding to container sessionId=${sessionId}`);
      const result = await this.sendToContainer(sessionId, {
        type: 'question_response',
        toolCallId,
        answer
      });
      Utils.logTrace(`[Bridge.handleQuestionResponse] sendToContainer returned: ${JSON.stringify(result)}`);
      return result;
    }
    
    // We're in the container - update tool state
    Utils.logTrace(`[Bridge.handleQuestionResponse] In container, looking up toolCallId=${toolCallId} in globals.toolCallStates`);
    const toolCallEntry = globals.toolCallStates.get(toolCallId);
    Utils.logTrace(`[Bridge.handleQuestionResponse] toolCallEntry lookup result: ${toolCallEntry ? 'found' : 'NOT FOUND'}`);
    if (!toolCallEntry) {
      Utils.logWarn(`[Bridge.handleQuestionResponse] Tool call ${toolCallId} not found in state map`);
      return;
    }
    
    Utils.logTrace(`[Bridge.handleQuestionResponse] Setting externalData on toolCallEntry: answer=${answer}`);
    toolCallEntry.externalData = {
      answerReceived: true,
      answer
    };
    
    // Add tool result message to session before resuming
    // This ensures the agent sees the answer in the message history
    Utils.logTrace(`[Bridge.handleQuestionResponse] Adding tool result message to session`);
    try {
      const sess = SessionModel.load(toolCallEntry.context.sessionId);
      if (sess) {
        sess.spec.messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          name: 'human__ask',
          content: answer,
          timestamp: new Date().toISOString()
        });
        SessionModel.save(toolCallEntry.context.sessionId, sess);
        Utils.logTrace(`[Bridge.handleQuestionResponse] Tool result message added and session saved`);
      }
    } catch (e) {
      Utils.logWarn(`[Bridge.handleQuestionResponse] Failed to add tool result message: ${e.message}`);
    }
    
    // Resume session
    Utils.logTrace(`[Bridge.handleQuestionResponse] Calling SessionModel.transition(${toolCallEntry.context.sessionId}, 'resume')`);
    const result = SessionModel.transition(toolCallEntry.context.sessionId, 'resume');
    Utils.logTrace(`[Bridge.handleQuestionResponse] SessionModel.transition returned: ${JSON.stringify(result)}`);
    if (result.success) {
      Utils.logInfo(`[Bridge.handleQuestionResponse] Session ${sessionId} resumed after question answer`);
    }
    
    Utils.logTrace(`[Bridge.handleQuestionResponse] COMPLETE`);
  }


  async handleAIPromptRequest(message, context = {}) {
    const { provider: providerName, model, messages, tools } = message;
    Utils.logTrace(`[Bridge.handleAIPromptRequest] Received request. Provider: ${providerName}, Model: ${model}`);
    
    // Import providers (lazy load)
    const { XAIProvider } = await import('../models/providers/xai.mjs');
    const { CopilotProvider } = await import('../models/providers/copilot.mjs');
    const { GeminiProvider } = await import('../models/providers/gemini.mjs');
    const { OllamaProvider } = await import('../models/providers/ollama.mjs');
    
    let provider;
    switch (providerName.toLowerCase()) {
      case 'xai': provider = new XAIProvider(); break;
      case 'copilot': provider = new CopilotProvider(); break;
      case 'gemini': provider = new GeminiProvider(); break;
      case 'ollama': provider = new OllamaProvider(); break;
      default: throw new Error(`Unknown provider: ${providerName}`);
    }
    
    try {
      Utils.logTrace(`[Bridge.handleAIPromptRequest] Calling provider.createChatCompletion`);
      const result = await provider.createChatCompletion({ model, messages, tools });
      Utils.logTrace(`[Bridge.handleAIPromptRequest] Provider success`);
      return { success: true, data: result };
    } catch (e) {
      Utils.logTrace(`[Bridge.handleAIPromptRequest] Provider failed: ${e.message}`);
      Utils.logError(`[Bridge] AI prompt failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /**
   * Handle command execution
   */
  async handleCommand(message, context = {}) {
    const { command, waitForResponse } = message;
    // Add procId to context for output filtering
    if (message.procId) {
      context.procId = message.procId;
    }
    Utils.logDebug(`[handleCommand] START - context.sessionId: ${context.sessionId} (type: ${typeof context.sessionId}), context.procId: ${context.procId}, context keys: [${Object.keys(context).join(', ')}]`);
    let currentSessionId = parseInt(context.sessionId || 0, 10);
    Utils.logDebug(`[handleCommand] Converted sessionId to: ${currentSessionId} (type: ${typeof currentSessionId})`);
    
    Utils.logDebug(`[handleCommand] Received command: "${command}" in session context: ${currentSessionId}, fromHost: ${message.fromHost}`);
    
    // Parse command to determine if it needs container routing
    const parsed = Utils.parseDSL(command);
    if (!parsed) {
      Utils.logDebug(`[handleCommand] Failed to parse DSL: "${command}"`);
      return { success: false, error: 'Invalid command' };
    }

    // Use centralized command resolution
    const resolved = this.resolveCommand(command);
    if (resolved.error) {
      Utils.logDebug(`[handleCommand] Command resolution failed: ${resolved.error}`);
      return { success: false, error: resolved.error };
    }

    let cmd = resolved.cmd;
    let args = resolved.args;
    const toolDef = resolved.toolDef;
    const isLocalCmd = toolDef?.metadata?.localCommand === true;
    
    if (isLocalCmd) {
      Utils.logDebug(`[handleCommand] "${cmd}" is a local command (metadata.localCommand=true) - forcing host execution (session=0)`);
      currentSessionId = 0; // Force host execution for local commands
    }

    // Check if tool requires host execution
    const requiresHost = toolDef?.metadata?.requiresHostExecution === true;
    Utils.logDebug(`[handleCommand] Tool "${cmd}" - requiresHost: ${requiresHost}`);
    
    // If session ID is non-zero and tool doesn't require host, forward to container
    // UNLESS this command is coming FROM the host (fromHost=true) - in that case execute locally in the container
    Utils.logDebug(`[handleCommand] Decision point: currentSessionId=${currentSessionId}, requiresHost=${requiresHost}, fromHost=${message.fromHost}, should forward=${currentSessionId !== 0 && !requiresHost && !message.fromHost}`);
    if (currentSessionId !== 0 && !requiresHost && !message.fromHost) {
      Utils.logDebug(`[handleCommand] Forwarding to container - sessionId: ${currentSessionId}, tool: "${cmd}"`);
      // Forward command to the container via its existing socket connection
      return this.forwardToContainer(currentSessionId, message);
    }

    Utils.logDebug(`[handleCommand] Executing locally on host - sessionId: ${currentSessionId}, tool: "${cmd}", fromHost: ${message.fromHost}`);

    // Otherwise execute locally via DSL registry
    // For commands from host, capture output and send response back
    if (message.fromHost) {
      Utils.logDebug(`[handleCommand] Executing fromHost - need to send response back via socket`);
      return new Promise(async (resolve) => {
        const outputBuffer = [];
        const logListener = (log) => {
          outputBuffer.push(log.message);
        };
        Utils.addLogListener(logListener);
        
        try {
          const handler = globals.dslRegistry.get(cmd);
          if (!handler) {
            Utils.logDebug(`[handleCommand] Handler not found for "${cmd}"`);
            const response = {
              messageId: message.messageId,
              success: false,
              error: `Tool ${cmd} not found`,
              type: 'command_response'
            };
            
            if (this.containerSocket) {
              Utils.logDebug(`[handleCommand] Sending error response via containerSocket`);
              this.containerSocket.write(JSON.stringify(response) + '\n');
            }
            resolve(response);
            return;
          }

          Utils.logDebug(`[handleCommand] Executing handler for "${cmd}"`);
          const handlerContext = { sessionId: currentSessionId, procId: context.procId };
          
          // Set global request context for output filtering
          globals.currentRequestContext.procId = context.procId || null;
          
          const result = await handler(args, handlerContext);
          const output = outputBuffer.join('\n');
          Utils.logTrace(`[handleCommand] Handler result details: type=${typeof result}, value=${JSON.stringify(result)}, output=${output}`);
          Utils.logDebug(`[handleCommand] Handler completed - result type: ${typeof result}, has status: ${result?.status ? 'yes' : 'no'}`);
          
          // Determine success: if result has explicit status, use it; otherwise treat as success if result is truthy or we have output
          let success = false;
          let resultContent = '';
          
          Utils.logTrace(`[handleCommand] Starting success determination logic`);
          
          if (result?.status === ToolExecutionStatus.SUCCESS || result?.status === 'success') {
            Utils.logTrace(`[handleCommand] Match: explicit SUCCESS status`);
            success = true;
            resultContent = result?.result || output;
          } else if (result?.status === ToolExecutionStatus.FAILURE || result?.status === 'error') {
            Utils.logTrace(`[handleCommand] Match: explicit ERROR status`);
            success = false;
            resultContent = result?.result || result?.error || output;
          } else {
            // Fallback for tools not yet migrated (if any remain) or simple return values
            // We default to FAILURE if no status is returned to enforce the new pattern
            Utils.logTrace(`[handleCommand] Match: no explicit status - defaulting to FAILURE (strict mode)`);
            success = false;
            resultContent = output || "Tool execution failed: No status returned";
          }
          
          Utils.logTrace(`[handleCommand] Final decision: success=${success}, resultContent length=${(resultContent || '').length}`);
          
          const response = {
            messageId: message.messageId,
            success,
            result: resultContent,
            error: result?.error,
            type: 'command_response'
          };
          
          // Send response back to host via container socket
          if (this.containerSocket) {
            Utils.logDebug(`[handleCommand] Sending response via containerSocket - success: ${response.success}`);
            this.containerSocket.write(JSON.stringify(response) + '\n');
          } else {
            Utils.logDebug(`[handleCommand] No containerSocket available to send response`);
          }
          
          resolve(response);
        } catch (e) {
          Utils.logError(`[handleCommand] Exception during execution: ${e.message}`);
          const response = {
            messageId: message.messageId,
            success: false,
            error: e.message,
            type: 'command_response'
          };
          
          if (this.containerSocket) {
            this.containerSocket.write(JSON.stringify(response) + '\n');
          }
          
          resolve(response);
        } finally {
          Utils.removeLogListener(logListener);
          // Clear request context
          globals.currentRequestContext.procId = null;
        }
      });
    }
    
    // For local commands (not from host)
    if (waitForResponse) {
      Utils.logDebug(`[handleCommand] Local command with waitForResponse - enqueueing: "${command}", requestId: ${message.requestId}`);
      // Store requestId mapping for this command
      if (message.requestId) {
        this.requestIdMap.set(command, message.requestId);
        Utils.logDebug(`[handleCommand] Stored requestId mapping: ${command} -> ${message.requestId}`);
      }
      return new Promise((resolve) => {
        const handler = (event) => {
          Utils.logDebug(`[handleCommand:eventHandler] Received commandProcessed event: command=${event.command}, requestId=${event.requestId}, success=${event.success}`);
          // Match by requestId if present, otherwise match by command string
          const matches = message.requestId 
            ? event.requestId === message.requestId
            : event.command === command;
          
          Utils.logDebug(`[handleCommand:eventHandler] Checking match: requestId match=${message.requestId ? event.requestId === message.requestId : 'N/A'}, command match=${event.command === command}`);
          
          if (matches) {
            Utils.logDebug(`[handleCommand:eventHandler] Match found! Resolving promise with output: ${event.output?.substring(0, 100)}`);
            globals.eventBus.off('commandProcessed', handler);
            // Clean up requestId mapping
            if (message.requestId) {
              this.requestIdMap.delete(command);
              Utils.logDebug(`[handleCommand:eventHandler] Cleaned up requestId mapping for: ${command}`);
            }
            const responseObj = {
              success: event.success,
              output: event.output || 'Command completed',
              result: event.result, // Pass result through
              error: event.error?.message,
              requestId: message.requestId
            };
            Utils.logDebug(`[handleCommand:eventHandler] Response object: ${JSON.stringify(responseObj)}`);
            resolve(responseObj);
          }
        };
        globals.eventBus.on('commandProcessed', handler);
        // Enqueue with procId metadata for output filtering
        globals.enqueueCommand(command, { procId: context.procId });
      });
    } else {
      Utils.logDebug(`[handleCommand] Local command without waitForResponse - enqueueing: "${command}"`);
      // Enqueue with procId metadata for output filtering
      globals.enqueueCommand(command, { procId: context.procId });
      return { success: true };
    }
  }

  /**
   * Forward command to container via existing socket connection
   */
  async forwardToContainer(sessionId, message) {
    // Ensure sessionId is a number for consistent map key lookup
    const originalSessionId = sessionId;
    sessionId = parseInt(sessionId, 10);
    Utils.logDebug(`[forwardToContainer] Received sessionId: ${originalSessionId} (type: ${typeof originalSessionId}), converted to: ${sessionId} (type: ${typeof sessionId})`);
    Utils.logDebug(`[forwardToContainer] Checking for session ${sessionId} connection. Active connections: ${this.hostConnections.size}`);
    Utils.logDebug(`[forwardToContainer] Connection keys: [${Array.from(this.hostConnections.keys()).map(k => `${k}(${typeof k})`).join(', ')}]`);
    
    const socket = this.hostConnections.get(sessionId);
    if (!socket) {
      Utils.logError(`[forwardToContainer] No socket connection found for session ${sessionId}`);
      return { success: false, error: `No connection for session ${sessionId}` };
    }

    Utils.logDebug(`[forwardToContainer] Found socket for session ${sessionId}, forwarding command`);

    return new Promise((resolve, reject) => {
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      Utils.logDebug(`[forwardToContainer] Created messageId: ${messageId}`);
      
      const timeout = setTimeout(() => {
        this.pendingMessages.delete(messageId);
        Utils.logError(`[forwardToContainer] Timeout waiting for response from session ${sessionId}`);
        reject({ success: false, error: 'Container command timeout' });
      }, 5000);

      this.pendingMessages.set(messageId, {
        resolve: (response) => {
          Utils.logDebug(`[forwardToContainer] Received response for messageId: ${messageId}`);
          Utils.logDebug(`[forwardToContainer:resolve] Response before adding requestId: ${JSON.stringify(response)}`);
          clearTimeout(timeout);
          // Add requestId to response if it was in the original message
          if (message.requestId && !response.requestId) {
            response.requestId = message.requestId;
            Utils.logDebug(`[forwardToContainer:resolve] Added requestId to response: ${message.requestId}`);
          }
          Utils.logDebug(`[forwardToContainer:resolve] Response after adding requestId: ${JSON.stringify(response)}`);
          resolve(response);
        },
        timeout
      });

      try {
        // Send command with messageId for response tracking
        const payload = JSON.stringify({ 
          ...message, 
          messageId,
          type: 'command',
          fromHost: true
        });
        Utils.logDebug(`[forwardToContainer] Sending to container: ${payload.substring(0, 100)}...`);
        const writeResult = socket.write(payload + '\n');
        Utils.logDebug(`[forwardToContainer] Write result: ${writeResult}, socket writable: ${socket.writable}, socket destroyed: ${socket.destroyed}`);
      } catch (e) {
        this.pendingMessages.delete(messageId);
        clearTimeout(timeout);
        Utils.logError(`[forwardToContainer] Failed to send to container: ${e.message}`);
        reject({ success: false, error: `Failed to send to container: ${e.message}` });
      }
    });
  }

  /**
   * Find tool definition from plugin registry
   */
  findToolDefinition(toolName) {
    for (const plugin of globals.pluginsRegistry.values()) {
      const def = plugin.definition;
      if (Array.isArray(def)) {
        const toolDef = def.find(t => t.function.name === toolName);
        if (toolDef) return toolDef;
      }
    }
    return null;
  }

  /**
   * Centralized command resolution - single source of truth for all command dispatch
   * 
   * Resolution order:
   * 1. Parse DSL command string (e.g. "shell exec cat /etc/hostname")
   * 2. Try alias functions from plugin definitions (metadata.alias)
   * 3. Try underscore fallback (shell exec → shell__execute)
   * 4. Return resolved command with handler and metadata
   * 
   * @param {string} cmdString - Raw command string
   * @returns {object|object} { cmd: string, args: array, toolDef: object|null, handler: function|null, error?: string }
   */
  resolveCommand(cmdString) {
    // Parse DSL
    const parsed = Utils.parseDSL(cmdString);
    if (!parsed) {
      Utils.logDebug(`[resolveCommand] Failed to parse DSL: "${cmdString}"`);
      return { error: 'Invalid command syntax', cmd: null, args: null, toolDef: null, handler: null };
    }

    let { command: cmd, args } = parsed;
    Utils.logDebug(`[resolveCommand] Parsed DSL - command: "${cmd}", args: [${args.join(', ')}]`);

    // Step 1: Try alias functions (preferred over underscore fallback)
    const allParts = [cmd, ...args];
    Utils.logDebug(`[resolveCommand] Attempting alias resolution with allParts: [${allParts.join(', ')}]`);
    let aliasFound = false;

    for (const plugin of globals.pluginsRegistry.values()) {
      const def = plugin.definition;
      if (!Array.isArray(def)) continue;

      for (const tool of def) {
        const alias = tool.metadata?.alias;
        if (typeof alias === 'function') {
          const result = alias(allParts);
          if (result && typeof result === 'object' && result.name) {
            // Keep args as-is (may be object with named args or array)
            Utils.logDebug(`[resolveCommand] Alias resolved to: "${result.name}", args: [${Array.isArray(result.args) ? result.args.join(', ') : JSON.stringify(result.args)}]`);
            cmd = result.name;
            args = result.args;
            aliasFound = true;
            break;
          }
        }
      }
      if (aliasFound || globals.dslRegistry.has(cmd)) {
        Utils.logDebug(`[resolveCommand] Alias resolution complete or found in registry`);
        break;
      }
    }

    // Step 2: Try underscore fallback if not found in registry yet
    // (Only if args is an array - if it's an object from an alias, we skip this)
    if (!globals.dslRegistry.has(cmd) && Array.isArray(args) && args.length > 0) {
      Utils.logDebug(`[resolveCommand] Cmd not in registry, attempting underscore fallback...`);
      let currentCmd = cmd;
      let currentArgs = [...args];
      let attempts = 0;

      while (currentArgs.length > 0) {
        const nextPart = currentArgs.shift();
        currentCmd = `${currentCmd}__${nextPart}`;
        attempts++;
        Utils.logDebug(`[resolveCommand] Fallback attempt ${attempts}: trying "${currentCmd}"`);

        if (globals.dslRegistry.has(currentCmd)) {
          Utils.logDebug(`[resolveCommand] Fallback resolved to: "${currentCmd}", remaining args: [${currentArgs.join(', ')}]`);
          cmd = currentCmd;
          args = currentArgs;
          break;
        }
      }
    }

    // Step 3: Look up handler and tool definition
    const handler = globals.dslRegistry.has(cmd) ? globals.dslRegistry.get(cmd) : null;
    const toolDef = this.findToolDefinition(cmd);

    const argsStr = Array.isArray(args) ? `[${args.join(', ')}]` : JSON.stringify(args);
    Utils.logDebug(`[resolveCommand] Final result - cmd: "${cmd}", args: ${argsStr}, found in registry: ${!!handler}, has toolDef: ${!!toolDef}`);

    return {
      cmd,
      args,
      handler,
      toolDef,
      error: !handler ? `Command not found: ${cmd}` : null
    };
  }

  /**
   * Send message to host (from container)
   */
  async sendToHost(message) {
    if (!this.containerSocket) {
      // Try to reconnect or fail
      throw new Error('Not connected to host');
    }
    
    return new Promise((resolve, reject) => {
      const messageId = ++this.messageCounter;
      const timeout = setTimeout(() => {
        this.pendingMessages.delete(messageId);
        Utils.logError(`[Bridge] Timeout waiting for response to messageId=${messageId}`);
        reject(new Error('Socket timeout (5s)'));
      }, 5000);
      
      this.pendingMessages.set(messageId, { resolve, reject, timeout });
      
      const request = {
        ...message,
        messageId
      };
      
      this.containerSocket.write(JSON.stringify(request) + '\n');
    });
  }

  /**
   * Send message to container (from host)
   */
  async sendToContainer(sessionId, message) {
    Utils.logTrace(`[Bridge.sendToContainer] START - sessionId=${sessionId} (type: ${typeof sessionId}), message.type=${message.type}`);
    Utils.logTrace(`[Bridge.sendToContainer] hostConnections map size: ${this.hostConnections.size}, keys: ${Array.from(this.hostConnections.keys()).map(k => `${k}(${typeof k})`)}`);
    
    // Normalize sessionId to number for consistent lookup
    const normalizedSessionId = parseInt(sessionId, 10);
    Utils.logTrace(`[Bridge.sendToContainer] Normalized sessionId to: ${normalizedSessionId} (type: ${typeof normalizedSessionId})`);
    
    const socket = this.hostConnections.get(normalizedSessionId);
    Utils.logTrace(`[Bridge.sendToContainer] Socket lookup for sessionId=${normalizedSessionId}: ${socket ? 'FOUND' : 'NOT FOUND'}`);
    if (!socket) {
      Utils.logTrace(`[Bridge.sendToContainer] ERROR: No connection for session ${normalizedSessionId}`);
      throw new Error(`No connection for session ${sessionId}`);
    }
    
    Utils.logTrace(`[Bridge.sendToContainer] Writing message to socket: ${JSON.stringify(message)}`);
    socket.write(JSON.stringify(message) + '\n');
    Utils.logTrace(`[Bridge.sendToContainer] Message written, returning success`);
    return { success: true };
  }

  /**
   * Get socket path for container
   */
  getContainerSocketPath(sessionId) {
    // Container sees socket at db/sockets/{sessionId}.sock (relative to /app mount)
    // Host sees socket at db/workspaces/{sessionId}/db/sockets/{sessionId}.sock
    if (this.isContainer) {
      return `./db/sockets/${sessionId}.sock`;
    }
    return path.join(globals.dbPaths.workspaces, sessionId, `db/sockets/${sessionId}.sock`);
  }

  /**
   * Get session ID from process arguments (for containers)
   */
  getSessionIdFromArgs() {
    const sessionArgIndex = process.argv.indexOf('--session');
    if (sessionArgIndex !== -1 && process.argv[sessionArgIndex + 1]) {
      return process.argv[sessionArgIndex + 1];
    }
    return null;
  }

  /**
   * Create socket server for this session
   */
  createServerSocket(sessionId, socketPath) {
    // Ensure directory exists
    const dir = socketPath.substring(0, socketPath.lastIndexOf('/'));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Remove existing socket if present
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
    
    const server = net.createServer((socket) => {
      socket.on('data', async (data) => {
        try {
          const message = JSON.parse(data.toString().trim());
          
          // Route message through bridge
          const result = await this.route(message, { sessionId });
          
          // Send response back
          socket.write(JSON.stringify(result) + '\n');
          socket.end();
        } catch (e) {
          Utils.logError(`[Bridge] Socket error: ${e.message}`);
          socket.write(JSON.stringify({ success: false, error: e.message }) + '\n');
          socket.end();
        }
      });
      
      socket.on('error', (err) => {
        Utils.logError(`[Bridge] Socket error: ${err.message}`);
      });
    });
    
    server.listen(socketPath, () => {
    });
    
    this.socketServers.set(sessionId, server);
    
    return server;
  }

  /**
   * Close socket server for session
   */
  closeServerSocket(sessionId) {
    const server = this.socketServers.get(sessionId);
    if (server) {
      server.close();
      this.socketServers.delete(sessionId);
      
      // Remove socket file
      const socketPath = this.getContainerSocketPath(sessionId);
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    }
  }
}

// Export singleton instance
export const bridge = new Bridge();
