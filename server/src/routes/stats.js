import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getStats } from '../services/orderService.js';
import { listRecent } from '../services/activityLog.js';

const router = Router();

router.get('/stats', requireAuth, asyncHandler(async (_req, res) => {
  res.json(await getStats());
}));

// Reads straight from the Mongo activity trail.
router.get('/activity', requireAuth, asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({ activity: await listRecent(limit) });
}));

export default router;
