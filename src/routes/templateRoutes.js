import express from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import templateService from '../services/templateService.js';

const router = express.Router();

// Apply auth middleware to all routes
router.use(requireAuth);

// =============================================
// TEMPLATE ROUTES (Blueprint Templates)
// =============================================

// Get all templates for user (including public templates)
router.get('/templates', async (req, res) => {
  try {
    const { includePublic = 'true' } = req.query;
    const userId = req.user.id;
    
    const templates = await templateService.getUserTemplates(
      userId,
      includePublic === 'true'
    );
    
    res.json(templates);
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// Get specific template by ID
router.get('/templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    const template = await templateService.getTemplateById(id, userId);
    res.json(template);
  } catch (error) {
    console.error('Error fetching template:', error);
    if (error.message?.includes('not found') || error.message?.includes('No rows')) {
      res.status(404).json({ error: 'Template not found' });
    } else {
      res.status(500).json({ error: 'Failed to fetch template' });
    }
  }
});

// Create new template blueprint
router.post('/templates', async (req, res) => {
  try {
    const { name, description, templateStructure } = req.body;
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    if (!name || !templateStructure) {
      return res.status(400).json({ error: 'Name and templateStructure are required' });
    }
    
    const template = await templateService.createTemplate(
      userId,
      name,
      description,
      templateStructure
    );
    
    res.status(201).json(template);
  } catch (error) {
    console.error('Error creating template:', error);
    
    if (error.message?.includes('unique') || error.message?.includes('duplicate')) {
      res.status(409).json({ error: 'Template with this name already exists' });
    } else {
      res.status(500).json({ 
        error: 'Failed to create template',
        details: error.message 
      });
    }
  }
});

// Update template blueprint
router.patch('/templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const updates = req.body;
    
    const template = await templateService.updateTemplate(id, userId, updates);
    res.json(template);
  } catch (error) {
    console.error('Error updating template:', error);
    if (error.message?.includes('Unauthorized') || error.message?.includes('access denied')) {
      res.status(403).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to update template' });
    }
  }
});

// Delete template blueprint
router.delete('/templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    await templateService.deleteTemplate(id, userId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting template:', error);
    const statusCode = error.message?.includes('not found') ? 404 : 
                      error.message?.includes('Unauthorized') ? 403 : 500;
    res.status(statusCode).json({ 
      error: error.message || 'Failed to delete template'
    });
  }
});

// Set template visibility (public/private)
router.patch('/templates/:id/visibility', async (req, res) => {
  try {
    const { id } = req.params;
    const { isPublic } = req.body;
    const userId = req.user.id;
    
    if (typeof isPublic !== 'boolean') {
      return res.status(400).json({ error: 'isPublic must be a boolean' });
    }
    
    const template = await templateService.setTemplateVisibility(id, userId, isPublic);
    res.json(template);
  } catch (error) {
    console.error('Error updating template visibility:', error);
    res.status(500).json({ error: 'Failed to update template visibility' });
  }
});

export default router;

