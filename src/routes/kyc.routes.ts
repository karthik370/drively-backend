import { Router } from 'express';
import { authenticate, requireDriver } from '../middleware/auth';
import KycController from '../controllers/kyc.controller';

const router = Router();

// All KYC routes require authentication + driver role
router.use(authenticate);
router.use(requireDriver);

router.post('/initiate', KycController.initiate);
router.get('/status', KycController.getStatus);
router.post('/digilocker/check', KycController.checkDigiLocker);
router.post('/fallback', KycController.fallback);
router.post('/selfie', KycController.submitSelfie);

export default router;
