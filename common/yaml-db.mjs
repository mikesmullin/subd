import fs from 'fs';
import path from 'path';
import YAML from 'js-yaml';
import { Utils } from './utils.mjs';

/**
 * Serialize data to YAML string with consistent multi-line formatting.
 * Uses js-yaml for proper literal block scalar (|) support for multi-line strings.
 * @param {any} data - Data to serialize
 * @returns {string} YAML string
 */
export function toYaml(data) {
  return YAML.dump(data, {
    indent: 2,
    lineWidth: 120,
    noRefs: true
  });
}

/**
 * Parse YAML string to object. Supports both YAML and JSON syntax.
 * More forgiving than JSON.parse - allows unquoted strings, flow syntax, etc.
 * @param {string} str - YAML or JSON string
 * @returns {any} Parsed object
 */
export function fromYaml(str) {
  return YAML.load(str);
}

/**
 * Parse a CLI argument that could be YAML flow syntax, JSON, or a plain string.
 * Useful for parsing tool arguments from command line.
 * Examples:
 *   "{content: hello}" -> {content: "hello"}
 *   "[{content: hello}, {content: world}]" -> [{content: "hello"}, {content: "world"}]
 *   "plain string" -> "plain string"
 * @param {string} str - String to parse
 * @returns {any} Parsed value (object, array, or original string if not parseable)
 */
export function parseArg(str) {
  if (typeof str !== 'string') return str;
  const trimmed = str.trim();
  // Only try to parse if it looks like YAML/JSON structure
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return YAML.load(trimmed);
    } catch (e) {
      // Not valid YAML, return as-is
      return str;
    }
  }
  return str;
}

/**
 * Write data to a YAML file with consistent formatting
 * @param {string} filePath - Path to write to
 * @param {any} data - Data to serialize
 */
export function writeYaml(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, toYaml(data));
}

export class YamlCollection {
  constructor(dirPath) {
    this.dirPath = dirPath;
    this.isGlob = dirPath.includes('*');
    this.items = new Map();
    this.filePaths = new Map();
    this.lastReadTs = new Map();
    this.dirty = new Set();
    this.deleted = new Set();
    this.hasChanges = false;
  }

  _getFilePath(id) {
    if (this.filePaths.has(id)) return this.filePaths.get(id);
    const resolved = this.isGlob ? this.dirPath.replace('**', id) : this.dirPath;
    return path.join(resolved, `${id}.yml`);
  }

  _scanFiles() {
    if (this.isGlob) {
      const glob = new Bun.Glob(path.join(this.dirPath, '*.yml'));
      return Array.from(glob.scanSync({ cwd: '.', absolute: true }));
    }
    if (!fs.existsSync(this.dirPath)) {
      fs.mkdirSync(this.dirPath, { recursive: true });
      return [];
    }
    return fs.readdirSync(this.dirPath)
      .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
      .map(f => path.join(this.dirPath, f));
  }

  _loadFile(id, filePath) {
    try {
      const stats = fs.statSync(filePath);
      const lastRead = this.lastReadTs.get(id) || 0;
      if (stats.mtimeMs > lastRead) {
        this.items.set(id, fromYaml(fs.readFileSync(filePath, 'utf8')));
        this.lastReadTs.set(id, stats.mtimeMs);
      }
      this.filePaths.set(id, filePath);
    } catch (e) {
      console.error(`Failed to parse or read ${filePath}`, e);
    }
  }

  loadAll() {
    this.dirty.clear();
    this.deleted.clear();
    this.hasChanges = false;
    const files = this._scanFiles();
    const currentFiles = new Set();
    for (const filePath of files) {
      const id = path.basename(filePath, path.extname(filePath));
      currentFiles.add(id);
      this._loadFile(id, filePath);
    }
    for (const id of this.items.keys()) {
      if (!currentFiles.has(id)) {
        this.items.delete(id);
        this.lastReadTs.delete(id);
        this.filePaths.delete(id);
      }
    }
  }

  get(id) {
    const cachedPath = this.filePaths.get(id);
    if (cachedPath) {
      this._loadFile(id, cachedPath);
      return this.items.get(id);
    }
    
    // Try .yml
    let filePath = this.isGlob ? this.dirPath.replace('**', id) : this.dirPath;
    let fullPath = path.join(filePath, `${id}.yml`);
    
    if (fs.existsSync(fullPath)) {
      this._loadFile(id, fullPath);
      return this.items.get(id);
    }
    
    // Try .yaml
    fullPath = path.join(filePath, `${id}.yaml`);
    if (fs.existsSync(fullPath)) {
      this._loadFile(id, fullPath);
      return this.items.get(id);
    }
    
    return undefined;
  }

  set(id, data) {
    this.items.set(id, data);
    this.dirty.add(id);
    this.deleted.delete(id);
    this.hasChanges = true;
  }

  delete(id) {
    if (this.items.has(id) || this.filePaths.has(id)) {
      this.items.delete(id);
      this.deleted.add(id);
      this.dirty.delete(id);
      this.hasChanges = true;
      return true;
    }
    return false;
  }

  list() {
    return this._scanFiles().map(f => path.basename(f, path.extname(f)));
  }
  
  getAll() {
    const results = [];
    for (const filePath of this._scanFiles()) {
      const id = path.basename(filePath, path.extname(filePath));
      this._loadFile(id, filePath);
      if (this.items.has(id)) results.push(this.items.get(id));
    }
    return results;
  }

  save() {
    if (!this.hasChanges) {
      return;
    }
    for (const id of this.deleted) {
      const filePath = this._getFilePath(id);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      this.filePaths.delete(id);
    }
    this.deleted.clear();
    for (const id of this.dirty) {
      const data = this.items.get(id);
      if (data) {
        const filePath = this._getFilePath(id);
        writeYaml(filePath, data);
        this.filePaths.set(id, filePath);
      }
    }
    this.dirty.clear();
    this.hasChanges = false;
  }
}
