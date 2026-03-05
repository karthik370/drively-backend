import { Router } from 'express';
import { authenticate } from '../middleware/auth';

const router = Router();

router.get('/', authenticate, (_req, res) => {
  res.json({ success: true, message: 'Notification routes - To be implemented' });
});

export default router;
