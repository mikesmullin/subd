import { BaseProvider } from './base.mjs';
import { Utils } from '../../../../common/utils.mjs';
import { globals } from '../../../../common/globals.mjs';
import { GoogleGenerativeAI } from '@google/generative-ai';

export class GeminiProvider extends BaseProvider {
  constructor() {
    super();
    this.client = null;
  }

  static getName() { return 'Gemini'; }

  async init() {
    if (this.initialized && this.client) return;

    const config = globals.getConfig('aiProviders.gemini');
    const apiKey = config?.apiKey || process.env.GOOGLE_API_KEY;
    
    if (!apiKey) {
      throw new Error('Gemini API key not found.');
    }

    this.client = new GoogleGenerativeAI(apiKey);
    this.initialized = true;
  }

  async createChatCompletion({ model, messages, tools = [], max_tokens, signal }) {
    if (!this.initialized) await this.init();
    
    try {
      const modelName = model || globals.getConfig('aiProviders.gemini.model') || 'gemini-pro';
      const genModel = this.client.getGenerativeModel({ model: modelName });
      
      const history = messages.slice(0, -1).map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
      }));
      const lastMsg = messages[messages.length - 1];
      
      const chat = genModel.startChat({
          history: history,
          generationConfig: {
              maxOutputTokens: max_tokens
          }
      });
      
      const result = await chat.sendMessage(lastMsg.content);
      const response = await result.response;
      const text = response.text();
      
      return {
          choices: [{
              message: { role: 'assistant', content: text },
              finish_reason: 'stop'
          }]
      };
    } catch (error) {
      Utils.logError(`Gemini API error: ${error.message}`);
      throw error;
    }
  }
}
