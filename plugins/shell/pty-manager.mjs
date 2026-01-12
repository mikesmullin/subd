/**
 * PTY Session Manager
 * 
 * Manages pseudo-terminal sessions for agents, providing:
 * - Session isolation per agent
 * - ANSI code stripping
 * - Cursor tracking for incremental reads
 * - Terminal buffer management
 */

import { spawn } from 'bun-pty';
import { platform } from 'os';

/**
 * Strip ANSI escape codes from text
 * @param {string} text - Text with ANSI codes
 * @returns {string} Clean text without ANSI codes
 */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][0-9];[^\x07]*\x07/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/\r/g, '');
}

/**
 * PTY Session class
 * Manages a single pseudo-terminal instance
 */
class PTYSession {
  constructor(options = {}) {
    this.id = options.id;
    this.name = options.name || `pty-${this.id}`;
    this.agentSessionId = options.agentSessionId;
    this.cwd = options.cwd || process.cwd();
    this.env = { ...process.env, ...options.env };
    this.shell = options.shell || (platform() === 'win32' ? 'powershell.exe' : 'bash');
    
    // Terminal dimensions
    this.cols = options.cols || 80;
    this.rows = options.rows || 24;
    
    // Buffer management
    this.buffer = [];  // Array of lines
    this.lastReadLine = 0;  // Cursor for incremental reads
    this.maxBufferLines = 1000;  // Keep last 1000 lines
    
    // Create PTY using bun-pty
    // bun-pty.spawn(file, args, options)
    this.pty = spawn(this.shell, [], {
      name: 'xterm-color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: this.env
    });
    
    // Collect output
    this.pty.onData((data) => {
      this.handleData(data);
    });
    
    // Track exit
    this.pty.onExit((exitEvent) => {
      this.exitCode = exitEvent.exitCode;
      this.signal = exitEvent.signal;
      this.closed = true;
    });
    
    this.closed = false;
    this.createdAt = new Date();
  }
  
  /**
   * Handle incoming data from PTY
   * @param {string} data - Raw data from PTY
   */
  handleData(data) {
    // Strip ANSI codes
    const clean = stripAnsi(data);
    
    // Split into lines and add to buffer
    const lines = clean.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (i === 0 && this.buffer.length > 0) {
        // Append to last line if it's a continuation
        this.buffer[this.buffer.length - 1] += line;
      } else {
        // Add as new line
        this.buffer.push(line);
      }
    }
    
    // Trim buffer if it exceeds max size
    if (this.buffer.length > this.maxBufferLines) {
      const excess = this.buffer.length - this.maxBufferLines;
      this.buffer.splice(0, excess);
      
      // Adjust cursor
      this.lastReadLine = Math.max(0, this.lastReadLine - excess);
    }
  }
  
  /**
   * Write text to PTY
   * @param {string} text - Text to send
   */
  write(text) {
    if (this.closed) {
      throw new Error(`PTY session ${this.id} is closed`);
    }
    this.pty.write(text);
  }
  
  /**
   * Read from PTY buffer
   * @param {Object} options - Read options
   * @param {number} options.lines - Number of lines to read (from end of buffer)
   * @param {boolean} options.sinceLastRead - Only return new lines since last read
   * @returns {Object} { content, linesRead, totalLines }
   */
  read(options = {}) {
    const { lines = null, sinceLastRead = false } = options;
    
    let startLine, endLine;
    
    if (sinceLastRead) {
      // Return only new content since last read
      startLine = this.lastReadLine;
      endLine = this.buffer.length;
    } else if (lines !== null) {
      // Return last N lines
      startLine = Math.max(0, this.buffer.length - lines);
      endLine = this.buffer.length;
    } else {
      // Return visible portion (last rows worth of lines)
      startLine = Math.max(0, this.buffer.length - this.rows);
      endLine = this.buffer.length;
    }
    
    // Update cursor
    this.lastReadLine = endLine;
    
    // Extract lines
    const content = this.buffer.slice(startLine, endLine).join('\n');
    
    return {
      content,
      linesRead: endLine - startLine,
      totalLines: this.buffer.length,
      lastReadLine: this.lastReadLine
    };
  }
  
  /**
   * Snapshot of PTY buffer (without advancing cursor)
   * @returns {string} Content of the last N rows
   */
  snapshot() {
    // Return visible portion (last rows worth of lines)
    const startLine = Math.max(0, this.buffer.length - this.rows);
    const endLine = this.buffer.length;
    
    // Extract lines
    return this.buffer.slice(startLine, endLine).join('\n');
  }
  
  /**
   * Resize the terminal
   * @param {number} cols - Columns
   * @param {number} rows - Rows
   */
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (!this.closed && this.pty.resize) {
      this.pty.resize(cols, rows);
    }
  }
  
  /**
   * Close the PTY session
   * @param {boolean} force - Force kill if graceful close fails
   */
  close(force = false) {
    if (this.closed) {
      return;
    }
    
    try {
      // bun-pty uses exit() method
      if (this.pty.exit) {
        this.pty.exit();
      } else if (this.pty.kill) {
        this.pty.kill();
      }
    } catch (error) {
      // Already closed
    }
    
    this.closed = true;
  }
  
  /**
   * Get session info
   * @returns {Object} Session metadata
   */
  getInfo() {
    return {
      id: this.id,
      name: this.name,
      agentSessionId: this.agentSessionId,
      cwd: this.cwd,
      shell: this.shell,
      cols: this.cols,
      rows: this.rows,
      bufferLines: this.buffer.length,
      lastReadLine: this.lastReadLine,
      closed: this.closed,
      exitCode: this.exitCode,
      signal: this.signal,
      createdAt: this.createdAt
    };
  }
}

/**
 * PTY Manager
 * Manages all PTY sessions with agent isolation
 */
export class PTYManager {
  constructor() {
    // Map of sessionKey -> PTYSession
    // sessionKey format: `${agentSessionId}:${ptySessionId}`
    this.sessions = new Map();
    this.nextId = 1;
  }
  
  /**
   * Generate session key
   * @param {string} agentSessionId - Agent session ID
   * @param {string} ptySessionId - PTY session ID
   * @returns {string} Combined key
   */
  getSessionKey(agentSessionId, ptySessionId) {
    return `${agentSessionId}:${ptySessionId}`;
  }
  
  /**
   * Create a new PTY session
   * @param {string} agentSessionId - Agent session ID
   * @param {Object} options - PTY options
   * @returns {PTYSession} New session
   */
  createSession(agentSessionId, options = {}) {
    const ptySessionId = options.id || `${this.nextId++}`;
    const sessionKey = this.getSessionKey(agentSessionId, ptySessionId);
    
    const session = new PTYSession({
      ...options,
      id: ptySessionId,
      agentSessionId
    });
    
    this.sessions.set(sessionKey, session);
    
    // Send initial commands if provided
    if (options.initialCommands) {
      session.write(options.initialCommands);
    }
    
    return session;
  }
  
  /**
   * Get a PTY session
   * @param {string} agentSessionId - Agent session ID
   * @param {string} ptySessionId - PTY session ID
   * @returns {PTYSession|null} Session or null if not found
   */
  getSession(agentSessionId, ptySessionId) {
    const sessionKey = this.getSessionKey(agentSessionId, ptySessionId);
    return this.sessions.get(sessionKey) || null;
  }
  
  /**
   * Close a PTY session
   * @param {string} agentSessionId - Agent session ID
   * @param {string} ptySessionId - PTY session ID
   * @param {boolean} force - Force close
   * @returns {boolean} True if session was found and closed
   */
  closeSession(agentSessionId, ptySessionId, force = false) {
    const sessionKey = this.getSessionKey(agentSessionId, ptySessionId);
    const session = this.sessions.get(sessionKey);
    
    if (!session) {
      return false;
    }
    
    session.close(force);
    this.sessions.delete(sessionKey);
    return true;
  }
  
  /**
   * Close all PTY sessions for an agent
   * @param {string} agentSessionId - Agent session ID
   * @returns {number} Number of sessions closed
   */
  closeAgentSessions(agentSessionId) {
    let count = 0;
    const prefix = `${agentSessionId}:`;
    
    for (const [sessionKey, session] of this.sessions.entries()) {
      if (sessionKey.startsWith(prefix)) {
        session.close(true);
        this.sessions.delete(sessionKey);
        count++;
      }
    }
    
    return count;
  }
  
  /**
   * List all PTY sessions for an agent
   * @param {string} agentSessionId - Agent session ID
   * @returns {Array} Array of session info objects
   */
  listAgentSessions(agentSessionId) {
    const prefix = `${agentSessionId}:`;
    const sessions = [];
    
    for (const [sessionKey, session] of this.sessions.entries()) {
      if (sessionKey.startsWith(prefix)) {
        sessions.push(session.getInfo());
      }
    }
    
    return sessions;
  }
  
  /**
   * Get total session count
   * @returns {number} Total sessions
   */
  getTotalSessions() {
    return this.sessions.size;
  }
}

// Singleton instance
export const ptyManager = new PTYManager();
