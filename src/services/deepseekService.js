import { createChartProcessor } from '../utils/chartProcessor.js';
import { createDeepSeekAdapter } from '../adapters/deepseekAdapter.js';

const deepseekProcessor = createChartProcessor(createDeepSeekAdapter());

export async function generateChartDataWithDeepSeek(inputText, model, templateStructure = null, formatStructure = null, webSearch = false, searchProvider = null) {
  return await deepseekProcessor.generateChart(inputText, model, templateStructure, formatStructure, webSearch, searchProvider);
}

export async function modifyChartDataWithDeepSeek(inputText, currentChartState, messageHistory = [], model, templateStructure = null, formatStructure = null, webSearch = false, searchProvider = null) {
  return await deepseekProcessor.modifyChart(inputText, currentChartState, messageHistory, model, templateStructure, formatStructure, webSearch, searchProvider);
}

export function getAvailableDeepSeekModels() {
  return deepseekProcessor.adapter.getAvailableModels();
}

export async function validateDeepSeekApiKey() {
  return await deepseekProcessor.validateApiKey();
}
