import { Router } from 'express';
import chartDataService from '../services/chartDataService.js';

const router = Router();

// Get shared chart data (PUBLIC - no auth required)
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

export default router;
