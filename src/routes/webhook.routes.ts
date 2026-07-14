import { Router } from 'express';
import DiditSessionController from '../controllers/diditSession.controller';

const router = Router();

// Public endpoint — Didit calls this with HMAC-signed events
// DO NOT add authentication middleware here
router.post('/didit', DiditSessionController.handleWebhook);

export default router;
