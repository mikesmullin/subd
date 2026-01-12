import { globals } from '../../../common/globals.mjs';
import { Utils } from '../../../common/utils.mjs';
import { SessionModel, SessionState } from '../models/session.mjs';
import { ToolExecutionStatus } from './host-container-bridge.mjs';
import { spawnSync } from 'child_process';
import { toYaml } from '../../../common/yaml-db.mjs';

export class SessionTools {
  constructor(plugin) {
    this.plugin = plugin;
  }

  async list(args) {
    // Ensure we have latest state
    SessionModel.collection.loadAll();
    const sessions = SessionModel.list();
    
    if (sessions.length === 0) {
      const msg = '(no active sessions)';
      Utils.logInfo(msg);
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: msg
      };
    }

    let output = '';
    for (const id of sessions) {
      const session = SessionModel.load(id);
      if (!session) continue;

      const meta = session.metadata || {};
      const name = meta.name || 'unnamed';
      let state = meta.status || 'unknown';
      let stateColor = 'reset';
      
      // Colorize state
      if (state === SessionState.RUNNING) stateColor = 'green';
      else if (state === SessionState.ERROR) stateColor = 'red';
      else if (state === SessionState.STOPPED) stateColor = 'gray';
      else if (state === SessionState.PAUSED) stateColor = 'yellow';
      else if (state === SessionState.SUCCESS) stateColor = 'blue';

      const created = meta.created ? new Date(meta.created).toUTCString() : 'unknown';
      const model = meta.model || 'unknown';
      
      let lastMsg = '(no messages)';
      if (session.spec?.messages?.length > 0) {
        const last = session.spec.messages[session.spec.messages.length - 1];
        let content = last.content || '';
        if (!content && last.tool_calls) {
            content = `[Tool Call: ${last.tool_calls[0].function.name}]`;
        }
        // Truncate and clean newlines
        content = content.replace(/\n/g, ' ').substring(0, 60);
        if (last.content && last.content.length > 60) content += '...';
        lastMsg = content;
      }

      output += `${Utils.colorize(stateColor, '●')} Session ${id}: ${name}\n`;
      output += `     State: ${Utils.colorize(stateColor, state)}\n`;
      output += `   Created: ${created}\n`;
      output += `     Model: ${model}\n`;
      output += `      Last: ${lastMsg}\n\n`;
    }

    output = output.trim();
    Utils.logInfo('\n'+ output);
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: output
    };
  }

  async detail(args) {
    const id = Array.isArray(args) ? args[0] : args.id;
    SessionModel.collection.loadAll();
    const session = SessionModel.load(id);
    if (!session) {
      const msg = `Session ${id} not found.`;
      Utils.logError(msg);
      return {
        status: ToolExecutionStatus.FAILURE,
        error: msg
      };
    }
    const output = `Session ${id}:\n${toYaml(session)}`;
    Utils.logInfo(output);
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: output
    };
  }

  async chat(args) {
    let id, msg;
    if (Array.isArray(args)) {
        id = args[0];
        msg = args.slice(1).join(' ');
    } else {
        id = args.id;
        msg = args.msg;
    }

    const session = SessionModel.load(id);
    if (!session) {
      const errMsg = `Session ${id} not found.`;
      Utils.logError(errMsg);
      return {
        status: ToolExecutionStatus.FAILURE,
        error: errMsg
      };
    }
    
    if (!session.spec.messages) session.spec.messages = [];
    session.spec.messages.push({ role: 'user', content: msg, timestamp: new Date().toISOString() });
    SessionModel.save(id, session);
    Utils.logInfo(`Added message to ${id}`);

    // Auto-revive if needed
    const status = session.metadata?.status;
    if (status === SessionState.SUCCESS || status === SessionState.ERROR || status === SessionState.STOPPED) {
        Utils.logInfo(`Reviving session ${id} (status: ${status})...`);
        
        let action = 'retry';
        if (status === SessionState.STOPPED) action = 'run';
        
        const result = SessionModel.transition(id, action);
        if (result.success) {
            // Ensure container is running
            // We need to reload session to get the new state
            const updatedSession = SessionModel.load(id);
            this.plugin.spawnAgentContainer(id, updatedSession);
        } else {
            Utils.logError(`Failed to revive session ${id}: ${result.error}`);
        }
    } else if (status === SessionState.PENDING || status === SessionState.RUNNING) {
        // Ensure container is running for active sessions
        const containerId = session.metadata?.containerId;
        if (containerId) {
            const containerStatus = this.plugin.getContainerStatus(containerId);
            if (containerStatus !== 'running') {
                Utils.logInfo(`Session ${id} is ${status} but container is not running. Spawning...`);
                this.plugin.spawnAgentContainer(id, session);
            }
        }
    }
    
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: `Message added to session ${id}`
    };
  }

  async last(args) {
    let id, maxlen = 2048;
    if (Array.isArray(args)) {
        id = args[0];
        if (args[1]) maxlen = parseInt(args[1]);
    } else {
        id = args.id;
        if (args.maxlen) maxlen = parseInt(args.maxlen);
    }

    const session = SessionModel.load(id);
    if (!session) {
      const msg = `Session ${id} not found.`;
      Utils.logError(msg);
      return {
        status: ToolExecutionStatus.FAILURE,
        error: msg
      };
    }
    
    const messages = session.spec?.messages || [];
    if (messages.length > 0) {
        const last = messages[messages.length - 1];
        let content = last.content || '(no content)';
        
        if (content.length > maxlen) {
            content = content.substring(0, maxlen) + `... (text truncated; to see more, increase maxlen param)`;
        }

        Utils.logInfo(content);
        return {
          status: ToolExecutionStatus.SUCCESS,
          result: content
        };
    } else {
        Utils.logInfo('(no messages)');
        return {
          status: ToolExecutionStatus.SUCCESS,
          result: '(no messages)'
        };
    }
  }

  async status(args) {
    const id = Array.isArray(args) ? args[0] : args.id;
    const session = SessionModel.load(id);
    if (!session) {
      const msg = `Session ${id} not found.`;
      Utils.logError(msg);
      return {
        status: ToolExecutionStatus.FAILURE,
        error: msg
      };
    }
    Utils.logInfo(`Status: ${session.metadata?.status || 'unknown'}`);
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: session.metadata?.status
    };
  }

  async log(args) {
    const id = Array.isArray(args) ? args[0] : args.id;
    const session = SessionModel.load(id);
    if (!session) {
      const msg = `Session ${id} not found.`;
      Utils.logError(msg);
      return {
        status: ToolExecutionStatus.FAILURE,
        error: msg
      };
    }
    
    const containerId = session.metadata?.containerId;
    if (!containerId) {
      const msg = `No container ID found for session ${id}`;
      Utils.logError(msg);
      return {
        status: ToolExecutionStatus.FAILURE,
        error: msg
      };
    }
    
    try {
        const result = spawnSync(globals.containerRuntime, ['logs', containerId]);
        const output = result.stdout.toString() || result.stderr.toString() || '(no logs)';
        Utils.logInfo(output);
        return {
          status: ToolExecutionStatus.SUCCESS,
          result: output
        };
    } catch (e) {
        const msg = `Failed to get logs for ${containerId}: ${e.message}`;
        Utils.logError(msg);
        return {
          status: ToolExecutionStatus.FAILURE,
          error: msg
        };
    }
  }

  async ps(args) {
    const id = Array.isArray(args) ? args[0] : args.id;
    const session = SessionModel.load(id);
    if (!session) {
      const msg = `Session ${id} not found.`;
      Utils.logError(msg);
      return {
        status: ToolExecutionStatus.FAILURE,
        error: msg
      };
    }
    
    const containerId = session.metadata?.containerId;
    if (!containerId) {
      const msg = `No container ID found for session ${id}`;
      Utils.logError(msg);
      return {
        status: ToolExecutionStatus.FAILURE,
        error: msg
      };
    }
    
    try {
        const result = spawnSync(globals.containerRuntime, ['ps', '-a', '-f', `name=${containerId}`]);
        const output = result.stdout.toString() || '(no output)';
        Utils.logInfo(output);
        return {
          status: ToolExecutionStatus.SUCCESS,
          result: output
        };
    } catch (e) {
        const msg = `Failed to get ps for ${containerId}: ${e.message}`;
        Utils.logError(msg);
        return {
          status: ToolExecutionStatus.FAILURE,
          error: msg
        };
    }
  }

  async pause(args) {
    const id = Array.isArray(args) ? args[0] : args.id;
    const result = await this.plugin.transitionSession(id, 'pause', 'SIGUSR1');
    return {
      status: result.success ? ToolExecutionStatus.SUCCESS : ToolExecutionStatus.FAILURE,
      result: result.success ? 'Session paused' : result.error,
      error: result.success ? undefined : result.error
    };
  }

  async resume(args) {
    const id = Array.isArray(args) ? args[0] : args.id;
    const result = await this.plugin.transitionSession(id, 'resume');
    return {
      status: result.success ? ToolExecutionStatus.SUCCESS : ToolExecutionStatus.FAILURE,
      result: result.success ? 'Session resumed' : result.error,
      error: result.success ? undefined : result.error
    };
  }

  async stop(args) {
    const id = Array.isArray(args) ? args[0] : args.id;
    const result = await this.plugin.transitionSession(id, 'stop', 'SIGUSR2');
    return {
      status: result.success ? ToolExecutionStatus.SUCCESS : ToolExecutionStatus.FAILURE,
      result: result.success ? 'Session stopped' : result.error,
      error: result.success ? undefined : result.error
    };
  }

  async run(args) {
    const id = Array.isArray(args) ? args[0] : args.id;
    const result = await this.plugin.transitionSession(id, 'run');
    if (result.success) {
        const session = SessionModel.load(id);
        this.plugin.spawnAgentContainer(id, session);
    }
    return {
      status: result.success ? ToolExecutionStatus.SUCCESS : ToolExecutionStatus.FAILURE,
      result: result.success ? 'Session running' : result.error,
      error: result.success ? undefined : result.error
    };
  }

  async delete(args) {
    const id = Array.isArray(args) ? args[0] : args.id;
    this.plugin.cleanupContainer(id);
    SessionModel.delete(id);
    Utils.logInfo(`Session ${id} deleted.`);
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: `Session ${id} deleted.`
    };
  }
}
