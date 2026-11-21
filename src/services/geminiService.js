import { createChartProcessor } from '../utils/chartProcessor.js';
import { createGeminiAdapter } from '../adapters/geminiAdapter.js';

const geminiProcessor = createChartProcessor(createGeminiAdapter());

export async function generateChartDataWithGemini(inputText, model, templateStructure = null, formatStructure = null, webSearch = false, searchProvider = null, options = {}) {
    return await geminiProcessor.generateChart(inputText, model, templateStructure, formatStructure, webSearch, searchProvider, options);
}

export async function modifyChartDataWithGemini(inputText, currentChartState, messageHistory = [], model, templateStructure = null, formatStructure = null, webSearch = false, searchProvider = null, options = {}) {
    return await geminiProcessor.modifyChart(inputText, currentChartState, messageHistory, model, templateStructure, formatStructure, webSearch, searchProvider, options);
}

export function getAvailableGeminiModels() {
    return geminiProcessor.adapter.getAvailableModels();
}

export async function validateGeminiApiKey() {
    return await geminiProcessor.validateApiKey();
}
