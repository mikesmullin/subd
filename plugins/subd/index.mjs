import { globals } from '../../common/globals.mjs';
import { spawn } from 'child_process';

export class SubdPlugin {
  constructor() {
    globals.pluginsRegistry.set('subd', this);
    this.registerTools();
  }

  registerTools() {
    globals.dslRegistry.set('subd', this.launchSubd.bind(this));
  }

  get definition() {
    return [
      {
        type: 'function',
        function: {
          name: 'subd',
          description: 'Launch a nested subd run. Prefer template + prompt, or pass raw args.',
          parameters: {
            type: 'object',
            properties: {
              template: { type: 'string', description: 'Template name/path for -t.' },
              prompt: { type: 'string', description: 'Prompt text for the child run.' },
              data: { type: 'string', description: 'YAML flow string for -d.' },
              output: { type: 'string', description: 'Output path for -o.' },
              turn_limit: { type: 'number', description: 'Turn limit for -l.' },
              verbose: { type: 'boolean', description: 'Enable -v.' },
              jsonl: { type: 'boolean', description: 'Enable -j.' },
              strict: { type: 'boolean', description: 'Enable --strict.' },
              read_stdin: { type: 'boolean', description: 'Enable -i.' },
              sandbox: { type: 'boolean', description: 'Enable -s for child run.' },
              args: {
                type: 'array',
                description: 'Raw CLI args. If provided, all other fields are ignored.',
                items: { type: 'string' }
              }
            }
          }
        }
      }
    ];
  }

  buildArgs(args = {}) {
    if (Array.isArray(args.args) && args.args.length > 0) {
      return args.args.map(String);
    }

    if (!args.template || !args.prompt) {
      throw new Error('subd tool requires either args[] or both template and prompt');
    }

    const built = ['-t', String(args.template)];

    if (args.data !== undefined) built.push('-d', String(args.data));
    if (args.output !== undefined) built.push('-o', String(args.output));
    if (args.verbose === true) built.push('-v');
    if (args.jsonl === true) built.push('-j');
    if (args.strict === true) built.push('--strict');
    if (args.read_stdin === true) built.push('-i');
    if (typeof args.turn_limit === 'number') built.push('-l', String(args.turn_limit));
    if (args.sandbox === true) built.push('-s');

    built.push(String(args.prompt));
    return built;
  }

  spawnLocal(forwardArgs) {
    const cliPath = `${globals.PROJECT_ROOT}/cli.mjs`;
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
        resolve({ ok: false, exitCode: 1, stdout, stderr, error: error.message });
      });

      child.on('close', (code) => {
        resolve({ ok: code === 0, exitCode: code ?? 1, stdout, stderr });
      });
    });
  }

  async launchSubd(args = {}) {
    try {
      const forwardArgs = this.buildArgs(args);
      const context = globals.subdContext || {};

      if (context.agentMode && context.sandboxSocketPath && typeof context.requestSpawnSubdFromHost === 'function') {
        const spawnArgs = [...forwardArgs];
        if (!spawnArgs.includes('-s')) {
          spawnArgs.unshift('-s');
        }

        const response = await context.requestSpawnSubdFromHost(spawnArgs);
        if (!response?.ok) {
          return {
            status: 'failure',
            error: response?.error || response?.stderr || 'Host failed to launch subd'
          };
        }

        return {
          status: 'success',
          result: response.stdout || response.stderr || `(subd exited ${response.exitCode ?? 0})`
        };
      }

      const result = await this.spawnLocal(forwardArgs);
      if (!result.ok) {
        return {
          status: 'failure',
          error: result.error || result.stderr || `subd exited with code ${result.exitCode}`
        };
      }

      return {
        status: 'success',
        result: result.stdout || result.stderr || `(subd exited ${result.exitCode ?? 0})`
      };
    } catch (error) {
      return {
        status: 'failure',
        error: error.message
      };
    }
  }
}
