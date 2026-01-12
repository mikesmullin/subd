import { globals } from '../../common/globals.mjs';
import { Utils } from '../../common/utils.mjs';
import { ToolExecutionStatus } from '../agent/controllers/host-container-bridge.mjs';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export class FsPlugin {
  constructor() {
    globals.pluginsRegistry.set('fs', this);
    this.registerTools();
  }

  registerTools() {
    globals.dslRegistry.set('fs__file__view', this.viewFile.bind(this));
    globals.dslRegistry.set('fs__file__create', this.createFile.bind(this));
    globals.dslRegistry.set('fs__directory__list', this.listDirectory.bind(this));
    globals.dslRegistry.set('fs__file__edit', this.editFile.bind(this));
    globals.dslRegistry.set('fs__directory__create', this.createDirectory.bind(this));
    globals.dslRegistry.set('fs__grep', this.grepSearch.bind(this));
    globals.dslRegistry.set('fs__patch__apply', this.applyPatchTool.bind(this));
    globals.dslRegistry.set('fs__file__await', this.awaitFile.bind(this));
    globals.dslRegistry.set('fs__file__delete', this.deleteFile.bind(this));
  }

  get definition() {
    return [
      {
        type: "function",
        function: {
          name: "fs__file__view",
          description: "Safely view file contents with read tracking for large files.",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "The path to the file to read." }
            },
            required: ["filePath"]
          }
        },
        metadata: { help: "fs file view <filePath>" }
      },
      {
        type: "function",
        function: {
          name: "fs__file__create",
          description: "Create a new file in the workspace. Can create new directories if needed.",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "The path to the file to create." },
              content: { type: "string", description: "The content to write to the file." }
            },
            required: ["filePath", "content"]
          }
        },
        metadata: { help: "fs file create <filePath> <content>" }
      },
      {
        type: "function",
        function: {
          name: "fs__directory__list",
          description: "List files and folders in a directory.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "The path to the directory to list." }
            },
            required: ["path"]
          }
        },
        metadata: { help: "fs directory list <path>" }
      },
      {
        type: "function",
        function: {
          name: "fs__file__edit",
          description: "Precisely edit files using string replacement.",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "The path to the file to edit." },
              oldString: { type: "string", description: "The exact string to replace." },
              newString: { type: "string", description: "The new string to insert. Use real newline characters for multi-line edits, not escaped '\\n' sequences." }
            },
            required: ["filePath", "oldString", "newString"]
          }
        },
        metadata: { help: "fs file edit <filePath> <oldString> <newString>" }
      },
      {
        type: "function",
        function: {
          name: "fs__directory__create",
          description: "Create a new directory structure in the workspace.",
          parameters: {
            type: "object",
            properties: {
              dirPath: { type: "string", description: "The path to the directory to create." }
            },
            required: ["dirPath"]
          }
        },
        metadata: { help: "fs directory create <dirPath>" }
      },
      {
        type: "function",
        function: {
          name: "fs__grep",
          description: "Do a fast text search in the workspace.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "The pattern to search for." },
              path: { type: "string", description: "The path to search in (default: workspace root)." }
            },
            required: ["query"]
          }
        },
        metadata: { help: "fs grep <query> [path]" }
      },
      {
        type: "function",
        function: {
          name: "fs__patch__apply",
          description: "Apply a unified diff patch to a file.",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "The absolute path to the file to patch." },
              patchContent: { type: "string", description: "The unified diff content." }
            },
            required: ["filePath", "patchContent"]
          }
        },
        metadata: { help: "fs patch apply <filePath> <patchContent>" }
      },
      {
        type: "function",
        function: {
          name: "fs__file__await",
          description: "Poll the filesystem until a file is created or modified.",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "The path to the file to wait for." }
            },
            required: ["filePath"]
          }
        },
        metadata: { help: "fs file await <filePath>" }
      },
      {
        type: "function",
        function: {
          name: "fs__file__delete",
          description: "Delete a file from the workspace.",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "The path to the file to delete." }
            },
            required: ["filePath"]
          }
        },
        metadata: { help: "fs file delete <filePath>" }
      }
    ];
  }



  async viewFile(args) {
      let filePath;
      if (Array.isArray(args)) {
          filePath = args[0];
      } else {
          filePath = args.filePath;
      }
      
      if (!filePath) return { status: ToolExecutionStatus.FAILURE, error: 'Usage: view_file <filePath>' };
      const absPath = path.resolve(process.cwd(), filePath);
      if (fs.existsSync(absPath)) {
          const content = fs.readFileSync(absPath, 'utf8');
          Utils.logInfo(`Content of ${filePath}:\n${content}`);
          return { status: ToolExecutionStatus.SUCCESS, result: content };
      } else {
          const err = `File not found: ${filePath}`;
          Utils.logError(err);
          return { status: ToolExecutionStatus.FAILURE, error: err };
      }
  }

  async awaitFile(args) {
    const filePath = args.filePath;
    const absPath = path.resolve(process.cwd(), filePath);
    
    let initialStats = null;
    if (fs.existsSync(absPath)) {
      initialStats = fs.statSync(absPath);
    }

    while (true) {
      if (fs.existsSync(absPath)) {
        const currentStats = fs.statSync(absPath);
        if (!initialStats || currentStats.mtimeMs > initialStats.mtimeMs || currentStats.size !== initialStats.size) {
          return { 
            status: ToolExecutionStatus.SUCCESS, 
            result: { 
              mtimeMs: currentStats.mtimeMs, 
              size: currentStats.size,
              status: initialStats ? 'modified' : 'created'
            } 
          };
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  async createFile(args) {
      let filePath, content;
      if (Array.isArray(args)) {
          filePath = args[0];
          content = args.slice(1).join(' ');
      } else {
          filePath = args.filePath;
          content = args.content;
      }

      if (!filePath) return { status: ToolExecutionStatus.FAILURE, error: 'Usage: create_file <filePath> <content>' };
      const absPath = path.resolve(process.cwd(), filePath);
      // Ensure dir exists
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absPath, content);
      Utils.logInfo(`Created file ${filePath}`);
      return { status: ToolExecutionStatus.SUCCESS, result: `Created file ${filePath}` };
  }

  async listDirectory(args) {
      let dirPath;
      if (Array.isArray(args)) {
          dirPath = args[0] || '.';
      } else {
          dirPath = args.path || '.';
      }

      const absPath = path.resolve(process.cwd(), dirPath);
      if (fs.existsSync(absPath)) {
          const files = fs.readdirSync(absPath);
          const output = `Files in ${dirPath}:\n${files.join('\n')}`;
          Utils.logInfo(output);
          return { status: ToolExecutionStatus.SUCCESS, result: output };
      } else {
          const err = `Directory not found: ${dirPath}`;
          Utils.logError(err);
          return { status: ToolExecutionStatus.FAILURE, error: err };
      }
  }

  async editFile(args) {
      let filePath, oldString, newString;
      if (Array.isArray(args)) {
          filePath = args[0];
          oldString = args[1];
          newString = args[2];
      } else {
          filePath = args.filePath;
          oldString = args.oldString;
          newString = args.newString;
      }

      if (!filePath || !oldString || newString === undefined) return { status: ToolExecutionStatus.FAILURE, error: 'Usage: edit_file <filePath> <oldString> <newString>' };
      
      const absPath = path.resolve(process.cwd(), filePath);
      if (fs.existsSync(absPath)) {
          const content = fs.readFileSync(absPath, 'utf8');
          
          // Normalize line endings for comparison
          const normalizedContent = content.replace(/\r\n/g, '\n');
          const normalizedOldString = oldString.replace(/\r\n/g, '\n');
          
          if (normalizedContent.includes(normalizedOldString)) {
              const newContent = normalizedContent.replace(normalizedOldString, newString.replace(/\r\n/g, '\n'));
              // Write back with original line endings if possible, or just use \n
              fs.writeFileSync(absPath, newContent);
              Utils.logInfo(`Edited ${filePath}`);
              return { status: ToolExecutionStatus.SUCCESS, result: `Edited ${filePath}` };
          } else {
              const err = `String not found in ${filePath}`;
              Utils.logError(err);
              return { status: ToolExecutionStatus.FAILURE, error: err };
          }
      } else {
          const err = `File not found: ${filePath}`;
          Utils.logError(err);
          return { status: ToolExecutionStatus.FAILURE, error: err };
      }
  }

  async createDirectory(args) {
      let dirPath;
      if (Array.isArray(args)) {
          dirPath = args[0];
      } else {
          dirPath = args.dirPath;
      }

      if (!dirPath) return { status: ToolExecutionStatus.FAILURE, error: 'Usage: create_directory <dirPath>' };
      const absPath = path.resolve(process.cwd(), dirPath);
      fs.mkdirSync(absPath, { recursive: true });
      Utils.logInfo(`Created directory ${dirPath}`);
      return { status: ToolExecutionStatus.SUCCESS, result: `Created directory ${dirPath}` };
  }

  async grepSearch(args) {
      let query, searchPath;
      if (Array.isArray(args)) {
          query = args[0];
          searchPath = args[1] || '.';
      } else {
          query = args.query;
          searchPath = args.path || '.';
      }

      if (!query) return { status: ToolExecutionStatus.FAILURE, error: 'Usage: grep_search <query> [path]' };
      const absPath = path.resolve(process.cwd(), searchPath);
      try {
          const result = execSync(`grep -rn "${query}" "${absPath}"`, { encoding: 'utf8' });
          Utils.logInfo(`Grep results:\n${result}`);
          return { status: ToolExecutionStatus.SUCCESS, result: result };
      } catch (e) {
          if (e.status === 1) {
              const msg = 'No matches found.';
              Utils.logInfo(msg);
              return { status: ToolExecutionStatus.SUCCESS, result: msg };
          }
          else {
              const err = `Grep failed: ${e.message}`;
              Utils.logError(err);
              return { status: ToolExecutionStatus.FAILURE, error: err };
          }
      }
  }

  async applyPatchTool(args) {
      let filePath, patchContent;
      if (Array.isArray(args)) {
          filePath = args[0];
          patchContent = args[1];
      } else {
          filePath = args.filePath;
          patchContent = args.patchContent;
      }

      if (!filePath || !patchContent) return { status: ToolExecutionStatus.FAILURE, error: 'Usage: apply_patch <filePath> <patchContent>' };
      const absPath = path.resolve(process.cwd(), filePath);
      const result = this.applyPatch(absPath, patchContent);
      if (result.success) {
          Utils.logInfo(`Patched ${filePath}`);
          return { status: ToolExecutionStatus.SUCCESS, result: `Patched ${filePath}` };
      }
      else {
          Utils.logError(`Patch failed: ${result.error}`);
          return { status: ToolExecutionStatus.FAILURE, error: `Patch failed: ${result.error}` };
      }
  }

  applyPatch(filePath, patchContent) {
      if (!fs.existsSync(filePath)) {
          return { success: false, error: 'File not found' };
      }

      const oldContent = fs.readFileSync(filePath, 'utf8');
      const lines = oldContent.split('\n');
      const patchLines = patchContent.split('\n');
      const hunks = [];
      let currentHunk = null;

      for (let i = 0; i < patchLines.length; i++) {
        const line = patchLines[i];
        const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
        if (hunkMatch) {
          if (currentHunk) hunks.push(currentHunk);
          currentHunk = {
            oldStart: parseInt(hunkMatch[1], 10),
            oldCount: parseInt(hunkMatch[2] || '1', 10),
            newStart: parseInt(hunkMatch[3], 10),
            newCount: parseInt(hunkMatch[4] || '1', 10),
            changes: []
          };
          continue;
        }
        if (currentHunk && (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+'))) {
          currentHunk.changes.push({ type: line[0], content: line.slice(1) });
        }
      }
      if (currentHunk) hunks.push(currentHunk);

      if (hunks.length === 0) return { success: false, error: 'No valid hunks found' };

      let newLines = [...lines];
      // Apply in reverse to keep indices valid
      for (let h = hunks.length - 1; h >= 0; h--) {
          const hunk = hunks[h];
          let lineIndex = hunk.oldStart - 1;
          let contextCount = 0;
          
          // Verify context
          for (const change of hunk.changes) {
              if (change.type === ' ' || change.type === '-') {
                  if (lineIndex + contextCount >= newLines.length || newLines[lineIndex + contextCount] !== change.content) {
                      return { success: false, error: `Context mismatch at line ${lineIndex + contextCount + 1}` };
                  }
                  contextCount++;
              }
          }

          // Apply changes
          const replacement = [];
          for (const change of hunk.changes) {
              if (change.type === ' ' || change.type === '+') {
                  replacement.push(change.content);
              }
          }
          
          newLines.splice(lineIndex, hunk.oldCount, ...replacement);
      }

      fs.writeFileSync(filePath, newLines.join('\n'));
      return { success: true };
  }

  async deleteFile(args) {
      let filePath;
      if (Array.isArray(args)) {
          filePath = args[0];
      } else {
          filePath = args.filePath;
      }

      if (!filePath) return { status: ToolExecutionStatus.FAILURE, error: 'Usage: delete_file <filePath>' };
      const absPath = path.resolve(process.cwd(), filePath);
      const cwd = process.cwd();

      if (!absPath.startsWith(cwd)) {
          const err = `Permission denied: Cannot delete file outside of current working directory: ${filePath}`;
          Utils.logError(err);
          return { status: ToolExecutionStatus.FAILURE, error: err };
      }

      if (fs.existsSync(absPath)) {
          fs.unlinkSync(absPath);
          Utils.logInfo(`Deleted file ${filePath}`);
          return { status: ToolExecutionStatus.SUCCESS, result: `Deleted file ${filePath}` };
      } else {
          const err = `File not found: ${filePath}`;
          Utils.logError(err);
          return { status: ToolExecutionStatus.FAILURE, error: err };
      }
  }
}

export const fsPlugin = new FsPlugin();
