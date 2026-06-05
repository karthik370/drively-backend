import { Router } from 'express';
import { authenticate, requireDriver } from '../middleware/auth';
import KycController from '../controllers/kyc.controller';

const router = Router();

// All KYC routes require authentication + driver role
router.use(authenticate);
router.use(requireDriver);

router.post('/initiate', KycController.initiate);
router.get('/status', KycController.getStatus);

// Aadhaar OTP verification (Surepass)
router.post('/aadhaar/send-otp', KycController.aadhaarSendOtp);
router.post('/aadhaar/verify-otp', KycController.aadhaarVerifyOtp);

// Legacy: DigiLocker check (now just returns current status)
router.post('/digilocker/check', KycController.checkDigiLocker);

// PAN + DL verification (Surepass)
router.post('/fallback', KycController.fallback);

// Selfie + Face match (Surepass)
router.post('/selfie', KycController.submitSelfie);

export default router;
