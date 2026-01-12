import { globals } from '../../../common/globals.mjs';
import { Utils } from '../../../common/utils.mjs';
import { writeYaml, fromYaml } from '../../../common/yaml-db.mjs';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Manages isolated git workspaces for agent sessions.
 * Each session gets its own workspace directory at db/workspaces/<session_id>/
 * that is volume-mounted to the container, allowing safe file modifications.
 */
export class WorkspaceManager {
  /**
   * Get the workspace directory path for a session
   * @param {string} sessionId 
   * @returns {string} Absolute path to the workspace
   */
  static getWorkspacePath(sessionId) {
    return path.join(globals.dbPaths.workspaces, sessionId);
  }

  /**
   * Create an isolated git workspace for a session.
   * Uses git worktree if available, otherwise copies committed files.
   * @param {string} sessionId 
   * @returns {string} Path to the created workspace
   */
  static create(sessionId) {
    const workspacePath = this.getWorkspacePath(sessionId);
    
    // Ensure parent directory exists
    const workspacesDir = path.dirname(workspacePath);
    if (!fs.existsSync(workspacesDir)) {
      fs.mkdirSync(workspacesDir, { recursive: true });
    }
    
    // Check if workspace already exists
    if (fs.existsSync(workspacePath)) {
      Utils.logDebug(`Workspace already exists for session ${sessionId}`);
      return workspacePath;
    }
    
    // Use git worktree
    if (this._tryCreateWorktree(sessionId, workspacePath)) {
      return workspacePath;
    }
    
    throw new Error(`Failed to create git worktree for session ${sessionId}`);
  }

  /**
   * Remove a session's workspace directory
   * @param {string} sessionId 
   */
  static cleanup(sessionId) {
    const workspacePath = this.getWorkspacePath(sessionId);
    
    // Check if it's a git worktree and remove properly
    const worktreeResult = spawnSync('git', ['worktree', 'remove', '--force', workspacePath], {
      cwd: globals.PROJECT_ROOT,
      stdio: 'pipe'
    });
    
    if (worktreeResult.status === 0) {
      return;
    }
    
    // Fallback: just delete the directory
    if (fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      Utils.logDebug(`Removed workspace directory for session ${sessionId}`);
    }
  }

  /**
   * Check if a workspace exists for a session
   * @param {string} sessionId 
   * @returns {boolean}
   */
  static exists(sessionId) {
    return fs.existsSync(this.getWorkspacePath(sessionId));
  }

  /**
   * Get the path to a session file within a workspace
   * @param {string} sessionId 
   * @returns {string} Path to session YAML file in the workspace
   */
  static getSessionPath(sessionId) {
    return path.join(this.getWorkspacePath(sessionId), 'db', 'sessions', `${sessionId}.yml`);
  }

  /**
   * Write session data to the workspace's db/sessions directory.
   * This is called after creating the workspace to seed the session file.
   * @param {string} sessionId 
   * @param {object} sessionData 
   */
  static writeSession(sessionId, sessionData) {
    const sessionPath = this.getSessionPath(sessionId);
    writeYaml(sessionPath, sessionData);
  }

  /**
   * Read session data from the workspace
   * @param {string} sessionId 
   * @returns {object|null} Session data or null if not found
   */
  static readSession(sessionId) {
    const sessionPath = this.getSessionPath(sessionId);
    if (!fs.existsSync(sessionPath)) {
      return null;
    }
    return fromYaml(fs.readFileSync(sessionPath, 'utf8'));
  }

  /**
   * List all workspace session IDs
   * @returns {string[]}
   */
  static list() {
    const workspacesDir = globals.dbPaths.workspaces;
    if (!fs.existsSync(workspacesDir)) {
      return [];
    }
    return fs.readdirSync(workspacesDir).filter(name => {
      const fullPath = path.join(workspacesDir, name);
      return fs.statSync(fullPath).isDirectory();
    });
  }

  /**
   * Remove all workspaces
   */
  static cleanupAll() {
    const workspaces = this.list();
    for (const sessionId of workspaces) {
      this.cleanup(sessionId);
    }
    
    // Prune stale worktrees (e.g. if directories were manually deleted)
    spawnSync('git', ['worktree', 'prune'], { stdio: 'ignore' });
  }

  // ─────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Try to create workspace using git worktree (most efficient)
   * @private
   */
  static _tryCreateWorktree(sessionId, workspacePath) {
    let result = spawnSync('git', ['worktree', 'add', '--detach', workspacePath, 'HEAD'], {
      cwd: globals.PROJECT_ROOT,
      stdio: 'pipe'
    });
    
    if (result.status === 0) {
      // Copy uncommitted changes over the worktree
      this._copyUncommittedChanges(workspacePath);
      return true;
    }
    
    const stderr = result.stderr.toString();
    if (stderr.includes('missing but already registered') || stderr.includes('already registered')) {
        Utils.logWarn(`Worktree metadata stale for ${sessionId}, pruning and retrying...`);
        spawnSync('git', ['worktree', 'prune'], { stdio: 'ignore' });
        
        // Retry once
        result = spawnSync('git', ['worktree', 'add', '--detach', workspacePath, 'HEAD'], {
            cwd: globals.PROJECT_ROOT,
            stdio: 'pipe'
        });
        
        if (result.status === 0) {
            // Copy uncommitted changes over the worktree
            this._copyUncommittedChanges(workspacePath);
            return true;
        }
    }
    
    Utils.logError(`Git worktree failed: ${result.stderr.toString()}`);
    return false;
  }

  /**
   * Copy uncommitted changes from main working directory to the worktree.
   * Uses rsync to efficiently sync only changed files.
   * @private
   */
  static _copyUncommittedChanges(workspacePath) {
    const result = spawnSync('rsync', [
      '-a',
      // Exclude patterns from .gitignore / .dockerignore
      '--exclude=.git',
      '--exclude=.gitignore',
      '--exclude=.dockerignore',
      '--exclude=.vscode',
      '--exclude=.env',
      '--exclude=.tokens.yaml',
      '--exclude=.bun-cache-copy',
      '--exclude=node_modules',
      '--exclude=db/',
      '--exclude=cli.sock',
      '--exclude=daemon.lock',
      '--exclude=daemon.log',
      '--exclude=daemon.log',
      '--exclude=bun.lockb',
      '--exclude=Dockerfile',
      '--exclude=PROMPT.md',
      '--exclude=TODO.md',
      '--exclude=tests',
      // '--exclude=tmp',
      './',
      workspacePath + '/'
    ], {
      cwd: globals.PROJECT_ROOT,
      stdio: 'pipe'
    });
    
    if (result.status === 0) {
    } else {
      Utils.logWarn(`Failed to sync changes: ${result.stderr.toString()}`);
    }
  }
}