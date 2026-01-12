import { BaseProvider } from './base.mjs';
import { Utils } from '../../../../common/utils.mjs';
import { globals } from '../../../../common/globals.mjs';
import OpenAI from 'openai';

export class LlamaCppProvider extends BaseProvider {
  constructor() {
    super();
    this.client = null;
  }

  static getName() { return 'LlamaCpp'; }

  async init() {
    if (this.initialized && this.client) return;

    const config = globals.getConfig('aiProviders.llamacpp');
    const apiKey = config?.apiKey || process.env.LLAMACPP_API_KEY || 'local';
    const baseURL = config?.baseUrl || process.env.LLAMACPP_BASE_URL || 'http://localhost:8080/v1';

    this.client = new OpenAI({
      apiKey: apiKey,
      baseURL: baseURL,
    });

    this.initialized = true;
  }

  async createChatCompletion({ model, messages, tools = [], max_tokens, signal }) {
    if (!this.initialized) await this.init();
    
    const startTime = Date.now();

    try {
      const requestOptions = {
        model: model || globals.getConfig('aiProviders.llamacpp.model') || 'default',
        messages: messages,
        max_tokens: max_tokens,
        stream: false,
      };

      // Only include tools if provided and non-empty
      if (tools && tools.length > 0) {
        requestOptions.tools = tools;
      }

      const response = await this.client.chat.completions.create(requestOptions, { signal });

      const endTime = Date.now();
      const totalTime = (endTime - startTime) / 1000;
      const tokensGenerated = response.usage?.completion_tokens || 0;

      response.metrics = {
        tokens_per_second: totalTime > 0 ? tokensGenerated / totalTime : 0,
        time_to_first_token_ms: endTime - startTime,
      };

      return this.normalizeResponse(response);
    } catch (error) {
      Utils.logError(`LlamaCpp API error: ${error.message}`);
      throw error;
    }
  }
}
