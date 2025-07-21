import { OpenAI } from 'openai';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Perplexity AI Adapter
 * Handles Perplexity-specific API calls and response formatting
 */
export class PerplexityAdapter {
  constructor() {
    this.serviceName = 'perplexity';
    this.client = new OpenAI({
      apiKey: process.env.PERPLEXITY_API_KEY,
      baseURL: "https://api.perplexity.ai"
    });
  }

  /**
   * Generate content using Perplexity
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
      model: model || 'sonar-pro',
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
   * Validate Perplexity API key
   * @returns {Promise<boolean>} - Whether the API key is valid
   */
  async validateApiKey() {
    try {
      if (!process.env.PERPLEXITY_API_KEY) {
        return false;
      }

      const response = await this.client.chat.completions.create({
        model: 'sonar-small',
        messages: [{ role: 'user', content: 'Test connection' }],
        max_tokens: 10
      });
      
      return !!response.choices?.[0]?.message?.content;
    } catch (error) {
      console.error('Perplexity API key validation failed:', error.message);
      return false;
    }
  }

  /**
   * Get additional metadata specific to Perplexity
   * @param {Object} response - API response
   * @param {string} model - Model used
   * @returns {Object} - Additional metadata
   */
  getAdditionalMetadata(response, model) {
    return {
      model_family: this.getModelFamily(model),
      finish_reason: response.rawResponse?.choices?.[0]?.finish_reason || null,
      citations: response.rawResponse?.citations || null
    };
  }

  /**
   * Enhance errors with Perplexity-specific context
   * @param {Error} error - Original error
   * @returns {Error} - Enhanced error
   */
  enhanceError(error) {
    if (error.status === 401) {
      return new Error('Invalid Perplexity API key');
    } else if (error.status === 429) {
      return new Error('Perplexity API rate limit exceeded');
    } else if (error.status >= 500) {
      return new Error('Perplexity API server error');
    } else {
      return new Error(`Perplexity API error: ${error.message}`);
    }
  }

  /**
   * Get available Perplexity models
   * @returns {Array} - List of available models
   */
  getAvailableModels() {
    return [
      {
        id: 'sonar-pro',
        name: 'Sonar Pro',
        description: 'Advanced search with grounding for complex queries',
        context_length: 4096,
        cost_tier: 'premium'
      },
      {
        id: 'sonar-small',
        name: 'Sonar Small',
        description: 'Efficient model for simpler tasks',
        context_length: 4096,
        cost_tier: 'basic'
      },
      {
        id: 'sonar-medium',
        name: 'Sonar Medium',
        description: 'Balanced performance and cost',
        context_length: 4096,
        cost_tier: 'standard'
      },
      {
        id: 'mistral-7b',
        name: 'Mistral 7B',
        description: 'Open-source model with good performance',
        context_length: 8192,
        cost_tier: 'standard'
      },
      {
        id: 'codellama-34b',
        name: 'CodeLlama 34B',
        description: 'Specialized for programming assistance',
        context_length: 4096,
        cost_tier: 'premium'
      },
      {
        id: 'llama-2-70b',
        name: 'Llama 2 70B',
        description: 'Large model with broad capabilities',
        context_length: 4096,
        cost_tier: 'premium'
      }
    ];
  }

  // ========== PRIVATE HELPER METHODS ==========

  /**
   * Get model family for metadata
   * @param {string} model - Model name
   * @returns {string} - Model family
   */
  getModelFamily(model) {
    if (model?.includes('sonar')) return 'sonar';
    if (model?.includes('mistral')) return 'mistral';
    if (model?.includes('llama')) return 'llama';
    if (model?.includes('codellama')) return 'codellama';
    return 'unknown';
  }
}

/**
 * Factory function to create Perplexity adapter
 * @returns {PerplexityAdapter} - Perplexity adapter instance
 */
export function createPerplexityAdapter() {
  return new PerplexityAdapter();
} 