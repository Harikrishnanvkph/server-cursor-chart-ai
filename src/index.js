import express from 'express';
import compression from 'compression';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from 'node:fs/promises'
import { generateChartDataWithPerplexity, modifyChartDataWithPerplexity } from './services/perplexityService.js';
import { generateChartDataWithOpenRouter, modifyChartDataWithOpenRouter } from './services/openrouterService.js';
import perplexityRoutes from './routes/perplexityRoutes.js';
import openrouterRoutes from './routes/openrouterRoutes.js';
import { requireAuth, rateLimitMiddleware, getSecurityStats, blockIP, unblockIP } from './middleware/authMiddleware.js'

dotenv.config();

// Check required environment variables
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY', 
  'SUPABASE_SERVICE_ROLE_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET'
];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnvVars);
  console.error('Please check your .env file and ensure all required variables are set.');
  process.exit(1);
}

console.log('✅ All required environment variables are configured');

const app = express();
const port = process.env.PORT || 3001;

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// In-memory conversation store (in production, use a database)
const conversationStore = new Map();

// Enhanced security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'", "https://api.openai.com", "https://api.perplexity.ai"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

app.use(cookieParser());
app.use(compression());
app.use(express.json({ limit: '10mb' })); // Limit request body size

// CORS with enhanced security
const appOrigin = process.env.APP_ORIGIN || 'http://localhost:3000'
app.use(
  cors({
    origin: appOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['X-Total-Count']
  })
)

// Global rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil(15 * 60 / 1000), // 15 minutes in seconds
      message: 'Rate limit exceeded. Please try again later.'
    });
  }
});

app.use(globalLimiter);

// Mount routes with enhanced security
import authRoutes from './routes/authRoutes.js'
app.use('/auth', authRoutes)
app.use('/api', requireAuth) // protect API endpoints
app.use('/api/perplexity', perplexityRoutes);
app.use('/api/openrouter', openrouterRoutes);

// Security monitoring endpoints (admin only)
app.get('/admin/security/stats', requireAuth, (req, res) => {
  // Check if user is admin (you can implement your own admin check)
  if (req.user?.email !== process.env.ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  const stats = getSecurityStats();
  res.json(stats);
});

app.post('/admin/security/block-ip', requireAuth, (req, res) => {
  // Check if user is admin
  if (req.user?.email !== process.env.ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  const { ipAddress, reason } = req.body;
  if (!ipAddress) {
    return res.status(400).json({ error: 'IP address is required' });
  }
  
  blockIP(ipAddress, reason || 'Admin action');
  res.json({ success: true, message: `IP ${ipAddress} blocked` });
});

app.post('/admin/security/unblock-ip', requireAuth, (req, res) => {
  // Check if user is admin
  if (req.user?.email !== process.env.ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  const { ipAddress } = req.body;
  if (!ipAddress) {
    return res.status(400).json({ error: 'IP address is required' });
  }
  
  const wasBlocked = unblockIP(ipAddress);
  if (wasBlocked) {
    res.json({ success: true, message: `IP ${ipAddress} unblocked` });
  } else {
    res.json({ success: false, message: `IP ${ipAddress} was not blocked` });
  }
});

// Helper function to generate chart data using Gemini
async function generateChartData(inputText) {
  try {
    // Get the generative model
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const text = await fs.readFile('./src/AI_Inform.txt', 'utf-8');

    const prompt = `${text} and User request: ${inputText}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let responseText = response.text()
   
    // Clean the response text - remove markdown code blocks if present
    responseText = responseText.trim();
    
    // Remove ```json and ``` if they exist
    if (responseText.startsWith('```json')) {
      responseText = responseText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (responseText.startsWith('```')) {
      responseText = responseText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    
    // Additional cleanup - remove any remaining backticks at start/end
    responseText = responseText.replace(/^`+|`+$/g, '').trim()
   
    // Parse the cleaned response text as JSON
    const chartData = JSON.parse(responseText);
    return chartData;
  } catch (error) {
    console.error('Error generating chart data:', error);
    throw error;
  }
}

// Helper function to modify existing chart
async function modifyChartData(inputText, currentChartState, messageHistory) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
    
    const modificationInstructions = await fs.readFile('./src/AI_Modification_Inform.txt', 'utf-8');
    
    // Create compact chart state summary (remove formatting to reduce tokens by ~70%)
    const compactData = JSON.stringify(currentChartState.chartData);
    const compactConfig = JSON.stringify(currentChartState.chartConfig);
    
    const contextPrompt = `
    ${modificationInstructions}

    Current Chart State:
    - Chart Type: ${currentChartState.chartType}
    - Current Data: ${compactData}
    - Current Config: ${compactConfig}

    Recent conversation context (last 2 messages):
    ${messageHistory.slice(-2).map(msg => {
      const content = msg.content?.length > 150 ? msg.content.substring(0, 150) + '...' : msg.content;
      return `${msg.role}: ${content}`;
    }).join('\n')}

    User's modification request: ${inputText}

    Respond with ONLY a JSON object containing the modified chart configuration.
    Keep all existing data and settings unless specifically requested to change.

    Response format:
    {
      "action": "modify",
      "chartType": "same or new type",
      "chartData": { /* modified data */ },
      "chartConfig": { /* modified config */ },
      "user_message": "Explanation of changes made",
      "changes": ["list of specific changes made"]
    }
    `;

    // console.log('Modification prompt:', contextPrompt);

    const result = await model.generateContent(contextPrompt);
    const response = await result.response;
    let responseText = response.text().trim();
    
    // Clean the response text
    if (responseText.startsWith('```json')) {
      responseText = responseText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (responseText.startsWith('```')) {
      responseText = responseText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    responseText = responseText.replace(/^`+|`+$/g, '').trim();
    
    const chartData = JSON.parse(responseText);
    return chartData;
  } catch (error) {
    console.error('Error modifying chart data:', error);
    throw error;
  }
}

// Endpoint to process chart request (new or modification)
app.post('/api/process-chart', async (req, res) => {
  try {
    const { input, conversationId, currentChartState, messageHistory } = req.body;
    
    if (!input) {
      return res.status(400).json({ error: 'Input text is required' });
    }

    let aiResponse;
    
    // Determine if this is a modification or new chart
    if (currentChartState && conversationId) {
      aiResponse = await modifyChartData(input, currentChartState, messageHistory || []);
    } else {
      aiResponse = await generateChartData(input);
    }

    // console.log('AI Response:', aiResponse);
    
    // Compose the correct format for the frontend
    const result = {
      chartType: aiResponse.chartType,
      chartData: aiResponse.chartData || aiResponse.data,
      chartConfig: aiResponse.chartConfig || aiResponse.options,
      user_message: aiResponse.user_message,
      action: aiResponse.action || 'create',
      changes: aiResponse.changes || []
    };
    
    res.json(result);
  } catch (error) {
    console.error('Error processing chart request:', error);
    res.status(500).json({ 
      error: 'Failed to process chart request',
      details: error.message 
    });
  }
});

// Endpoint to get conversation history
app.get('/api/conversation/:id', (req, res) => {
  const { id } = req.params;
  const conversation = conversationStore.get(id);
  
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  
  res.json(conversation);
});

// Endpoint to delete conversation
app.delete('/api/conversation/:id', (req, res) => {
  const { id } = req.params;
  const deleted = conversationStore.delete(id);
  
  if (!deleted) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  
  res.json({ message: 'Conversation deleted successfully' });
});

// Enhanced main endpoint that supports both Google and Perplexity
app.post('/api/process-chart-enhanced', async (req, res) => {
  try {
    const { 
      input, 
      service = 'google', // 'google' or 'perplexity'
      model,
      conversationId, 
      currentChartState, 
      messageHistory 
    } = req.body;
    
    if (!input) {
      return res.status(400).json({ error: 'Input text is required' });
    }

    let aiResponse;
    
    if (service === 'perplexity') {
      if (!process.env.PERPLEXITY_API_KEY) {
        return res.status(500).json({ error: 'Perplexity API key not configured' });
      }
      
      if (currentChartState && conversationId) {
        aiResponse = await modifyChartDataWithPerplexity(input, currentChartState, messageHistory || [], model);
      } else {
        aiResponse = await generateChartDataWithPerplexity(input, model);
      }
      
    } else if (service === 'openrouter') {
      if (!process.env.OPENROUTER_API_KEY) {
        return res.status(500).json({ error: 'OpenRouter API key not configured' });
      }
      
      if (currentChartState && conversationId) {
        aiResponse = await modifyChartDataWithOpenRouter(input, currentChartState, messageHistory || [], model);
      } else {
        aiResponse = await generateChartDataWithOpenRouter(input, model);
      }
      
    } else {
      // Default to Google (existing logic)
      if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ error: 'Google API key not configured' });
      }
      
      if (currentChartState && conversationId) {
        aiResponse = await modifyChartData(input, currentChartState, messageHistory || []);
      } else {
        aiResponse = await generateChartData(input);
      }
    }

    // Format response consistently
    const result = {
      chartType: aiResponse.chartType,
      chartData: aiResponse.chartData || aiResponse.data,
      chartConfig: aiResponse.chartConfig || aiResponse.options,
      user_message: aiResponse.user_message,
      action: aiResponse.action || 'create',
      changes: aiResponse.changes || [],
      service: service,
      _metadata: aiResponse._metadata
    };
    
    res.json(result);
    
  } catch (error) {
    console.error(`Error processing chart request with ${service || 'google'}:`, error);
    res.status(500).json({ 
      error: `Failed to process chart request with ${service || 'google'}`,
      details: error.message 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    security: 'enabled',
    version: '2.0.0'
  });
});

// Security status endpoint
app.get('/security/status', (req, res) => {
  const stats = getSecurityStats();
  res.json({
    status: 'secure',
    timestamp: new Date().toISOString(),
    blockedIPs: stats.blockedIPs.length,
    suspiciousIPs: stats.suspiciousIPs.length,
    rateLimitStats: stats.rateLimitStats
  });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});