import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import SupportController from '../controllers/support.controller';

const router = Router();

router.get('/threads', authenticate, SupportController.listThreads);
router.get('/threads/:bookingId/messages', authenticate, SupportController.listMessages);

router.post('/tickets', authenticate, (_req, res) => {
  res.json({ success: true, message: 'Support routes - To be implemented' });
});

export default router;
