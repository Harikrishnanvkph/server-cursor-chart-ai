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
    if (!process.env.PERPLEXITY_API_KEY) {
      return res.status(500).json({ error: 'Perplexity API key not configured' });
    }
    
    let aiResponse;
    
    // Determine if this is a modification or new chart
    if (currentChartState && conversationId) {
      aiResponse = await modifyChartDataWithPerplexity(input, currentChartState, messageHistory || [], model);
    } else {
      aiResponse = await generateChartDataWithPerplexity(input, model);
    }

    // Format response to match frontend expectations
    const result = {
      chartType: aiResponse.chartType,
      chartData: aiResponse.chartData || aiResponse.data,
      chartConfig: aiResponse.chartConfig || aiResponse.options,
      user_message: aiResponse.user_message || `Chart ${currentChartState ? 'modified' : 'generated'} using Perplexity AI (${model})`,
      action: aiResponse.action || (currentChartState ? 'modify' : 'create'),
      changes: aiResponse.changes || [],
      suggestions: aiResponse.suggestions || [],
      service: 'perplexity',
      _metadata: aiResponse._metadata
    };

    // Validate that we have the minimum required data
    if (!result.chartType || !result.chartData) {
      console.error('Validation failed:', {
        chartType: result.chartType,
        hasChartData: !!result.chartData,
        chartDataKeys: result.chartData ? Object.keys(result.chartData) : 'null'
      });
      throw new Error('AI response missing required chart data - please try a different request');
    }
    
    res.json(result);
    
  } catch (error) {
    console.error('Error processing Perplexity chart request:', {
      message: error.message,
      stack: error.stack,
      input: req.body.input?.substring(0, 100) + '...',  // Log first 100 chars of input for debugging
      model: req.body.model || 'sonar-pro',
      timestamp: new Date().toISOString()
    });
    
    // Provide more specific error messages based on error type
    let errorMessage = 'Failed to process chart request with Perplexity';
    let details = error.message;
    let statusCode = 500;
    
    if (error.message?.includes('Empty response')) {
      errorMessage = 'Perplexity AI returned empty response';
      details = 'This might be due to rate limiting or service issues. Try using Google Gemini instead.';
      statusCode = 503; // Service Unavailable
    } else if (error.message?.includes('timeout')) {
      errorMessage = 'Request timed out';
      details = 'The Perplexity AI service took too long to respond. Try using Google Gemini instead.';
      statusCode = 504; // Gateway Timeout
    } else if (error.message?.includes('API key')) {
      errorMessage = 'Perplexity API configuration error';
      details = 'Please contact support if this persists.';
      statusCode = 401; // Unauthorized
    } else if (error.message?.includes('rate limit')) {
      errorMessage = 'Perplexity API rate limit exceeded';
      details = 'Please wait a moment before trying again, or use Google Gemini instead.';
      statusCode = 429; // Too Many Requests
    } else if (error.message?.includes('JSON')) {
      errorMessage = 'Perplexity AI returned invalid response format';
      details = 'The AI service returned malformed data. Try rephrasing your request or use Google Gemini instead.';
      statusCode = 422; // Unprocessable Entity
    } else if (error.message?.includes('truncated') || error.message?.includes('length limits')) {
      errorMessage = 'Perplexity response was truncated';
      details = 'The response exceeded token limits. Try a simpler request or use Google Gemini instead.';
      statusCode = 413; // Payload Too Large
    }
    
    res.status(statusCode).json({ 
      error: errorMessage,
      details: details,
      service: 'perplexity',
      fallback_suggestion: 'Try using Google Gemini AI service instead',
      timestamp: new Date().toISOString()
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
    const models = getAvailablePerplexityModels()
    
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
      'sonar-pro'
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