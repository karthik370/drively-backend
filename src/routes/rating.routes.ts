import { Router } from 'express';
import { authenticate } from '../middleware/auth';

const router = Router();

router.post('/', authenticate, (_req, res) => {
  res.json({ success: true, message: 'Rating routes - To be implemented' });
});

export default router;
