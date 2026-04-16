import express from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import formatService from '../services/formatService.js';

const router = express.Router();

// =============================================
// PUBLIC FORMAT ROUTES (official formats - no auth needed)
// =============================================

// Get all official formats (for gallery display - no auth required)
router.get('/formats/official', async (req, res) => {
  try {
    const formats = await formatService.getOfficialFormats();
    res.json(formats);
  } catch (error) {
    console.error('Error fetching official formats:', error);
    res.status(500).json({ error: 'Failed to fetch formats' });
  }
});

// =============================================
// AUTHENTICATED FORMAT ROUTES
// =============================================

// Get only the user's own custom formats (non-official)
router.get('/formats/mine', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const formats = await formatService.getUserFormats(userId);
    res.json(formats);
  } catch (error) {
    console.error('Error fetching user formats:', error);
    res.status(500).json({ error: 'Failed to fetch user formats' });
  }
});

// Get all formats (official + user's own - requires auth)
router.get('/formats', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const formats = await formatService.getFormats(userId);
    res.json(formats);
  } catch (error) {
    console.error('Error fetching formats:', error);
    res.status(500).json({ error: 'Failed to fetch formats' });
  }
});

// Get specific format by ID
router.get('/formats/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const format = await formatService.getFormatById(id, userId);
    res.json(format);
  } catch (error) {
    console.error('Error fetching format:', error);
    if (error.message?.includes('not found')) {
      res.status(404).json({ error: 'Format not found' });
    } else {
      res.status(500).json({ error: 'Failed to fetch format' });
    }
  }
});

// Create a new format blueprint
router.post('/formats', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { name, skeleton, dimensions } = req.body;
    if (!name || !skeleton || !dimensions) {
      return res.status(400).json({ error: 'name, skeleton, and dimensions are required' });
    }

    const format = await formatService.createFormat(userId, req.body);
    res.status(201).json(format);
  } catch (error) {
    console.error('Error creating format:', error);
    res.status(500).json({
      error: 'Failed to create format',
      details: error.message
    });
  }
});

// Update a format blueprint
router.patch('/formats/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const format = await formatService.updateFormat(id, userId, req.body);
    res.json(format);
  } catch (error) {
    console.error('Error updating format:', error);
    if (error.message?.includes('access denied')) {
      res.status(403).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to update format' });
    }
  }
});

// Delete a format blueprint
router.delete('/formats/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    await formatService.deleteFormat(id, userId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting format:', error);
    const statusCode = error.message?.includes('not found') ? 404 :
                        error.message?.includes('access denied') ? 403 : 500;
    res.status(statusCode).json({
      error: error.message || 'Failed to delete format'
    });
  }
});

// Toggle official status (admin only)
router.patch('/formats/:id/official', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { isOfficial } = req.body;

    if (typeof isOfficial !== 'boolean') {
      return res.status(400).json({ error: 'isOfficial must be a boolean' });
    }

    const format = await formatService.setFormatOfficial(id, isOfficial);
    res.json(format);
  } catch (error) {
    console.error('Error updating format official status:', error);
    res.status(500).json({ error: 'Failed to update format official status' });
  }
});

// Bulk create formats (for seeding - admin only)
router.post('/formats/bulk', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { formats } = req.body;
    if (!formats || !Array.isArray(formats) || formats.length === 0) {
      return res.status(400).json({ error: 'formats array is required' });
    }

    const created = await formatService.bulkCreateFormats(userId, formats);
    res.status(201).json({ success: true, count: created.length, formats: created });
  } catch (error) {
    console.error('Error bulk creating formats:', error);
    res.status(500).json({
      error: 'Failed to bulk create formats',
      details: error.message
    });
  }
});

export default router;
