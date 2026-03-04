import { createChartProcessor } from '../utils/chartProcessor.js';
import { createDeepSeekAdapter } from '../adapters/deepseekAdapter.js';

const deepseekProcessor = createChartProcessor(createDeepSeekAdapter());

export async function generateChartDataWithDeepSeek(inputText, model, templateStructure = null) {
  return await deepseekProcessor.generateChart(inputText, model, templateStructure);
}

export async function modifyChartDataWithDeepSeek(inputText, currentChartState, messageHistory = [], model, templateStructure = null) {
  return await deepseekProcessor.modifyChart(inputText, currentChartState, messageHistory, model, templateStructure);
}

export function getAvailableDeepSeekModels() {
  return deepseekProcessor.adapter.getAvailableModels();
}

export async function validateDeepSeekApiKey() {
  return await deepseekProcessor.validateApiKey();
}
