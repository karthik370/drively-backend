import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import SupportController from '../controllers/support.controller';

const router = Router();

router.get('/threads', authenticate, SupportController.listThreads);
router.get('/threads/:bookingId/messages', authenticate, SupportController.listMessages);

// Onboarding support — driver calls this to open a support ticket during KYC/verification
router.post('/onboarding-ticket', authenticate, SupportController.createOnboardingTicket);

export default router;
