import express from 'express';
import {
  generateChartDataWithDeepSeek,
  modifyChartDataWithDeepSeek,
  getAvailableDeepSeekModels,
  validateDeepSeekApiKey
} from '../services/deepseekService.js';
import { canConsumeAiCredit, deductAiCredit, refundAiCredit } from '../services/subscriptionService.js';

const router = express.Router();

/**
 * POST /api/deepseek/process-chart
 */
router.post('/process-chart', async (req, res) => {
  let creditDeducted = false;
  let deductDetails = null;
  const userId = req.user?.user_id || req.user?.id;

  try {
    const { input, model, conversationId, currentChartState, messageHistory, mode, templateStructure, formatStructure, webSearch, searchProvider } = req.body;

    if (!input) return res.status(400).json({ error: 'Input text is required' });
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: 'DeepSeek API key not configured' });

    // Determine required AI credits: 1 for chart mode, 2 for template/format mode
    const isTemplateMode =
      mode === 'template' ||
      Boolean(templateStructure && Object.keys(templateStructure).length > 0) ||
      Boolean(formatStructure && Object.keys(formatStructure).length > 0);
    const requiredCredits = isTemplateMode ? 2 : 1;

    let updatedSubscription = null;
    if (userId) {
      const deductResult = await deductAiCredit(userId, requiredCredits);
      if (!deductResult || deductResult.exhausted || deductResult.success === false) {
        return res.status(403).json({
          error: requiredCredits > 1
            ? `Template mode requires ${requiredCredits} AI credits, but you have ${deductResult?.ai_credits_remaining ?? 0} remaining. Top up your AI credits to continue.`
            : 'AI credit limit reached. Purchase an AI Credits pack to continue generating charts.',
          code: 'AI_CREDITS_EXHAUSTED',
          requiredCredits,
          subscription: deductResult
        });
      }
      creditDeducted = true;
      deductDetails = {
        free: deductResult.deducted_free || 0,
        purchased: deductResult.deducted_purchased || 0,
        bucket: deductResult.deducted_bucket || 'free',
        amount: requiredCredits
      };
      updatedSubscription = deductResult;
    }

    const effectiveSearchProvider = searchProvider || (webSearch ? 'deepseek' : null);

    const aiResponse = currentChartState && conversationId
      ? await modifyChartDataWithDeepSeek(input, currentChartState, messageHistory || [], model, templateStructure, formatStructure, webSearch, effectiveSearchProvider)
      : await generateChartDataWithDeepSeek(input, model, templateStructure, formatStructure, webSearch, effectiveSearchProvider);

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
      _metadata: aiResponse._metadata,
      subscription: updatedSubscription
    });

  } catch (error) {
    console.error('DeepSeek chart request error:', error.message);
    if (creditDeducted && userId) {
      try {
        await refundAiCredit(userId, deductDetails || 'free');
      } catch (refundErr) {
        console.error('Failed to refund AI credit after error:', refundErr.message);
      }
    }
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
