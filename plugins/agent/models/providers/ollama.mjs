import { BaseProvider } from './base.mjs';
import { Utils } from '../../../../common/utils.mjs';
import { globals } from '../../../../common/globals.mjs';
import { Ollama } from 'ollama';

export class OllamaProvider extends BaseProvider {
  constructor() {
    super();
    this.client = null;
  }

  static getName() { return 'Ollama'; }

  async init() {
    if (this.initialized && this.client) return;

    const config = globals.getConfig('aiProviders.ollama');
    const host = config?.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

    this.client = new Ollama({ host });
    this.initialized = true;
  }

  async createChatCompletion({ model, messages, tools = [], max_tokens, signal }) {
    Utils.logTrace(`[OllamaProvider] createChatCompletion called. Model: ${model}, Tools: ${tools?.length}`);
    if (!this.initialized) await this.init();
    
    try {
      // Ensure tools is undefined if empty array (Ollama client behavior)
      const toolDefinitions = tools.length > 0 ? tools : undefined;

      Utils.logTrace(`[OllamaProvider] Calling this.client.chat`);
      const response = await this.client.chat({
        model: model || globals.getConfig('aiProviders.ollama.model') || 'llama2',
        messages: messages,
        tools: toolDefinitions,
        stream: false,
        options: {
            num_predict: max_tokens
        }
      });
      Utils.logTrace(`[OllamaProvider] this.client.chat returned success`);

      return {
          choices: [{
              message: response.message,
              finish_reason: response.done_reason
          }],
          usage: {
              prompt_tokens: response.prompt_eval_count || 0,
              completion_tokens: response.eval_count || 0,
              total_tokens: (response.eval_count || 0) + (response.prompt_eval_count || 0)
          }
      };
    } catch (error) {
      Utils.logTrace(`[OllamaProvider] Error: ${error.message}`);
      Utils.logError(`Ollama API error: ${error.message}`);
      throw error;
    }
  }
}
