import { globals } from '../../common/globals.mjs';
import { Utils } from '../../common/utils.mjs';
import { exec } from 'child_process';
import util from 'util';
import { checkCommand } from './terminal-allowlist.mjs';
import { ToolExecutionStatus } from '../agent/controllers/host-container-bridge.mjs';

const execAsync = util.promisify(exec);

export class ShellPlugin {
  constructor() {
    globals.pluginsRegistry.set('shell', this);
    this.registerTools();
  }

  registerTools() {
    globals.dslRegistry.set('shell__execute', this.executeShell.bind(this));
  }

  get definition() {
    return [
      {
        type: 'function',
        function: {
          name: 'shell__execute',
          description: 'Execute a shell command.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'The command to execute.' }
            },
            required: ['command']
          }
        },
        metadata: {
          help: 'shell exec <command>',
          alias: (args) => {
            if (args[0] === 'shell' && /^(exec|execute)$/.test(args[1])) {
              return { name: 'shell__execute', args: { command: args.slice(2).join(' ') } };
            }
            return false;
          }
        }
      }
    ];
  }

  async executeShell(args, context = {}) {
    const command = Array.isArray(args) ? args.join(' ') : args.command;
    if (!command || !command.trim()) {
      return {
        status: ToolExecutionStatus.FAILURE,
        error: 'Usage: shell__execute requires a non-empty command'
      };
    }

    const toolOptions = globals.sessionToolOptions?.get('shell__execute');
    const sessionAllowlist = toolOptions?.allowlist;
    const checkOptions = sessionAllowlist ? { allowlist: sessionAllowlist } : {};
    const check = await checkCommand(command, checkOptions);

    if (!check.approved && context?.sessionId) {
      let errorMsg = `Command execution rejected by allowlist policy. Reason: ${check.reason}.`;
      if (sessionAllowlist) {
        const allowedCommands = Object.keys(sessionAllowlist).filter(k => sessionAllowlist[k] === true);
        if (allowedCommands.length > 0) {
          errorMsg += ` Allowed commands: ${allowedCommands.join(', ')}.`;
        }
      }
      return {
        status: ToolExecutionStatus.FAILURE,
        error: errorMsg
      };
    }

    return await this.executeCommand(command);
  }

  async executeCommand(command) {
    try {
      const { stdout, stderr } = await execAsync(command);
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: stdout || stderr || 'Command executed. Exit code: 0'
      };
    } catch (e) {
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
}

export const shellPlugin = new ShellPlugin();
