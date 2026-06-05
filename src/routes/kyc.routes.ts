import { Router } from 'express';
import { authenticate, requireDriver } from '../middleware/auth';
import KycController from '../controllers/kyc.controller';

const router = Router();

// All KYC routes require authentication + driver role
router.use(authenticate);
router.use(requireDriver);

router.post('/initiate', KycController.initiate);
router.get('/status', KycController.getStatus);

// DigiLocker verification (Surepass)
router.post('/digilocker/initiate', KycController.digilockerInitiate);
router.post('/digilocker/check', KycController.checkDigiLocker);

// PAN + DL verification (Surepass standalone)
router.post('/fallback', KycController.fallback);

// Selfie + Face match (Surepass)
router.post('/selfie', KycController.submitSelfie);

export default router;
