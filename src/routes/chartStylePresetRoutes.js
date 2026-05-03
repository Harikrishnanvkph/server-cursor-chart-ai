import express from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import chartStylePresetService from '../services/chartStylePresetService.js';

const router = express.Router();

// =============================================
// PUBLIC CHART STYLE PRESET ROUTES
// =============================================

// Get all official presets (for gallery display - no auth required)
router.get('/chart-style-presets/official', async (req, res) => {
  try {
    const presets = await chartStylePresetService.getOfficialPresets();
    res.json(presets);
  } catch (error) {
    console.error('Error fetching official chart style presets:', error);
    res.status(500).json({ error: 'Failed to fetch chart style presets' });
  }
});

// =============================================
// AUTHENTICATED CHART STYLE PRESET ROUTES
// =============================================

// Get only the user's own custom presets
router.get('/chart-style-presets/mine', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const presets = await chartStylePresetService.getUserPresets(userId);
    res.json(presets);
  } catch (error) {
    console.error('Error fetching user chart style presets:', error);
    res.status(500).json({ error: 'Failed to fetch user chart style presets' });
  }
});

// Get all presets (official + user's own - requires auth)
router.get('/chart-style-presets', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const presets = await chartStylePresetService.getPresets(userId);
    res.json(presets);
  } catch (error) {
    console.error('Error fetching chart style presets:', error);
    res.status(500).json({ error: 'Failed to fetch chart style presets' });
  }
});

// Get specific preset by ID
router.get('/chart-style-presets/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const preset = await chartStylePresetService.getPresetById(id, userId);
    res.json(preset);
  } catch (error) {
    console.error('Error fetching chart style preset:', error);
    if (error.message?.includes('not found')) {
      res.status(404).json({ error: 'Chart style preset not found' });
    } else {
      res.status(500).json({ error: 'Failed to fetch chart style preset' });
    }
  }
});

// Create a new chart style preset
router.post('/chart-style-presets', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { name, chartType, colorStrategy } = req.body;
    if (!name || !chartType || !colorStrategy) {
      return res.status(400).json({ error: 'name, chartType, and colorStrategy are required' });
    }

    const preset = await chartStylePresetService.createPreset(userId, req.body);
    res.status(201).json(preset);
  } catch (error) {
    console.error('Error creating chart style preset:', error);
    res.status(500).json({
      error: 'Failed to create chart style preset',
      details: error.message
    });
  }
});

// Update a chart style preset
router.patch('/chart-style-presets/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const preset = await chartStylePresetService.updatePreset(id, userId, req.body);
    res.json(preset);
  } catch (error) {
    console.error('Error updating chart style preset:', error);
    if (error.message?.includes('access denied')) {
      res.status(403).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to update chart style preset' });
    }
  }
});

// Delete a chart style preset
router.delete('/chart-style-presets/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    await chartStylePresetService.deletePreset(id, userId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting chart style preset:', error);
    const statusCode = error.message?.includes('not found') ? 404 :
                        error.message?.includes('access denied') ? 403 : 500;
    res.status(statusCode).json({
      error: error.message || 'Failed to delete chart style preset'
    });
  }
});

// Toggle official status (admin only)
router.patch('/chart-style-presets/:id/official', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { isOfficial } = req.body;

    if (typeof isOfficial !== 'boolean') {
      return res.status(400).json({ error: 'isOfficial must be a boolean' });
    }

    const preset = await chartStylePresetService.setPresetOfficial(id, isOfficial);
    res.json(preset);
  } catch (error) {
    console.error('Error updating preset official status:', error);
    res.status(500).json({ error: 'Failed to update preset official status' });
  }
});

export default router;
