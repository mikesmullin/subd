import { globals } from '../../common/globals.mjs';
import { Utils } from '../../common/utils.mjs';
import { ToolExecutionStatus } from '../agent/controllers/host-container-bridge.mjs';
import vm from 'vm';
import fs from 'fs';
import path from 'path';

export class ReplPlugin {
  constructor() {
    globals.pluginsRegistry.set('repl', this);
    // Persistent sandbox context for JavaScript evaluation
    // This maintains state between calls (variables, functions, etc.)
    this.sandboxContext = vm.createContext({
      // Provide common globals that are safe
      console: {
        log: (...args) => this._consoleOutput.push(args.map(a => this._stringify(a)).join(' ')),
        error: (...args) => this._consoleOutput.push('[ERROR] ' + args.map(a => this._stringify(a)).join(' ')),
        warn: (...args) => this._consoleOutput.push('[WARN] ' + args.map(a => this._stringify(a)).join(' ')),
        info: (...args) => this._consoleOutput.push('[INFO] ' + args.map(a => this._stringify(a)).join(' ')),
      },
      // Safe built-ins
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Promise,
      Symbol,
      Error,
      TypeError,
      ReferenceError,
      SyntaxError,
      RangeError,
      // Utilities
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURI,
      decodeURI,
      encodeURIComponent,
      decodeURIComponent,
      // Timers are not provided for security (could block execution)
    });
    this._consoleOutput = [];
    this.registerTools();
  }

  _stringify(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'function') return value.toString();
    if (typeof value === 'symbol') return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  registerTools() {
    globals.dslRegistry.set('repl__js_eval', this.jsEval.bind(this));
    globals.dslRegistry.set('repl__js_import', this.jsImport.bind(this));
  }

  get definition() {
    return [
      {
        type: "function",
        function: {
          name: "repl__js_eval",
          description: "Execute JavaScript code in a persistent sandbox. State (variables, functions) is preserved between calls. Returns the result of the last expression or any console output.",
          parameters: {
            type: "object",
            properties: {
              code: { 
                type: "string", 
                description: "The JavaScript code to execute." 
              }
            },
            required: ["code"]
          }
        },
        metadata: { 
          help: "repl js <code>",
          alias: (args) => {
            if (args[0] === 'repl' && args[1] === 'js') {
              return { name: 'repl__js_eval', args: { code: args.slice(2).join(' ') } };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "repl__js_import",
          description: "Import a JavaScript file into the REPL sandbox. The file's exports become available as a variable in the sandbox. For ES6 modules, both default and named exports are captured.",
          parameters: {
            type: "object",
            properties: {
              filePath: { 
                type: "string", 
                description: "The path to the JavaScript file to import." 
              },
              as: {
                type: "string",
                description: "The variable name to assign the imports to in the sandbox. Defaults to the filename without extension."
              }
            },
            required: ["filePath"]
          }
        },
        metadata: { 
          help: "repl import <filePath> [as <name>]",
          alias: (args) => {
            if (args[0] === 'repl' && args[1] === 'import') {
              const asIndex = args.indexOf('as');
              if (asIndex > 2) {
                return { name: 'repl__js_import', args: { filePath: args.slice(2, asIndex).join(' '), as: args[asIndex + 1] } };
              }
              return { name: 'repl__js_import', args: { filePath: args.slice(2).join(' ') } };
            }
            return false;
          }
        }
      }
    ];
  }

  /**
   * Execute JavaScript code in a sandboxed environment
   * @param {Object} args - Arguments containing the code to execute
   * @param {string} args.code - The JavaScript code to execute
   * @returns {Object} Result object with status and result/error
   */
  async jsEval(args) {
    const { code } = args;

    if (!code || typeof code !== 'string') {
      return {
        status: ToolExecutionStatus.ERROR,
        error: 'Missing required parameter: code'
      };
    }

    // Clear console output buffer for this execution
    this._consoleOutput = [];

    try {
      let result;
      
      // Check if code contains await - if so, wrap in async IIFE
      if (code.includes('await ')) {
        // Wrap in async IIFE to support top-level await
        const asyncCode = `(async () => { return (${code}); })()`;
        const promise = vm.runInContext(asyncCode, this.sandboxContext, {
          timeout: 30000, // Longer timeout for async operations
          displayErrors: true
        });
        result = await promise;
      } else {
        // Execute synchronously for non-async code
        result = vm.runInContext(code, this.sandboxContext, {
          timeout: 5000, // 5 second timeout to prevent infinite loops
          displayErrors: true
        });
      }

      // Build output string
      let output = '';
      
      // Include any console output first
      if (this._consoleOutput.length > 0) {
        output += this._consoleOutput.join('\n') + '\n';
      }

      // Include the result of the expression
      const resultStr = this._stringify(result);
      if (resultStr !== 'undefined' || this._consoleOutput.length === 0) {
        output += resultStr;
      }

      Utils.logInfo(`[REPL] Executed JS: ${code.substring(0, 50)}${code.length > 50 ? '...' : ''}`);
      
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: output.trim() || 'undefined'
      };
    } catch (error) {
      // Return error message in a format similar to what a real REPL would show
      const errorMessage = error.message || String(error);
      const errorName = error.name || 'Error';
      
      Utils.logWarn(`[REPL] JS Error: ${errorName}: ${errorMessage}`);
      
      return {
        status: ToolExecutionStatus.SUCCESS, // Return SUCCESS so LLM sees the error as output
        result: `Uncaught ${errorName}: ${errorMessage}`
      };
    }
  }

  /**
   * Import a JavaScript file into the sandbox
   * @param {Object} args - Arguments containing the file path
   * @param {string} args.filePath - Path to the JavaScript file to import
   * @param {string} args.as - Variable name to assign the imports to (optional)
   * @returns {Object} Result object with status and result/error
   */
  async jsImport(args) {
    const { filePath, as } = args;

    if (!filePath || typeof filePath !== 'string') {
      return {
        status: ToolExecutionStatus.ERROR,
        error: 'Missing required parameter: filePath'
      };
    }

    // Resolve the file path
    const resolvedPath = path.isAbsolute(filePath) 
      ? filePath 
      : path.resolve(process.cwd(), filePath);

    // Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: `Error: File not found: ${resolvedPath}`
      };
    }

    // Derive variable name from filename if not provided
    const varName = as || path.basename(filePath, path.extname(filePath));
    
    // Validate variable name
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(varName)) {
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: `Error: Invalid variable name: ${varName}. Must be a valid JavaScript identifier.`
      };
    }

    try {
      // Use dynamic import to load the ES6 module
      const fileUrl = 'file://' + resolvedPath;
      const module = await import(fileUrl);
      
      // Make the module available in the sandbox
      // Include both default export and named exports
      const exports = {};
      for (const [key, value] of Object.entries(module)) {
        exports[key] = value;
      }
      
      // If there's a default export, also make it directly accessible
      if (module.default) {
        this.sandboxContext[varName] = module.default;
        // Also add named exports as properties if default is an object/class
        if (typeof module.default === 'function' || typeof module.default === 'object') {
          // Keep named exports available separately
          for (const [key, value] of Object.entries(module)) {
            if (key !== 'default') {
              this.sandboxContext[key] = value;
            }
          }
        }
      } else {
        // No default export, assign all named exports to the variable
        this.sandboxContext[varName] = exports;
      }
      
      // Also expose all named exports directly in the sandbox
      for (const [key, value] of Object.entries(module)) {
        if (key !== 'default') {
          this.sandboxContext[key] = value;
        }
      }

      // Build result message
      const exportNames = Object.keys(module).filter(k => k !== 'default');
      const hasDefault = 'default' in module;
      
      let resultParts = [];
      if (hasDefault) {
        resultParts.push(`default export -> ${varName}`);
      }
      if (exportNames.length > 0) {
        resultParts.push(`named exports: ${exportNames.join(', ')}`);
      }

      Utils.logInfo(`[REPL] Imported: ${resolvedPath} as ${varName}`);
      
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: `Imported ${path.basename(filePath)}: ${resultParts.join('; ')}`
      };
    } catch (error) {
      const errorMessage = error.message || String(error);
      const errorName = error.name || 'Error';
      
      Utils.logWarn(`[REPL] Import Error: ${errorName}: ${errorMessage}`);
      
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: `Import Error: ${errorName}: ${errorMessage}`
      };
    }
  }
}

export const replPlugin = new ReplPlugin();
