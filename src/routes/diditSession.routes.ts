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

// Confirm session decision (called after deep-link callback from mobile)
// Fetches decision from Didit, updates DB, returns { sessionId, status, kycCompleted }
router.post('/:sessionId/confirm', DiditSessionController.confirmSession);

// Raw decision from Didit (optional polling)
router.get('/:sessionId/decision', DiditSessionController.getDecision);

export default router;
