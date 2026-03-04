import express from 'express';
import {
    generateChartDataWithGemini,
    modifyChartDataWithGemini,
    getAvailableGeminiModels,
    validateGeminiApiKey
} from '../services/geminiService.js';

const router = express.Router();

/**
 * POST /api/gemini/process-chart
 */
router.post('/process-chart', async (req, res) => {
    try {
        const { input, model, conversationId, currentChartState, messageHistory } = req.body;

        if (!input) return res.status(400).json({ error: 'Input text is required' });
        if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'Gemini API key not configured' });

        const aiResponse = currentChartState && conversationId
            ? await modifyChartDataWithGemini(input, currentChartState, messageHistory || [], model)
            : await generateChartDataWithGemini(input, model);

        if (!aiResponse.chartType || !aiResponse.chartData) {
            throw new Error('AI response missing required chart data');
        }

        res.json({
            chartType: aiResponse.chartType,
            chartData: aiResponse.chartData || aiResponse.data,
            chartConfig: aiResponse.chartConfig || aiResponse.options,
            user_message: aiResponse.user_message || `Chart ${currentChartState ? 'modified' : 'generated'} using Gemini AI`,
            action: aiResponse.action || (currentChartState ? 'modify' : 'create'),
            changes: aiResponse.changes || [],
            suggestions: aiResponse.suggestions || [],
            service: 'gemini',
            _metadata: aiResponse._metadata
        });

    } catch (error) {
        console.error('Gemini chart request error:', error.message);
        res.status(500).json({ error: 'Failed to process chart request with Gemini', details: error.message, service: 'gemini' });
    }
});

/**
 * GET /api/gemini/models
 */
router.get('/models', (req, res) => {
    try {
        const models = getAvailableGeminiModels();
        res.json({ models, total: models.length, recommended: 'gemini-2.5-flash' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch models', details: error.message });
    }
});

/**
 * GET /api/gemini/validate
 */
router.get('/validate', async (req, res) => {
    try {
        if (!process.env.GEMINI_API_KEY) {
            return res.status(400).json({ valid: false, error: 'Gemini API key not configured' });
        }
        const isValid = await validateGeminiApiKey();
        isValid
            ? res.json({ valid: true, message: 'Gemini API key is valid' })
            : res.status(401).json({ valid: false, error: 'Gemini API key is invalid' });
    } catch (error) {
        res.status(500).json({ valid: false, error: 'Validation failed', details: error.message });
    }
});

/**
 * GET /api/gemini/status
 */
router.get('/status', (req, res) => {
    res.json({
        service: 'gemini',
        status: process.env.GEMINI_API_KEY ? 'configured' : 'not_configured',
        api_key_configured: !!process.env.GEMINI_API_KEY,
        available_models: getAvailableGeminiModels().length,
        timestamp: new Date().toISOString()
    });
});

export default router;
