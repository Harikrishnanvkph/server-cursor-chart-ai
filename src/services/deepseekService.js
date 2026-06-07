import { createChartProcessor } from '../utils/chartProcessor.js';
import { createDeepSeekAdapter } from '../adapters/deepseekAdapter.js';

const deepseekProcessor = createChartProcessor(createDeepSeekAdapter());

export async function generateChartDataWithDeepSeek(inputText, model, templateStructure = null, formatStructure = null) {
  return await deepseekProcessor.generateChart(inputText, model, templateStructure, formatStructure);
}

export async function modifyChartDataWithDeepSeek(inputText, currentChartState, messageHistory = [], model, templateStructure = null, formatStructure = null) {
  return await deepseekProcessor.modifyChart(inputText, currentChartState, messageHistory, model, templateStructure, formatStructure);
}

export function getAvailableDeepSeekModels() {
  return deepseekProcessor.adapter.getAvailableModels();
}

export async function validateDeepSeekApiKey() {
  return await deepseekProcessor.validateApiKey();
}
