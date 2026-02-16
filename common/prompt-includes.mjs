import fs from 'fs';
import path from 'path';

function normalizeIncludePath(rootDir, includePath) {
  if (typeof includePath !== 'string' || !includePath.trim()) {
    throw new Error('Include path is empty');
  }

  const trimmed = includePath.trim();
  if (path.isAbsolute(trimmed)) {
    throw new Error(`Absolute include paths are not allowed: ${trimmed}`);
  }

  const resolved = path.resolve(rootDir, trimmed);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Include path escapes workspace root: ${trimmed}`);
  }

  return resolved;
}

function includePromptInner(includePath, context) {
  const { rootDir, maxDepth, stack } = context;

  if (stack.length >= maxDepth) {
    throw new Error(`Max include depth exceeded (${maxDepth}) while resolving ${String(includePath || '').trim()}`);
  }

  const fullPath = normalizeIncludePath(rootDir, includePath);
  if (stack.includes(fullPath)) {
    const chain = [...stack, fullPath].map((value) => path.relative(rootDir, value)).join(' -> ');
    throw new Error(`Circular include detected: ${chain}`);
  }

  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    throw new Error(`Include file not found: ${path.relative(rootDir, fullPath)}`);
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  return String(content).replace(/<%[-=]?\s*includePrompt\(([^)]*)\)\s*%>/g, (match, rawArg) => {
    const normalizedArg = String(rawArg || '').trim().replace(/^['"]|['"]$/g, '');
    return includePromptInner(normalizedArg, {
      rootDir,
      maxDepth,
      stack: [...stack, fullPath]
    });
  });
}

export function createPromptIncludeFn(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const maxDepth = Number.isFinite(options.maxDepth) && options.maxDepth > 0
    ? Math.floor(options.maxDepth)
    : 10;

  return function includePrompt(includePath) {
    return includePromptInner(includePath, {
      rootDir,
      maxDepth,
      stack: []
    });
  };
}
