import { SessionModel } from '../agent/models/session.mjs';
import { Utils } from '../../common/utils.mjs';
import { globals } from '../../common/globals.mjs';

export class CoreContext {
  constructor(plugin) {
    this.plugin = plugin;
  }

  async context(args, context) {
    Utils.logTrace(`[CoreContext] context called with args: ${JSON.stringify(args)}`);
    // Use ID from args if provided (for CLI usage), otherwise use current session context
    // If both are missing/zero, default to 1 for convenience in single-session testing
    let sessionId = args?.id || context?.sessionId;
    if (!sessionId || sessionId === 0) {
        sessionId = '1';
    }
    Utils.logTrace(`[CoreContext] Using sessionId: ${sessionId}`);

    const session = SessionModel.load(sessionId);

    if (!session) {
      Utils.logTrace(`[CoreContext] Session ${sessionId} not found`);
      return {
        status: 'failure',
        error: `Session ${sessionId} not found`
      };
    }

    const model = session.spec.model || session.metadata?.model || 'unknown';
    Utils.logTrace(`[CoreContext] Model: ${model}`);
    const contextLimit = this.getContextLimit(model);
    
    // 1. Calculate Component Sizes (Estimated)
    const systemPrompt = session.spec.system_prompt || '';
    const toolsDef = this.getToolsDefinition(session);
    const messages = session.spec.messages || [];

    // Estimate tokens (approx 3.5 chars per token is a common rule of thumb, but 4 is safer for upper bound)
    // We use a simple estimator here since we don't have a tokenizer loaded
    const estSystemTokens = Math.ceil(systemPrompt.length / 3.5);
    const estToolsTokens = Math.ceil(JSON.stringify(toolsDef).length / 3.5);
    const estMessagesTokens = messages.reduce((acc, msg) => {
      return acc + Math.ceil((msg.content || '').length / 3.5);
    }, 0);

    // 2. Reconcile with Real Usage (if available)
    let finalSystem = estSystemTokens;
    let finalTools = estToolsTokens;
    let finalMessages = estMessagesTokens;
    let finalTotal = 0;

    const usage = session.metadata?.usage;
    Utils.logTrace(`[CoreContext] Usage data: ${JSON.stringify(usage)}`);
    if (usage && usage.prompt_tokens) {
        // We have real data!
        const totalPrompt = usage.prompt_tokens;
        
        // Strategy: System and Tools are relatively fixed. 
        // We assume our estimation for them is "close enough" or we treat them as the baseline.
        // The remainder is messages.
        
        // However, if our estimates are wildly off, we scale them.
        const totalEst = estSystemTokens + estToolsTokens + estMessagesTokens;
        
        if (totalEst > 0) {
            const ratio = totalPrompt / totalEst;
            finalSystem = Math.round(estSystemTokens * ratio);
            finalTools = Math.round(estToolsTokens * ratio);
            finalMessages = Math.round(estMessagesTokens * ratio);
        } else {
            // Edge case: empty everything but usage exists?
            finalMessages = totalPrompt;
        }
    }

    // 3. Reserved & Free
    // Reserved is usually output buffer + safety margin. 
    // Claude Code prompt suggests "autocompact + output buffer".
    // We'll use a fixed percentage or value based on model.
    const reservedTokens = this.getReservedTokens(model, contextLimit);
    
    finalTotal = finalSystem + finalTools + finalMessages + reservedTokens;
    const freeTokens = Math.max(0, contextLimit - finalTotal);
    const usagePercent = (finalTotal / contextLimit) * 100;

    // 4. Generate Report
    const graph = this.generateGraph(contextLimit, finalSystem, finalTools, reservedTokens, finalMessages);
    
    // Format numbers for legend
    const fmt = (n) => this.formatK(n);
    const pct = (n) => ((n / contextLimit) * 100).toFixed(1) + '%';

    // Slash commands count (placeholder logic - we don't track this strictly yet)
    const slashCount = 0; 
    const lastCmdTokens = usage?.total_tokens || 0; // Use total from last request as proxy

    // Helper for bold colors
    const bold = (color, text) => Utils.colorize(color, `\x1b[1m${text}`);
    const color = (c, t) => Utils.colorize(c, t);

    const report = `
${color('cyan', 'L')} ${bold('white', 'Context Usage')} ${bold('grey', this.formatK(finalTotal) + '/' + this.formatK(contextLimit) + ' tokens')} ${bold('grey', '(' + usagePercent.toFixed(0) + '%)')}
${graph}

${color('cyan', '⛁')} ${bold('white', 'System prompt:')} ${fmt(finalSystem)} tokens (${pct(finalSystem)})
${color('cyan', '⛁')} ${bold('white', 'System tools:')} ${fmt(finalTools)} tokens (${pct(finalTools)})
${color('white', '⛝')} ${bold('white', 'Reserved:')} ${fmt(reservedTokens)} tokens (${pct(reservedTokens)})
  [autocompact + output tokens]
${color('purple', '⛃')} ${bold('white', 'Messages:')} ${finalMessages} tokens (${pct(finalMessages)})
${color('white', '⬚')} ${bold('white', 'Free space:')} ${this.formatK(freeTokens)} (${pct(freeTokens)})

${bold('white', 'Slash/Command Tool')} - ${bold('grey', slashCount + ' commands')}
${color('cyan', 'L')} ${color('white', 'Total:')} ${lastCmdTokens} tokens
\x1b[0m`.trim();

    Utils.logTrace(`[CoreContext] Report generated, length: ${report.length}`);
    return {
      status: 'success',
      result: report
    };
  }

  getContextLimit(model) {
    const m = model.toLowerCase();
    if (m.includes('128k') || m.includes('gpt-4o') || m.includes('turbo')) return 128000;
    if (m.includes('claude-3-5-sonnet') || m.includes('sonnet-4.5')) return 200000;
    if (m.includes('claude-3') || m.includes('opus')) return 200000;
    if (m.includes('grok-beta') || m.includes('grok-4')) return 131072; // Grok beta often 128k approx
    if (m.includes('gemini-1.5')) return 1000000;
    if (m.includes('qwen3:8b') || m.includes('qwen')) return 32768; // Qwen 2.5/3 often 32k
    if (m.includes('llama3')) return 8192;
    return 8192; // Default fallback
  }

  getReservedTokens(model, limit) {
      // Heuristic: Reserve ~5-10% or 4k, whichever is reasonable
      // User example showed 45k reserved on 200k limit (approx 22%)
      // We'll aim for ~20% to match the visual style requested
      return Math.round(limit * 0.20);
  }

  getToolsDefinition(session) {
    const allowedTools = new Set();
    const sessionTools = session.metadata?.tools || [];
    for (const item of sessionTools) {
        if (typeof item === 'string') {
            allowedTools.add(item);
        } else if (typeof item === 'object') {
            const name = Object.keys(item)[0];
            allowedTools.add(name);
        }
    }

    const tools = [];
    for (const plugin of globals.pluginsRegistry.values()) {
        const def = plugin.definition;
        if (Array.isArray(def)) {
            for (const tool of def) {
                const toolName = tool.function.name;
                if (allowedTools.size > 0 && !allowedTools.has(toolName)) continue;
                tools.push({
                    type: tool.type,
                    function: tool.function
                });
            }
        }
    }
    return tools;
  }

  generateGraph(limit, system, tools, reserved, messages) {
    const totalBlocks = 90; // 9 rows * 10 cols
    const tokensPerBlock = limit / totalBlocks;

    const systemBlocks = Math.ceil(system / tokensPerBlock);
    const toolsBlocks = Math.ceil(tools / tokensPerBlock);
    const reservedBlocks = Math.ceil(reserved / tokensPerBlock);
    const messageBlocks = Math.ceil(messages / tokensPerBlock);
    
    let graph = '';
    let currentBlock = 0;

    // Order: system prompt → system tools → reserved → messages → free space
    const totalUsedBlocks = systemBlocks + toolsBlocks + reservedBlocks + messageBlocks;

    // Helper for colors
    const color = (c, t) => Utils.colorize(c, t);

    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 10; col++) {
        if (currentBlock < systemBlocks) {
          graph += color('cyan', '⛁ ');
        } else if (currentBlock < systemBlocks + toolsBlocks) {
          graph += color('cyan', '⛁ '); 
        } else if (currentBlock < systemBlocks + toolsBlocks + reservedBlocks) {
          graph += color('white', '⛝ ');
        } else if (currentBlock < systemBlocks + toolsBlocks + reservedBlocks + messageBlocks) {
          graph += color('purple', '⛃ ');
        } else {
          graph += color('white', '⬚ ');
        }
        currentBlock++;
      }
      graph = graph.trimEnd() + '\n';
    }
    return graph.trimEnd();
  }

  formatK(num) {
    if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'k';
    }
    return num.toString();
  }
}

