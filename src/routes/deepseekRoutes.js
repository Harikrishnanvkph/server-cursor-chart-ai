import express from 'express';
import {
  generateChartDataWithDeepSeek,
  modifyChartDataWithDeepSeek,
  getAvailableDeepSeekModels,
  validateDeepSeekApiKey
} from '../services/deepseekService.js';

const router = express.Router();

/**
 * POST /api/deepseek/process-chart
 */
router.post('/process-chart', async (req, res) => {
  try {
    const { input, model, conversationId, currentChartState, messageHistory } = req.body;

    if (!input) return res.status(400).json({ error: 'Input text is required' });
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: 'DeepSeek API key not configured' });

    const aiResponse = currentChartState && conversationId
      ? await modifyChartDataWithDeepSeek(input, currentChartState, messageHistory || [], model)
      : await generateChartDataWithDeepSeek(input, model);

    if (!aiResponse.chartType || !aiResponse.chartData) {
      throw new Error('AI response missing required chart data');
    }

    res.json({
      chartType: aiResponse.chartType,
      chartData: aiResponse.chartData || aiResponse.data,
      chartConfig: aiResponse.chartConfig || aiResponse.options,
      user_message: aiResponse.user_message || `Chart ${currentChartState ? 'modified' : 'generated'} using DeepSeek AI`,
      action: aiResponse.action || (currentChartState ? 'modify' : 'create'),
      changes: aiResponse.changes || [],
      suggestions: aiResponse.suggestions || [],
      service: 'deepseek',
      _metadata: aiResponse._metadata
    });

  } catch (error) {
    console.error('DeepSeek chart request error:', error.message);
    res.status(500).json({ error: 'Failed to process chart request with DeepSeek', details: error.message, service: 'deepseek' });
  }
});

/**
 * GET /api/deepseek/models
 */
router.get('/models', (req, res) => {
  try {
    const models = getAvailableDeepSeekModels();
    res.json({ models, total: models.length, recommended: 'deepseek-chat' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch models', details: error.message });
  }
});

/**
 * GET /api/deepseek/validate
 */
router.get('/validate', async (req, res) => {
  try {
    if (!process.env.DEEPSEEK_API_KEY) {
      return res.status(400).json({ valid: false, error: 'DeepSeek API key not configured' });
    }
    const isValid = await validateDeepSeekApiKey();
    isValid
      ? res.json({ valid: true, message: 'DeepSeek API key is valid' })
      : res.status(401).json({ valid: false, error: 'DeepSeek API key is invalid' });
  } catch (error) {
    res.status(500).json({ valid: false, error: 'Validation failed', details: error.message });
  }
});

/**
 * GET /api/deepseek/status
 */
router.get('/status', (req, res) => {
  res.json({
    service: 'deepseek',
    status: process.env.DEEPSEEK_API_KEY ? 'configured' : 'not_configured',
    api_key_configured: !!process.env.DEEPSEEK_API_KEY,
    available_models: getAvailableDeepSeekModels().length,
    timestamp: new Date().toISOString()
  });
});

export default router;
