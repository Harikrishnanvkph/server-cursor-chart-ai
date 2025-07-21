import express from 'express';
import { 
  generateChartDataWithPerplexity,
  modifyChartDataWithPerplexity,
  getAvailablePerplexityModels, 
  validatePerplexityApiKey 
} from '../services/perplexityService.js';

const router = express.Router();

// ========== PERPLEXITY AI ROUTES ==========

/**
 * POST /api/perplexity/process-chart
 * Process chart request using Perplexity AI
 */
router.post('/process-chart', async (req, res) => {
  try {
    const { 
      input, 
      model = 'sonar-pro',
      conversationId,
      currentChartState,
      messageHistory
    } = req.body;
    
    if (!input) {
      return res.status(400).json({ error: 'Input text is required' });
    }
    console.log(process.env.PERPLEXITY_API_KEY)
    if (!process.env.PERPLEXITY_API_KEY) {
      return res.status(500).json({ error: 'Perplexity API key not configured' });
    }

    console.log(`Processing chart request with Perplexity (${model}):`, input.substring(0, 100) + '...');
    
    let aiResponse;
    
    // Determine if this is a modification or new chart
    if (currentChartState && conversationId) {
      console.log('Processing chart modification with Perplexity for conversation:', conversationId);
      aiResponse = await modifyChartDataWithPerplexity(input, currentChartState, messageHistory || [], model);
    } else {
      console.log('Processing new chart creation with Perplexity');
      aiResponse = await generateChartDataWithPerplexity(input, model);
    }
    
    // Format response to match frontend expectations
    const result = {
      chartType: aiResponse.chartType,
      chartData: aiResponse.data || aiResponse.chartData,
      chartConfig: aiResponse.options || aiResponse.chartConfig,
      user_message: aiResponse.user_message || `Chart ${currentChartState ? 'modified' : 'generated'} using Perplexity AI (${model})`,
      action: aiResponse.action || (currentChartState ? 'modify' : 'create'),
      changes: aiResponse.changes || [],
      suggestions: aiResponse.suggestions || [],
      service: 'perplexity',
      _metadata: aiResponse._metadata
    };
    
    console.log('Perplexity response generated successfully:', result.chartType);
    res.json(result);
    
  } catch (error) {
    console.error('Error processing Perplexity chart request:', error);
    res.status(500).json({ 
      error: 'Failed to process chart request with Perplexity',
      details: error.message 
    });
  }
});

/**
 * GET /api/perplexity/models
 * Get available Perplexity models
 */
router.get('/models', (req, res) => {
  try {
    const models = getAvailablePerplexityModels();
    res.json({ 
      models,
      total: models.length,
      recommended: 'sonar-pro'
    });
  } catch (error) {
    console.error('Error fetching Perplexity models:', error);
    res.status(500).json({ 
      error: 'Failed to fetch available models',
      details: error.message 
    });
  }
});

/**
 * GET /api/perplexity/validate
 * Validate Perplexity API key
 */
router.get('/validate', async (req, res) => {
  try {
    if (!process.env.PERPLEXITY_API_KEY) {
      return res.status(400).json({ 
        valid: false, 
        error: 'Perplexity API key not configured in environment variables' 
      });
    }
    
    const isValid = await validatePerplexityApiKey();
    
    if (isValid) {
      res.json({ 
        valid: true, 
        message: 'Perplexity API key is valid and working',
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(401).json({ 
        valid: false, 
        error: 'Perplexity API key is invalid or service unavailable' 
      });
    }
  } catch (error) {
    console.error('Error validating Perplexity API key:', error);
    res.status(500).json({ 
      valid: false,
      error: 'Failed to validate API key',
      details: error.message 
    });
  }
});

/**
 * GET /api/perplexity/status
 * Get Perplexity service status and configuration info
 */
router.get('/status', (req, res) => {
  try {
    const hasApiKey = !!process.env.PERPLEXITY_API_KEY;
    const models = getAvailablePerplexityModels();
    
    res.json({
      service: 'perplexity',
      version: '1.0.0',
      status: hasApiKey ? 'configured' : 'not_configured',
      api_key_configured: hasApiKey,
      available_models: models.length,
      supported_features: [
        'chart_generation',
        'chart_modification',
        'real_time_web_search',
        'cited_responses',
        'multiple_model_options',
        'conversation_context'
      ],
      limitations: [
        'conversation_context_limited',
        'api_costs_may_apply'
      ],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting Perplexity status:', error);
    res.status(500).json({ 
      error: 'Failed to get service status',
      details: error.message 
    });
  }
});

/**
 * POST /api/perplexity/test
 * Test endpoint for development and debugging
 */
router.post('/test', async (req, res) => {
  try {
    const { query = 'What is artificial intelligence?' } = req.body;
    
    if (!process.env.PERPLEXITY_API_KEY) {
      return res.status(400).json({ 
        error: 'Perplexity API key not configured for testing' 
      });
    }
    
    // Simple test query (not for chart generation)
    const testResponse = await generateChartDataWithPerplexity(
      `Create a simple bar chart showing: ${query}`, 
      'sonar-small'
    );
    
    res.json({
      test: 'success',
      query: query,
      response_type: testResponse.chartType,
      has_data: !!(testResponse.data || testResponse.chartData),
      model_used: testResponse._metadata?.model,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error in Perplexity test:', error);
    res.status(500).json({ 
      test: 'failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

export default router; 