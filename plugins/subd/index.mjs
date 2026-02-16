import { globals } from '../../common/globals.mjs';
import { spawn } from 'child_process';

export class SubdPlugin {
  constructor() {
    this.backgroundRuns = new Map();
    this.nextRunId = 1;
    globals.pluginsRegistry.set('subd', this);
    this.registerTools();
  }

  registerTools() {
    globals.dslRegistry.set('subd', this.launchSubd.bind(this));
    globals.dslRegistry.set('subd__await', this.awaitSubd.bind(this));
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
              wait: { type: 'boolean', description: 'Wait for completion (default true). Set false to launch in background.' },
              args: {
                type: 'array',
                description: 'Raw CLI args. If provided, all other fields are ignored.',
                items: { type: 'string' }
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'subd__await',
          description: 'Wait for a previously launched background subd run by run_id.',
          parameters: {
            type: 'object',
            properties: {
              run_id: { type: 'string', description: 'Run id returned by subd(wait=false).' },
              timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds.' }
            },
            required: ['run_id']
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

  launchLocalBackground(forwardArgs) {
    const cliPath = `${globals.PROJECT_ROOT}/cli.mjs`;
    const child = spawn(process.execPath, [cliPath, ...forwardArgs], {
      cwd: process.cwd(),
      env: process.env
    });

    const runId = `subd_run_${this.nextRunId++}`;
    const MAX_BUFFER = 65536;
    const cap = (text) => text.length > MAX_BUFFER ? text.slice(-MAX_BUFFER) : text;

    let stdout = '';
    let stderr = '';

    const completion = new Promise((resolve) => {
      child.stdout.on('data', (chunk) => {
        stdout = cap(stdout + chunk.toString());
      });

      child.stderr.on('data', (chunk) => {
        stderr = cap(stderr + chunk.toString());
      });

      child.on('error', (error) => {
        resolve({ ok: false, exitCode: 1, stdout, stderr, error: error.message, runId, pid: child.pid ?? null });
      });

      child.on('close', (code) => {
        resolve({ ok: code === 0, exitCode: code ?? 1, stdout, stderr, runId, pid: child.pid ?? null });
      });
    });

    this.backgroundRuns.set(runId, {
      runId,
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      completion
    });

    completion.finally(() => {
      this.backgroundRuns.delete(runId);
    });

    return { runId, pid: child.pid ?? null };
  }

  async awaitSubd(args = {}) {
    try {
      const runId = typeof args.run_id === 'string' ? args.run_id.trim() : '';
      if (!runId) {
        return { status: 'failure', error: 'subd__await requires run_id' };
      }

      const run = this.backgroundRuns.get(runId);
      if (!run) {
        return { status: 'failure', error: `Unknown or completed run_id: ${runId}` };
      }

      const timeoutMs = Math.max(0, Number(args.timeout_ms || 0));
      let result;

      if (timeoutMs > 0) {
        result = await Promise.race([
          run.completion,
          new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), timeoutMs))
        ]);

        if (result?.timedOut) {
          return {
            status: 'success',
            result: {
              run_id: runId,
              pid: run.pid,
              running: true,
              timed_out: true
            }
          };
        }
      } else {
        result = await run.completion;
      }

      if (!result?.ok) {
        return {
          status: 'failure',
          error: result?.error || result?.stderr || `subd run failed with exit code ${result?.exitCode ?? 1}`
        };
      }

      return {
        status: 'success',
        result: {
          run_id: runId,
          pid: run.pid,
          exit_code: result.exitCode ?? 0,
          output: result.stdout || result.stderr || `(subd exited ${result.exitCode ?? 0})`
        }
      };
    } catch (error) {
      return {
        status: 'failure',
        error: error.message
      };
    }
  }

  async launchSubd(args = {}) {
    try {
      const forwardArgs = this.buildArgs(args);
      const context = globals.subdContext || {};
      const shouldWait = args.wait !== false;

      if (context.agentMode && typeof context.requestSpawnSubdFromHost === 'function') {
        const spawnArgs = [...forwardArgs];
        if (!spawnArgs.includes('-s')) {
          spawnArgs.unshift('-s');
        }

        const response = await context.requestSpawnSubdFromHost(spawnArgs, { wait: shouldWait });
        if (!response?.ok) {
          return {
            status: 'failure',
            error: response?.error || response?.stderr || 'Host failed to launch subd'
          };
        }

        if (!shouldWait) {
          return {
            status: 'success',
            result: {
              launched: true,
              wait: false,
              pid: response.pid ?? null
            }
          };
        }

        return {
          status: 'success',
          result: response.stdout || response.stderr || `(subd exited ${response.exitCode ?? 0})`
        };
      }

      if (!shouldWait) {
        const launched = this.launchLocalBackground(forwardArgs);
        return {
          status: 'success',
          result: {
            launched: true,
            wait: false,
            run_id: launched.runId,
            pid: launched.pid
          }
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
