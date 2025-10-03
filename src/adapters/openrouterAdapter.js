import { OpenAI } from 'openai';
import dotenv from 'dotenv';

dotenv.config();

/**
 * OpenRouter AI Adapter
 * Handles OpenRouter-specific API calls and response formatting
 */
export class OpenRouterAdapter {
  constructor() {
    this.serviceName = 'openrouter';
    this.client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "http://localhost:3001",
        "X-Title": process.env.OPENROUTER_SITE_NAME || "Chart Generator",
      }
      // No timeout - let frontend handle it
    });
  }

  /**
   * Generate content using OpenRouter
   * @param {Object} params - Generation parameters
   * @returns {Promise<Object>} - API response
   */
  async generateContent(params) {
    const { systemPrompt, userPrompt, model, maxTokens, temperature, topP } = params;
    
    const messages = [];
    
    // Add system message if provided
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    
    // Add user message
    messages.push({ role: "user", content: userPrompt });

    const response = await this.client.chat.completions.create({
      model: model || 'openai/gpt-4o-mini',
      messages: messages,
      max_tokens: maxTokens || 2000,
      temperature: temperature || 0.3,
      top_p: topP || 0.9
    });

    return {
      content: response.choices[0].message.content,
      tokensUsed: response.usage?.total_tokens || null,
      rawResponse: response
    };
  }

  /**
   * Validate OpenRouter API key
   * @returns {Promise<boolean>} - Whether the API key is valid
   */
  async validateApiKey() {
    try {
      if (!process.env.OPENROUTER_API_KEY) {
        return false;
      }

      const response = await this.client.chat.completions.create({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'Test connection' }],
        max_tokens: 10
      });
      
      return !!response.choices?.[0]?.message?.content;
    } catch (error) {
      console.error('OpenRouter API key validation failed:', error.message);
      return false;
    }
  }

  /**
   * Get additional metadata specific to OpenRouter
   * @param {Object} response - API response
   * @param {string} model - Model used
   * @returns {Object} - Additional metadata
   */
  getAdditionalMetadata(response, model) {
    return {
      provider: this.extractProvider(model),
      model_full_name: model,
      finish_reason: response.rawResponse?.choices?.[0]?.finish_reason || null,
      prompt_tokens: response.rawResponse?.usage?.prompt_tokens || null,
      completion_tokens: response.rawResponse?.usage?.completion_tokens || null
    };
  }

  /**
   * Enhance errors with OpenRouter-specific context
   * @param {Error} error - Original error
   * @returns {Error} - Enhanced error
   */
  enhanceError(error) {
    if (error.status === 401) {
      return new Error('Invalid OpenRouter API key');
    } else if (error.status === 429) {
      return new Error('OpenRouter API rate limit exceeded');
    } else if (error.status >= 500) {
      return new Error('OpenRouter API server error');
    } else if (error.status === 402) {
      return new Error('OpenRouter insufficient credits');
    } else {
      return new Error(`OpenRouter API error: ${error.message}`);
    }
  }

  /**
   * Get available OpenRouter models
   * @returns {Array} - List of available models
   */
  getAvailableModels() {
    return [
      {
        id: 'openai/gpt-4o-mini',
        name: 'GPT-4o Mini',
        provider: 'OpenAI',
        description: 'Fast and efficient model for most tasks',
        context_length: 128000,
        cost_tier: 'low',
        capabilities: ['chart_generation', 'chart_modification']
      },
      {
        id: 'openai/gpt-4o',
        name: 'GPT-4o',
        provider: 'OpenAI',
        description: 'Most capable multimodal model',
        context_length: 128000,
        cost_tier: 'high',
        capabilities: ['chart_generation', 'chart_modification', 'advanced_reasoning']
      },
      {
        id: 'anthropic/claude-3.5-sonnet',
        name: 'Claude 3.5 Sonnet',
        provider: 'Anthropic',
        description: 'Excellent reasoning and analysis capabilities',
        context_length: 200000,
        cost_tier: 'medium',
        capabilities: ['chart_generation', 'chart_modification', 'data_analysis']
      },
      {
        id: 'anthropic/claude-3-haiku',
        name: 'Claude 3 Haiku',
        provider: 'Anthropic',
        description: 'Fast and cost-effective',
        context_length: 200000,
        cost_tier: 'low',
        capabilities: ['chart_generation', 'chart_modification']
      },
      {
        id: 'google/gemini-pro-1.5',
        name: 'Gemini Pro 1.5',
        provider: 'Google',
        description: 'Advanced reasoning with large context',
        context_length: 1000000,
        cost_tier: 'medium',
        capabilities: ['chart_generation', 'chart_modification', 'large_context']
      },
      {
        id: 'meta-llama/llama-3.1-70b-instruct',
        name: 'Llama 3.1 70B',
        provider: 'Meta',
        description: 'Open-source model with strong performance',
        context_length: 131072,
        cost_tier: 'medium',
        capabilities: ['chart_generation', 'chart_modification']
      },
      {
        id: 'mistralai/mistral-7b-instruct',
        name: 'Mistral 7B',
        provider: 'Mistral AI',
        description: 'Efficient open-source model',
        context_length: 32768,
        cost_tier: 'low',
        capabilities: ['chart_generation', 'chart_modification']
      },
      {
        id: 'cohere/command-r-plus',
        name: 'Command R+',
        provider: 'Cohere',
        description: 'Great for business applications',
        context_length: 128000,
        cost_tier: 'medium',
        capabilities: ['chart_generation', 'chart_modification', 'business_focus']
      }
    ];
  }

  /**
   * Get OpenRouter account information
   * @returns {Promise<Object|null>} - Account information
   */
  async getAccountInfo() {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (response.ok) {
        return await response.json();
      }
      return null;
    } catch (error) {
      console.error('Error fetching OpenRouter account info:', error);
      return null;
    }
  }

  // ========== PRIVATE HELPER METHODS ==========

  /**
   * Extract provider from model name
   * @param {string} model - Model name (e.g., 'openai/gpt-4o-mini')
   * @returns {string} - Provider name
   */
  extractProvider(model) {
    return model?.split('/')?.[0] || 'unknown';
  }
}

/**
 * Factory function to create OpenRouter adapter
 * @returns {OpenRouterAdapter} - OpenRouter adapter instance
 */
export function createOpenRouterAdapter() {
  return new OpenRouterAdapter();
} 