import { createChartProcessor } from '../utils/chartProcessor.js';
import { createOpenRouterAdapter } from '../adapters/openrouterAdapter.js';

// Create processor with OpenRouter adapter
const openrouterProcessor = createChartProcessor(createOpenRouterAdapter());

/**
 * Generate chart data using OpenRouter AI
 * @param {string} inputText - User's chart request
 * @param {string} model - OpenRouter model to use (default: openai/gpt-4o-mini)
 * @param {Object} templateStructure - Template structure metadata for generating template text content
 * @returns {Promise<Object>} - Generated chart configuration
 */
export async function generateChartDataWithOpenRouter(inputText, model = 'deepseek/deepseek-chat-v3-0324:free', templateStructure = null) {
  return await openrouterProcessor.generateChart(inputText, model, templateStructure);
}

/**
 * Modify existing chart data using OpenRouter AI
 * @param {string} inputText - User's modification request
 * @param {Object} currentChartState - Current chart state
 * @param {Array} messageHistory - Conversation history
 * @param {string} model - OpenRouter model to use
 * @param {Object} templateStructure - Template structure metadata for generating template text content
 * @returns {Promise<Object>} - Modified chart configuration
 */
export async function modifyChartDataWithOpenRouter(inputText, currentChartState, messageHistory = [], model = 'deepseek/deepseek-chat-v3-0324:free', templateStructure = null) {
  return await openrouterProcessor.modifyChart(inputText, currentChartState, messageHistory, model, templateStructure);
}

/**
 * Get available OpenRouter models
 * @returns {Array} - List of available models
 */
export function getAvailableOpenRouterModels() {
  return openrouterProcessor.adapter.getAvailableModels();
}

/**
 * Validate OpenRouter API key
 * @returns {Promise<boolean>} - Whether the API key is valid
 */
export async function validateOpenRouterApiKey() {
  return await openrouterProcessor.validateApiKey();
}

/**
 * Get OpenRouter account information (credits, usage, etc.)
 * @returns {Promise<Object|null>} - Account information or null if unavailable
 */
export async function getOpenRouterAccountInfo() {
  return await openrouterProcessor.adapter.getAccountInfo();
} 