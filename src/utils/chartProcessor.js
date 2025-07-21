import fs from 'node:fs/promises';

/**
 * Generic Chart Processing Engine
 * Handles common operations while delegating service-specific logic to adapters
 */
export class ChartProcessor {
  constructor(adapter) {
    this.adapter = adapter;
    this.aiContextCache = null;
    this.modificationContextCache = null;
  }

  /**
   * Generate new chart data
   * @param {string} inputText - User's chart request
   * @param {string} model - Model to use
   * @returns {Promise<Object>} - Generated chart configuration
   */
  async generateChart(inputText, model) {
    try {
      // Get AI context (with caching)
      const aiContext = await this.getAIContext();
      
      // Construct prompts
      const systemPrompt = this.buildSystemPrompt(aiContext);
      const userPrompt = this.buildUserPrompt(inputText);
      
      // Make service-specific API call
      const response = await this.adapter.generateContent({
        systemPrompt,
        userPrompt,
        model,
        maxTokens: 2000,
        temperature: 0.3,
        topP: 0.9
      });
      
      // Process response
      const cleanedResponse = this.cleanResponse(response.content);
      const chartData = this.parseJSON(cleanedResponse, this.adapter.serviceName);
      
      // Add metadata
      chartData._metadata = this.buildMetadata(response, model);
      
      return chartData;
      
    } catch (error) {
      console.error(`Error generating chart with ${this.adapter.serviceName}:`, error);
      throw this.enhanceError(error);
    }
  }

  /**
   * Modify existing chart data
   * @param {string} inputText - User's modification request
   * @param {Object} currentChartState - Current chart state
   * @param {Array} messageHistory - Conversation history
   * @param {string} model - Model to use
   * @returns {Promise<Object>} - Modified chart configuration
   */
  async modifyChart(inputText, currentChartState, messageHistory = [], model) {
    try {
      // Get modification context (with caching)
      const modificationContext = await this.getModificationContext();
      
      // Build modification prompt
      const contextPrompt = this.buildModificationPrompt(
        modificationContext, 
        currentChartState, 
        messageHistory, 
        inputText
      );
      
      // Make service-specific API call
      const response = await this.adapter.generateContent({
        userPrompt: contextPrompt,
        model,
        maxTokens: 2000,
        temperature: 0.3
      });
      
      // Process response
      const cleanedResponse = this.cleanResponse(response.content);
      const chartData = this.parseJSON(cleanedResponse, this.adapter.serviceName);
      
      // Add metadata
      chartData._metadata = this.buildMetadata(response, model);
      
      return chartData;
      
    } catch (error) {
      console.error(`Error modifying chart with ${this.adapter.serviceName}:`, error);
      throw this.enhanceError(error);
    }
  }

  /**
   * Validate service API key
   * @returns {Promise<boolean>} - Whether the API key is valid
   */
  async validateApiKey() {
    try {
      return await this.adapter.validateApiKey();
    } catch (error) {
      console.error(`Error validating ${this.adapter.serviceName} API key:`, error);
      return false;
    }
  }

  // ========== PRIVATE HELPER METHODS ==========

  /**
   * Get AI context with caching
   * @returns {Promise<string>} - AI context content
   */
  async getAIContext() {
    if (!this.aiContextCache) {
      this.aiContextCache = await fs.readFile('./src/AI_Inform.txt', 'utf-8');
    }
    return this.aiContextCache;
  }

  /**
   * Get modification context with caching
   * @returns {Promise<string>} - Modification context content
   */
  async getModificationContext() {
    if (!this.modificationContextCache) {
      this.modificationContextCache = await fs.readFile('./src/AI_Modification_Inform.txt', 'utf-8');
    }
    return this.modificationContextCache;
  }

  /**
   * Build system prompt for chart generation
   * @param {string} aiContext - AI context from file
   * @returns {string} - System prompt
   */
  buildSystemPrompt(aiContext) {
    return `${aiContext}

You are an expert chart data generator. Always respond with valid JSON that follows Chart.js format. 
Focus on creating accurate, well-structured data that can be immediately used to render charts.
Include proper labels, datasets, colors, and configuration options.`;
  }

  /**
   * Build user prompt for chart generation
   * @param {string} inputText - User's request
   * @returns {string} - User prompt
   */
  buildUserPrompt(inputText) {
    return `User request: ${inputText}

Please generate chart data in valid JSON format.`;
  }

  /**
   * Build modification prompt
   * @param {string} modificationContext - Modification instructions
   * @param {Object} currentChartState - Current chart state
   * @param {Array} messageHistory - Conversation history
   * @param {string} inputText - User's modification request
   * @returns {string} - Modification prompt
   */
  buildModificationPrompt(modificationContext, currentChartState, messageHistory, inputText) {
    return `${modificationContext}

Current Chart State:
- Chart Type: ${currentChartState.chartType}
- Current Data: ${JSON.stringify(currentChartState.chartData, null, 2)}
- Current Config: ${JSON.stringify(currentChartState.chartConfig, null, 2)}

Recent conversation context (last 3 messages):
${messageHistory.slice(-3).map(msg => `${msg.role}: ${msg.content}`).join('\n')}

User's modification request: ${inputText}

Respond with ONLY a JSON object containing the modified chart configuration.
Keep all existing data and settings unless specifically requested to change.

Response format:
{
  "action": "modify",
  "chartType": "same or new type",
  "chartData": { /* modified data */ },
  "chartConfig": { /* modified config */ },
  "user_message": "Explanation of changes made",
  "changes": ["list of specific changes made"]
}`;
  }

  /**
   * Clean response text by removing markdown formatting
   * @param {string} responseText - Raw response text
   * @returns {string} - Cleaned response text
   */
  cleanResponse(responseText) {
    if (!responseText) {
      throw new Error('Empty response from AI service');
    }

    let cleaned = responseText.trim();
    
    // Remove ```json and ``` if they exist
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    
    // Additional cleanup - remove any remaining backticks at start/end
    cleaned = cleaned.replace(/^`+|`+$/g, '').trim();
    
    return cleaned;
  }

  /**
   * Parse JSON with enhanced error handling
   * @param {string} jsonText - JSON text to parse
   * @param {string} serviceName - Service name for error context
   * @returns {Object} - Parsed JSON object
   */
  parseJSON(jsonText, serviceName) {
    try {
      return JSON.parse(jsonText);
    } catch (parseError) {
      console.error(`JSON Parse Error from ${serviceName}:`, parseError.message);
      console.error('Raw response:', jsonText.substring(0, 500));
      throw new Error(`Failed to parse ${serviceName} response as valid JSON: ${parseError.message}`);
    }
  }

  /**
   * Build metadata object
   * @param {Object} response - API response
   * @param {string} model - Model used
   * @returns {Object} - Metadata object
   */
  buildMetadata(response, model) {
    const baseMetadata = {
      service: this.adapter.serviceName,
      model: model,
      timestamp: new Date().toISOString(),
      tokens_used: response.tokensUsed || null
    };

    // Add service-specific metadata
    return { ...baseMetadata, ...this.adapter.getAdditionalMetadata(response, model) };
  }

  /**
   * Enhance errors with service-specific context
   * @param {Error} error - Original error
   * @returns {Error} - Enhanced error
   */
  enhanceError(error) {
    // Check for common error patterns
    if (error.message?.includes('JSON')) {
      return new Error(`Failed to parse ${this.adapter.serviceName} response as valid JSON`);
    }
    
    // Delegate to adapter for service-specific error handling
    return this.adapter.enhanceError(error);
  }

  /**
   * Clear all caches (useful for testing or memory management)
   */
  clearCache() {
    this.aiContextCache = null;
    this.modificationContextCache = null;
  }
}

/**
 * Factory function to create chart processor with adapter
 * @param {Object} adapter - Service-specific adapter
 * @returns {ChartProcessor} - Configured chart processor
 */
export function createChartProcessor(adapter) {
  return new ChartProcessor(adapter);
} 