import { createChartProcessor } from '../utils/chartProcessor.js';
import { createPerplexityAdapter } from '../adapters/perplexityAdapter.js';

// Create processor with Perplexity adapter
const perplexityProcessor = createChartProcessor(createPerplexityAdapter());

/**
 * Generate chart data using Perplexity AI
 * @param {string} inputText - User's chart request
 * @param {string} model - Perplexity model to use (default: sonar-pro)
 * @param {Object} templateStructure - Template structure metadata for generating template text content
 * @returns {Promise<Object>} - Generated chart configuration
 */
export async function generateChartDataWithPerplexity(inputText, model = 'sonar-pro', templateStructure = null, formatStructure = null, webSearch = false, searchProvider = null, options = {}) {
  return await perplexityProcessor.generateChart(inputText, model, templateStructure, formatStructure, webSearch, searchProvider, options);
}

/**
 * Modify existing chart data using Perplexity AI
 * @param {string} inputText - User's modification request
 * @param {Object} currentChartState - Current chart state
 * @param {Array} messageHistory - Conversation history
 * @param {string} model - Perplexity model to use
 * @param {Object} templateStructure - Template structure metadata for generating template text content
 * @param {Object} formatStructure - Format structure metadata
 * @param {boolean} webSearch - Whether to perform web search
 * @param {string} searchProvider - Search provider override
 * @param {Object} options - Optional request options including AbortSignal
 * @returns {Promise<Object>} - Modified chart configuration
 */
export async function modifyChartDataWithPerplexity(inputText, currentChartState, messageHistory = [], model = 'sonar-pro', templateStructure = null, formatStructure = null, webSearch = false, searchProvider = null, options = {}) {
  return await perplexityProcessor.modifyChart(inputText, currentChartState, messageHistory, model, templateStructure, formatStructure, webSearch, searchProvider, options);
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