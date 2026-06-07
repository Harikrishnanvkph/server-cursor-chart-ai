import express from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import chartDataService from '../services/chartDataService.js';
import { supabaseAdminClient } from '../supabase/client.js';
import sharp from 'sharp';

const router = express.Router();

// =============================================
// PUBLIC SHARE ROUTES
// =============================================

// Get shared chart data (UNAUTHENTICATED)
router.get('/shared/:shareId', async (req, res) => {
  try {
    const { shareId } = req.params;
    if (!shareId) {
      return res.status(400).json({ error: 'Share ID is required' });
    }

    const sharedChart = await chartDataService.getSharedChart(shareId);
    res.json(sharedChart);
  } catch (error) {
    if (error.message === 'Shared chart not found') {
      return res.status(404).json({ error: 'Shared chart not found' });
    }
    console.error('Error fetching shared chart:', error);
    res.status(500).json({ error: 'Failed to fetch shared chart' });
  }
});

// Apply auth middleware to all remaining routes
router.use(requireAuth);

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
    res.status(500).json({
      error: 'Failed to fetch messages',
      details: error.message
    });
  }
});

// =============================================
// CHART SNAPSHOT ROUTES
// =============================================

// Save chart snapshot (POST for create, PUT for update)
router.post('/chart-snapshots', async (req, res) => {
  try {
    const { conversationId, chartType, chartData, chartConfig, templateStructure, templateContent, snapshotId } = req.body;

    if (!conversationId || !chartType || !chartData) {
      return res.status(400).json({ error: 'Missing required fields' });
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
      error: errorMessage,
      details: error.details || error.hint || null
    });
  }
});

// Update chart snapshot
router.put('/chart-snapshots/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { conversationId, chartType, chartData, chartConfig, templateStructure, templateContent } = req.body;

    if (!id || !conversationId || !chartType || !chartData) {
      return res.status(400).json({ error: 'Missing required fields' });
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
      error: errorMessage,
      details: error.details || error.hint || null
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

// Get current chart snapshot for conversation
router.get('/conversations/:id/current-snapshot', async (req, res) => {
  try {
    const { id } = req.params;

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

    if (!conversationId || !role || !content) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!['user', 'assistant'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
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

    let contentType = match[1];
    const base64String = match[2];
    let buffer = Buffer.from(base64String, 'base64');

    const isSvg = contentType.includes('svg');
    let finalExtension = contentType.split('/')[1] || 'png';
    let processedBuffer = buffer;

    // Apply compression logic if not SVG
    if (!isSvg) {
      try {
        const metadata = await sharp(buffer).metadata();
        const originalWidth = metadata.width || 0;
        const originalHeight = metadata.height || 0;
        const longestSide = Math.max(originalWidth, originalHeight);
        const originalSizeKB = buffer.length / 1024;

        // Compress if: file size > 150KB OR width/height > 2000px
        if (originalSizeKB > 150 || longestSide > 2000) {
          let pipeline = sharp(buffer);

          // Proportional scaling
          if (longestSide > 2000) {
            if (originalWidth > originalHeight) {
              pipeline = pipeline.resize(2000, null, { withoutEnlargement: true });
            } else {
              pipeline = pipeline.resize(null, 2000, { withoutEnlargement: true });
            }
          }

          // Transcode to WebP (85% quality)
          pipeline = pipeline.webp({ quality: 85 });
          processedBuffer = await pipeline.toBuffer();
          contentType = 'image/webp';
          finalExtension = 'webp';
          console.log(`[ImageUpload] Compressed image from ${originalSizeKB.toFixed(1)}KB to ${(processedBuffer.length / 1024).toFixed(1)}KB (webp)`);
        }
      } catch (sharpError) {
        console.warn('[ImageUpload] Sharp compression failed, uploading original buffer:', sharpError);
      }
    }

    // Create a unique filename with correct extension
    let name = filename || `format-image-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    // Strip original extension if name contains it
    if (name.includes('.')) {
      name = name.substring(0, name.lastIndexOf('.'));
    }
    const safeName = name.replace(/[^a-zA-Z0-9-]/g, '_');
    const safeFilename = `${safeName}.${finalExtension}`;
    const path = `presets/${safeFilename}`;

    const bucketName = 'format-assets';

    // Verify/create bucket
    // Note: service role client can create buckets directly
    const { data: buckets } = await supabaseAdminClient.storage.listBuckets();
    const bucketExists = buckets?.some(b => b.name === bucketName);
    
    if (!bucketExists) {
      const { error: createError } = await supabaseAdminClient.storage.createBucket(bucketName, {
        public: true,
        allowedMimeTypes: ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/svg+xml']
      });
      if (createError) {
        console.error(`Error creating storage bucket ${bucketName}:`, createError);
      } else {
        console.log(`Created public storage bucket: ${bucketName}`);
      }
    }

    // Upload buffer to Supabase Storage
    const { data, error } = await supabaseAdminClient.storage
      .from(bucketName)
      .upload(path, processedBuffer, {
        contentType,
        upsert: true
      });

    if (error) {
      throw error;
    }

    // Get public URL
    const { data: { publicUrl } } = supabaseAdminClient.storage
      .from(bucketName)
      .getPublicUrl(path);

    res.status(200).json({ publicUrl });
  } catch (error) {
    console.error('Error uploading image to storage:', error);
    res.status(500).json({ error: 'Failed to upload image', details: error.message });
  }
});

export default router;

