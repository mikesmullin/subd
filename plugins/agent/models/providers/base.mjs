import { Utils } from '../../../../common/utils.mjs';

export class BaseProvider {
  constructor(config = {}) {
    this.config = config;
    this.initialized = false;
  }

  static getName() {
    throw new Error('Provider must implement static getName() method');
  }

  async init() {
    throw new Error('Provider must implement init() method');
  }

  async createChatCompletion({ model, messages, tools = [], max_tokens, signal }) {
    throw new Error('Provider must implement createChatCompletion() method');
  }
  
  normalizeResponse(response) {
      return response;
  }
}
