import { BaseProvider } from './base.mjs';
import { Utils } from '../../../../common/utils.mjs';

export class RemoteProvider extends BaseProvider {
  constructor(providerName) {
    super();
    this.providerName = providerName;
  }

  static getName() { return 'Remote'; }

  async init() {
    this.initialized = true;
  }

  async createChatCompletion({ model, messages, tools = [], max_tokens, signal }) {
    // Use the bridge to send AI prompt request to host
    const { bridge } = await import('../../controllers/host-container-bridge.mjs');
    
    try {
      Utils.logTrace(`[RemoteProvider] Sending ai_prompt_request to host. Model: ${model}, Tools: ${tools.length}`);
      const response = await bridge.sendToHost({
        type: 'ai_prompt_request',
        provider: this.providerName,
        model,
        messages,
        tools
      });
      
      if (response.success) {
        Utils.logTrace(`[RemoteProvider] Received success response from host`);
        return response.data;
      } else {
        Utils.logTrace(`[RemoteProvider] Received error response from host: ${response.error}`);
        throw new Error(response.error || 'Unknown remote error');
      }
    } catch (err) {
      Utils.logError(`[RemoteProvider] Bridge communication error: ${err.message}`);
      throw err;
    }
  }
}
