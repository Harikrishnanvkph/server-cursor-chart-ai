import { createChartProcessor } from '../utils/chartProcessor.js';
import { createPerplexityAdapter } from '../adapters/perplexityAdapter.js';

// Create processor with Perplexity adapter
const perplexityProcessor = createChartProcessor(createPerplexityAdapter());

/**
 * Generate chart data using Perplexity AI
 * @param {string} inputText - User's chart request
 * @param {string} model - Perplexity model to use (default: sonar-pro)
 * @returns {Promise<Object>} - Generated chart configuration
 */
export async function generateChartDataWithPerplexity(inputText, model = 'sonar-pro') {
  return await perplexityProcessor.generateChart(inputText, model);
}

/**
 * Modify existing chart data using Perplexity AI
 * @param {string} inputText - User's modification request
 * @param {Object} currentChartState - Current chart state
 * @param {Array} messageHistory - Conversation history
 * @param {string} model - Perplexity model to use
 * @returns {Promise<Object>} - Modified chart configuration
 */
export async function modifyChartDataWithPerplexity(inputText, currentChartState, messageHistory = [], model = 'sonar-pro') {
  return await perplexityProcessor.modifyChart(inputText, currentChartState, messageHistory, model);
}

/**
 * Get available Perplexity models
 * @returns {Array} - List of available models
 */
export function getAvailablePerplexityModels() {
  return perplexityProcessor.adapter.getAvailableModels();
}

/**
 * Validate Perplexity API key
 * @returns {Promise<boolean>} - Whether the API key is valid
 */
export async function validatePerplexityApiKey() {
  return await perplexityProcessor.validateApiKey();
} 