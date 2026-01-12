import { globals } from '../../../common/globals.mjs';
import { Utils } from '../../../common/utils.mjs';
import { SessionModel, SessionState } from '../models/session.mjs';
import { RemoteProvider } from '../models/providers/remote.mjs';
import { bridge, ToolExecutionStatus } from './host-container-bridge.mjs';
import net from 'net';
import fs from 'fs';
import ejs from 'ejs';
import os from 'os';

export class AgentLoop {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.isRunning = false;
    this.provider = null;
    this.currentAbortController = null;
    
    // Build tool metadata map (which tools need socket routing)
    this.toolMetadata = new Map();
    
    // Track attempted AI prompts to prevent infinite retry loops
    // Key: JSON.stringify([messageCount, lastMessageContent])
    this.attemptedPrompts = new Set();

    // Track if we've evaluated system_prompt in container context
    this.systemPromptEvaluated = false;

    // Signal handlers for interruption
    process.on('SIGUSR1', this.handlePause.bind(this));
    process.on('SIGUSR2', this.handleStop.bind(this));
  }



  handlePause() {
      Utils.logInfo('Received SIGUSR1 (Pause)');
      // Transition to paused state
      SessionModel.transition(this.sessionId, 'pause');
      // Cancel any local abort controller
      if (this.currentAbortController) {
          this.currentAbortController.abort();
      }
      // Note: Socket tool calls are aborted by the main loop when it processes the pause command
  }

  handleStop() {
      Utils.logInfo('Received SIGUSR2 (Stop)');
      // Transition to stopped state
      SessionModel.transition(this.sessionId, 'stop');
      this.isRunning = false;
      // Cancel any local abort controller
      if (this.currentAbortController) {
          this.currentAbortController.abort();
      }
      // Note: Socket tool calls are aborted by the main loop when it processes the stop command
  }

  /**
   * Evaluate system_prompt EJS template in container context
   * Called once on first start to ensure template variables reflect container environment
   * @param {object} session - Session object
   * @returns {boolean} true if evaluation was performed, false if already evaluated
   */
  evaluateSystemPromptInContainer(session) {
    if (!session?.spec?.system_prompt) {
      return false;
    }

    // Skip if no EJS markers found (optimization)
    if (!session.spec.system_prompt.includes('<%')) {
      Utils.logTrace(`[agent-loop] No EJS markers in system_prompt, skipping evaluation`);
      return false;
    }

    try {
      Utils.logTrace(`[agent-loop] Evaluating system_prompt EJS template in container context`);
      const evaluatedPrompt = ejs.render(session.spec.system_prompt, { os, process });
      
      // Update in-memory session
      session.spec.system_prompt = evaluatedPrompt;
      
      // Persist to disk via collection
      SessionModel.collection.set(this.sessionId, session);
      SessionModel.collection.save();
      
      Utils.logTrace(`[agent-loop] System_prompt evaluated and persisted`);
      return true;
    } catch (e) {
      Utils.logError(`[agent-loop] Failed to evaluate system_prompt: ${e.message}`);
      return false;
    }
  }

  async start() {
    try {
      this.isRunning = true;
      Utils.logTrace(`[agent-loop.mjs] [TRACE] ${new Date().toISOString()} AgentLoop.start called for session ${this.sessionId}`);
      Utils.logDebug(`[agent-loop.start] Starting agent loop - sessionId: ${this.sessionId} (type: ${typeof this.sessionId})`);
      
      // Connect to host socket
      Utils.logDebug(`[agent-loop.start] About to call bridge.connectToHost() with sessionId: ${this.sessionId}`);
      await bridge.connectToHost(this.sessionId);
      Utils.logDebug(`[agent-loop.start] bridge.connectToHost() completed successfully`);

      // Transition from pending to running
      SessionModel.transition(this.sessionId, 'start');
      Utils.logDebug(`[agent-loop.start] Session transitioned to running`);
      
      // Evaluate system_prompt EJS template in container context (once on first start)
      if (!this.systemPromptEvaluated) {
        const session = SessionModel.load(this.sessionId);
        if (session) {
          this.evaluateSystemPromptInContainer(session);
          this.systemPromptEvaluated = true;
        }
      }
      
      while (this.isRunning) {
        try {
          await this.tick();
        } catch (e) {
          Utils.logError(`Agent Loop Error: ${e.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2s
      }
    } catch (e) {
      Utils.logError(`Failed to start Agent Loop: ${e.message}`);
      Utils.logError(e.stack);
    }
  }

  stop() {
    this.isRunning = false;
    SessionModel.transition(this.sessionId, 'stop');
  }

  async tick() {
    // Force reload to pick up new messages from disk
    SessionModel.collection.loadAll();
    const session = SessionModel.load(this.sessionId);
    if (!session) {
        Utils.logError(`Session ${this.sessionId} not found`);
        this.stop();
        return;
    }

    const status = session.metadata?.status;
    
    // Handle FSM states
    if (status === SessionState.PAUSED) return;
    if (status === SessionState.PENDING) {
        Utils.logInfo(`Auto-starting pending session ${this.sessionId}`);
        SessionModel.transition(this.sessionId, 'start');
        return;
    }
    if (status === SessionState.STOPPED) {
        this.isRunning = false;
        return;
    }
    if (status === SessionState.SUCCESS || status === SessionState.ERROR) {
        this.isRunning = false;
        return;
    }

    // Check if last message is from user
    const messages = session.spec.messages || [];
    if (messages.length === 0) return;

    const lastMessage = messages[messages.length - 1];
    
    // Check if we have pending tool calls from the last assistant message
    // This happens when a tool returns RUNNING (e.g. awaiting approval)
    // In that case, we didn't add a tool message yet, so the last message is still the assistant message
    let pendingToolCalls = [];
    if (lastMessage.role === 'assistant' && lastMessage.tool_calls) {
        pendingToolCalls = lastMessage.tool_calls;
    }

    // Only respond to user messages, tool outputs, or pending tool calls
    if (lastMessage.role === 'user' || lastMessage.role === 'tool' || pendingToolCalls.length > 0) {
        if (lastMessage.role === 'user') {
            Utils.logInfo(`[Session ${this.sessionId}] User Request: ${lastMessage.content}`);
        } else if (lastMessage.role === 'tool') {
            Utils.logDebug(`[Session ${this.sessionId}] Processing tool output`);
        } else if (pendingToolCalls.length > 0) {
            Utils.logDebug(`[Session ${this.sessionId}] Resuming pending tool calls`);
        }
        
        const modelStr = session.metadata?.model;
        if (!modelStr) {
            Utils.logError(`[Session ${this.sessionId}] No model configured`);
            return;
        }
        
        // Handle model strings with multiple colons (e.g. ollama:qwen3:8b)
        let providerName, modelName;
        if (modelStr.includes(':')) {
            const parts = modelStr.split(':');
            providerName = parts[0];
            modelName = parts.slice(1).join(':');
        } else {
            Utils.logError(`[Session ${this.sessionId}] Invalid model format: ${modelStr}. Expected provider:model`);
            return;
        }

        // Initialize provider if needed
        if (!this.provider) {
            // Always use RemoteProvider inside the container
            this.provider = new RemoteProvider(providerName);
        }

        // Gather tools and build metadata map
        // Filter to only tools allowed by session metadata
        // Also filter out humanOnly tools (those are for CLI use only)
        const allowedTools = new Set();
        const toolOverrides = new Map();
        
        const sessionTools = session.metadata?.tools || [];
        for (const item of sessionTools) {
            if (typeof item === 'string') {
                allowedTools.add(item);
            } else if (typeof item === 'object') {
                const name = Object.keys(item)[0];
                allowedTools.add(name);
                toolOverrides.set(name, item[name]);
            }
        }

        const tools = [];
        this.toolMetadata.clear();
        for (const plugin of globals.pluginsRegistry.values()) {
            const def = plugin.definition;
            if (Array.isArray(def)) {
                for (const tool of def) {
                    const toolName = tool.function.name;
                    
                    // Skip tools not in the allowed list (if list is specified)
                    if (allowedTools.size > 0 && !allowedTools.has(toolName)) {
                        continue;
                    }
                    
                    // Deny humanOnly tools - these are for CLI/human use only
                    if (tool.metadata?.humanOnly || globals.humanOnlyTools.has(toolName)) {
                        Utils.logDebug(`Denying humanOnly tool: ${toolName}`);
                        continue;
                    }
                    
                    // Store metadata for later use
                    let effectiveMetadata = tool.metadata || {};
                    
                    // Apply overrides
                    const overrides = toolOverrides.get(toolName);
                    if (overrides) {
                        // Handle object format (e.g. { exec_on: 'host_danger' })
                        if (!Array.isArray(overrides) && typeof overrides === 'object') {
                            if (overrides.exec_on === 'host_danger') {
                                effectiveMetadata = { ...effectiveMetadata, requiresHostExecution: true };
                            }
                        }
                    }

                    if (Object.keys(effectiveMetadata).length > 0) {
                        this.toolMetadata.set(toolName, effectiveMetadata);
                    }

                    // Strip metadata before sending to AI (OpenAI schema compliance)
                    const cleanTool = {
                        type: tool.type,
                        function: tool.function
                    };
                    tools.push(cleanTool);
                }
            }
        }

        // Build messages array with system prompt first
        const chatMessages = [];
        if (session.spec.system_prompt) {
            chatMessages.push({ role: 'system', content: session.spec.system_prompt });
        }
        chatMessages.push(...messages);

        let combinedMessage;

        // If we have pending tool calls, skip AI generation and use the last message
        if (pendingToolCalls.length > 0) {
            combinedMessage = lastMessage;
            // We don't need to push it to messages again, it's already there
        } else {
            // Normal flow: Call AI
            // Check if we've already attempted this exact prompt (prevent infinite retry loop)
            // Use session ID + message count as key (simpler and more reliable)
            const promptKey = `${this.sessionId}:${messages.length}`;
            if (this.attemptedPrompts.has(promptKey)) {
                Utils.logWarn(`[Session ${this.sessionId}] Skipping duplicate AI prompt attempt (already failed once for message index ${messages.length})`);
                return; // Skip this tick, don't retry endlessly
            }

            let response;
            try {
                Utils.logTrace(`[agent-loop.mjs] [TRACE] ${new Date().toISOString()} Calling provider.createChatCompletion for model: ${modelName}`);
                response = await this.provider.createChatCompletion({
                    model: modelName,
                    messages: chatMessages,
                    tools: tools.length > 0 ? tools : undefined
                });
                Utils.logTrace(`[AgentLoop] Provider returned response: ${JSON.stringify(response ? 'success' : 'empty')}`);
                
                // Capture usage metrics
                if (response.usage) {
                    session.metadata.usage = {
                        ...response.usage,
                        timestamp: new Date().toISOString(),
                        model: modelName
                    };
                }

                // Success - clear the attempted prompts set (allow retries after process restart)
                this.attemptedPrompts.clear();
            } catch (e) {
                Utils.logTrace(`[AgentLoop] Provider failed: ${e.message}`);
                // Mark this prompt as attempted to prevent infinite retry
                this.attemptedPrompts.add(promptKey);
                Utils.logError(`[Session ${this.sessionId}] AI prompt failed: ${e.message}`);
                throw e; // Re-throw to trigger error handling in tick()
            }
            
            // Process ALL choices (some providers like Copilot/Claude split content and tool_calls)
            // Collect all messages and tool_calls from all choices
            combinedMessage = { role: 'assistant', content: '', tool_calls: [] };
            let finishReason = 'stop';
            
            for (const choice of response.choices) {
                if (choice.message.content) {
                    combinedMessage.content += choice.message.content;
                }
                if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
                    combinedMessage.tool_calls.push(...choice.message.tool_calls);
                }
                // Use 'tool_calls' finish_reason if any choice has it
                if (choice.finish_reason === 'tool_calls') {
                    finishReason = 'tool_calls';
                }
            }
            
            combinedMessage.timestamp = new Date().toISOString();
            combinedMessage.finish_reason = finishReason;

            if (combinedMessage.content) {
                Utils.logInfo(`[Session ${this.sessionId}] Agent Response: ${combinedMessage.content}`);
            }
        }
        
        // Handle Tool Calls
        if (combinedMessage.tool_calls && combinedMessage.tool_calls.length > 0) {
             // Only push to messages if it's a new message (not pending resumption)
             if (pendingToolCalls.length === 0) {
                 session.spec.messages.push(combinedMessage);
                 SessionModel.save(this.sessionId, session);
                 SessionModel.collection.save();
             }
             
             // Process all tool calls (may have parallel executions with some awaiting events)
             for (const toolCall of combinedMessage.tool_calls) {
                 const { function: { name, arguments: argsStr }, id } = toolCall;
                 Utils.logInfo(`[Session ${this.sessionId}] Tool Call: ${name} ${argsStr}`);
                 
                 let cmdArgs;
                 try {
                     cmdArgs = JSON.parse(argsStr);
                 } catch (e) {
                     cmdArgs = {};
                 }

                 this.currentAbortController = new AbortController();
                 let toolResult;
                 try {
                     // Route tool call through bridge (handles stateful execution and host routing)
                     toolResult = await bridge.route({
                         type: 'tool_call',
                         toolCallId: id,
                         toolName: name,
                         args: cmdArgs,
                         sessionId: this.sessionId
                     }, {
                         signal: this.currentAbortController.signal,
                         sessionId: this.sessionId,
                         toolCallId: id
                     });
                 } catch (e) {
                     toolResult = {
                         status: ToolExecutionStatus.FAILURE,
                         error: `Error: ${e.message}`
                     };
                 } finally {
                     this.currentAbortController = null;
                 }

                 // Handle tool result based on status
                 if (toolResult.status === ToolExecutionStatus.RUNNING) {
                     // Tool is awaiting external event (e.g., approval)
                     // Don't add to messages yet - tool will be re-invoked when event arrives
                     Utils.logInfo(`[Session ${this.sessionId}] Tool ${name} awaiting event (status: RUNNING)`);
                     continue; // Skip adding message
                 }
                 
                 // Tool completed (SUCCESS or FAILURE)
                 let resultContent;
                 if (toolResult.status === ToolExecutionStatus.SUCCESS) {
                     resultContent = typeof toolResult.result === 'string' 
                         ? toolResult.result 
                         : JSON.stringify(toolResult.result);
                 } else {
                     // FAILURE
                     resultContent = toolResult.error || 'Tool execution failed';
                 }
                 
                 const truncatedResult = resultContent.length > 200 
                     ? resultContent.substring(0, 200) + '...' 
                     : resultContent;
                 Utils.logInfo(`[Session ${this.sessionId}] Tool Result (${name}): ${truncatedResult}`);
                 
                 // Reload session to ensure we have latest metadata (e.g. status changes from host)
                 // This is important because the host might have changed status (paused/resumed) while we were waiting
                 SessionModel.collection.loadAll();
                 const freshSession = SessionModel.load(this.sessionId);
                 if (freshSession) {
                     session.metadata = freshSession.metadata;
                 }

                 session.spec.messages.push({
                     role: 'tool',
                     tool_call_id: id,
                     name: name,
                     content: resultContent,
                     timestamp: new Date().toISOString()
                 });
             }
             
             // Reload session metadata before saving to ensure we have latest status
             // (e.g., tool might have paused the session during approval request)
             SessionModel.collection.loadAll();
             const latestSession = SessionModel.load(this.sessionId);
             if (latestSession) {
                 session.metadata = latestSession.metadata;
             }
             
             SessionModel.save(this.sessionId, session);
             SessionModel.collection.save();
             // After tool execution, loop continues to let assistant respond to tool results
        } else {
            // No tool calls - assistant gave a final response
            session.spec.messages.push(combinedMessage);
            SessionModel.save(this.sessionId, session);
            SessionModel.collection.save();
            Utils.logInfo(`Responded: ${combinedMessage.content}`);
            
            // If finish_reason is 'stop' (or 'end_turn' for some providers), conversation is complete
            if (finishReason === 'stop' || finishReason === 'end_turn') {
                Utils.logInfo(`Session complete (finish_reason: ${finishReason})`);
                SessionModel.transition(this.sessionId, 'complete');
                this.isRunning = false;
            }
        }
    }
  }
}
