import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { BadgeService } from '../services/badge.service';

const router = Router();

// Get all badge definitions
router.get('/', authenticate, asyncHandler(async (_req: AuthRequest, res: Response) => {
  const badges = await BadgeService.getAllBadges();
  res.status(200).json({ success: true, data: badges });
}));

// Get current driver's earned badges
router.get('/my', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw new Error('Not authenticated');
  const badges = await BadgeService.getDriverBadges(req.user.id);
  res.status(200).json({ success: true, data: badges });
}));

// Get a specific driver's earned badges
router.get('/driver/:driverId', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const badges = await BadgeService.getDriverBadges(req.params.driverId);
  res.status(200).json({ success: true, data: badges });
}));

// Get quiz questions for a badge (without answers)
router.get('/:badgeId/quiz', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const quiz = await BadgeService.getQuiz(req.params.badgeId);
  res.status(200).json({ success: true, data: quiz });
}));

// Submit quiz answers
router.post('/:badgeId/quiz', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw new Error('Not authenticated');
  const { answers } = req.body || {};
  if (!Array.isArray(answers)) {
    res.status(400).json({ success: false, message: 'answers array is required' });
    return;
  }

  const result = await BadgeService.submitQuiz(req.user.id, req.params.badgeId, answers);
  res.status(200).json({ success: true, data: result });
}));

export default router;
