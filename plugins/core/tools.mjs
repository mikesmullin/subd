import { globals } from '../../common/globals.mjs';
import { Utils } from '../../common/utils.mjs';
import { WorkspaceManager } from '../agent/controllers/workspace.mjs';
import { SessionModel } from '../agent/models/session.mjs';
import { toYaml } from '../../common/yaml-db.mjs';
import { ToolExecutionStatus } from '../agent/controllers/host-container-bridge.mjs';
import { CoreContext } from './context.mjs';
import fs from 'fs';

export class CoreTools {
  constructor(plugin) {
    this.plugin = plugin;
    this.coreContext = new CoreContext(plugin);
  }

  async context(args, context) {
    return await this.coreContext.context(args, context);
  }

  help(args) {
    const pattern = args?.pattern;
    
    // Generate TSV of all tools
    const lines = [];
    
    let tools = [];
    
    for (const plugin of globals.pluginsRegistry.values()) {
      const def = plugin.definition;
      if (Array.isArray(def)) {
        for (const tool of def) {
          tools.push(tool);
        }
      }
    }

    // Filter if pattern provided
    if (pattern) {
        let p = pattern;
        // If no wildcard provided, imply wildcard on both sides
        if (!p.includes('*')) {
            p = '*' + p + '*';
        }
        // Convert glob pattern to regex
        // Escape special regex characters, then replace * with .*
        const regexString = '^' + p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
        const filterRegex = new RegExp(regexString);
        
        tools = tools.filter(t => filterRegex.test(t.function.name));
    }
    
    // Sort tools alphabetically by name
    tools.sort((a, b) => a.function.name.localeCompare(b.function.name));
    
    const rows = tools.map(tool => ({
        Name: tool.function.name,
        'Usage/Alias': tool.metadata?.help || '',
        Description: tool.function.description || ''
    }));

    const output = Utils.outputAs('table', rows, { truncate: true, truncateLength: 60 });
    Utils.logInfo(output);
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: output
    };
  }

  listWidgets() {
    const widgets = Array.from(globals.widgetRegistry.keys()).sort();
    
    if (widgets.length === 0) {
      const msg = "No widgets available.";
      Utils.logInfo(msg);
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: msg
      };
    }

    const lines = [];
    lines.push('Available Widgets:');
    for (const name of widgets) {
      const widget = globals.widgetRegistry.get(name);
      const plugin = widget.plugin || 'unknown';
      lines.push(`  ${name.padEnd(30)}`);
    }
    
    const output = lines.join('\n');
    Utils.logInfo(output);
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: output
    };
  }

  // Config management tools
  configSet(args) {
    const { key, value } = args;
    if (!key) {
      const msg = "Error: key is required";
      Utils.logError(msg);
      return {
        status: ToolExecutionStatus.FAILURE,
        error: msg
      };
    }
    
    // Parse value (try as JSON, fall back to string)
    let parsedValue = value;
    if (typeof value === 'string') {
      try {
        parsedValue = JSON.parse(value);
      } catch (e) {
        // Not JSON, use as string
      }
    }
    
    globals.setConfig(key, parsedValue);
    
    // Sync log level to in-memory state if log.level was changed
    if (key === 'log.level') {
      Utils.setLogLevel(parsedValue);
    }
    
    const msg = `Config ${key} = ${JSON.stringify(parsedValue)}`;
    Utils.logInfo(msg);
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: msg
    };
  }

  configGet(args) {
    const { key } = args;
    const value = key ? globals.getConfig(key) : globals.config;
    
    if (value === undefined) {
      const msg = `Config key "${key}" not found`;
      Utils.logInfo(msg);
      return {
        status: ToolExecutionStatus.FAILURE,
        error: msg
      };
    }
    
    const output = JSON.stringify(value, null, 2);
    Utils.logInfo(output);
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: output
    };
  }

  configList() {
    const flattened = globals.getFlattenedConfig();
    const lines = Object.entries(flattened)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
    
    const output = lines.join('\n');
    Utils.logInfo(output);
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: output || "No config values"
    };
  }

  configSave(args) {
    const path = args?.path || globals.dbPaths.config;
    
    try {
      // Use js-yaml for proper multi-line formatting
      const yaml = toYaml(globals.config);
      fs.writeFileSync(path, yaml, 'utf8');
      const msg = `Config saved to ${path}`;
      Utils.logInfo(msg);
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: msg
      };
    } catch (e) {
      const msg = `Failed to save config: ${e.message}`;
      Utils.logError(msg);
      return {
        status: ToolExecutionStatus.FAILURE,
        error: msg
      };
    }
  }

  configLoad(args) {
    const path = args?.path || globals.dbPaths.config;
    
    try {
      globals.loadConfig(path);
      const msg = `Config loaded from ${path}`;
      Utils.logInfo(msg);
      return {
        status: ToolExecutionStatus.SUCCESS,
        result: msg
      };
    } catch (e) {
      const msg = `Failed to load config: ${e.message}`;
      Utils.logError(msg);
      return {
        status: ToolExecutionStatus.FAILURE,
        error: msg
      };
    }
  }

  configReset() {
    globals.config = {};
    const msg = "Config reset to empty state (not saved to disk)";
    Utils.logInfo(msg);
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: msg
    };
  }

  // System management tools
  exit() {
    const msg = "Exiting...";
    Utils.logInfo(msg);
    process.exit(0);
  }

  pause() {
    globals.pause();
    const msg = "System paused";
    Utils.logInfo(msg);
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: msg
    };
  }

  resume() {
    globals.resume();
    const msg = "System resumed";
    Utils.logInfo(msg);
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: msg
    };
  }

  stop() {
    globals.commandQueue = [];
    const msg = "Command queue cleared";
    Utils.logInfo(msg);
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: msg
    };
  }

  clean() {
    for (const collection of globals.dbCollections) {
      // Skip templates
      if (collection.dirPath.includes('templates')) continue;
      
      for (const id of collection.list()) {
        collection.delete(id);
      }
      collection.save();
    }
    
    // Clean up workspaces
    WorkspaceManager.cleanupAll();
    
    SessionModel.resetId();
    // Truncate daemon.log
    try { fs.writeFileSync('./daemon.log', ''); } catch (e) {}
    const msg = "All temporary files removed from disk.";
    Utils.logInfo(msg);
    return {
      status: ToolExecutionStatus.SUCCESS,
      result: msg
    };
  }



  get definition() {
    return [
      {
        type: "function",
        function: {
          name: "core__help",
          description: "List all available tools and their descriptions",
          parameters: { 
            type: "object", 
            properties: {
              pattern: { type: "string", description: "Optional glob pattern to filter tools (e.g. 'shell*')" }
            } 
          }
        },
        metadata: {
          humanOnly: true,
          localCommand: true,
          help: "help [pattern]",
          alias: (args) => {
            // Matches: help [pattern] or tools [pattern]
            if (args[0] === 'help' || args[0] === 'tools') {
              const pattern = args[1];
              return { name: 'core__help', args: { pattern } };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "core__widgets__list",
          description: "List available dashboard widgets",
          parameters: { type: "object", properties: {} }
        },
        metadata: {
          humanOnly: true,
          help: "widgets",
          alias: (args) => {
            if (args.length === 1 && args[0] === 'widgets') {
              return { name: 'core__widgets__list', args: {} };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "core__config__set",
          description: "Set a configuration value",
          parameters: {
            type: "object",
            properties: {
              key: { type: "string", description: "Config key (dot notation, e.g. 'unattended')" },
              value: { description: "Config value (any JSON type)" }
            },
            required: ["key", "value"]
          }
        },
        metadata: {
          humanOnly: true,
          localCommand: true,
          help: "set <key> <value>",
          alias: (args) => {
            if (args[0] === 'set' && args.length >= 3) {
              return { 
                name: 'core__config__set', 
                args: { key: args[1], value: args.slice(2).join(' ') } 
              };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "core__config__get",
          description: "Get a configuration value",
          parameters: {
            type: "object",
            properties: {
              key: { type: "string", description: "Config key (dot notation). Omit to get all config." }
            }
          }
        },
        metadata: {
          humanOnly: true,
          localCommand: true,
          help: "get [key]",
          alias: (args) => {
            if (args[0] === 'get') {
              return { name: 'core__config__get', args: { key: args[1] } };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "core__config__list",
          description: "List all configuration values (flattened)",
          parameters: { type: "object", properties: {} }
        },
        metadata: {
          humanOnly: true,
          localCommand: true,
          help: "vars",
          alias: (args) => {
            if (args.length === 1 && args[0] === 'vars') {
              return { name: 'core__config__list', args: {} };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "core__config__save",
          description: "Save current configuration to YAML file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to save to (default: project config.yml)" }
            }
          }
        },
        metadata: {
          humanOnly: true,
          help: "save [path]",
          alias: (args) => {
            if (args[0] === 'save') {
              return { name: 'core__config__save', args: { path: args[1] } };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "core__config__load",
          description: "Load configuration from YAML file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to load from (default: project config.yml)" }
            }
          }
        },
        metadata: {
          humanOnly: true,
          help: "load [path]",
          alias: (args) => {
            if (args[0] === 'load') {
              return { name: 'core__config__load', args: { path: args[1] } };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "core__config__reset",
          description: "Reset configuration to empty state (not saved to disk)",
          parameters: { type: "object", properties: {} }
        },
        metadata: {
          humanOnly: true,
          help: "reset",
          alias: (args) => {
            if (args.length === 1 && args[0] === 'reset') {
              return { name: 'core__config__reset', args: {} };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "core__system__exit",
          description: "Shutdown the daemon",
          parameters: { type: "object", properties: {} }
        },
        metadata: {
          humanOnly: true,
          localCommand: true,
          help: "exit",
          alias: (args) => {
            if (args.length === 1 && args[0] === 'exit') {
              return { name: 'core__system__exit', args: {} };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "core__system__pause",
          description: "Pause processing",
          parameters: { type: "object", properties: {} }
        },
        metadata: {
          humanOnly: true,
          localCommand: true,
          help: "pause (p)",
          alias: (args) => {
            if (args.length === 1 && (args[0] === 'pause' || args[0] === 'p')) {
              return { name: 'core__system__pause', args: {} };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "core__system__resume",
          description: "Resume processing",
          parameters: { type: "object", properties: {} }
        },
        metadata: {
          humanOnly: true,
          localCommand: true,
          help: "continue (c)",
          alias: (args) => {
            if (args.length === 1 && (args[0] === 'continue' || args[0] === 'c')) {
              return { name: 'core__system__resume', args: {} };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "core__system__stop",
          description: "Clear command queue",
          parameters: { type: "object", properties: {} }
        },
        metadata: {
          humanOnly: true,
          localCommand: true,
          help: "stop (s)",
          alias: (args) => {
            if (args.length === 1 && (args[0] === 'stop' || args[0] === 's')) {
              return { name: 'core__system__stop', args: {} };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "core__system__clean",
          description: "Delete DB files and cleanup workspaces",
          parameters: { type: "object", properties: {} }
        },
        metadata: {
          humanOnly: true,
          localCommand: true,
          help: "clean",
          alias: (args) => {
            if (args.length === 1 && args[0] === 'clean') {
              return { name: 'core__system__clean', args: {} };
            }
            return false;
          }
        }
      },
      {
        type: "function",
        function: {
          name: "core__memory_context",
          description: "Show agent context window memory usage report",
          parameters: { type: "object", properties: {} }
        },
        metadata: {
          humanOnly: true,
          localCommand: true,
          help: "context [id]",
          alias: (args) => {
            if (args.length >= 1 && args[0] === 'context') {
              return { name: 'core__memory_context', args: { id: args[1] } };
            }
            return false;
          }
        }
      }
    ];
  }
}
