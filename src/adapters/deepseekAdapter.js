import { OpenAI } from 'openai';

/**
 * DeepSeek Adapter
 * DeepSeek's API is OpenAI-compatible, so we reuse the OpenAI SDK.
 */
export class DeepSeekAdapter {
  constructor() {
    this.serviceName = 'deepseek';
    this._client = null; // lazy-initialized on first use
  }

  // Lazy client getter — defers instantiation until env vars are loaded
  get client() {
    if (!this._client) {
      this._client = new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: 'https://api.deepseek.com/v1'
      });
    }
    return this._client;
  }

  async generateContent({ systemPrompt, userPrompt, model, maxTokens, temperature }) {
    const resolvedModel = model || 'deepseek-chat';

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });

    try {
      const response = await this.client.chat.completions.create({
        model: resolvedModel,
        messages,
        max_tokens: maxTokens || 4096,
        temperature: temperature ?? 0.3,
        stream: false
      }, {
        signal: AbortSignal.timeout(60000) // 60-second timeout
      });

      const content = response.choices[0]?.message?.content;
      if (!content?.trim()) throw new Error('Empty response from DeepSeek AI service');

      return {
        content,
        tokensUsed: response.usage?.total_tokens || null,
        rawResponse: response
      };
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') throw new Error('DeepSeek API request timed out after 30 seconds.');
      if (error.status === 401) throw new Error('Invalid DeepSeek API key');
      if (error.status === 429) throw new Error('DeepSeek API rate limit exceeded. Please try again.');
      if (error.status >= 500) throw new Error('DeepSeek API server error. Please try again later.');
      throw error;
    }
  }

  async validateApiKey() {
    try {
      if (!process.env.DEEPSEEK_API_KEY) return false;
      const response = await this.client.chat.completions.create({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Test connection' }],
        max_tokens: 10
      });
      return !!response.choices?.[0]?.message?.content;
    } catch {
      return false;
    }
  }

  getAvailableModels() {
    return [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', description: 'General purpose — fast and capable', cost_tier: 'standard' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', description: 'Advanced reasoning (R1)', cost_tier: 'premium' }
    ];
  }

  getAdditionalMetadata(response, model) {
    return {
      model_used: model || 'deepseek-chat',
      finish_reason: response.rawResponse?.choices?.[0]?.finish_reason || null
    };
  }

  enhanceError(error) {
    if (error.status === 401) return new Error('Invalid DeepSeek API key');
    if (error.status === 429) return new Error('DeepSeek API rate limit exceeded');
    if (error.status >= 500) return new Error('DeepSeek API server error');
    return new Error(`DeepSeek API error: ${error.message}`);
  }
}

export function createDeepSeekAdapter() {
  return new DeepSeekAdapter();
}
