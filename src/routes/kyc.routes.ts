import { Router } from 'express';
import { authenticate, requireDriver } from '../middleware/auth';
import KycController from '../controllers/kyc.controller';

const router = Router();

// All KYC routes require authentication + driver role
router.use(authenticate);
router.use(requireDriver);

// Initiate KYC flow
router.post('/initiate', KycController.initiate);

// Get current KYC status
router.get('/status', KycController.getStatus);

// NEW: Aadhaar verification via Didit database validation (no OTP/DigiLocker)
// Body: { aadhaarNumber: string }
router.post('/aadhaar', KycController.verifyAadhaar);

// PAN + DL verification via Didit database validation
// Body: { panNumber?: string, dlNumber?: string, dob?: string }
router.post('/fallback', KycController.fallback);

// Selfie + Face match via Didit
// Body: { base64: string, mimeType: string }
router.post('/selfie', KycController.submitSelfie);

// DEPRECATED: DigiLocker routes (return 410 Gone)
router.post('/digilocker/initiate', KycController.digilockerInitiate);
router.post('/digilocker/check', KycController.checkDigiLocker);

export default router;
