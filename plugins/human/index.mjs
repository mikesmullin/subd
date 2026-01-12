import { globals } from '../../common/globals.mjs';
import { Utils } from '../../common/utils.mjs';
import { SessionModel } from '../agent/models/session.mjs';
import { QuestionModel } from './models/question.mjs';
import { ApprovalModel } from './models/approval.mjs';
import { ToolExecutionStatus } from '../agent/controllers/host-container-bridge.mjs';
import { spawn } from 'child_process';
import open from 'open';

export class HumanPlugin {
  constructor() {
    globals.pluginsRegistry.set('human', this);
    QuestionModel.init();
    ApprovalModel.init();
    this.registerTools();
    this.registerWidgets();
  }

  registerTools() {
    globals.dslRegistry.set('human__ask', this.askHuman.bind(this));
    globals.dslRegistry.set('human__dashboard', this.renderDashboard.bind(this));
    globals.dslRegistry.set('human__questions__list', this.listQuestions.bind(this));
    globals.dslRegistry.set('human__questions__answer', this.answerQuestion.bind(this));
    globals.dslRegistry.set('human__approvals__list', this.listApprovals.bind(this));
    globals.dslRegistry.set('human__approvals__approve', this.approveRequest.bind(this));
    globals.dslRegistry.set('human__file__open', this.openFile.bind(this));
    globals.dslRegistry.set('human__browser__open', this.openBrowser.bind(this));
    
    // Mark human-only tools
    globals.humanOnlyTools.add('human__dashboard');
    globals.humanOnlyTools.add('human__questions__list');
    globals.humanOnlyTools.add('human__questions__answer');
    globals.humanOnlyTools.add('human__approvals__list');
    globals.humanOnlyTools.add('human__approvals__approve');
  }

  registerWidgets() {
    globals.widgetRegistry.set('human.questions.count', {
      plugin: 'human',
      render: async () => {
        const count = globals.humanQuestions.size;
        return `Pending Questions: ${count}`;
      }
    });
    globals.widgetRegistry.set('human.approvals.count', {
        plugin: 'human',
        render: async () => {
            const pending = ApprovalModel.list().filter(a => a.status === 'pending');
            return `Pending Approvals: ${pending.length}`;
        }
    });
  }

  get definition() {
    return [
      {
        type: "function",
        function: {
          name: "human__ask",
          description: "Prompt the human for input using an interactive prompt.",
          parameters: {
            type: "object",
            properties: {
              question: { type: "string", description: "The question to ask the human." }
            },
            required: ["question"]
          }
        },
        metadata: {
          requiresHostExecution: true,
          help: "human ask <question>"
        }
      },
      {
        type: "function",
        function: {
          name: "human__dashboard",
          description: "Render the dashboard with configured widgets.",
          parameters: {
            type: "object",
            properties: {}
          }
        },
        metadata: {
          humanOnly: true,
          help: "dashboard",
          alias: (args) => {
            // Matches "dashboard", "dash", "/dashboard", or "/dash"
            const input = args.join(' ').trim();
            if (/^\/?(dashboard|dash)$/i.test(input)) {
              return { name: 'human__dashboard', args: {} };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "human__questions__list",
          description: "List all pending questions from all sessions",
          parameters: { type: "object", properties: {} }
        },
        metadata: {
          humanOnly: true,
          help: "d questions",
          alias: (args) => {
            if (args.length === 1 && /^(questions?|q)$/i.test(args[0])) {
              return { name: 'human__questions__list', args: {} };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "human__questions__answer",
          description: "Answer a specific question by id",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string" },
              answer: { type: "string" }
            },
            required: ["id", "answer"]
          }
        },
        metadata: {
          humanOnly: true,
          localCommand: true,
          help: "d answer <id> <answer>",
          alias: (args) => {
            if (args.length >= 3 && /^a(nswer)?$/i.test(args[0])) {
              const id = args[1];
              const answer = args.slice(2).join(' ');
              return { name: 'human__questions__answer', args: { id, answer } };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "human__approvals__list",
          description: "List all pending approval requests",
          parameters: { type: "object", properties: {} }
        },
        metadata: {
          humanOnly: true,
          localCommand: true,
          help: "d approvals",
          alias: (args) => {
            if (args.length === 1 && /^(approvals?|a)$/i.test(args[0])) {
              return { name: 'human__approvals__list', args: {} };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "human__approvals__approve",
          description: "choose to APPROVE, REJECT, or MODIFY a pending request",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "Approval ID" },
              choice: { type: "string", enum: ["APPROVE", "REJECT", "MODIFY"], description: "Decision" },
              explanation: { type: "string", description: "Optional explanation" }
            },
            required: ["id", "choice"]
          }
        },
        metadata: {
          humanOnly: true,
          localCommand: true,
          help: "approve <id> <choice> [explanation]",
          alias: (args) => {
            if (args[0] === 'approve' && args.length >= 3) {
              return { 
                name: 'human__approvals__approve', 
                args: { 
                  id: args[1], 
                  choice: args[2].toUpperCase(),
                  explanation: args.slice(3).join(' ') 
                } 
              };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "human__file__open",
          description: "Open a file on the host machine",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"]
          }
        },
        metadata: {
          requiresHostExecution: true,
          help: "human file open <path>"
        }
      },
      {
        type: "function",
        function: {
          name: "human__browser__open",
          description: "Open a URL in the host browser",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"]
          }
        },
        metadata: {
          requiresHostExecution: true,
          help: "human browser open <url>"
        }
      }
    ];
  }

  /**
   * Render the dashboard with configured widgets
   * Reads widget configuration from config.yml and calls each widget's render function
   */
  async renderDashboard() {
    const dashboardConfig = globals.getConfig('dashboard');
    
    if (!dashboardConfig || !dashboardConfig.widgets || !Array.isArray(dashboardConfig.widgets)) {
      const msg = 'No dashboard widgets configured. Add widgets to config.yml under dashboard.widgets';
      Utils.logInfo(msg);
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: msg
      };
    }

    const widgets = dashboardConfig.widgets;
    
    // Build a 2D grid to place widgets
    // First, find the max dimensions needed
    let maxCol = 0;
    let maxRow = 0;
    
    for (const widgetConfig of widgets) {
      const { name, col = 0, row = 0, width = 40, height = 10 } = widgetConfig;
      maxCol = Math.max(maxCol, col + width);
      maxRow = Math.max(maxRow, row + height);
    }

    // Initialize grid with spaces
    const grid = Array.from({ length: maxRow }, () => Array(maxCol).fill(' '));

    // Render each widget and place in grid
    for (const widgetConfig of widgets) {
      const { name, col = 0, row = 0, width = 40, height = 10 } = widgetConfig;
      
      const widget = globals.widgetRegistry.get(name);
      if (!widget) {
        Utils.logWarn(`Widget "${name}" not found, skipping`);
        continue;
      }

      try {
        const content = await widget.render();
        if (typeof content !== 'string') {
          Utils.logWarn(`Widget "${name}" render() did not return a string, skipping`);
          continue;
        }

        // Split content into lines and place in grid (truncate, no wrap)
        const lines = content.split('\n');
        for (let r = 0; r < Math.min(lines.length, height); r++) {
          const line = lines[r] || '';
          for (let c = 0; c < Math.min(line.length, width); c++) {
            if (row + r < maxRow && col + c < maxCol) {
              grid[row + r][col + c] = line[c];
            }
          }
        }
      } catch (err) {
        Utils.logError(`Widget "${name}" render() threw error: ${err.message}`);
      }
    }

    // Convert grid to string
    const output = grid.map(row => row.join('')).join('\n');
    Utils.logInfo(output);
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: output
    };
  }

  async askHuman(args, context) {
      let question;
      if (Array.isArray(args)) {
          question = args.join(' ');
      } else {
          question = args.question;
      }

      const sessionId = context?.sessionId;
      const toolCallId = context?.toolCallId;
      const state = context?.state || {};
      const externalData = context?.externalData || {};
      
      Utils.logTrace(`[askHuman] START - question: "${question}", sessionId: ${sessionId}, toolCallId: ${toolCallId}, state.phase: ${state.phase}`);
      
      // Phase 2: Process answer response
      if (state.phase === 'awaiting_answer') {
          Utils.logTrace(`[askHuman] In awaiting_answer phase`);
          if (!externalData.answerReceived) {
              Utils.logWarn(`Tool call ${toolCallId} re-invoked but no answer yet`);
              Utils.logTrace(`[askHuman] Returning RUNNING status, still waiting for answer`);
              return {
                  status: ToolExecutionStatus.RUNNING,
                  state: { phase: 'awaiting_answer', question: state.question }
              };
          }
          
          const answer = externalData.answer;
          Utils.logTrace(`[askHuman] Answer received: ${answer}`);
          Utils.logInfo(`Human answered: ${answer}`);
          
          // Return success with the answer
          return {
              status: ToolExecutionStatus.SUCCESS,
              result: answer
          };
      }
      
      // Phase 1: Initial request
      Utils.logTrace(`[askHuman] In initial phase, sending question request`);
      Utils.logInfo(`[HUMAN REQUEST] Question: ${question} (Session: ${sessionId})`);

      // Alert user if in interactive mode
      if (globals.isRepl) {
          process.stdout.write('\x07');
      }

      // Send question request through bridge
      // The bridge will handle pausing the session and creating the question record
      try {
          Utils.logTrace(`[askHuman] Importing bridge`);
          const { bridge } = await import('../agent/controllers/host-container-bridge.mjs');
          Utils.logTrace(`[askHuman] Bridge imported, sending question_request`);
          
          const result = await bridge.route({
              type: 'question_request',
              sessionId,
              toolCallId,
              question
          }, { sessionId });
          
          Utils.logTrace(`[askHuman] bridge.route returned: ${JSON.stringify(result)}`);
          
          // Return RUNNING status with state for next invocation
          return {
              status: ToolExecutionStatus.RUNNING,
              state: { phase: 'awaiting_answer', question }
          };
      } catch (e) {
          Utils.logError(`[askHuman] Failed to send question request: ${e.message}`);
          Utils.logError(e.stack);
          return {
              status: ToolExecutionStatus.FAILURE,
              error: `Failed to ask question: ${e.message}`
          };
      }
  }

  async listQuestions() {
      // Combine in-memory and persisted questions
      // Actually, persisted should be source of truth for listing
      const questions = QuestionModel.list();
      
      if (questions.length === 0) {
          const msg = "No pending questions.";
          Utils.logInfo(msg);
          return {
            status: ToolExecutionStatus.SUCCESS,
            result: msg
          };
      }
      
      let output = "PENDING QUESTIONS:\n";
      for (const q of questions) {
          output += `[${q.id}] (Session ${q.sessionId}): ${q.question}\n`;
      }
      Utils.logInfo(output);
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: output
      };
  }

  async answerQuestion(args) {
      const { id, answer } = args;
      
      Utils.logTrace(`[answerQuestion] START - id=${id}, answer=${answer}`);
      
      // Check persistence first
      const persistedQ = QuestionModel.get(id);
      if (!persistedQ) {
          const msg = `Error: Question ID ${id} not found.`;
          Utils.logError(msg);
          Utils.logTrace(`[answerQuestion] Question not found, returning failure`);
          return {
            status: ToolExecutionStatus.FAILURE,
            error: msg
          };
      }
      
      Utils.logTrace(`[answerQuestion] Found question - sessionId=${persistedQ.sessionId}, toolCallId=${persistedQ.toolCallId}`);
      
      // Inject question response through bridge
      Utils.logTrace(`[answerQuestion] Checking if toolCallId exists: ${persistedQ.toolCallId ? 'yes' : 'no'}`);
      if (persistedQ.toolCallId) {
          try {
              // Lazy import bridge
              Utils.logTrace(`[answerQuestion] Importing bridge...`);
              const { bridge } = await import('../agent/controllers/host-container-bridge.mjs');
              Utils.logTrace(`[answerQuestion] Bridge imported successfully`);
              
              Utils.logTrace(`[answerQuestion] Calling bridge.handleQuestionResponse with toolCallId=${persistedQ.toolCallId}, sessionId=${persistedQ.sessionId}`);
              await bridge.handleQuestionResponse({
                  toolCallId: persistedQ.toolCallId,
                  sessionId: persistedQ.sessionId,
                  answer
              }, { sessionId: persistedQ.sessionId });
              Utils.logTrace(`[answerQuestion] bridge.handleQuestionResponse completed successfully`);
          } catch (e) {
              Utils.logError(`[answerQuestion] Failed to send question response via bridge: ${e.message}`);
              Utils.logTrace(`[answerQuestion] Error details: ${e.stack}`);
              // Continue with cleanup even if bridge call fails
          }
      }
      
      // Cleanup persistence
      Utils.logTrace(`[answerQuestion] Deleting question record`);
      QuestionModel.delete(id);
      
      // Resume the session if paused
      Utils.logTrace(`[answerQuestion] Checking if sessionId exists: ${persistedQ.sessionId ? 'yes' : 'no'}`);
      if (persistedQ.sessionId) {
          const result = SessionModel.transition(persistedQ.sessionId, 'resume');
          if (result.success) {
              Utils.logInfo(`Session ${persistedQ.sessionId} resumed.`);
          } else {
              Utils.logWarn(`Failed to resume session ${persistedQ.sessionId}: ${result.error}`);
          }
      }
      
      Utils.logInfo(`[HUMAN ANSWER] Question ${id} answered.`);
      Utils.logTrace(`[answerQuestion] COMPLETE`);
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: `Question ${id} answered.`
      };
  }

  async listApprovals() {
      Utils.logTrace(`[listApprovals] START`);
      const approvals = ApprovalModel.list().filter(a => a.status === 'pending');
      Utils.logTrace(`[listApprovals] Found ${approvals.length} pending approvals`);
      
      if (approvals.length === 0) {
          const msg = "No pending approvals.";
          Utils.logTrace(`[listApprovals] No approvals, returning message`);
          Utils.logInfo(msg);
          return {
            status: ToolExecutionStatus.SUCCESS,
            result: msg
          };
      }
      
      // Convert to array of objects for proper table formatting
      Utils.logTrace(`[listApprovals] Converting ${approvals.length} approvals to table format`);
      const rows = approvals.map(a => ({
          ID: a.id,
          Session: a.sessionId || 'N/A',
          Type: a.type || 'tool',
          Description: a.description
      }));
      
      Utils.logTrace(`[listApprovals] Formatting as table`);
      const table = Utils.outputAs('table', rows);
      Utils.logInfo('\n' + table);
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: table
      };
  }

  async approveRequest(args) {
      Utils.logTrace(`[approveRequest] START - args: ${JSON.stringify(args)}`);
      const { id, choice, explanation } = args;
      Utils.logTrace(`[approveRequest] Extracted: id=${id}, choice=${choice}, explanation=${explanation}`);
      
      const approval = ApprovalModel.get(id);
      Utils.logTrace(`[approveRequest] ApprovalModel.get(${id}) returned: ${approval ? 'found' : 'not found'}`);
      if (!approval) {
          Utils.logTrace(`[approveRequest] Approval not found, returning error`);
          return {
            status: ToolExecutionStatus.FAILURE,
            error: `Error: Approval ID ${id} not found.`
          };
      }
      
      Utils.logTrace(`[approveRequest] Approval status: ${approval.status}`);
      if (approval.status !== 'pending') {
          Utils.logTrace(`[approveRequest] Approval not pending, returning error`);
          return {
            status: ToolExecutionStatus.FAILURE,
            error: `Error: Approval ${id} is already ${approval.status}.`
          };
      }
      
      // Update status
      Utils.logTrace(`[approveRequest] Updating approval status to: ${choice.toLowerCase()}`);
      ApprovalModel.update(id, { 
          status: choice.toLowerCase(),
          response: explanation,
          respondedAt: new Date().toISOString()
      });
      Utils.logTrace(`[approveRequest] Approval status updated`);
      
      // Inject approval response into tool state via bridge
      Utils.logTrace(`[approveRequest] Checking if toolCallId exists: ${approval.toolCallId ? 'yes' : 'no'}`);
      if (approval.toolCallId) {
          // Lazy import bridge
          Utils.logTrace(`[approveRequest] Importing bridge...`);
          const { bridge } = await import('../agent/controllers/host-container-bridge.mjs');
          Utils.logTrace(`[approveRequest] Bridge imported successfully`);
          
          Utils.logTrace(`[approveRequest] Calling bridge.handleApprovalResponse with toolCallId=${approval.toolCallId}, sessionId=${approval.sessionId}`);
          await bridge.handleApprovalResponse({
              toolCallId: approval.toolCallId,
              sessionId: approval.sessionId,
              choice,
              explanation
          }, { sessionId: approval.sessionId });
          Utils.logTrace(`[approveRequest] bridge.handleApprovalResponse completed successfully`);
      }
      
      // Resume session if paused
      Utils.logTrace(`[approveRequest] Checking if sessionId exists: ${approval.sessionId ? 'yes' : 'no'}`);
      if (approval.sessionId) {
          // Find the pending promise in globals (if active) - legacy path
          Utils.logTrace(`[approveRequest] Checking globals.humanApprovals for id=${id}`);
          if (globals.humanApprovals && globals.humanApprovals.has(id)) {
              Utils.logTrace(`[approveRequest] Found pending promise, resolving it`);
              const p = globals.humanApprovals.get(id);
              p.resolve({ choice, explanation });
              globals.humanApprovals.delete(id);
              Utils.logTrace(`[approveRequest] Promise resolved and deleted from map`);
          } else {
              // Recovery mode: Session loop is gone, we need to manually inject the answer
              // Utils.logInfo(`Waking ${id} (Session ${approval.sessionId}) to notify of approval`);
              
              if (approval.sessionId && approval.toolCallId) {
                  const session = SessionModel.load(approval.sessionId);
                  if (session) {
                      // Resume/Restart the session based on current state
                      if (session.metadata.status === 'paused') {
                          // Utils.logInfo(`Session ${approval.sessionId} is paused. Resuming...`);
                          const agentPlugin = globals.pluginsRegistry.get('agent');
                          if (agentPlugin) {
                              await agentPlugin.sessionTools.resume({ id: approval.sessionId });
                          }
                          // Utils.logInfo(`[HUMAN APPROVAL] Request ${id} handled (Session resumed).`);
                          return {
                            status: ToolExecutionStatus.SUCCESS,
                            result: `Request ${id} ${choice.toLowerCase()}. Session resumed.`
                          };
                      } else if (session.metadata.status === 'stopped') {
                          // Utils.logInfo(`Session ${approval.sessionId} is stopped. Restarting...`);
                          const agentPlugin = globals.pluginsRegistry.get('agent');
                          if (agentPlugin) {
                              await agentPlugin.sessionTools.run({ id: approval.sessionId });
                          }
                          // Utils.logInfo(`[HUMAN APPROVAL] Request ${id} handled (Session restarted).`);
                          return {
                            status: ToolExecutionStatus.SUCCESS,
                            result: `Request ${id} ${choice.toLowerCase()}. Session restarted.`
                          };
                      }
                  }
              }
          }
      }
      
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: `Request ${id} ${choice.toLowerCase()}.`
      };
  }

  /**
   * @deprecated - Internal tool-calling-tool pattern removed. Use HumanPlugin.requestApproval() static method directly.
   */
  async requestApprovalTool(args, context) {
    throw new Error('requestApprovalTool() is deprecated. Use HumanPlugin.requestApproval() static method instead.');
  }

  // Helper for other plugins to request approval
  static async requestApproval(sessionId, type, description, toolCallId) {
      // Check if --no-humans mode is enabled
      const unattended = globals.getConfig('unattended') === true;
      if (unattended) {
        Utils.logWarn(`Approval auto-rejected by unattended mode policy: ${description}`);
        // Immediately resolve with rejection
        return Promise.resolve({
          choice: 'REJECT',
          explanation: 'Auto-rejected by unattended mode. Use commands that match the allowlist or enable human approval by setting unattended to false.'
        });
      }

      const id = (++globals.humanApprovalsCounter).toString();
      
      Utils.logInfo(`[APPROVAL NEEDED] ${description} (ID: ${id})`);
      if (globals.isRepl) {
          process.stdout.write('\x07');
      }
      
      ApprovalModel.create({
          id,
          sessionId,
          type,
          description,
          toolCallId
      });
      
      // Pause session
      if (sessionId) {
          const result = SessionModel.transition(sessionId, 'pause');
          if (result.success) {
              Utils.logInfo(`Session ${sessionId} paused waiting for approval.`);
          } else {
              Utils.logWarn(`Failed to pause session ${sessionId}: ${result.error}`);
          }
      }
      
      // Wait for approval via CLI (in-memory promise)
      return new Promise((resolve, reject) => {
          globals.humanApprovals.set(id, { resolve, reject, sessionId });
      });
  }

  async openFile(args) {
      const path = Array.isArray(args) ? args[0] : args.path;
      try {
          // Prefer VS Code if available
          await open(path, { app: { name: 'code' } });
          Utils.logInfo(`Opened file ${path} in VS Code`);
          return {
            status: ToolExecutionStatus.SUCCESS,
            result: `Opened file ${path} in VS Code`
          };
      } catch (e) {
          // Fallback to default system handler
          try {
              await open(path);
              Utils.logInfo(`Opened file ${path} (system default)`);
              return {
                status: ToolExecutionStatus.SUCCESS,
                result: `Opened file ${path}`
              };
          } catch (e2) {
              Utils.logError(`Failed to open file ${path}: ${e2.message}`);
              return {
                status: ToolExecutionStatus.FAILURE,
                error: `Error: ${e2.message}`
              };
          }
      }
  }

  async openBrowser(args) {
      const url = Array.isArray(args) ? args[0] : args.url;
      try {
          await open(url);
          Utils.logInfo(`Opened URL ${url}`);
          return {
            status: ToolExecutionStatus.SUCCESS,
            result: `Opened URL ${url}`
          };
      } catch (e) {
          Utils.logError(`Failed to open URL ${url}: ${e.message}`);
          return {
            status: ToolExecutionStatus.FAILURE,
            error: `Error: ${e.message}`
          };
      }
  }
}

export const humanPlugin = new HumanPlugin();
