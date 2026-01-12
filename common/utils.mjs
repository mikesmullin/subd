import { globals } from './globals.mjs';

export class Utils {
  static LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
  };

  static currentLogLevel = 'info';

  static setLogLevel(level) {
    if (this.LOG_LEVELS[level] !== undefined) {
      this.currentLogLevel = level;
    }
  }

  static shouldLog(level) {
    return this.LOG_LEVELS[level] >= this.LOG_LEVELS[this.currentLogLevel];
  }

  static logListeners = new Set();

  static addLogListener(listener) {
    this.logListeners.add(listener);
  }

  static removeLogListener(listener) {
    this.logListeners.delete(listener);
  }

  static emitLog(level, message) {
    for (const listener of this.logListeners) {
      listener({ level, message, timestamp: new Date() });
    }
  }

  static logHandler = null;

  static setLogHandler(handler) {
    this.logHandler = handler;
  }

  static getHandler() {
    if (this.logHandler) {
      return this.logHandler;
    }
    console.error('No log handler set!');
    process.exit(1);
  }

  static logInfo(message, context = {}) {
    if (this.shouldLog('info')) {
      this.getHandler()('info', Utils.colorize('#3498db', `[INFO] ${this.formatTime(new Date())}: `)+ message, context);
      this.emitLog('info', message);
    }
  }

  static logWarn(message, context = {}) {
    if (this.shouldLog('warn')) {
      this.getHandler()('warn', Utils.colorize('#f1c40f', `[WARN] ${this.formatTime(new Date())}: `)+ message, context);
      this.emitLog('warn', message);
    }
  }

  static logDebug(message, context = {}) {
    if (this.shouldLog('debug')) {
      this.getHandler()('debug', Utils.colorize('#95a5a6', `[DEBUG] ${this.formatTime(new Date())}: `)+ message, context);
      this.emitLog('debug', message);
    }
  }

  // this is a special case of Debug that is only used temporarily during refactoring. these will be removed in occasional cleanup passes by the human programmer, after troubleshooting is completed successfully.
  static logTrace(message, context = {}) {
    if (this.shouldLog('debug')) {
      this.getHandler()('debug', Utils.colorize('#95a5a6', `[TRACE] ${this.formatTime(new Date())}: `)+ message, context);
      this.emitLog('debug', message);
    }
  }  

  static logError(message, context = {}) {
    if (this.shouldLog('error')) {
      this.getHandler()('error', Utils.colorize('#e74c3c', `[ERROR] ${this.formatTime(new Date())}: `)+ message, context);
      this.emitLog('error', message);
    }
  }

  static colorize(colorInput, text) {
    let isBg = false;
    let colorValue = colorInput.toLowerCase();

    // Parse prefixes
    if (colorValue.startsWith('background:')) {
      isBg = true;
      colorValue = colorValue.substring(11).trim();
    } else if (colorValue.startsWith('color:')) {
      colorValue = colorValue.substring(6).trim();
    }

    // Helper to wrap ANSI
    const wrap = (code) => `${code}${text}\x1b[0m`;

    // 1. Handle Hex Colors (TrueColor)
    if (colorValue.startsWith('#')) {
      const hex = colorValue.substring(1);
      // Handle shorthand #333 -> #333333
      const fullHex = hex.length === 3 
        ? hex.split('').map(c => c + c).join('') 
        : hex;
      
      const r = parseInt(fullHex.substring(0, 2), 16);
      const g = parseInt(fullHex.substring(2, 4), 16);
      const b = parseInt(fullHex.substring(4, 6), 16);
      
      return wrap(`\x1b[${isBg ? 48 : 38};2;${r};${g};${b}m`);
    }

    // 2. Handle RGB Colors (TrueColor)
    if (colorValue.startsWith('rgb(')) {
      const match = colorValue.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      if (match) {
        const [_, r, g, b] = match;
        return wrap(`\x1b[${isBg ? 48 : 38};2;${r};${g};${b}m`);
      }
    }

    // 3. Handle Named Colors
    const namedColors = {
      // Standard (FG code)
      reset: 0,
      black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
      gray: 90, grey: 90,
      
      // Bright (FG code)
      bright_red: 91, bright_green: 92, bright_yellow: 93, bright_blue: 94, 
      bright_magenta: 95, bright_cyan: 96, bright_white: 97,

      // Extended (256-color index)
      orange: { index: 208 },
      purple: { index: 129 },
      pink: { index: 213 },
      lime: { index: 46 },
      teal: { index: 30 },
      violet: { index: 93 },
      
      // Custom (TrueColor RGB)
      construction_yellow: { rgb: [206, 173, 73] },
      money_green: { rgb: [37, 168, 103] },
      indigo: { rgb: [128, 114, 174] }
    };

    const def = namedColors[colorValue];
    if (def !== undefined) {
      if (typeof def === 'number') {
        // 4-bit / 16-color (the original ANSI colors)
        // Standard/Bright: FG=N, BG=N+10 (except reset)
        const code = def === 0 ? 0 : (def + (isBg ? 10 : 0));
        return wrap(`\x1b[${code}m`);
      }
      if (def.index !== undefined) {
        // 8-bit / 256-color
        return wrap(`\x1b[${isBg ? 48 : 38};5;${def.index}m`);
      }
      if (def.rgb) {
        // 24-bit / True Color (16.7 million colors)
        const [r, g, b] = def.rgb;
        return wrap(`\x1b[${isBg ? 48 : 38};2;${r};${g};${b}m`);
      }
    }

    return text;
  }

  static debounce(fn, delay) {
    let timeoutId;
    return function (...args) {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  static throttle(fn, delay) {
    let lastCall = 0;
    return function (...args) {
      const now = new Date().getTime();
      if (now - lastCall < delay) {
        return;
      }
      lastCall = now;
      return fn.apply(this, args);
    };
  }

  static parseDSL(commandString) {
    // Parser: split by spaces, respecting quotes
    // YAML/JSON flow syntax ({...} or [...]) only allowed as final argument
    const trimmed = commandString.trim();
    
    // Check for trailing YAML/JSON structure as final arg
    let mainPart = trimmed;
    let trailingArg = null;
    
    const lastChar = trimmed[trimmed.length - 1];
    if (lastChar === '}' || lastChar === ']') {
      const closeChar = lastChar;
      const openChar = closeChar === '}' ? '{' : '[';
      
      // Find matching opener by counting depth from end
      let depth = 0;
      let inQuote = false;
      let quoteChar = null;
      
      for (let i = trimmed.length - 1; i >= 0; i--) {
        const char = trimmed[i];
        
        // Track quotes (simple - doesn't handle escapes in reverse)
        if ((char === '"' || char === "'") && (i === 0 || trimmed[i-1] !== '\\')) {
          if (!inQuote) {
            inQuote = true;
            quoteChar = char;
          } else if (char === quoteChar) {
            inQuote = false;
            quoteChar = null;
          }
        }
        
        if (!inQuote) {
          if (char === closeChar) depth++;
          else if (char === openChar) depth--;
          
          if (depth === 0) {
            // Found the matching opener
            trailingArg = trimmed.slice(i);
            mainPart = trimmed.slice(0, i).trim();
            break;
          }
        }
      }
    }
    
    // Parse the main part with simple space splitting (respecting quotes)
    const args = [];
    let current = '';
    let inQuote = false;
    let quoteChar = null;
    
    for (let i = 0; i < mainPart.length; i++) {
      const char = mainPart[i];
      
      if (char === '\\' && i + 1 < mainPart.length) {
        current += char + mainPart[i + 1];
        i++;
        continue;
      }
      
      if ((char === '"' || char === "'") && (!inQuote || char === quoteChar)) {
        inQuote = !inQuote;
        quoteChar = inQuote ? char : null;
        current += char;
      } else if (char === ' ' && !inQuote) {
        if (current.length > 0) {
          args.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
    if (current.length > 0) {
      args.push(current);
    }
    
    // Add trailing YAML/JSON arg if present
    if (trailingArg) {
      args.push(trailingArg);
    }
    
    if (args.length === 0) return null;
    
    return {
      command: args[0],
      args: args.slice(1)
    };
  }

  static formatTime(date) {
    return date.toISOString();
  }

  static outputAs(type, data, options = {}) {
    const kind = String(type || '').toLowerCase();
    const { truncate = false, truncateLength = 50, flatten = false } = options;

    const truncateValue = (value) => {
      if (!truncate || typeof value !== 'string') return value;
      return value.length > truncateLength ? value.substring(0, truncateLength - 3) + '...' : value;
    };

    const truncateData = (obj) => {
      if (Array.isArray(obj)) {
        return obj.map(truncateData);
      } else if (obj && typeof obj === 'object') {
        const truncated = {};
        for (const [key, value] of Object.entries(obj)) {
          truncated[key] = truncateData(value);
        }
        return truncated;
      } else {
        return truncateValue(obj);
      }
    };

    let processedData = data;
    if (kind === 'table' && truncate) processedData = truncateData(processedData);

    if (kind === 'json') {
      return JSON.stringify(processedData, null, 2);
    }

    // Normalize to array of row objects
    let rows;
    if (Array.isArray(processedData)) {
      rows = processedData;
    } else if (processedData && typeof processedData === 'object') {
      rows = [processedData];
    } else {
      rows = [{ value: processedData }];
    }

    // Derive column keys
    const keys = Array.from(
      rows.reduce((set, row) => {
        if (row && typeof row === 'object' && !Array.isArray(row)) {
          Object.keys(row).forEach(k => set.add(k));
        } else {
          set.add('value');
        }
        return set;
      }, new Set())
    );

    const formatCell = (v) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    };

    if (kind === 'table') {
      if (rows.length === 0) return '';

      // Calculate column widths
      const colWidths = keys.map((key, i) => {
        const headerWidth = key.length;
        const dataWidths = rows.map(r => {
          const rowObj = (r && typeof r === 'object' && !Array.isArray(r)) ? r : { value: r };
          return formatCell(rowObj[key]).replace(/\|/g, '\\|').replace(/\n/g, '<br>').length;
        });
        return Math.max(headerWidth, ...dataWidths);
      });

      // Format header
      const header = keys.map((k, i) => k.padEnd(colWidths[i])).join(' | ');

      // Format separator
      const separator = colWidths.map(w => '-'.repeat(w)).join('-|-');

      // Format body
      const body = rows
        .map(r => {
          const rowObj = (r && typeof r === 'object' && !Array.isArray(r)) ? r : { value: r };
          return keys.map((k, i) =>
            formatCell(rowObj[k]).replace(/\|/g, '\\|').replace(/\n/g, '<br>').padEnd(colWidths[i])
          ).join(' | ');
        })
        .join('\n');

      return `\n${header}\n${separator}\n${body}`;
    }
    
    return JSON.stringify(data, null, 2);
  }

  static colorize(colorInput, text) {
    if (!colorInput) return text;
    
    let isBg = false;
    let colorValue = String(colorInput).toLowerCase();

    // Parse prefixes
    if (colorValue.startsWith('background:')) {
      isBg = true;
      colorValue = colorValue.substring(11).trim();
    } else if (colorValue.startsWith('color:')) {
      colorValue = colorValue.substring(6).trim();
    }

    // Helper to wrap ANSI
    const wrap = (code) => `${code}${text}\x1b[0m`;

    // 1. Handle Hex Colors (TrueColor)
    if (colorValue.startsWith('#')) {
      const hex = colorValue.substring(1);
      // Handle shorthand #333 -> #333333
      const fullHex = hex.length === 3 
        ? hex.split('').map(c => c + c).join('') 
        : hex;
      
      const r = parseInt(fullHex.substring(0, 2), 16);
      const g = parseInt(fullHex.substring(2, 4), 16);
      const b = parseInt(fullHex.substring(4, 6), 16);
      
      if (isNaN(r) || isNaN(g) || isNaN(b)) return text;
      
      return wrap(`\x1b[${isBg ? 48 : 38};2;${r};${g};${b}m`);
    }

    // 2. Handle RGB Colors (TrueColor)
    if (colorValue.startsWith('rgb(')) {
      const match = colorValue.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
      if (match) {
        const [_, r, g, b] = match;
        return wrap(`\x1b[${isBg ? 48 : 38};2;${r};${g};${b}m`);
      }
    }

    // 3. Handle Named Colors
    const namedColors = {
      // Standard (FG code)
      reset: 0,
      black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
      gray: 90, grey: 90,
      
      // Bright (FG code)
      bright_red: 91, bright_green: 92, bright_yellow: 93, bright_blue: 94, 
      bright_magenta: 95, bright_cyan: 96, bright_white: 97,

      // Extended (256-color index)
      orange: { index: 208 },
      purple: { index: 129 },
      pink: { index: 213 },
      lime: { index: 46 },
      teal: { index: 30 },
      violet: { index: 93 },
      
      // Custom (TrueColor RGB)
      construction_yellow: { rgb: [206, 173, 73] },
      money_green: { rgb: [37, 168, 103] },
      indigo: { rgb: [128, 114, 174] }
    };

    const def = namedColors[colorValue];
    if (def !== undefined) {
      if (typeof def === 'number') {
        // Standard/Bright: FG=N, BG=N+10 (except reset)
        const code = def === 0 ? 0 : (def + (isBg ? 10 : 0));
        return wrap(`\x1b[${code}m`);
      }
      if (def.index !== undefined) {
        // 256-color
        return wrap(`\x1b[${isBg ? 48 : 38};5;${def.index}m`);
      }
      if (def.rgb) {
        // TrueColor
        const [r, g, b] = def.rgb;
        return wrap(`\x1b[${isBg ? 48 : 38};2;${r};${g};${b}m`);
      }
    }

    return text;
  }

  /**
   * @deprecated - Use bridge.route() instead for stateful tool execution
   * 
   * Execute a tool with automatic host routing if needed.
   * This is the universal tool executor that checks metadata and routes accordingly.
   * 
   * @param {string} toolName - Name of the tool to execute
   * @param {object} args - Tool arguments
   * @param {object} context - Execution context with { sessionId, toolCallId, signal }
   * @param {Map} toolMetadata - Optional pre-built metadata map (for performance)
   * @returns {Promise<any>} Tool execution result
   */
  static async executeTool(toolName, args, context = {}, toolMetadata = null) {
    throw new Error('executeTool() is deprecated. Use bridge.route() instead.');
  }

  /**
   * @deprecated - Use bridge.route() instead for stateful tool execution
   * 
   * Execute a tool via Unix socket (for host-only tools).
   * Extracted from AgentLoop.executeToolViaSocket for reuse.
   * 
   * @param {string} name - Tool name
   * @param {object} args - Tool arguments
   * @param {object} context - Context with sessionId and toolCallId
   * @returns {Promise<any>} Tool execution result
   */
  static async executeToolViaSocket(name, args, context = {}) {
    throw new Error('executeToolViaSocket() is deprecated. Use bridge.route() instead.');
  }
}
