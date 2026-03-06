import express from 'express';
import compression from 'compression';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { generateChartDataWithGemini, modifyChartDataWithGemini } from './services/geminiService.js';
import { generateChartDataWithOpenRouter, modifyChartDataWithOpenRouter } from './services/openrouterService.js';
import { generateChartDataWithDeepSeek, modifyChartDataWithDeepSeek } from './services/deepseekService.js';
import perplexityRoutes from './routes/perplexityRoutes.js';
import openrouterRoutes from './routes/openrouterRoutes.js';
import deepseekRoutes from './routes/deepseekRoutes.js';
import geminiRoutes from './routes/geminiRoutes.js';
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
const port = process.env.PORT || 5000;

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
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:3003'
];

if (process.env.APP_ORIGIN) {
  allowedOrigins.push(process.env.APP_ORIGIN);
}

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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

// Stricter rate limiter for AI endpoints (prevents credit abuse)
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // limit each IP to 30 AI requests per 15 minutes
  message: 'Too many AI requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many AI requests',
      retryAfter: 900,
      message: 'AI rate limit exceeded. Please try again later.'
    });
  }
});

// Mount routes with enhanced security
import authRoutes from './routes/authRoutes.js'
import dataRoutes from './routes/dataRoutes.js'
import templateRoutes from './routes/templateRoutes.js'
app.use('/auth', authRoutes)

// Chart processing endpoints (require auth + stricter AI rate limit)
app.use('/api/gemini', requireAuth, aiLimiter, geminiRoutes);
app.use('/api/perplexity', requireAuth, aiLimiter, perplexityRoutes);
app.use('/api/openrouter', requireAuth, aiLimiter, openrouterRoutes);
app.use('/api/deepseek', requireAuth, aiLimiter, deepseekRoutes);

// Protected API endpoints (require authentication)
app.use('/api/data', requireAuth, dataRoutes);
app.use('/api/data', requireAuth, templateRoutes);

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



// Enhanced main endpoint that supports both Google and Perplexity
// Protected: requires authentication + AI rate limiting
app.post('/api/process-chart-enhanced', requireAuth, aiLimiter, async (req, res) => {
  const {
    input,
    service = 'gemini', // default AI: 'gemini' | 'deepseek' | 'openrouter' | 'google'
    model,
    conversationId,
    currentChartState,
    messageHistory,
    templateStructure // NEW: Template structure metadata for generating template text content
  } = req.body;

  try {

    if (!input) {
      return res.status(400).json({ error: 'Input text is required' });
    }

    // Service registry — add new services here, no if/else needed
    const SERVICE_REGISTRY = {
      perplexity: { generate: generateChartDataWithGemini, modify: modifyChartDataWithGemini, apiKey: 'GEMINI_API_KEY' },
      gemini: { generate: generateChartDataWithGemini, modify: modifyChartDataWithGemini, apiKey: 'GEMINI_API_KEY' },
      openrouter: { generate: generateChartDataWithOpenRouter, modify: modifyChartDataWithOpenRouter, apiKey: 'OPENROUTER_API_KEY' },
      deepseek: { generate: generateChartDataWithDeepSeek, modify: modifyChartDataWithDeepSeek, apiKey: 'DEEPSEEK_API_KEY' },
      google: { generate: generateChartDataWithGemini, modify: modifyChartDataWithGemini, apiKey: 'GEMINI_API_KEY' },
    };

    const svc = SERVICE_REGISTRY[service] ?? SERVICE_REGISTRY.gemini;

    const apiKeyValue = process.env[svc.apiKey];
    const isPlaceholder = !apiKeyValue || apiKeyValue.startsWith('your_') || apiKeyValue === '';

    if (isPlaceholder) {
      return res.status(500).json({ error: `API key for '${service}' is not configured. Set ${svc.apiKey} in .env` });
    }

    console.log(`🤖 Processing chart request using: ${service.toUpperCase()} (Model: ${model || 'default'})`);

    const aiResponse = (currentChartState && conversationId)
      ? await svc.modify(input, currentChartState, messageHistory || [], model, templateStructure)
      : await svc.generate(input, model, templateStructure);

    // Format response consistently
    const result = {
      chartType: aiResponse.chartType,
      chartData: aiResponse.chartData || aiResponse.data,
      chartConfig: aiResponse.chartConfig || aiResponse.options,
      user_message: aiResponse.user_message,
      action: aiResponse.action || 'create',
      changes: aiResponse.changes || [],
      service: service,
      _metadata: aiResponse._metadata,
      // Include template content if generated
      templateContent: aiResponse.templateContent || null
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

// Security status endpoint (protected — requires admin)
app.get('/security/status', requireAuth, (req, res) => {
  if (req.user?.email !== process.env.ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const stats = getSecurityStats();
  res.json({
    status: 'secure',
    timestamp: new Date().toISOString(),
    blockedIPs: stats.blockedIPs.length,
    suspiciousIPs: stats.suspiciousIPs.length,
    rateLimitStats: stats.rateLimitStats
  });
});

// Start server with graceful shutdown support
const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// Graceful shutdown handler
function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('Server closed. Exiting process.');
    process.exit(0);
  });
  // Force exit after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));