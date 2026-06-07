import './env.js'; // MUST be the first import to load env vars before ESM hoisting
import express from 'express';
import compression from 'compression';
import cors from 'cors';
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
import imageProxyRoutes from './routes/imageProxyRoutes.js';
import { requireAuth, requireAdmin, rateLimitMiddleware, getSecurityStats, blockIP, unblockIP } from './middleware/authMiddleware.js'

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
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

app.use(cookieParser());
app.use(compression({ threshold: '1kb' }));
app.use(express.json({ limit: '10mb' })); // Limit request body size

// CORS with enhanced security
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:3003',
  'http://192.168.1.3:3000' //this is temporary for mobile testing only
];

if (process.env.FRONTEND_URL) {
  allowedOrigins.push(process.env.FRONTEND_URL);
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
import formatRoutes from './routes/formatRoutes.js'
import chartStylePresetRoutes from './routes/chartStylePresetRoutes.js'
app.use('/auth', authRoutes)

// Chart processing endpoints (require auth + stricter AI rate limit)
app.use('/api/gemini', requireAuth, aiLimiter, geminiRoutes);
app.use('/api/perplexity', requireAuth, aiLimiter, perplexityRoutes);
app.use('/api/openrouter', requireAuth, aiLimiter, openrouterRoutes);
app.use('/api/deepseek', requireAuth, aiLimiter, deepseekRoutes);

// Format and chart style preset routes (have both public and authenticated endpoints - must be BEFORE auth-protected routes)
app.use('/api/data', formatRoutes);
app.use('/api/data', chartStylePresetRoutes);

// Protected API endpoints (require authentication)
app.use('/api/data', requireAuth, dataRoutes);
app.use('/api/data', requireAuth, templateRoutes);

// Utilities (no requireAuth because img tags cannot send Auth headers, protected via ALLOWED_PROXY_DOMAINS whitelist)
app.use('/api/proxy', imageProxyRoutes);

// Security monitoring endpoints (admin only)
app.get('/admin/security/stats', requireAuth, requireAdmin, (req, res) => {
  const stats = getSecurityStats();
  res.json(stats);
});

app.post('/admin/security/block-ip', requireAuth, requireAdmin, (req, res) => {
  const { ipAddress, reason } = req.body;
  if (!ipAddress) {
    return res.status(400).json({ error: 'IP address is required' });
  }

  blockIP(ipAddress, reason || 'Admin action');
  res.json({ success: true, message: `IP ${ipAddress} blocked` });
});

app.post('/admin/security/unblock-ip', requireAuth, requireAdmin, (req, res) => {
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
    service = 'deepseek', // default AI: 'gemini' | 'deepseek' | 'openrouter' | 'google'
    model,
    conversationId,
    currentChartState,
    messageHistory,
    templateStructure, // NEW: Template structure metadata for generating template text content
    formatStructure
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
      ? await svc.modify(input, currentChartState, messageHistory || [], model, templateStructure, formatStructure)
      : await svc.generate(input, model, templateStructure, formatStructure);

    // Determine if this is a creation or modification
    const isModification = !!(currentChartState && conversationId);

    // Format response consistently
    const result = {
      chartType: aiResponse.chartType,
      chartData: aiResponse.chartData || aiResponse.data,
      // For creation: chartConfig is null — frontend builds from getDefaultConfigForType()
      // For modification: AI returns full chartConfig with styling changes
      chartConfig: isModification ? (aiResponse.chartConfig || aiResponse.options) : null,
      user_message: aiResponse.user_message,
      action: aiResponse.action || (isModification ? 'modify' : 'create'),
      changes: aiResponse.changes || [],
      service: service,
      _metadata: aiResponse._metadata,
      // Include template content if generated
      templateContent: aiResponse.templateContent || null,
      // Include format content if generated
      formatContent: aiResponse.formatContent || null,
      // Pass through AI-generated text metadata (creation only — frontend uses these to populate config)
      title: aiResponse.title || null,
      subtitle: aiResponse.subtitle || null,
      xAxisTitle: aiResponse.xAxisTitle || null,
      yAxisTitle: aiResponse.yAxisTitle || null,
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
app.get('/security/status', requireAuth, requireAdmin, (req, res) => {
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