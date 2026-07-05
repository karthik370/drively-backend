/**
 * KYC Controller — REST Endpoints
 * ────────────────────────────────
 * POST   /kyc/initiate       → Start KYC flow
 * GET    /kyc/status         → Get current KYC status
 * POST   /kyc/aadhaar        → Verify Aadhaar (Didit DB validation — no OTP)
 * POST   /kyc/fallback       → Submit PAN/DL numbers (Didit DB validation)
 * POST   /kyc/selfie         → Upload selfie + trigger face match (Didit)
 *
 * Removed (DigiLocker):
 *   POST   /kyc/digilocker/initiate  → DEPRECATED (returns 410)
 *   POST   /kyc/digilocker/check     → DEPRECATED (returns 410)
 */
import { Response } from 'express';
import { v2 as cloudinary } from 'cloudinary';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import {
  initiateKyc,
  verifyAadhaarDirect,
  verifyMissingDocumentsFallback,
  submitDLPhotoForFaceScan,
  submitSelfieAndFaceMatch,
  getKycStatus,
  initiateDigiLocker,
  checkDigiLockerCompletion,
} from '../services/kyc.service';

// Configure Cloudinary from env vars
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export class KycController {
  /**
   * POST /kyc/initiate
   * Starts the KYC verification flow.
   */
  static initiate = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const phoneNumber = req.user.phoneNumber;
    if (!phoneNumber) {
      throw new AppError('Phone number not found on user account', 400);
    }

    const result = await initiateKyc(req.user.id, phoneNumber);

    res.status(200).json({
      success: true,
      message: 'KYC verification initiated',
      data: result,
    });
  });

  /**
   * POST /kyc/aadhaar
   * Verify Aadhaar number directly via Didit database validation.
   * No DigiLocker, no OTP, no WebView — just a number.
   * Body: { aadhaarNumber: string }
   */
  static verifyAadhaar = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const aadhaarNumber = typeof req.body?.aadhaarNumber === 'string'
      ? req.body.aadhaarNumber.replace(/\s/g, '').trim()
      : undefined;

    if (!aadhaarNumber) {
      throw new AppError('aadhaarNumber is required', 400);
    }

    // 12 digits only
    if (!/^\d{12}$/.test(aadhaarNumber)) {
      throw new AppError('Invalid Aadhaar number. Must be exactly 12 digits.', 400);
    }

    const result = await verifyAadhaarDirect(req.user.id, aadhaarNumber);

    res.status(200).json({
      success: true,
      message: 'Aadhaar verified successfully',
      data: result,
    });
  });

  /**
   * GET /kyc/status
   * Returns the current KYC status for the authenticated driver.
   */
  static getStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const status = await getKycStatus(req.user.id);

    res.status(200).json({
      success: true,
      data: status,
    });
  });

  /**
   * POST /kyc/fallback
   * Submit PAN and/or DL numbers for verification via Didit.
   * Body: { panNumber?: string, dlNumber?: string, dob?: string }
   */
  static fallback = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const panNumber = typeof req.body?.panNumber === 'string' ? req.body.panNumber.trim() : undefined;
    const dlNumber = typeof req.body?.dlNumber === 'string' ? req.body.dlNumber.trim() : undefined;
    const dob = typeof req.body?.dob === 'string' ? req.body.dob.trim() : undefined;

    if (!panNumber && !dlNumber) {
      throw new AppError('At least one of panNumber or dlNumber is required', 400);
    }

    // Validate PAN format: 5 letters + 4 digits + 1 letter
    if (panNumber && !/^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(panNumber)) {
      throw new AppError('Invalid PAN format. Expected: ABCDE1234F', 400);
    }

    // Basic DL validation
    if (dlNumber && dlNumber.length < 5) {
      throw new AppError('Invalid Driving License number', 400);
    }

    // Validate DOB format if provided (YYYY-MM-DD)
    if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      throw new AppError('Invalid DOB format. Expected: YYYY-MM-DD', 400);
    }

    const status = await verifyMissingDocumentsFallback(req.user.id, { panNumber, dlNumber, dob });

    res.status(200).json({
      success: true,
      message: 'Verification processed',
      data: status,
    });
  });

  /**
   * POST /kyc/dl-photo
   * Upload front photo of physical DL card.
   * Didit scans it → extracts face → stored as face match reference.
   * Body: { base64: string, mimeType: string }
   */
  static submitDLPhoto = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const { base64, mimeType } = req.body || {};
    if (!base64 || typeof base64 !== 'string') {
      throw new AppError('base64 DL front image is required', 400);
    }

    const mime = typeof mimeType === 'string' ? mimeType : 'image/jpeg';
    const dataUri = base64.startsWith('data:') ? base64 : `data:${mime};base64,${base64}`;

    const result = await submitDLPhotoForFaceScan(req.user.id, dataUri);

    res.status(200).json({
      success: true,
      message: result.message,
      data: {
        faceExtracted: result.faceExtracted,
        nextStep: 'selfie',
      },
    });
  });

  /**
   * POST /kyc/selfie
   * Upload selfie (base64) and run face match via Didit.
   * Body: { base64: string, mimeType: string }
   */
  static submitSelfie = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const { base64, mimeType } = req.body || {};
    if (!base64 || typeof base64 !== 'string') {
      throw new AppError('base64 selfie image is required', 400);
    }

    const validMimes = ['image/jpeg', 'image/png', 'image/webp'];
    const mime = typeof mimeType === 'string' ? mimeType : 'image/jpeg';
    if (!validMimes.includes(mime)) {
      throw new AppError('Invalid mimeType for selfie', 400);
    }

    const tempSelfieRef = `data:${mime};base64,${base64}`;
    const result = await submitSelfieAndFaceMatch(req.user.id, tempSelfieRef, base64);

    // Only upload to Cloudinary if face match PASSED and KYC is completed
    if (result.kycCompleted) {
      try {
        const folder = `drivemate/${req.user.id}/kyc-selfie`;
        const publicId = `selfie_${Date.now()}`;

        logger.info('[KYC] Face match passed — uploading verified selfie to Cloudinary', {
          folder,
          publicId,
          cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        });

        const uploadResult = await cloudinary.uploader.upload(
          `data:${mime};base64,${base64}`,
          { folder, public_id: publicId, resource_type: 'image', overwrite: true }
        );
        const selfieUrl = uploadResult.secure_url;
        logger.info('[KYC] Verified selfie uploaded to Cloudinary', { url: selfieUrl });

        await import('../config/database').then(({ default: prisma }) =>
          prisma.user.update({
            where: { id: req.user!.id },
            data: { profileImage: selfieUrl },
          })
        );
        logger.info('[KYC] Driver profile image updated with verified selfie', { userId: req.user.id });
      } catch (err: any) {
        logger.error('[KYC] Cloudinary upload failed after face match', { error: err?.message });
      }
    } else {
      logger.info('[KYC] Face match failed — selfie NOT uploaded to Cloudinary', {
        userId: req.user.id,
        faceMatchScore: result.faceMatchScore,
      });
    }

    res.status(200).json({
      success: true,
      message: result.kycCompleted
        ? 'KYC completed! Your identity has been verified.'
        : 'Face verification processed',
      data: result,
    });
  });

  /**
   * POST /kyc/digilocker/initiate  — DEPRECATED
   * DigiLocker is no longer used. Returns 410 Gone.
   */
  static digilockerInitiate = asyncHandler(async (req: AuthRequest, _res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);
    // Calls the stub which throws 410
    await initiateDigiLocker(req.user.id);
  });

  /**
   * POST /kyc/digilocker/check  — DEPRECATED
   * DigiLocker is no longer used. Returns 410 Gone.
   */
  static checkDigiLocker = asyncHandler(async (req: AuthRequest, _res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);
    await checkDigiLockerCompletion(req.user.id);
  });
}

export default KycController;
