import { Router } from 'express';
import { authenticate, requireDriver } from '../middleware/auth';
import DiditSessionController from '../controllers/diditSession.controller';

const router = Router();

// All session routes require authentication + driver role
router.use(authenticate);
router.use(requireDriver);

// Create a Didit hosted KYC verification session
// Body: { callbackUrl?: string }
// Returns: { verificationUrl, sessionId, status }
router.post('/create', DiditSessionController.createSession);

// Poll Didit for the decision on a specific session
// Used after the deep-link callback to confirm Approved/Declined server-side
router.get('/:sessionId/decision', DiditSessionController.getDecision);

export default router;
