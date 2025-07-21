import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

/**
 * Google Gemini AI Adapter
 * Handles Google-specific API calls and response formatting
 */
export class GoogleAdapter {
  constructor() {
    this.serviceName = 'google';
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }

  /**
   * Generate content using Google Gemini
   * @param {Object} params - Generation parameters
   * @returns {Promise<Object>} - API response
   */
  async generateContent(params) {
    const { systemPrompt, userPrompt, model, maxTokens, temperature } = params;
    
    // Select appropriate model based on context
    const modelName = this.getModelName(model);
    const genModel = this.genAI.getGenerativeModel({ model: modelName });

    // For Google, we combine system and user prompts
    const combinedPrompt = systemPrompt ? `${systemPrompt}\n\nUser request: ${userPrompt}` : userPrompt;

    const result = await genModel.generateContent(combinedPrompt);
    const response = await result.response;
    const responseText = response.text();

    return {
      content: responseText,
      tokensUsed: this.extractTokenUsage(result),
      rawResponse: result
    };
  }

  /**
   * Validate Google API key
   * @returns {Promise<boolean>} - Whether the API key is valid
   */
  async validateApiKey() {
    try {
      if (!process.env.GEMINI_API_KEY) {
        return false;
      }

      const model = this.genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const result = await model.generateContent("Test connection");
      const response = await result.response;
      return !!response.text();
    } catch (error) {
      console.error('Google API key validation failed:', error.message);
      return false;
    }
  }

  /**
   * Get additional metadata specific to Google
   * @param {Object} response - API response
   * @param {string} model - Model used
   * @returns {Object} - Additional metadata
   */
  getAdditionalMetadata(response, model) {
    return {
      model_full_name: this.getModelName(model),
      safety_ratings: response.rawResponse?.response?.candidates?.[0]?.safetyRatings || null
    };
  }

  /**
   * Enhance errors with Google-specific context
   * @param {Error} error - Original error
   * @returns {Error} - Enhanced error
   */
  enhanceError(error) {
    if (error.status === 401 || error.message?.includes('API key')) {
      return new Error('Invalid Google Gemini API key');
    } else if (error.status === 429) {
      return new Error('Google Gemini API rate limit exceeded');
    } else if (error.status >= 500) {
      return new Error('Google Gemini API server error');
    } else if (error.message?.includes('SAFETY')) {
      return new Error('Google Gemini blocked the request due to safety concerns');
    } else {
      return new Error(`Google Gemini API error: ${error.message}`);
    }
  }

  // ========== PRIVATE HELPER METHODS ==========

  /**
   * Get appropriate Google model name
   * @param {string} requestedModel - Requested model
   * @returns {string} - Actual Google model name
   */
  getModelName(requestedModel) {
    // For chart generation, use flash model (faster)
    if (requestedModel === 'modification') {
      return 'gemini-2.5-pro'; // Use pro for modifications (better reasoning)
    }
    return requestedModel || 'gemini-2.5-flash';
  }

  /**
   * Extract token usage from Google response
   * @param {Object} result - Google API result
   * @returns {number|null} - Token usage
   */
  extractTokenUsage(result) {
    try {
      const usage = result.response?.usageMetadata;
      return usage ? (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0) : null;
    } catch (error) {
      return null;
    }
  }
}

/**
 * Factory function to create Google adapter
 * @returns {GoogleAdapter} - Google adapter instance
 */
export function createGoogleAdapter() {
  return new GoogleAdapter();
} 