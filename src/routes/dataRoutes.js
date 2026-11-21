import express from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/authMiddleware.js';
import chartDataService from '../services/chartDataService.js';
import templateService from '../services/templateService.js';
import formatService from '../services/formatService.js';
import { supabaseAdminClient } from '../supabase/client.js';
import { canSaveCloudChart } from '../services/subscriptionService.js';

const MAX_SHARP_UPLOAD_PIXELS = 40_000_000;

export function sanitizeSvgContent(svgText) {
  if (typeof svgText !== 'string') return '';

  const dangerousTagPatterns = [
    /<script[\s\S]*?>[\s\S]*?<\/script\s*>/gi,
    /<script\b[^>]*\/?\s*>/gi,
    /<foreignObject[\s\S]*?>[\s\S]*?<\/foreignObject\s*>/gi,
    /<foreignObject\b[^>]*\/?\s*>/gi,
    /<(iframe|object|embed|animate|animateTransform|animateMotion|set)\b[\s\S]*?>[\s\S]*?<\/\1\s*>/gi,
    /<(iframe|object|embed|animate|animateTransform|animateMotion|set)\b[^>]*\/?\s*>/gi,
  ];

  let prev;
  let current = svgText;
  // Loop until stable to prevent nested bypasses like <scr<script>ipt>
  do {
    prev = current;
    for (const pattern of dangerousTagPatterns) {
      current = current.replace(pattern, '');
    }
    // Strip inline event handlers (e.g., onload=..., onmouseover=...)
    current = current.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    // Neutralize external <use href="https://..."> or <use xlink:href="...">
    current = current.replace(
      /(<use\b[^>]*?)\b(?:xlink:)?href\s*=\s*(?:"\s*(?:https?:)?\/\/[^"]*"|'\s*(?:https?:)?\/\/[^']*')/gi,
      '$1'
    );
    // Decode basic numeric/named entities inside href/xlink:href attributes and strip javascript/vbscript/data:text/html
    current = current.replace(
      /\b(?:xlink:)?href\s*=\s*("([^"]*)"|'([^']*)')/gi,
      (fullMatch, quoted, dq, sq) => {
        const rawVal = dq !== undefined ? dq : (sq !== undefined ? sq : '');
        const decoded = rawVal
          .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
            const cp = parseInt(hex, 16);
            return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
          })
          .replace(/&#(\d+);?/g, (_, dec) => {
            const cp = parseInt(dec, 10);
            return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
          })
          .replace(/&colon;/gi, ':')
          .replace(/[\x00-\x20]/g, '');
        if (/^(?:javascript|vbscript|data\s*:\s*text\/html)/i.test(decoded)) {
          return 'href=""';
        }
        return fullMatch;
      }
    );
  } while (current !== prev);

  return current;
}

// Lazy-load native sharp only when /upload-image actually processes a raster image (cuts serverless cold starts)
let _sharpInstance = null;
async function getSharp() {
  if (!_sharpInstance) {
    _sharpInstance = (await import('sharp')).default;
  }
  return _sharpInstance;
}

const router = express.Router();

// =============================================
// CONVERSATION ROUTES
// =============================================

// Get user's conversations
router.get('/conversations', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const userId = req.user.id;

    const conversations = await chartDataService.getUserConversations(userId, parseInt(limit));
    res.json(conversations);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Get specific conversation
router.get('/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const conversation = await chartDataService.getConversationById(id, userId);
    res.json(conversation);
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// Create new conversation
router.post('/conversations', async (req, res) => {
  try {
    const { title, description } = req.body;
    const userId = req.user.id;

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    // Check cloud chart limit (5 permanent Free + any active Cloud Credits packs)
    const saveCheck = await canSaveCloudChart(userId);
    if (!saveCheck.allowed) {
      return res.status(saveCheck.unavailable ? 503 : 403).json({
        error: saveCheck.error,
        code: saveCheck.unavailable ? 'SERVICE_UNAVAILABLE' : 'CLOUD_SAVE_LIMIT_REACHED',
        subscription: saveCheck.subscription
      });
    }

    const conversation = await chartDataService.createConversation(userId, title, description);
    res.status(201).json(conversation);
  } catch (error) {
    console.error('Error creating conversation:', error);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// Update conversation
router.patch('/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const updates = req.body;

    const conversation = await chartDataService.updateConversation(id, userId, updates);
    res.json(conversation);
  } catch (error) {
    console.error('Error updating conversation:', error);
    res.status(500).json({ error: 'Failed to update conversation' });
  }
});

// Delete conversation
router.delete('/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    await chartDataService.deleteConversation(id, userId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting conversation:', error);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

// Delete all conversations for a user
router.delete('/conversations', async (req, res) => {
  try {
    const userId = req.user.id;

    await chartDataService.deleteAllConversations(userId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting all conversations:', error);
    res.status(500).json({ error: 'Failed to delete all conversations' });
  }
});

// Get conversation messages
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 100 } = req.query;
    const userId = req.user?.id;

    // Verify conversation exists and belongs to user before fetching messages
    const { data: conversation, error: convError } = await supabaseAdminClient
      .from('conversations')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (convError || !conversation) {
      // Return empty array instead of error for missing/deleted conversations
      // This prevents console errors on frontend for stale local storage entries
      return res.json([]);
    }

    const messages = await chartDataService.getConversationMessages(id, parseInt(limit));
    res.json(messages || []);
  } catch (error) {
    console.error('❌ Error fetching messages:', error.message);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// =============================================
// CHART SNAPSHOT ROUTES
// =============================================

// Helper: verify conversation belongs to user before allowing snapshot/message operations
async function verifyConversationOwner(conversationId, userId) {
  if (!conversationId || !userId) return false;
  const { data, error } = await supabaseAdminClient
    .from('conversations')
    .select('id, user_id')
    .eq('id', conversationId)
    .maybeSingle();

  if (error || !data) return false;
  return String(data.user_id) === String(userId);
}

// Save chart snapshot (POST for create, PUT for update)
router.post('/chart-snapshots', async (req, res) => {
  try {
    const { conversationId, chartType, chartData, chartConfig, templateStructure, templateContent, snapshotId } = req.body;
    const userId = req.user?.id || req.user?.user_id;

    if (!conversationId || !chartType || !chartData) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Security: Verify user owns this conversation
    const isOwner = await verifyConversationOwner(conversationId, userId);
    if (!isOwner) {
      return res.status(403).json({ error: 'Unauthorized: conversation does not belong to user' });
    }

    const resultId = await chartDataService.saveChartSnapshot(
      conversationId,
      chartType,
      chartData,
      chartConfig,
      templateStructure || null,
      templateContent || null,
      snapshotId || null
    );

    res.status(snapshotId ? 200 : 201).json({ id: resultId });
  } catch (error) {
    console.error('Error saving chart snapshot:', error);
    const errorMessage = error.message || error.error || 'Failed to save chart snapshot';
    res.status(500).json({
      error: 'Failed to save chart snapshot'
    });
  }
});

// Update chart snapshot
router.put('/chart-snapshots/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { conversationId, chartType, chartData, chartConfig, templateStructure, templateContent } = req.body;
    const userId = req.user?.id || req.user?.user_id;

    if (!id || !conversationId || !chartType || !chartData) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Security: Verify user owns this conversation
    const isOwner = await verifyConversationOwner(conversationId, userId);
    if (!isOwner) {
      return res.status(403).json({ error: 'Unauthorized: conversation does not belong to user' });
    }

    const updatedSnapshotId = await chartDataService.saveChartSnapshot(
      conversationId,
      chartType,
      chartData,
      chartConfig,
      templateStructure || null,
      templateContent || null,
      id
    );

    res.json({ id: updatedSnapshotId });
  } catch (error) {
    console.error('Error updating chart snapshot:', error);
    const errorMessage = error.message || error.error || 'Failed to update chart snapshot';
    res.status(500).json({
      error: 'Failed to update chart snapshot'
    });
  }
});

// Generate or fetch a share link for a chart snapshot
router.post('/chart-snapshots/:id/share', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id; // guaranteed by requireAuth

    if (!id) {
      return res.status(400).json({ error: 'Snapshot ID is required' });
    }

    const shareInfo = await chartDataService.generateShareLink(id, userId);
    res.json(shareInfo);
  } catch (error) {
    console.error('Error generating share link:', error);
    res.status(500).json({ error: 'Failed to generate share link' });
  }
});

// Generate or fetch a share link for a conversation's current snapshot
router.post('/conversations/:id/share', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id; // guaranteed by requireAuth

    if (!id) {
      return res.status(400).json({ error: 'Conversation ID is required' });
    }

    const shareInfo = await chartDataService.generateShareLinkForConversation(id, userId);
    res.json(shareInfo);
  } catch (error) {
    if (
      error.message === 'Conversation not found or unauthorized' ||
      error.message === 'Snapshot not found for conversation'
    ) {
      return res.status(404).json({ error: error.message });
    }
    console.error('Error generating share link for conversation:', error);
    res.status(500).json({ error: 'Failed to generate share link' });
  }
});

// Batch fetch current chart snapshots for multiple conversations
router.post('/conversations/batch-snapshots', async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.user_id;
    const { conversationIds } = req.body || {};

    if (!Array.isArray(conversationIds)) {
      return res.status(400).json({ error: 'conversationIds must be an array' });
    }

    const sanitizedIds = [...new Set(
      conversationIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
    )].slice(0, 24);

    if (sanitizedIds.length === 0) {
      return res.json({ snapshots: {} });
    }

    const snapshots = await chartDataService.getBatchCurrentSnapshots(userId, sanitizedIds);
    res.json({ snapshots });
  } catch (error) {
    console.error('Error fetching batch snapshots:', error);
    res.status(500).json({ error: 'Failed to fetch batch snapshots' });
  }
});

// Get current chart snapshot for conversation
router.get('/conversations/:id/current-snapshot', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id || req.user?.user_id;

    // Security: Verify user owns this conversation
    const isOwner = await verifyConversationOwner(id, userId);
    if (!isOwner) {
      return res.status(403).json({ error: 'Unauthorized: conversation does not belong to user' });
    }

    const snapshot = await chartDataService.getCurrentChartSnapshot(id);
    res.json(snapshot);
  } catch (error) {
    console.error('Error fetching current snapshot:', error);
    res.status(500).json({ error: 'Failed to fetch current snapshot' });
  }
});

// Get chart history for conversation
router.get('/conversations/:id/chart-history', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 10 } = req.query;
    const userId = req.user?.id || req.user?.user_id;

    // Security: Verify user owns this conversation
    const isOwner = await verifyConversationOwner(id, userId);
    if (!isOwner) {
      return res.status(403).json({ error: 'Unauthorized: conversation does not belong to user' });
    }

    const history = await chartDataService.getChartHistory(id, parseInt(limit));
    res.json(history);
  } catch (error) {
    console.error('Error fetching chart history:', error);
    res.status(500).json({ error: 'Failed to fetch chart history' });
  }
});

// =============================================
// MESSAGE ROUTES
// =============================================

// Add message to conversation
router.post('/messages', async (req, res) => {
  try {
    const {
      conversationId,
      role,
      content,
      chartSnapshotId,
      action,
      changes
    } = req.body;
    const userId = req.user?.id || req.user?.user_id;

    if (!conversationId || !role || !content) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!['user', 'assistant'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Security: Verify user owns this conversation
    const isOwner = await verifyConversationOwner(conversationId, userId);
    if (!isOwner) {
      return res.status(403).json({ error: 'Unauthorized: conversation does not belong to user' });
    }

    const message = await chartDataService.addMessage(
      conversationId,
      role,
      content,
      chartSnapshotId,
      action,
      changes
    );

    res.status(201).json(message);
  } catch (error) {
    console.error('Error adding message:', error);
    res.status(500).json({ error: 'Failed to add message' });
  }
});

// Add multiple messages to a conversation in one round-trip
router.post('/messages/batch', async (req, res) => {
  try {
    const { conversationId, messages } = req.body || {};
    const userId = req.user?.id || req.user?.user_id;

    if (!conversationId || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'conversationId and messages array are required' });
    }

    if (messages.length === 0) {
      return res.status(200).json([]);
    }

    if (messages.length > 100) {
      return res.status(400).json({ error: 'Batch size cannot exceed 100 messages' });
    }

    for (const msg of messages) {
      if (!msg || !['user', 'assistant'].includes(msg.role) || typeof msg.content !== 'string' || !msg.content) {
        return res.status(400).json({ error: 'Each message must have a valid role and non-empty content' });
      }
    }

    // Security: Verify user owns this conversation once for the whole batch
    const isOwner = await verifyConversationOwner(conversationId, userId);
    if (!isOwner) {
      return res.status(403).json({ error: 'Unauthorized: conversation does not belong to user' });
    }

    const inserted = await chartDataService.addMessagesBatch(conversationId, messages);
    res.status(201).json(inserted);
  } catch (error) {
    console.error('Error batch adding messages:', error);
    res.status(500).json({ error: 'Failed to add messages' });
  }
});

// =============================================
// USER PREFERENCES ROUTES
// =============================================

// Get user preferences
router.get('/user-preferences', async (req, res) => {
  try {
    const userId = req.user.id;
    const preferences = await chartDataService.getUserPreferences(userId);
    res.json(preferences);
  } catch (error) {
    console.error('Error fetching user preferences:', error);
    res.status(500).json({ error: 'Failed to fetch user preferences' });
  }
});

// Update user preferences
router.put('/user-preferences', async (req, res) => {
  try {
    const userId = req.user.id;
    const preferences = req.body;

    const updatedPreferences = await chartDataService.updateUserPreferences(userId, preferences);
    res.json(updatedPreferences);
  } catch (error) {
    console.error('Error updating user preferences:', error);
    res.status(500).json({ error: 'Failed to update user preferences' });
  }
});

// =============================================
// PROJECT ROUTES
// =============================================

// Get user projects
router.get('/projects', async (req, res) => {
  try {
    const userId = req.user.id;
    const projects = await chartDataService.getUserProjects(userId);
    res.json(projects);
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// Create new project
router.post('/projects', async (req, res) => {
  try {
    const { name, description } = req.body;
    const userId = req.user.id;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const project = await chartDataService.createProject(userId, name, description);
    res.status(201).json(project);
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// Upload image route (converts base64 data URI from builder and uploads to Supabase Storage, returning public URL)
router.post('/upload-image', async (req, res) => {
  try {
    const { base64Data, filename } = req.body;
    if (!base64Data) {
      return res.status(400).json({ error: 'base64Data is required' });
    }

    // Match metadata (e.g. data:image/png;base64,) and extract mime type and raw base64 string
    const match = base64Data.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid data URI format' });
    }

    let contentType = match[1].toLowerCase().trim();
    const allowedMimeTypes = new Set([
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
      'image/gif',
      'image/svg+xml'
    ]);
    if (!allowedMimeTypes.has(contentType)) {
      return res.status(400).json({ error: 'Unsupported image MIME type' });
    }

    const base64String = match[2];
    let buffer = Buffer.from(base64String, 'base64');

    const isSvg = contentType === 'image/svg+xml';
    const isGif = contentType === 'image/gif';
    let finalExtension = isSvg ? 'svg' : (contentType.split('/')[1] || 'png');
    if (finalExtension === 'jpeg') finalExtension = 'jpg';
    let processedBuffer = buffer;

    if (isSvg) {
      const sanitizedSvg = sanitizeSvgContent(buffer.toString('utf8'));
      processedBuffer = Buffer.from(sanitizedSvg, 'utf8');
    } else {
      // Apply compression logic & verify valid raster image via sharp (lazy-loaded)
      try {
        const sharp = await getSharp();
        const sharpInputOpts = isGif
          ? { animated: true, limitInputPixels: MAX_SHARP_UPLOAD_PIXELS }
          : { limitInputPixels: MAX_SHARP_UPLOAD_PIXELS };
        const metadata = await sharp(buffer, sharpInputOpts).metadata();
        const originalWidth = metadata.width || 0;
        const originalHeight = metadata.height || 0;
        const longestSide = Math.max(originalWidth, originalHeight);
        const originalSizeKB = buffer.length / 1024;

        // Compress if: file size > 150KB OR width/height > 2000px
        if (originalSizeKB > 150 || longestSide > 2000) {
          let pipeline = sharp(buffer, sharpInputOpts);

          // Proportional scaling
          if (longestSide > 2000) {
            if (originalWidth > originalHeight) {
              pipeline = pipeline.resize(2000, null, { withoutEnlargement: true });
            } else {
              pipeline = pipeline.resize(null, 2000, { withoutEnlargement: true });
            }
          }

          // Transcode to WebP (85% quality; animated frames preserved when opened with animated: true)
          pipeline = pipeline.webp({ quality: 85 });
          processedBuffer = await pipeline.toBuffer();
          contentType = 'image/webp';
          finalExtension = 'webp';
          console.log(`[ImageUpload] Compressed image from ${originalSizeKB.toFixed(1)}KB to ${(processedBuffer.length / 1024).toFixed(1)}KB (webp)`);
        }
      } catch (sharpError) {
        if (/Input image exceeds pixel limit/i.test(String(sharpError?.message || ''))) {
          return res.status(413).json({ error: 'Image dimensions exceed processing limit' });
        }
        console.warn('[ImageUpload] Sharp validation/compression failed:', sharpError);
        return res.status(400).json({ error: 'Invalid or corrupted image file' });
      }
    }

    // Create a guaranteed-unique filename so separate uploads never overwrite or collide on image_path
    let baseName = (filename && typeof filename === 'string') ? filename : 'format-image';
    if (baseName.includes('.')) {
      baseName = baseName.substring(0, baseName.lastIndexOf('.'));
    }
    const safeName = baseName.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 64) || 'format-image';
    const uniqueSuffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const safeFilename = `${safeName}-${uniqueSuffix}.${finalExtension}`;
    const userId = req.user.id;
    const storagePath = `presets/${userId}/${safeFilename}`;

    const bucketName = 'format-assets';
    const uploadOptions = {
      contentType,
      upsert: false,
      cacheControl: '31536000',
    };

    // Upload directly without paying for a storage.listBuckets() round-trip on every upload.
    // Only create the bucket if Supabase reports it does not exist yet.
    let { data, error } = await supabaseAdminClient.storage
      .from(bucketName)
      .upload(storagePath, processedBuffer, uploadOptions);

    if (error && /bucket.*not\s*found|not\s*found/i.test(String(error.message || ''))) {
      const { error: createError } = await supabaseAdminClient.storage.createBucket(bucketName, {
        public: true,
        allowedMimeTypes: ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/svg+xml']
      });
      if (createError && !/already\s*exists/i.test(String(createError.message || ''))) {
        console.error(`Error creating storage bucket ${bucketName}:`, createError);
      } else {
        console.log(`Created public storage bucket: ${bucketName}`);
      }
      ({ data, error } = await supabaseAdminClient.storage
        .from(bucketName)
        .upload(storagePath, processedBuffer, uploadOptions));
    }

    if (error) {
      throw error;
    }

    // Get public URL
    const { data: { publicUrl } } = supabaseAdminClient.storage
      .from(bucketName)
      .getPublicUrl(storagePath);

    // Save tracking record to public.user_uploaded_images
    const { error: dbError } = await supabaseAdminClient
      .from('user_uploaded_images')
      .insert({
        user_id: userId,
        image_path: storagePath,
        image_url: publicUrl,
        filename: safeFilename
      });

    if (dbError) {
      console.error('Error inserting user image tracking record:', dbError);
      throw dbError;
    }

    res.status(200).json({ publicUrl });
  } catch (error) {
    console.error('Error uploading image to storage:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// =============================================
// MY IMAGES MANAGEMENT ROUTES
// =============================================

// Get user's uploaded images and check what they are mapped to (charts, templates, formats)
router.get('/my-images', async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Run all 4 independent user-scoped queries in parallel instead of sequentially
    const [
      { data: images, error: imagesError },
      { data: conversations, error: convsError },
      { data: templates, error: templatesError },
      { data: formats, error: formatsError }
    ] = await Promise.all([
      supabaseAdminClient
        .from('user_uploaded_images')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
      supabaseAdminClient
        .from('conversations')
        .select('id, title')
        .eq('user_id', userId)
        .eq('is_active', true),
      supabaseAdminClient
        .from('user_templates')
        .select('id, name, template_structure')
        .eq('user_id', userId),
      supabaseAdminClient
        .from('format_blueprints')
        .select('id, name, skeleton, thumbnail_url')
        .eq('user_id', userId)
    ]);

    if (imagesError) throw imagesError;
    if (!images || images.length === 0) {
      return res.json([]);
    }
    if (convsError) throw convsError;
    if (templatesError) throw templatesError;
    if (formatsError) throw formatsError;

    // 2. Fetch current snapshots only for the user's active conversations
    let snapshots = [];
    if (conversations && conversations.length > 0) {
      const convIds = conversations.map(c => c.id);
      const { data: snaps, error: snapsError } = await supabaseAdminClient
        .from('chart_snapshots')
        .select('id, conversation_id, chart_config, template_structure')
        .in('conversation_id', convIds)
        .eq('is_current', true);
      if (snapsError) throw snapsError;
      snapshots = snaps || [];
    }

    // 5. Pre-stringify entities ONCE to avoid O(N×M) repeated serialization
    const snapSearchData = snapshots.map(snap => ({
      snap,
      searchStr: JSON.stringify({ chart_config: snap.chart_config, template_structure: snap.template_structure })
    }));
    const tplSearchData = (templates || []).map(tpl => ({
      tpl,
      searchStr: JSON.stringify(tpl.template_structure)
    }));
    const fmtSearchData = (formats || []).map(fmt => ({
      fmt,
      searchStr: JSON.stringify({ skeleton: fmt.skeleton, thumbnail_url: fmt.thumbnail_url })
    }));

    // Build usage mappings for each image using pre-computed strings (match unique storage path or full URL)
    const imagesWithMappings = images.map(img => {
      const storagePath = img.image_path;
      const imageUrl = img.image_url;
      const matchesImage = (str) =>
        (storagePath && str.includes(storagePath)) || (imageUrl && str.includes(imageUrl));

      // Find mapped charts
      const mappedCharts = [];
      snapSearchData.forEach(({ snap, searchStr }) => {
        if (matchesImage(searchStr)) {
          const conv = conversations.find(c => c.id === snap.conversation_id);
          if (conv) {
            mappedCharts.push({ id: conv.id, title: conv.title, snapshotId: snap.id });
          }
        }
      });

      // Find mapped templates
      const mappedTemplates = [];
      tplSearchData.forEach(({ tpl, searchStr }) => {
        if (matchesImage(searchStr)) {
          mappedTemplates.push({ id: tpl.id, name: tpl.name });
        }
      });

      // Find mapped formats
      const mappedFormats = [];
      fmtSearchData.forEach(({ fmt, searchStr }) => {
        if (matchesImage(searchStr)) {
          mappedFormats.push({ id: fmt.id, name: fmt.name });
        }
      });

      return {
        ...img,
        mappings: {
          charts: mappedCharts,
          templates: mappedTemplates,
          formats: mappedFormats
        }
      };
    });

    res.json(imagesWithMappings);
  } catch (error) {
    console.error('Error fetching user images and mappings:', error);
    res.status(500).json({ error: 'Failed to fetch images' });
  }
});

// Delete user image from storage and database, cascading deletion to associated charts, templates, and formats
router.delete('/my-images/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // 1. Fetch image record and verify ownership
    const { data: img, error: imgError } = await supabaseAdminClient
      .from('user_uploaded_images')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (imgError || !img) {
      return res.status(404).json({ error: 'Image not found or unauthorized' });
    }

    const storagePath = img.image_path;
    const imageUrl = img.image_url;
    const matchesImage = (str) =>
      (storagePath && str.includes(storagePath)) || (imageUrl && str.includes(imageUrl));

    // 2. Identify all associated charts (conversations)
    const { data: conversations, error: convsError } = await supabaseAdminClient
      .from('conversations')
      .select('id, title')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (convsError) throw convsError;

    const conversationsToDelete = [];
    if (conversations && conversations.length > 0) {
      const convIds = conversations.map(c => c.id);
      const { data: snaps } = await supabaseAdminClient
        .from('chart_snapshots')
        .select('id, conversation_id, chart_config, template_structure')
        .in('conversation_id', convIds)
        .eq('is_current', true);

      (snaps || []).forEach(snap => {
        const snapString = JSON.stringify({
          chart_config: snap.chart_config,
          template_structure: snap.template_structure
        });
        if (matchesImage(snapString)) {
          if (!conversationsToDelete.includes(snap.conversation_id)) {
            conversationsToDelete.push(snap.conversation_id);
          }
        }
      });
    }

    // 3. Identify all associated templates
    const { data: templates, error: templatesError } = await supabaseAdminClient
      .from('user_templates')
      .select('id, name, template_structure')
      .eq('user_id', userId);

    if (templatesError) throw templatesError;

    const templatesToDelete = [];
    templates.forEach(tpl => {
      const tplString = JSON.stringify(tpl.template_structure);
      if (matchesImage(tplString)) {
        templatesToDelete.push(tpl.id);
      }
    });

    // 4. Identify all associated formats
    const { data: formats, error: formatsError } = await supabaseAdminClient
      .from('format_blueprints')
      .select('id, name, skeleton, thumbnail_url')
      .eq('user_id', userId);

    if (formatsError) throw formatsError;

    const formatsToDelete = [];
    formats.forEach(fmt => {
      const fmtString = JSON.stringify({ skeleton: fmt.skeleton, thumbnail_url: fmt.thumbnail_url });
      if (matchesImage(fmtString)) {
        formatsToDelete.push(fmt.id);
      }
    });

    // 5. Delete physical image file from Supabase Storage
    const { error: storageError } = await supabaseAdminClient.storage
      .from('format-assets')
      .remove([img.image_path]);

    if (storageError) {
      console.warn('[StorageCleanup] Failed to delete image file from storage:', storageError);
      // We continue deleting database records even if storage file delete fails
    }

    // 6. Delete image record from database
    const { error: dbDeleteError } = await supabaseAdminClient
      .from('user_uploaded_images')
      .delete()
      .eq('id', id);

    if (dbDeleteError) throw dbDeleteError;

    // 7. Cascade delete associated charts/conversations
    const deletedCharts = [];
    for (const convId of conversationsToDelete) {
      try {
        const conv = conversations.find(c => c.id === convId);
        await chartDataService.deleteConversation(convId, userId);
        deletedCharts.push(conv ? conv.title : convId);
      } catch (err) {
        console.error(`Failed to cascade delete conversation ${convId}:`, err);
      }
    }

    // 8. Cascade delete associated templates
    const deletedTemplates = [];
    for (const tplId of templatesToDelete) {
      try {
        const tpl = templates.find(t => t.id === tplId);
        await templateService.deleteTemplate(tplId, userId, req.user?.is_admin === true);
        deletedTemplates.push(tpl ? tpl.name : tplId);
      } catch (err) {
        console.error(`Failed to cascade delete template ${tplId}:`, err);
      }
    }

    // 9. Cascade delete associated formats
    const deletedFormats = [];
    for (const fmtId of formatsToDelete) {
      try {
        const fmt = formats.find(f => f.id === fmtId);
        await formatService.deleteFormat(fmtId, userId, req.user?.is_admin === true);
        deletedFormats.push(fmt ? fmt.name : fmtId);
      } catch (err) {
        console.error(`Failed to cascade delete format ${fmtId}:`, err);
      }
    }

    res.json({
      success: true,
      deletedImage: img.filename,
      cascade: {
        charts: deletedCharts,
        templates: deletedTemplates,
        formats: deletedFormats
      }
    });
  } catch (error) {
    console.error('Error deleting image and cascading dependencies:', error);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

export default router;

