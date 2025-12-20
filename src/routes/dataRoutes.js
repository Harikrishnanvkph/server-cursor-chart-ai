import express from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import chartDataService from '../services/chartDataService.js';
import { supabaseAdminClient } from '../supabase/client.js';

const router = express.Router();

// Apply auth middleware to all routes
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

export default router;

