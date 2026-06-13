import express from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import chartDataService from '../services/chartDataService.js';
import templateService from '../services/templateService.js';
import formatService from '../services/formatService.js';
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
    const userId = req.user.id;
    const path = `presets/${userId}/${safeFilename}`;

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

    // Save tracking record to public.user_uploaded_images
    const { error: dbError } = await supabaseAdminClient
      .from('user_uploaded_images')
      .insert({
        user_id: userId,
        image_path: path,
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
    res.status(500).json({ error: 'Failed to upload image', details: error.message });
  }
});

// =============================================
// MY IMAGES MANAGEMENT ROUTES
// =============================================

// Get user's uploaded images and check what they are mapped to (charts, templates, formats)
router.get('/my-images', async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Fetch user's uploaded images
    const { data: images, error: imagesError } = await supabaseAdminClient
      .from('user_uploaded_images')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (imagesError) throw imagesError;
    if (!images || images.length === 0) {
      return res.json([]);
    }

    // 2. Fetch user's active conversations and their current snapshots (charts)
    const { data: conversations, error: convsError } = await supabaseAdminClient
      .from('conversations')
      .select('id, title')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (convsError) throw convsError;

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

    // 3. Fetch user's templates
    const { data: templates, error: templatesError } = await supabaseAdminClient
      .from('user_templates')
      .select('id, name, template_structure')
      .eq('user_id', userId);

    if (templatesError) throw templatesError;

    // 4. Fetch user's formats
    const { data: formats, error: formatsError } = await supabaseAdminClient
      .from('format_blueprints')
      .select('id, name, skeleton, thumbnail_url')
      .eq('user_id', userId);

    if (formatsError) throw formatsError;

    // 5. Build usage mappings for each image
    const imagesWithMappings = images.map(img => {
      const filename = img.image_path.split('/').pop();
      const imageUrl = img.image_url;

      // Find mapped charts
      const mappedCharts = [];
      snapshots.forEach(snap => {
        const snapString = JSON.stringify({
          chart_config: snap.chart_config,
          template_structure: snap.template_structure
        });
        if (snapString.includes(filename) || snapString.includes(imageUrl)) {
          const conv = conversations.find(c => c.id === snap.conversation_id);
          if (conv) {
            mappedCharts.push({ id: conv.id, title: conv.title, snapshotId: snap.id });
          }
        }
      });

      // Find mapped templates
      const mappedTemplates = [];
      templates.forEach(tpl => {
        const tplString = JSON.stringify(tpl.template_structure);
        if (tplString.includes(filename) || tplString.includes(imageUrl)) {
          mappedTemplates.push({ id: tpl.id, name: tpl.name });
        }
      });

      // Find mapped formats
      const mappedFormats = [];
      formats.forEach(fmt => {
        const fmtString = JSON.stringify({ skeleton: fmt.skeleton, thumbnail_url: fmt.thumbnail_url });
        if (fmtString.includes(filename) || fmtString.includes(imageUrl)) {
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
    res.status(500).json({ error: 'Failed to fetch images', details: error.message });
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

    const filename = img.image_path.split('/').pop();
    const imageUrl = img.image_url;

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
        if (snapString.includes(filename) || snapString.includes(imageUrl)) {
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
      if (tplString.includes(filename) || tplString.includes(imageUrl)) {
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
      if (fmtString.includes(filename) || fmtString.includes(imageUrl)) {
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
        await templateService.deleteTemplate(tplId, userId);
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
        await formatService.deleteFormat(fmtId, userId);
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
    res.status(500).json({ error: 'Failed to delete image', details: error.message });
  }
});

export default router;

