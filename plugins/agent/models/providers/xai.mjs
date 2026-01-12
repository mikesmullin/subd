import { BaseProvider } from './base.mjs';
import { Utils } from '../../../../common/utils.mjs';
import { globals } from '../../../../common/globals.mjs';
import OpenAI from 'openai';

export class XAIProvider extends BaseProvider {
  constructor() {
    super();
    this.client = null;
  }

  static getName() { return 'xAI'; }

  async init() {
    if (this.initialized && this.client) return;

    const config = globals.getConfig('aiProviders.xai');
    const apiKey = config?.apiKey || process.env.XAI_API_KEY;
    
    if (!apiKey) {
      throw new Error('xAI API key not found in config or env.');
    }

    this.client = new OpenAI({
      apiKey: apiKey,
      baseURL: config?.baseUrl || 'https://api.x.ai/v1',
    });

    this.initialized = true;
  }

  async createChatCompletion({ model, messages, tools = [], max_tokens, signal }) {
    if (!this.initialized) await this.init();
    
    const startTime = Date.now();
    let firstTokenTime = null;

    try {
      const response = await this.client.chat.completions.create({
        model: model || globals.getConfig('aiProviders.xai.model') || 'grok-beta',
        messages: messages,
        tools: tools.length > 0 ? tools : undefined,
        max_tokens: max_tokens,
        stream: false,
      }, { signal });

      firstTokenTime = Date.now(); // Approx for non-streaming
      const endTime = Date.now();
      const totalTime = (endTime - startTime) / 1000;
      const tokensGenerated = response.usage?.completion_tokens || 0;

      // Add metrics to the raw response object before normalizing
      response.metrics = {
        tokens_per_second: totalTime > 0 ? tokensGenerated / totalTime : 0,
        time_to_first_token_ms: firstTokenTime - startTime,
      };

      return this.normalizeResponse(response);
    } catch (error) {
      Utils.logError(`xAI API error: ${error.message}`);
      throw error;
    }
  }
}
