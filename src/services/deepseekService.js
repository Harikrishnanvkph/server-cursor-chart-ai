import { createChartProcessor } from '../utils/chartProcessor.js';
import { createDeepSeekAdapter } from '../adapters/deepseekAdapter.js';

const deepseekProcessor = createChartProcessor(createDeepSeekAdapter());

export async function generateChartDataWithDeepSeek(inputText, model, templateStructure = null, formatStructure = null, webSearch = false) {
  return await deepseekProcessor.generateChart(inputText, model, templateStructure, formatStructure, webSearch);
}

export async function modifyChartDataWithDeepSeek(inputText, currentChartState, messageHistory = [], model, templateStructure = null, formatStructure = null, webSearch = false) {
  return await deepseekProcessor.modifyChart(inputText, currentChartState, messageHistory, model, templateStructure, formatStructure, webSearch);
}

export function getAvailableDeepSeekModels() {
  return deepseekProcessor.adapter.getAvailableModels();
}

export async function validateDeepSeekApiKey() {
  return await deepseekProcessor.validateApiKey();
}
