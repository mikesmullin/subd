#!/usr/bin/env bun
import fs from 'fs';
import path from 'path';
import ejs from 'ejs';
import yaml from 'js-yaml';
import os from 'os';
import { globals } from './common/globals.mjs';
import { Utils } from './common/utils.mjs';
import { SessionModel, SessionState } from './plugins/agent/models/session.mjs';
import { TemplateModel } from './plugins/agent/models/template.mjs';
import { XAIProvider } from './plugins/agent/models/providers/xai.mjs';
import { OllamaProvider } from './plugins/agent/models/providers/ollama.mjs';
import { LlamaCppProvider } from './plugins/agent/models/providers/llamacpp.mjs';
import { GeminiProvider } from './plugins/agent/models/providers/gemini.mjs';
import { CopilotProvider } from './plugins/agent/models/providers/copilot.mjs';

// Provider registry
const providerRegistry = {
  'xai': XAIProvider,
  'ollama': OllamaProvider,
  'llamacpp': LlamaCppProvider,
  'gemini': GeminiProvider,
  'copilot': CopilotProvider,
};

function getProviderForModel(modelStr) {
  if (!modelStr || !modelStr.includes(':')) {
    // Default to xai if no prefix
    return { provider: new XAIProvider(), modelName: modelStr || 'grok-3' };
  }
  
  const parts = modelStr.split(':');
  const providerName = parts[0].toLowerCase();
  const modelName = parts.slice(1).join(':').split('#')[0].trim();
  
  const ProviderClass = providerRegistry[providerName];
  if (!ProviderClass) {
    throw new Error(`Unknown provider: ${providerName}. Available: ${Object.keys(providerRegistry).join(', ')}`);
  }
  
  return { provider: new ProviderClass(), modelName };
}

// Load Plugins
import { CorePlugin } from './plugins/core/index.mjs';
import { FsPlugin } from './plugins/fs/index.mjs';
import { ShellPlugin } from './plugins/shell/index.mjs';
import { WebPlugin } from './plugins/web/index.mjs';
import { AgentPlugin } from './plugins/agent/controllers/agent.mjs';
import { HumanPlugin } from './plugins/human/index.mjs';
import { ReplPlugin } from './plugins/repl/index.mjs';

// Handle subcommands
const args = process.argv.slice(2);
if (args[0] === 'clean') {
  const sessionsDir = path.resolve(import.meta.dirname, 'agent/sessions');
  const files = fs.existsSync(sessionsDir) 
    ? fs.readdirSync(sessionsDir).filter(f => f.endsWith('.yml'))
    : [];
  for (const file of files) {
    fs.unlinkSync(path.join(sessionsDir, file));
  }
  console.log(`Removed ${files.length} session file(s).`);
  process.exit(0);
}

// Parse Args
let templatePath = null;
let dataYaml = null;
let outputPath = null;
let verbose = false;
let turnLimit = null;
let readStdinFlag = false;
let promptParts = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '-t') {
    templatePath = args[++i];
  } else if (args[i] === '-d') {
    dataYaml = args[++i];
  } else if (args[i] === '-o') {
    outputPath = args[++i];
  } else if (args[i] === '-v') {
    verbose = true;
  } else if (args[i] === '-l') {
    turnLimit = parseInt(args[++i], 10);
  } else if (args[i] === '-i') {
    readStdinFlag = true;
  } else {
    promptParts.push(args[i]);
  }
}

// Helper for templates to read stdin (only if -i flag was passed)
let stdinCache = null;
async function readStdin() {
  if (!readStdinFlag) return '';
  if (stdinCache !== null) return stdinCache;
  stdinCache = await Bun.stdin.text();
  return stdinCache;
}

// Initialize Logger
Utils.setLogLevel(verbose ? 'debug' : 'warn');
Utils.setLogHandler((level, message) => {
  // Send all logs to stderr so stdout can be used for the final response
  if (Utils.shouldLog(level)) {
    console.error(message);
  }
});

// Performance tracking
const processStartTime = Date.now();
function logPerf(label, stats) {
  if (!verbose) return;
  const parts = Object.entries(stats).map(([k, v]) => {
    if (typeof v === 'number') return `${k}=${v.toFixed(3)}`;
    return `${k}=${v}`;
  });
  console.error(`\x1b[95m[PERF] ${label}: ${parts.join(' ')}\x1b[0m`);
}

// Colored output helpers for verbose mode
function logThoughts(text) {
  if (!verbose || !text) return;
  console.error(`\x1b[90m[THOUGHTS] ${text}\x1b[0m`); // Grey
}

function logAssistant(text) {
  if (!verbose || !text) return;
  console.error(`\x1b[33m[ASSISTANT] ${text}\x1b[0m`); // Yellow
}

const userPrompt = promptParts.join(' ');

if (!templatePath || !userPrompt) {
  console.error('Usage: subd -t <template.yaml> [-d <yaml_data>] [-o output.log] [-v] [-i] [-l <turns>] <prompt...>');
  process.exit(1);
}

// Resolve template path
function resolveTemplatePath(p) {
  const searchPaths = [
    path.resolve(process.cwd(), p),
    path.resolve(process.cwd(), p + '.yaml'),
    path.resolve(globals.dbPaths.templates, p),
    path.resolve(globals.dbPaths.templates, p + '.yaml')
  ];

  for (const sp of searchPaths) {
    if (fs.existsSync(sp) && fs.statSync(sp).isFile()) {
      return sp;
    }
  }
  return null;
}

const fullTemplatePath = resolveTemplatePath(templatePath);

if (!fullTemplatePath) {
  console.error(`Template not found: ${templatePath}`);
  process.exit(1);
}

// Load Template
const templateContent = fs.readFileSync(fullTemplatePath, 'utf8');
const template = yaml.load(templateContent);

// Load Data
let data = {};
if (dataYaml) {
  try {
    data = yaml.load(dataYaml);
  } catch (e) {
    console.error(`Failed to parse data YAML: ${e.message}`);
    process.exit(1);
  }
}

// Extract validate function from template metadata
const validateFn = template.metadata?.validate || null;

// Extract loop control limits from template metadata
const maxTurns = template.metadata?.max_turns || null;
const maxValidationFails = template.metadata?.max_validation_fails || null;

// Render System Prompt
if (template.spec && template.spec.system_prompt) {
  try {
    template.spec.system_prompt = await ejs.render(template.spec.system_prompt, { 
      ...data,
      process,
      os,
      readStdin
    }, { async: true });
  } catch (e) {
    console.error(`Failed to render system prompt: ${e.message}`);
    process.exit(1);
  }
}

// Append validation prompt if validate function is present
if (validateFn) {
  const validationPrompt = `\n\nYour reply must cause the following function to return truthy:\n\`\`\`js\n${validateFn}\`\`\``;
  template.spec.system_prompt = (template.spec.system_prompt || '') + validationPrompt;
}

// Log final system prompt in verbose mode
if (verbose && template.spec?.system_prompt) {
  console.error(`\x1b[94m[SYSTEM PROMPT]\n${template.spec.system_prompt}\x1b[0m`);
}

// Initialize Plugins
globals.config.unattended = true;
new CorePlugin();
new FsPlugin();
new ShellPlugin();
new WebPlugin();
new AgentPlugin();
new HumanPlugin();

// Create Session
const sessionId = SessionModel.generateId();
const templateName = path.basename(fullTemplatePath, path.extname(fullTemplatePath));
Utils.logInfo(`Creating session ${sessionId}...`);
const session = SessionModel.create(sessionId, { template, name: templateName });
session.spec.messages = [
  { role: 'user', content: userPrompt, timestamp: new Date().toISOString() }
];
SessionModel.save(sessionId, session);
SessionModel.collection.save();

// Initialize Provider based on model string from template
const modelStr = template.metadata?.model || 'xai:grok-3';
const { provider, modelName } = getProviderForModel(modelStr);
await provider.init();

// Tool Call Loop
async function getChatMessages(sessionId) {
  const currentSession = SessionModel.load(sessionId);
  if (!currentSession) {
    throw new Error(`Session ${sessionId} not found`);
  }
  const messages = [];
  if (currentSession.spec.system_prompt) {
    messages.push({ role: 'system', content: currentSession.spec.system_prompt });
  }
  messages.push(...currentSession.spec.messages);
  return messages;
}

// Parse tool options from session metadata
// Format: tools: ["tool_name", { "tool_name": { allowlist: {...} } }]
// Returns: { allowedTools: Set or null (null means no restriction), toolOptions: Map }
function parseToolOptions(sessionTools) {
  const toolOptions = new Map();
  
  // If tools key is not present (undefined), allow all tools
  if (sessionTools === undefined) {
    return { allowedTools: null, toolOptions };
  }
  
  // If tools is an empty array, allow no tools
  const allowedTools = new Set();
  if (!Array.isArray(sessionTools)) {
    return { allowedTools, toolOptions };
  }
  
  for (const item of sessionTools) {
    if (typeof item === 'string') {
      allowedTools.add(item);
    } else if (typeof item === 'object' && item !== null) {
      // Format: { tool_name: { allowlist: {...} } }
      for (const [toolName, options] of Object.entries(item)) {
        allowedTools.add(toolName);
        if (options && typeof options === 'object') {
          toolOptions.set(toolName, options);
        }
      }
    }
  }
  
  return { allowedTools, toolOptions };
}

// Store tool options globally for access by tool handlers
globals.sessionToolOptions = new Map();

async function getTools(sessionId) {
  const currentSession = SessionModel.load(sessionId);
  const tools = [];
  const { allowedTools, toolOptions } = parseToolOptions(currentSession.metadata?.tools);
  
  // Store tool options globally for tool handlers to access
  globals.sessionToolOptions = toolOptions;
  
  // If allowedTools is null, no restriction - load all tools
  // If allowedTools is a Set, only load tools in the set
  for (const plugin of globals.pluginsRegistry.values()) {
    const def = plugin.definition;
    if (Array.isArray(def)) {
      for (const tool of def) {
        if (allowedTools === null || allowedTools.has(tool.function.name)) {
          tools.push({
            type: tool.type,
            function: tool.function
          });
        }
      }
    }
  }
  return tools.length > 0 ? tools : undefined;
}

async function executeSingleTool(sessionId, toolCall) {
  const toolName = toolCall.function.name;
  const argsStr = toolCall.function.arguments;
  let cmdArgs = {};
  try { cmdArgs = JSON.parse(argsStr); } catch (e) {}
  
  Utils.logInfo(`Tool Call: ${toolName}(${argsStr})`);
  const handler = globals.dslRegistry.get(toolName);
  if (!handler) return { role: 'tool', tool_call_id: toolCall.id, name: toolName, content: `Error: Tool ${toolName} not found`, timestamp: new Date().toISOString() };

  const toolStartTime = Date.now();
  try {
    const result = await handler(cmdArgs, { sessionId, toolCallId: toolCall.id });
    const toolDuration = (Date.now() - toolStartTime) / 1000;
    
    let content = result.status === 'success' 
      ? (typeof result.result === 'string' ? result.result : JSON.stringify(result.result))
      : (result.status === 'failure' ? `Error: ${result.error}` : JSON.stringify(result));

    // Log tool result in verbose mode (cyan color)
    if (verbose) {
      console.error(`\x1b[36m[TOOL RESULT] ${content.substring(0, 500)}${content.length > 500 ? '...' : ''}\x1b[0m`);
    }

    logPerf(`tool:${toolName}`, { 'duration(s)': toolDuration });

    return { role: 'tool', tool_call_id: toolCall.id, name: toolName, content, timestamp: new Date().toISOString() };
  } catch (e) {
    const toolDuration = (Date.now() - toolStartTime) / 1000;
    logPerf(`tool:${toolName}`, { 'duration(s)': toolDuration, error: true });
    const content = `Exception: ${e.message}`;
    if (verbose) {
      console.error(`\x1b[36m[TOOL RESULT] ${content}\x1b[0m`);
    }
    return { role: 'tool', tool_call_id: toolCall.id, name: toolName, content, timestamp: new Date().toISOString() };
  }
}

async function handleToolCalls(sessionId, toolCalls) {
  const currentSession = SessionModel.load(sessionId);
  for (const toolCall of toolCalls) {
    const toolResultMessage = await executeSingleTool(sessionId, toolCall);
    currentSession.spec.messages.push(toolResultMessage);
  }
  SessionModel.save(sessionId, currentSession);
}

async function runLoop() {
  let running = true;
  let lastAssistantContent = '';
  let turnCount = 0;
  let validationFailCount = 0;
  
  // Effective turn limit: CLI -l flag takes precedence, then template max_turns
  const effectiveTurnLimit = turnLimit || maxTurns;
  
  while (running) {
    const messages = await getChatMessages(sessionId);
    const tools = await getTools(sessionId);

    Utils.logInfo(`Calling AI with ${tools?.length || 0} tools...${effectiveTurnLimit ? ` (turn ${turnCount + 1}/${effectiveTurnLimit})` : ''}`);
    turnCount++;
    
    const apiStartTime = Date.now();
    const response = await provider.createChatCompletion({
      model: modelName,
      messages,
      tools
    });
    const apiEndTime = Date.now();
    const apiDuration = (apiEndTime - apiStartTime) / 1000;
    
    // Log API request performance
    const tokenCount = response.usage?.completion_tokens || 0;
    const ttft = response.metrics?.time_to_first_token_ms ? response.metrics.time_to_first_token_ms / 1000 : apiDuration;
    const tokensPerSec = apiDuration > 0 ? tokenCount / apiDuration : 0;
    logPerf('api-request', {
      'ttft(s)': ttft,
      'tokens': tokenCount,
      'duration(s)': apiDuration,
      'tokens/s': tokensPerSec
    });

    const combinedMessage = { role: 'assistant', content: '', tool_calls: [] };
    let finishReason = 'stop'; // Default to stop if not specified
    let reasoning = '';
    
    for (const choice of response.choices) {
      // Extract reasoning/thinking if present (various provider formats)
      if (choice.message.reasoning) reasoning += choice.message.reasoning;
      if (choice.message.reasoning_content) reasoning += choice.message.reasoning_content;
      if (choice.message.thinking) reasoning += choice.message.thinking;
      
      if (choice.message.content) combinedMessage.content += choice.message.content;
      if (choice.message.tool_calls) combinedMessage.tool_calls.push(...choice.message.tool_calls);
      // Use 'tool_calls' finish_reason if any choice has it, otherwise use last choice's reason
      if (choice.finish_reason === 'tool_calls') {
        finishReason = 'tool_calls';
      } else if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }
    
    // Log thoughts/reasoning in purple (verbose mode)
    if (reasoning) logThoughts(reasoning);
    
    combinedMessage.timestamp = new Date().toISOString();
    combinedMessage.finish_reason = finishReason;
    
    const currentSession = SessionModel.load(sessionId);
    currentSession.spec.messages.push(combinedMessage);
    SessionModel.save(sessionId, currentSession);

    if (combinedMessage.tool_calls && combinedMessage.tool_calls.length > 0) {
      // Has tool calls - log content in verbose mode and continue
      if (combinedMessage.content) logAssistant(combinedMessage.content);
      await handleToolCalls(sessionId, combinedMessage.tool_calls);
      
      // Check turn limit after processing tool calls
      if (effectiveTurnLimit && turnCount >= effectiveTurnLimit) {
        console.error(`No answer could be returned; max turns (${effectiveTurnLimit}) reached.`);
        process.exit(1);
      }
    } else {
      // No tool calls - check finish_reason to determine if session is complete
      // Track the last assistant content for final output
      if (combinedMessage.content) {
        lastAssistantContent = combinedMessage.content;
        // In verbose mode, log intermediate responses in yellow
        logAssistant(combinedMessage.content);
      }
      
      // Only terminate when finish_reason indicates completion
      if (finishReason === 'stop' || finishReason === 'end_turn') {
        // If validate function is present, eval it against the response
        if (validateFn) {
          let validationResult;
          try {
            // Create a function that evaluates the validate code and passes the reply
            const validateCode = `
              const reply = arguments[0];
              ${validateFn}
            `;
            const fn = new Function(validateCode);
            validationResult = fn(lastAssistantContent);
          } catch (e) {
            validationResult = `Validation error: ${e.message}`;
          }
          
          if (!validationResult) {
            validationFailCount++;
            Utils.logInfo(`Validation failed (${validationFailCount}${maxValidationFails ? '/' + maxValidationFails : ''}), result: ${JSON.stringify(validationResult)}`);
            
            // Check max validation fails limit
            if (maxValidationFails && validationFailCount >= maxValidationFails) {
              console.error(`No answer could be returned; the LLM failed to construct an answer that could pass validation in (${maxValidationFails}) attempts.`);
              process.exit(1);
            }
            
            // Check turn limit before continuing
            if (effectiveTurnLimit && turnCount >= effectiveTurnLimit) {
              console.error(`No answer could be returned; max turns (${effectiveTurnLimit}) reached.`);
              process.exit(1);
            } else {
              // Add validation failure message and continue loop
              const validationMsg = `Your reply failed validation because the validation function returned: ${JSON.stringify(validationResult)}. Please review the javascript validation function code provided, and adapt your reply to conform strictly, paying attention to spacing.`;
              const currentSession = SessionModel.load(sessionId);
              currentSession.spec.messages.push({
                role: 'user',
                content: validationMsg,
                timestamp: new Date().toISOString()
              });
              SessionModel.save(sessionId, currentSession);
              Utils.logInfo(`Sent validation correction prompt, continuing...`);
            }
          } else {
            // Validation passed - output YAML serialized result instead of assistant content
            Utils.logInfo(`Session complete (finish_reason: ${finishReason}, validation passed)`);
            const overallDuration = (Date.now() - processStartTime) / 1000;
            logPerf('process-end', { 'overall(s)': overallDuration });
            
            // Serialize validation result to YAML
            const yamlOutput = yaml.dump(validationResult);
            if (outputPath) {
              fs.writeFileSync(outputPath, yamlOutput);
            } else {
              process.stdout.write(yamlOutput);
            }
            running = false;
          }
        } else {
          // No validation - proceed as before
          Utils.logInfo(`Session complete (finish_reason: ${finishReason})`);
          // Log overall process time
          const overallDuration = (Date.now() - processStartTime) / 1000;
          logPerf('process-end', { 'overall(s)': overallDuration });
          
          // Output the final response
          if (outputPath) {
            fs.writeFileSync(outputPath, lastAssistantContent);
          } else {
            process.stdout.write(lastAssistantContent + '\n');
          }
          running = false;
        }
      } else {
        // AI returned content but didn't signal termination - continue loop
        Utils.logInfo(`AI returned content with finish_reason: ${finishReason}, continuing...`);
      }
    }
  }
}

try {
    await runLoop();
} catch (e) {
    Utils.logError(`Fatal Error: ${e.message}`);
    process.exit(1);
}
