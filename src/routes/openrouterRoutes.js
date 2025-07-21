import express from 'express';
import { 
  generateChartDataWithOpenRouter, 
  modifyChartDataWithOpenRouter,
  getAvailableOpenRouterModels, 
  validateOpenRouterApiKey,
  getOpenRouterAccountInfo
} from '../services/openrouterService.js';

const router = express.Router();

// ========== OPENROUTER AI ROUTES ==========

/**
 * POST /api/openrouter/process-chart
 * Process chart request using OpenRouter AI
 */
//moonshotai/kimi-k2:free
//deepseek/deepseek-chat-v3-0324:free
router.post('/process-chart', async (req, res) => {
  try {
    const { 
      input, 
      model = 'deepseek/deepseek-chat-v3-0324:free',
      conversationId,
      currentChartState,
      messageHistory
    } = req.body;
    
    if (!input) {
      return res.status(400).json({ error: 'Input text is required' });
    }
    
    if (!process.env.OPENROUTER_API_KEY) {
      console.log('dfs');
      return res.status(500).json({ error: 'OpenRouter API key not configured' });
    }

    console.log(`Processing chart request with OpenRouter (${model}):`, input.substring(0, 100) + '...');
    
    let aiResponse;
    
    // Determine if this is a modification or new chart
    if (currentChartState && conversationId) {
      console.log('Processing chart modification with OpenRouter for conversation:', conversationId);
      aiResponse = await modifyChartDataWithOpenRouter(input, currentChartState, messageHistory || [], model);
    } else {
      console.log('Processing new chart creation with OpenRouter');
      aiResponse = await generateChartDataWithOpenRouter(input, model);
    }
    
    // Format response to match frontend expectations
    const result = {
      chartType: aiResponse.chartType,
      chartData: aiResponse.data || aiResponse.chartData,
      chartConfig: aiResponse.options || aiResponse.chartConfig,
      user_message: aiResponse.user_message || `Chart generated using OpenRouter AI (${model})`,
      action: aiResponse.action || 'create',
      changes: aiResponse.changes || [],
      suggestions: aiResponse.suggestions || [],
      service: 'openrouter',
      _metadata: aiResponse._metadata
    };
    
    console.log('OpenRouter response generated successfully:', result.chartType);
    res.json(result);
    
  } catch (error) {
    console.error('Error processing OpenRouter chart request:', error);
    res.status(500).json({ 
      error: 'Failed to process chart request with OpenRouter',
      details: error.message 
    });
  }
});

/**
 * GET /api/openrouter/models
 * Get available OpenRouter models
 */
router.get('/models', (req, res) => {
  try {
    const models = getAvailableOpenRouterModels();
    
    // Group models by provider
    const modelsByProvider = models.reduce((acc, model) => {
      if (!acc[model.provider]) {
        acc[model.provider] = [];
      }
      acc[model.provider].push(model);
      return acc;
    }, {});
    
    res.json({ 
      models,
      total: models.length,
      by_provider: modelsByProvider,
      recommended: 'openai/gpt-4o-mini',
      providers: Object.keys(modelsByProvider)
    });
  } catch (error) {
    console.error('Error fetching OpenRouter models:', error);
    res.status(500).json({ 
      error: 'Failed to fetch available models',
      details: error.message 
    });
  }
});

/**
 * GET /api/openrouter/validate
 * Validate OpenRouter API key
 */
router.get('/validate', async (req, res) => {
  try {
    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(400).json({ 
        valid: false, 
        error: 'OpenRouter API key not configured in environment variables' 
      });
    }
    
    const isValid = await validateOpenRouterApiKey();
    
    if (isValid) {
      res.json({ 
        valid: true, 
        message: 'OpenRouter API key is valid and working',
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(401).json({ 
        valid: false, 
        error: 'OpenRouter API key is invalid or service unavailable' 
      });
    }
  } catch (error) {
    console.error('Error validating OpenRouter API key:', error);
    res.status(500).json({ 
      valid: false,
      error: 'Failed to validate API key',
      details: error.message 
    });
  }
});

/**
 * GET /api/openrouter/status
 * Get OpenRouter service status and configuration info
 */
router.get('/status', async (req, res) => {
  try {
    const hasApiKey = !!process.env.OPENROUTER_API_KEY;
    const models = getAvailableOpenRouterModels();
    
    // Try to get account info if API key is available
    let accountInfo = null;
    if (hasApiKey) {
      accountInfo = await getOpenRouterAccountInfo();
    }
    
    res.json({
      service: 'openrouter',
      version: '1.0.0',
      status: hasApiKey ? 'configured' : 'not_configured',
      api_key_configured: hasApiKey,
      available_models: models.length,
      providers: [...new Set(models.map(m => m.provider))],
      supported_features: [
        'chart_generation',
        'chart_modification',
        'multi_provider_access',
        'conversation_context',
        'advanced_models'
      ],
      limitations: [
        'api_costs_apply',
        'rate_limits_may_apply'
      ],
      account_info: accountInfo,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting OpenRouter status:', error);
    res.status(500).json({ 
      error: 'Failed to get service status',
      details: error.message 
    });
  }
});

/**
 * GET /api/openrouter/account
 * Get OpenRouter account information
 */
router.get('/account', async (req, res) => {
  try {
    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(400).json({ 
        error: 'OpenRouter API key not configured' 
      });
    }
    
    const accountInfo = await getOpenRouterAccountInfo();
    
    if (accountInfo) {
      res.json({
        success: true,
        account: accountInfo,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(404).json({ 
        success: false,
        error: 'Unable to fetch account information'
      });
    }
  } catch (error) {
    console.error('Error fetching OpenRouter account info:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch account information',
      details: error.message 
    });
  }
});

/**
 * POST /api/openrouter/test
 * Test endpoint for development and debugging
 */
router.post('/test', async (req, res) => {
  try {
    const { 
      query = 'Create a simple bar chart showing monthly sales data',
      model = 'openai/gpt-4o-mini'
    } = req.body;
    
    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(400).json({ 
        error: 'OpenRouter API key not configured for testing' 
      });
    }
    
    // Test chart generation
    const testResponse = await generateChartDataWithOpenRouter(query, model);
    
    res.json({
      test: 'success',
      query: query,
      model_used: model,
      response_type: testResponse.chartType,
      has_data: !!(testResponse.data || testResponse.chartData),
      provider: testResponse._metadata?.provider,
      tokens_used: testResponse._metadata?.tokens_used,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error in OpenRouter test:', error);
    res.status(500).json({ 
      test: 'failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/openrouter/models/:provider
 * Get models from a specific provider
 */
router.get('/models/:provider', (req, res) => {
  try {
    const { provider } = req.params;
    const allModels = getAvailableOpenRouterModels();
    const providerModels = allModels.filter(model => 
      model.provider.toLowerCase() === provider.toLowerCase()
    );
    
    if (providerModels.length === 0) {
      return res.status(404).json({ 
        error: `No models found for provider: ${provider}`,
        available_providers: [...new Set(allModels.map(m => m.provider))]
      });
    }
    
    res.json({
      provider: provider,
      models: providerModels,
      total: providerModels.length,
      recommended: providerModels.find(m => m.cost_tier === 'low')?.id || providerModels[0].id
    });
  } catch (error) {
    console.error('Error fetching provider models:', error);
    res.status(500).json({ 
      error: 'Failed to fetch provider models',
      details: error.message 
    });
  }
});

export default router; 