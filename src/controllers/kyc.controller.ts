/**
 * KYC Controller — REST Endpoints
 * ────────────────────────────────
 * POST   /kyc/initiate           → Start DigiLocker flow
 * GET    /kyc/status             → Get current KYC status
 * POST   /kyc/digilocker/check   → Check DigiLocker completion
 * POST   /kyc/fallback           → Submit PAN/DL manually (standalone APIs)
 * POST   /kyc/selfie             → Upload selfie + trigger face match
 */
import { Response } from 'express';
import { v2 as cloudinary } from 'cloudinary';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import {
  initiateKyc,
  checkDigiLockerCompletion,
  verifyMissingDocumentsFallback,
  submitSelfieAndFaceMatch,
  getKycStatus,
} from '../services/kyc.service';

export class KycController {
  /**
   * POST /kyc/initiate
   * Starts the DigiLocker KYC flow. Returns a URL to open in WebView.
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
      message: 'DigiLocker verification initiated',
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
   * POST /kyc/digilocker/check
   * Called after the driver returns from DigiLocker WebView.
   * Polls Cashfree for the result and updates KYC records.
   */
  static checkDigiLocker = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const status = await checkDigiLockerCompletion(req.user.id);

    res.status(200).json({
      success: true,
      message: 'DigiLocker status checked',
      data: status,
    });
  });

  /**
   * POST /kyc/fallback
   * Submit PAN/DL numbers manually when DigiLocker couldn't fetch them.
   * Body: { panNumber?: string, dlNumber?: string }
   */
  static fallback = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const panNumber = typeof req.body?.panNumber === 'string' ? req.body.panNumber.trim() : undefined;
    const dlNumber = typeof req.body?.dlNumber === 'string' ? req.body.dlNumber.trim() : undefined;

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

    const status = await verifyMissingDocumentsFallback(req.user.id, { panNumber, dlNumber });

    res.status(200).json({
      success: true,
      message: 'Fallback verification processed',
      data: status,
    });
  });

  /**
   * POST /kyc/selfie
   * Upload selfie (base64) and run face match + liveness.
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

    // Upload selfie to Cloudinary first
    let selfieUrl: string;
    try {
      const folder = `drivemate/${req.user.id}/kyc-selfie`;
      const publicId = `selfie_${Date.now()}`;

      const uploadResult = await cloudinary.uploader.upload(
        `data:${mime};base64,${base64}`,
        { folder, public_id: publicId, resource_type: 'image', overwrite: true }
      );
      selfieUrl = uploadResult.secure_url;
    } catch (err: any) {
      logger.error('[KYC] Selfie upload to Cloudinary failed', { error: err?.message });
      throw new AppError('Failed to upload selfie', 502);
    }

    // Run face match
    const result = await submitSelfieAndFaceMatch(req.user.id, selfieUrl, base64);

    res.status(200).json({
      success: true,
      message: result.kycCompleted
        ? 'KYC completed! Your identity has been verified.'
        : 'Face verification processed',
      data: result,
    });
  });
}

export default KycController;
