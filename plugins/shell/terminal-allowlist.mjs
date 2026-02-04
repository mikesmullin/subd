import { globals } from '../../common/globals.mjs';
import { Utils } from '../../common/utils.mjs';
import fs from 'fs';
import path from 'path';
import os from 'os';

// User-configurable allowlist stored in ~/.config/daemon/plugins/shell/storage/
const USER_CONFIG_DIR = path.join(os.homedir(), '.config', 'daemon', 'plugins', 'shell', 'storage');
const USER_ALLOWLIST_PATH = path.join(USER_CONFIG_DIR, 'terminal-cmd-allowlist.yaml');
// Example file shipped with the repo (copied to user config on first run)
const EXAMPLE_ALLOWLIST_PATH = path.join(globals.PROJECT_ROOT, 'plugins/shell/storage/terminal-cmd-allowlist.yaml.example');
let cachedAllowlist = null;

export async function loadAllowlist() {
  if (cachedAllowlist) {
    return cachedAllowlist;
  }

  // Check if user config exists in ~/.config/daemon/...
  if (!fs.existsSync(USER_ALLOWLIST_PATH)) {
    // Create the user config directory if it doesn't exist
    if (!fs.existsSync(USER_CONFIG_DIR)) {
      fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
    }
    
    // Copy the example file to user config location
    fs.copyFileSync(EXAMPLE_ALLOWLIST_PATH, USER_ALLOWLIST_PATH);
    Utils.logInfo(`Created user allowlist config at ${USER_ALLOWLIST_PATH}`);
  }

  const file = fs.readFileSync(USER_ALLOWLIST_PATH, 'utf8');
  cachedAllowlist = Bun.YAML.parse(file);
  return cachedAllowlist;
}

function parseRegexPattern(str) {
  const match = str.match(/^\/(.+)\/([a-z]*)$/);
  if (!match) return null;

  try {
    return new RegExp(match[1], match[2]);
  } catch (error) {
    Utils.logWarn(`Invalid regex pattern: ${str}`);
    return null;
  }
}

export function parseCommandLine(commandLine) {
  const commands = [];

  const inlinePatterns = [
    /\$\([^)]+\)/g,      // $(command)
    /`[^`]+`/g,          // `command`
    /<\([^)]+\)/g,       // <(command)
    />\([^)]+\)/g,       // >(command)
  ];

  for (const pattern of inlinePatterns) {
    const matches = commandLine.match(pattern);
    if (matches) {
      for (const match of matches) {
        const inner = match.replace(/^(\$\(|`|[<>]\()/, '').replace(/(\)|`)$/, '');
        commands.push(inner.trim());
      }
    }
  }

  const parts = commandLine.split(/(\|\||&&|;|\|)/);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();

    if (['||', '&&', ';', '|'].includes(part)) {
      continue;
    }

    if (part) {
      commands.push(part);
    }
  }

  return commands;
}

function getBaseCommand(command) {
  let cmd = command.trim();

  if (cmd.startsWith('"') || cmd.startsWith("'")) {
    const quote = cmd[0];
    const endQuote = cmd.indexOf(quote, 1);
    if (endQuote > 0) {
      cmd = cmd.substring(1, endQuote);
    }
  }

  const parts = cmd.split(/\s+/);
  const baseCmd = parts[0];

  return baseCmd.replace(/^\.\//, '').replace(/^\.\\/, '').replace(/\\/g, '/');
}

function matchesPattern(command, pattern) {
  const regex = parseRegexPattern(pattern);
  if (regex) {
    return regex.test(command);
  }

  const baseCmd = getBaseCommand(command);
  const patternBase = getBaseCommand(pattern);

  return command.startsWith(pattern) ||
    baseCmd === patternBase ||
    baseCmd.endsWith('/' + patternBase) ||
    baseCmd.endsWith('\\' + patternBase);
}

function checkSingleCommand(command, allowlist, checkFullCommand = false) {
  let approved = null;
  let matchedRule = null;

  for (const [pattern, value] of Object.entries(allowlist)) {
    const isObject = typeof value === 'object' && value !== null;

    if (isObject && checkFullCommand && !value.matchCommandLine) {
      continue;
    }

    if (isObject && !checkFullCommand && value.matchCommandLine) {
      continue;
    }

    if (matchesPattern(command, pattern)) {
      matchedRule = pattern;

      if (isObject) {
        approved = value.approve;
      } else if (value === null) {
        continue;
      } else {
        approved = value;
      }

      if (approved === false) {
        break;
      }
    }
  }

  return {
    approved: approved === true,
    denied: approved === false,
    matchedRule,
    reason: approved === true
      ? `Approved by rule: ${matchedRule}`
      : approved === false
        ? `Denied by rule: ${matchedRule}`
        : 'No matching rule found'
  };
}

export async function checkCommand(commandLine, options = {}) {
  const allowlist = options.allowlist || await loadAllowlist();

  const subCommands = parseCommandLine(commandLine);
  const fullLineCheck = checkSingleCommand(commandLine, allowlist, true);

  const subCommandChecks = subCommands.map(cmd => ({
    command: cmd,
    ...checkSingleCommand(cmd, allowlist, false)
  }));

  const anyDenied = fullLineCheck.denied || subCommandChecks.some(c => c.denied);
  const allSubCommandsApproved = subCommandChecks.length > 0 && subCommandChecks.every(c => c.approved);
  const fullLineApproved = fullLineCheck.approved;

  const approved = !anyDenied && (allSubCommandsApproved || fullLineApproved);

  let reason;
  if (anyDenied) {
    const deniedCheck = fullLineCheck.denied ? fullLineCheck : subCommandChecks.find(c => c.denied);
    reason = `Command denied: ${deniedCheck.reason}`;
  } else if (approved) {
    if (fullLineApproved) {
      reason = `Full command line approved: ${fullLineCheck.matchedRule}`;
    } else {
      reason = 'All sub-commands approved';
    }
  } else {
    reason = 'No matching approval rule found - requires explicit approval';
  }

  return {
    approved,
    reason,
    commandLine,
    subCommands,
    details: {
      fullLineCheck,
      subCommandChecks
    }
  };
}
