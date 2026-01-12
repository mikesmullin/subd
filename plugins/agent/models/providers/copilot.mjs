import { BaseProvider } from './base.mjs';
import { Utils } from '../../../../common/utils.mjs';
import { globals } from '../../../../common/globals.mjs';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

export class CopilotProvider extends BaseProvider {
  constructor() {
    super();
    this.client = null;
    this.tokensPath = globals.dbPaths.tokens;
    
    // Default Config
    this.config = {
        github: {
            device_code_url: 'https://github.com/login/device/code',
            access_token_url: 'https://github.com/login/oauth/access_token',
            client_id: 'Iv1.b507a08c87ecfe98', // VS Code Client ID
            user_agent: 'GitHubCopilot/1.155.0',
        },
        copilot: {
            api_key_url: 'https://api.github.com/copilot_internal/v2/token',
            default_api_url: 'https://api.githubcopilot.com',
            editor_version: 'vscode/1.85.1',
            editor_plugin_version: 'copilot/1.155.0',
            user_agent: 'GitHubCopilot/1.155.0',
            integration_id: 'vscode-chat',
        }
    };
  }

  static getName() { return 'Copilot'; }

  async init() {
    if (this.initialized && this.client) return;

    // Ensure db directory exists
    const dbDir = path.dirname(this.tokensPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    const session = await this.getSession();
    if (!session || !session.tokens) {
        throw new Error('Failed to authenticate with Copilot');
    }

    this.client = new OpenAI({
      apiKey: session.tokens.copilot_token,
      baseURL: session.tokens.api_url || this.config.copilot.default_api_url,
      defaultHeaders: {
        'Editor-Version': this.config.copilot.editor_version,
        'Editor-Plugin-Version': this.config.copilot.editor_plugin_version,
        'User-Agent': this.config.copilot.user_agent,
        'Copilot-Integration-Id': this.config.copilot.integration_id,
        'OpenAI-Intent': 'conversation-panel',
      }
    });

    this.initialized = true;
  }

  async createChatCompletion({ model, messages, tools = [], max_tokens, signal }) {
    if (!this.initialized) await this.init();
    
    const startTime = Date.now();
    let firstTokenTime = null;

    try {
      const response = await this.client.chat.completions.create({
        model: model || globals.getConfig('aiProviders.copilot.model') || 'gpt-4',
        messages: messages,
        tools: tools.length > 0 ? tools : undefined,
        max_tokens: max_tokens,
        stream: false,
      }, { signal });

      firstTokenTime = Date.now();
      const endTime = Date.now();
      const totalTime = (endTime - startTime) / 1000;
      const tokensGenerated = response.usage?.completion_tokens || 0;

      response.metrics = {
        tokens_per_second: totalTime > 0 ? tokensGenerated / totalTime : 0,
        time_to_first_token_ms: firstTokenTime - startTime,
      };

      return this.normalizeResponse(response);
    } catch (error) {
      if (error.message.includes('token expired') || error.status === 401) {
          Utils.logWarn('Copilot token expired, re-authenticating...');
          this.initialized = false;
          this.client = null;
          // Clear tokens file to force refresh
          if (fs.existsSync(this.tokensPath)) fs.unlinkSync(this.tokensPath);
          
          await this.init();
          return this.createChatCompletion({ model, messages, tools, max_tokens, signal });
      }
      Utils.logError(`Copilot API error: ${error.message}`);
      throw error;
    }
  }

  // Auth Methods

  saveTokens(tokens) {
      fs.writeFileSync(this.tokensPath, Bun.YAML.stringify(tokens), 'utf8');
  }

  async startDeviceFlow() {
    const response = await fetch(this.config.github.device_code_url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': this.config.github.user_agent,
      },
      body: JSON.stringify({
        client_id: this.config.github.client_id,
        scope: 'read:user',
      }),
    });

    if (!response.ok) throw new Error(`Device flow failed: ${response.statusText}`);
    return await response.json();
  }

  async pollForAccessToken(deviceCode, interval) {
    const startTime = Date.now();
    const maxWait = 15 * 60 * 1000; // 15 minutes

    Utils.logInfo('Polling for GitHub authentication...');

    while (Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, interval * 1000));

      const response = await fetch(this.config.github.access_token_url, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': this.config.github.user_agent,
        },
        body: JSON.stringify({
          client_id: this.config.github.client_id,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });

      const data = await response.json();

      if (data.access_token) return data.access_token;
      if (data.error === 'authorization_pending') continue;
      if (data.error) throw new Error(`Authentication failed: ${data.error_description || data.error}`);
    }
    throw new Error('Authentication timeout');
  }

  async getCopilotToken(githubToken) {
    const response = await fetch(this.config.copilot.api_key_url, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${githubToken}`,
        'User-Agent': this.config.copilot.user_agent,
        'Editor-Version': this.config.copilot.editor_version,
        'Editor-Plugin-Version': this.config.copilot.editor_plugin_version,
      },
    });

    if (!response.ok) throw new Error(`Failed to get Copilot token: ${response.statusText}`);
    return await response.json();
  }

  async performFreshAuthentication() {
    const deviceFlow = await this.startDeviceFlow();

    Utils.logWarn(`\n📋 Please visit: ${deviceFlow.verification_uri}`);
    Utils.logWarn(`🔑 Enter code: ${deviceFlow.user_code}\n`);
    
    // We don't open browser automatically in daemon mode
    
    const githubToken = await this.pollForAccessToken(deviceFlow.device_code, deviceFlow.interval);
    Utils.logInfo('✅ GitHub authenticated!');

    const copilotData = await this.getCopilotToken(githubToken);
    Utils.logInfo('✅ Copilot token obtained!');

    const tokens = {
        github_token: githubToken,
        copilot_token: copilotData.token,
        expires_at: copilotData.expires_at,
        api_url: copilotData.endpoints?.api || this.config.copilot.default_api_url
    };

    this.saveTokens(tokens);
    return tokens;
  }

  async getSession() {
    let tokens = {};
    
    if (fs.existsSync(this.tokensPath)) {
        try {
            tokens = Bun.YAML.parse(fs.readFileSync(this.tokensPath, 'utf8'));
        } catch (e) {
            Utils.logWarn('Failed to read tokens file, starting fresh.');
        }
    }

    // 1. Valid Copilot Token
    if (tokens.copilot_token && tokens.expires_at && tokens.expires_at * 1000 > Date.now()) {
        return { tokens };
    }

    // 2. Refresh with GitHub Token
    if (tokens.github_token) {
        Utils.logDebug('Refreshing Copilot token...');
        try {
            const copilotData = await this.getCopilotToken(tokens.github_token);
            tokens.copilot_token = copilotData.token;
            tokens.expires_at = copilotData.expires_at;
            tokens.api_url = copilotData.endpoints?.api || this.config.copilot.default_api_url;
            this.saveTokens(tokens);
            return { tokens };
        } catch (e) {
            Utils.logWarn('Cached GitHub token expired or invalid.');
        }
    }

    // 3. Fresh Auth
    tokens = await this.performFreshAuthentication();
    return { tokens };
  }
}
