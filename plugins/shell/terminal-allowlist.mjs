import { globals } from '../../common/globals.mjs';
import { Utils } from '../../common/utils.mjs';
import fs from 'fs';
import path from 'path';

const ALLOWLIST_PATH = path.join(globals.PROJECT_ROOT, 'plugins/shell/storage/terminal-cmd-allowlist.yaml');
let cachedAllowlist = null;

const DEFAULT_ALLOWLIST = {
  "cd": true,
  "echo": true,
  "ls": true,
  "pwd": true,
  "cat": true,
  "head": true,
  "tail": true,
  "findstr": true,
  "wc": true,
  "tr": true,
  "cut": true,
  "cmp": true,
  "which": true,
  "basename": true,
  "dirname": true,
  "realpath": true,
  "readlink": true,
  "stat": true,
  "file": true,
  "du": true,
  "df": true,
  "sleep": true,
  "git status": true,
  "git log": true,
  "git show": true,
  "git diff": true,
  "Get-ChildItem": true,
  "Get-Content": true,
  "Get-Date": true,
  "Get-Random": true,
  "Get-Location": true,
  "Write-Host": true,
  "Write-Output": true,
  "Split-Path": true,
  "Join-Path": true,
  "Start-Sleep": true,
  "Where-Object": true,
  "/^Select-[a-z0-9]/i": true,
  "/^Measure-[a-z0-9]/i": true,
  "/^Compare-[a-z0-9]/i": true,
  "/^Format-[a-z0-9]/i": true,
  "/^Sort-[a-z0-9]/i": true,
  "column": true,
  "/^column\\b.*-c\\s+[0-9]{4,}/": false,
  "date": true,
  "/^date\\b.*(-s|--set)\\b/": false,
  "find": true,
  "/^find\\b.*-(delete|exec|execdir|fprint|fprintf|fls|ok|okdir)\\b/": false,
  "grep": true,
  "/^grep\\b.*-(f|P)\\b/": false,
  "sort": true,
  "/^sort\\b.*-(o|S)\\b/": false,
  "tree": true,
  "/^tree\\b.*-o\\b/": false,
  "rm": false,
  "rmdir": false,
  "del": false,
  "Remove-Item": false,
  "ri": false,
  "rd": false,
  "erase": false,
  "dd": false,
  "kill": false,
  "ps": false,
  "top": false,
  "Stop-Process": false,
  "spps": false,
  "taskkill": false,
  "taskkill.exe": false,
  "curl": false,
  "wget": false,
  "Invoke-RestMethod": false,
  "Invoke-WebRequest": false,
  "irm": false,
  "iwr": false,
  "chmod": false,
  "chown": false,
  "Set-ItemProperty": false,
  "sp": false,
  "Set-Acl": false,
  "jq": false,
  "xargs": false,
  "eval": false,
  "Invoke-Expression": false,
  "iex": false
};

export async function loadAllowlist() {
  if (cachedAllowlist) {
    return cachedAllowlist;
  }

  if (!fs.existsSync(ALLOWLIST_PATH)) {
    const dir = path.dirname(ALLOWLIST_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    const yaml = Bun.YAML.stringify(DEFAULT_ALLOWLIST);
    fs.writeFileSync(ALLOWLIST_PATH, yaml);
    cachedAllowlist = DEFAULT_ALLOWLIST;
    return cachedAllowlist;
  }

  const file = fs.readFileSync(ALLOWLIST_PATH, 'utf8');
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
