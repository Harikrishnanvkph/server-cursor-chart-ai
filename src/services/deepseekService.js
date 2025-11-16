import { callDeepSeekAPI } from '../adapters/deepseekAdapter.js'

const NOT_IMPLEMENTED_MESSAGE = 'DeepSeek chart generation is not yet available. Please use Google, Perplexity, or OpenRouter.'

export async function generateChartDataWithDeepSeek(input, model) {
  console.warn('[DeepSeek] generateChartDataWithDeepSeek invoked before integration is complete.')
  throw new Error(NOT_IMPLEMENTED_MESSAGE)
}

export async function modifyChartDataWithDeepSeek(input, currentChartState, messageHistory, model) {
  console.warn('[DeepSeek] modifyChartDataWithDeepSeek invoked before integration is complete.')
  throw new Error(NOT_IMPLEMENTED_MESSAGE)
}

