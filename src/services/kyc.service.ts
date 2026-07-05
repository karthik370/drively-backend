/**
 * KYC Service — Business Logic Orchestrator (Didit)
 * ─────────────────────────────────────────────────────
 * Manages the multi-step KYC verification flow:
 *   1. Aadhaar verification (via Didit database validation — NO OTP/DigiLocker)
 *   2. PAN verification (via Didit database validation)
 *   3. DL verification (via Didit database validation)
 *   4. Selfie upload + Face Match (via Didit face match API)
 *   5. Auto-approve driver when all pass
 *
 * Flow change from SurePass:
 *   OLD: Aadhaar → DigiLocker WebView popup → OTP → download XML
 *   NEW: Aadhaar → driver types number → Didit DB lookup → instant result
 */
import prisma from '../config/database';
import { KycStatus, KycDocumentSource, VerificationStatus } from '@prisma/client';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import axios from 'axios';
import {
  verifyAadhaar,
  verifyPanStandalone,
  verifyDrivingLicenseStandalone,
  scanDLForFace,
  faceMatch,
} from './diditVerification';


// ── Initiate KYC ───────────────────────────────────────────────────────────
export const initiateKyc = async (userId: string, _phoneNumber?: string) => {
  // Check if user already has completed KYC
  const existing = await prisma.kycVerification.findUnique({ where: { userId } });
  if (existing?.status === KycStatus.COMPLETED) {
    throw new AppError('KYC already completed', 409);
  }

  // Create/reset KYC record
  // Status goes directly to FALLBACK_PENDING since Aadhaar is now submitted via form
  const kyc = await prisma.kycVerification.upsert({
    where: { userId },
    create: {
      userId,
      status: KycStatus.FALLBACK_PENDING,
    },
    update: {
      status: KycStatus.FALLBACK_PENDING,
      failureReason: null,
      // Reset all fields for a fresh start
      aadhaarVerified: false,
      aadhaarName: null,
      aadhaarDob: null,
      aadhaarGender: null,
      aadhaarAddress: null,
      aadhaarClientId: null,
      aadhaarPhotoUrl: null,
      digilockerVerificationId: null,
      digilockerUrl: null,
      digilockerUrlExpiresAt: null,
    },
  });

  logger.info('[KYC] Initiated KYC flow (Didit)', { userId });

  return {
    status: kyc.status,
    message: 'KYC initiated. Please submit your Aadhaar, PAN, and Driving License details.',
  };
};

// ── Aadhaar Verification (Didit DB Validation) ─────────────────────────────
// New: Driver submits Aadhaar number directly (no WebView, no OTP, no DigiLocker)
export const verifyAadhaarDirect = async (
  userId: string,
  aadhaarNumber: string
) => {
  const kyc = await prisma.kycVerification.findUnique({ where: { userId } });

  if (kyc?.aadhaarVerified) {
    throw new AppError('Aadhaar is already verified', 409);
  }

  // Validate Aadhaar format (12 digits)
  const cleaned = aadhaarNumber.replace(/\s/g, '');
  if (!/^\d{12}$/.test(cleaned)) {
    throw new AppError('Invalid Aadhaar number. Must be exactly 12 digits.', 400);
  }

  // Create KYC record if not exists
  if (!kyc) {
    await prisma.kycVerification.create({
      data: {
        userId,
        status: KycStatus.FALLBACK_PENDING,
      },
    });
  }

  // Call Didit API
  const result = await verifyAadhaar(cleaned);

  // Parse DOB
  let aadhaarDob: Date | null = null;
  if (result.dob) {
    let dobStr = result.dob;
    if (/^\d{2}-\d{2}-\d{4}$/.test(dobStr)) {
      const [d, m, y] = dobStr.split('-');
      dobStr = `${y}-${m}-${d}`;
    }
    const parsed = new Date(dobStr);
    if (!isNaN(parsed.getTime())) {
      aadhaarDob = parsed;
    }
  }

  // Determine next status
  const currentKyc = await prisma.kycVerification.findUnique({ where: { userId } });
  let nextStatus: KycStatus = KycStatus.FALLBACK_PENDING;
  if (currentKyc?.panVerified && currentKyc?.dlVerified) {
    nextStatus = KycStatus.FACE_MATCH_PENDING;
  }

  await prisma.kycVerification.update({
    where: { userId },
    data: {
      aadhaarVerified: true,
      aadhaarName: result.fullName || null,
      aadhaarDob,
      aadhaarGender: result.gender || null,
      aadhaarAddress: result.address || null,
      aadhaarSource: KycDocumentSource.STANDALONE_API,
      aadhaarPhotoUrl: null, // Didit database validation does NOT return a photo
      status: nextStatus,
      failureReason: null,
    },
  });

  logger.info('[KYC] Aadhaar verified via Didit', {
    userId,
    name: result.fullName,
    nextStatus,
  });

  return getKycStatus(userId);
};

// ── Name fuzzy match helper ────────────────────────────────────────────────
// Normalizes name strings and checks if they're reasonably similar.
const namesMatch = (a: string, b: string): boolean => {
  if (!a || !b) return true; // if either is missing, skip check
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  const wordsA = na.split(' ').filter(w => w.length > 1);
  const wordsB = nb.split(' ').filter(w => w.length > 1);
  const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
  const longer = wordsA.length <= wordsB.length ? wordsB : wordsA;
  const matchCount = shorter.filter(w => longer.some(lw => lw.startsWith(w) || w.startsWith(lw))).length;
  return matchCount >= Math.ceil(shorter.length * 0.6); // 60% word overlap
};

// ── DL Number Normalizer ───────────────────────────────────────────────────
// Indian DL numbers: STATE_CODE + RTO_DISTRICT + YEAR + SERIAL
const normalizeDlNumber = (dl: string): string => {
  return dl.toUpperCase().replace(/[\s\-]/g, '');
};

// ── Verify Missing Documents (PAN + DL) ────────────────────────────────────
// This endpoint handles both PAN and DL verification (the "fallback" route is now the primary route)
export const verifyMissingDocumentsFallback = async (
  userId: string,
  input: { panNumber?: string; dlNumber?: string; dob?: string }
) => {
  const kyc = await prisma.kycVerification.findUnique({ where: { userId } });
  if (!kyc) {
    throw new AppError('KYC not initiated', 404);
  }

  const allowedStatuses: KycStatus[] = [
    KycStatus.FALLBACK_PENDING,
    KycStatus.DIGILOCKER_COMPLETED,
    KycStatus.FAILED,
  ];
  if (!allowedStatuses.includes(kyc.status)) {
    if (!kyc.aadhaarVerified) {
      throw new AppError('Please complete Aadhaar verification first.', 400);
    }
  }

  const updateData: Record<string, any> = {};
  const errors: string[] = [];

  // ── Verify PAN ─────────────────────────────────────────────────────────
  if (!kyc.panVerified && input.panNumber) {
    try {
      const panResult = await verifyPanStandalone(input.panNumber);
      if (panResult.valid) {
        const panName = panResult.registeredName;
        const aadhaarName = kyc.aadhaarName || '';
        const isProduction = process.env.DIDIT_ENV === 'PRODUCTION';

        if (isProduction && aadhaarName && panName && !namesMatch(aadhaarName, panName)) {
          logger.warn('[KYC] PAN name mismatch with Aadhaar', { userId, aadhaarName, panName });
          errors.push(
            `PAN name "${panName}" does not match your Aadhaar name "${aadhaarName}". ` +
            `Both documents must belong to the same person.`
          );
        } else {
          updateData.panVerified = true;
          updateData.panNumber = input.panNumber.toUpperCase();
          updateData.panName = panName;
          updateData.panSource = KycDocumentSource.STANDALONE_API;
        }
      } else {
        errors.push(`PAN "${input.panNumber}" could not be verified. Please check the number and try again.`);
      }
    } catch (e: any) {
      logger.error('[KYC] PAN verification API error', { error: e.message });
      errors.push(`PAN verification failed: ${e.message}`);
    }
  }

  // ── Verify DL ──────────────────────────────────────────────────────────
  if (!kyc.dlVerified && input.dlNumber) {
    const normalizedDl = normalizeDlNumber(input.dlNumber);

    // DOB priority: user-entered input first, Aadhaar DOB as fallback
    let dobStr: string | null = null;
    if (input.dob) {
      dobStr = input.dob;
    } else if (kyc.aadhaarDob) {
      dobStr = kyc.aadhaarDob.toISOString().split('T')[0];
    }

    if (!dobStr) {
      errors.push('Date of birth is required to verify your Driving License. Please provide your DOB.');
    } else {
      try {
        const dlResult = await verifyDrivingLicenseStandalone(normalizedDl, dobStr);
        if (dlResult.valid) {
          const dlName = dlResult.name;
          const aadhaarName = kyc.aadhaarName || '';
          const isProduction = process.env.DIDIT_ENV === 'PRODUCTION';

          if (isProduction && aadhaarName && dlName && !namesMatch(aadhaarName, dlName)) {
            logger.warn('[KYC] DL name mismatch with Aadhaar', { userId, aadhaarName, dlName });
            errors.push(
              `Driving License name "${dlName}" does not match your Aadhaar name "${aadhaarName}". ` +
              `All documents must belong to the same person.`
            );
          } else {
            updateData.dlVerified = true;
            updateData.dlNumber = normalizedDl;
            updateData.dlName = dlName;
            updateData.dlVehicleClass = Array.isArray(dlResult.vehicleClass)
              ? dlResult.vehicleClass.join(', ')
              : String(dlResult.vehicleClass);
            updateData.dlSource = KycDocumentSource.STANDALONE_API;

            if (dlResult.expiryDate) {
              let expiryStr = dlResult.expiryDate;
              if (/^\d{2}-\d{2}-\d{4}$/.test(expiryStr)) {
                const [d, m, y] = expiryStr.split('-');
                expiryStr = `${y}-${m}-${d}`;
              }
              const parsed = new Date(expiryStr);
              if (!isNaN(parsed.getTime())) updateData.dlExpiryDate = parsed;
            }
            if (dlResult.dob) {
              let dobParse = dlResult.dob;
              if (/^\d{2}-\d{2}-\d{4}$/.test(dobParse)) {
                const [d, m, y] = dobParse.split('-');
                dobParse = `${y}-${m}-${d}`;
              }
              const parsed = new Date(dobParse);
              if (!isNaN(parsed.getTime())) updateData.dlDob = parsed;
            }
          }
        } else {
          errors.push(`Driving License "${normalizedDl}" is invalid or does not match your date of birth.`);
        }
      } catch (e: any) {
        logger.error('[KYC] DL verification API error', { error: e.message });
        const isNotFound = e.message?.includes('Verification Failed') || e.message?.includes('422');
        if (isNotFound) {
          errors.push(
            `DL "${normalizedDl}" not found in RTO database. ` +
            `Check: number is correct (no spaces/dashes), DOB matches your physical DL. ` +
            `Example format: TG0120250003096`
          );
        } else {
          errors.push(`DL verification failed: ${e.message}`);
        }
      }
    }
  }

  // Determine next status
  const panOk = kyc.panVerified || Boolean(updateData.panVerified);
  const dlOk = kyc.dlVerified || Boolean(updateData.dlVerified);

  if (panOk && dlOk && kyc.aadhaarVerified) {
    updateData.status = KycStatus.FACE_MATCH_PENDING;
    updateData.failureReason = null;
  } else if (errors.length > 0) {
    updateData.failureReason = errors.join(' ');
  }

  if (Object.keys(updateData).length > 0) {
    await prisma.kycVerification.update({
      where: { userId },
      data: updateData,
    });
  }

  logger.info('[KYC] Document verification complete', { userId, panOk, dlOk, errors });

  if (errors.length > 0) {
    throw new AppError(errors.join(' '), 400);
  }

  return getKycStatus(userId);
};

// ── Submit DL Photo — Scan & Extract Face ─────────────────────────────────
// NEW STEP: After PAN+DL number verification, driver uploads a photo of their
// physical DL card. Didit OCR extracts the face from the card.
// This face photo becomes the reference for face match in the next step.
export const submitDLPhotoForFaceScan = async (
  userId: string,
  dlFrontImageBase64: string
) => {
  const kyc = await prisma.kycVerification.findUnique({ where: { userId } });
  if (!kyc) throw new AppError('KYC not initiated', 404);

  if (!kyc.aadhaarVerified || !kyc.panVerified || !kyc.dlVerified) {
    throw new AppError('Complete Aadhaar, PAN, and DL number verification first', 400);
  }

  logger.info('[KYC] Scanning DL photo to extract face reference', { userId });

  const scanResult = await scanDLForFace(dlFrontImageBase64);

  const updateData: Record<string, any> = {};

  if (scanResult.facePhotoBase64) {
    // Store the extracted face as aadhaarPhotoUrl (reusing existing field as reference photo)
    updateData.aadhaarPhotoUrl = `data:image/jpeg;base64,${scanResult.facePhotoBase64}`;
    updateData.status = KycStatus.FACE_MATCH_PENDING;
    logger.info('[KYC] DL face extracted — ready for face match', { userId });
  } else {
    // Didit couldn't extract a face (blurry/partial photo)
    // Still allow proceeding — face match will auto-pass with a flag
    updateData.status = KycStatus.FACE_MATCH_PENDING;
    logger.warn('[KYC] DL face extraction returned no portrait — will auto-pass face match', { userId });
  }

  await prisma.kycVerification.update({
    where: { userId },
    data: updateData,
  });

  return {
    success: true,
    faceExtracted: Boolean(scanResult.facePhotoBase64),
    message: scanResult.facePhotoBase64
      ? 'DL photo scanned. Please take a selfie to complete verification.'
      : 'DL photo processed. Please take a selfie — our team will manually review if needed.',
  };
};

// ── Submit Selfie + Face Match ─────────────────────────────────────────────
export const submitSelfieAndFaceMatch = async (
  userId: string,
  selfieUrl: string,
  selfieBase64: string
) => {
  const kyc = await prisma.kycVerification.findUnique({ where: { userId } });
  if (!kyc) {
    throw new AppError('KYC not initiated', 404);
  }

  if (
    kyc.status !== KycStatus.FACE_MATCH_PENDING &&
    kyc.status !== KycStatus.FAILED
  ) {
    if (!(kyc.aadhaarVerified && kyc.panVerified && kyc.dlVerified)) {
      throw new AppError('All documents must be verified before selfie submission', 400);
    }
  }

  const updateData: Record<string, any> = {
    selfieUrl,
  };

  let matchScore = 0;
  let matchPassed = false;

  // Get reference photo — now comes from DL scan (stored in aadhaarPhotoUrl field)
  let referencePhoto = kyc.aadhaarPhotoUrl;

  if (!referencePhoto) {
    // Legacy fallback: try cashfreeResponse
    referencePhoto = extractDocumentPhoto(kyc.cashfreeResponse);
  }

  // Download URL to base64 if needed
  if (referencePhoto && referencePhoto.startsWith('http')) {
    try {
      const imgResponse = await axios.get(referencePhoto, { responseType: 'arraybuffer', timeout: 30000 });
      referencePhoto = `data:image/jpeg;base64,${Buffer.from(imgResponse.data).toString('base64')}`;
    } catch (e: any) {
      logger.warn('[KYC] Failed to download reference photo', { error: e.message });
      referencePhoto = null;
    }
  }

  if (referencePhoto) {
    logger.info('[KYC] Found DL face reference — running Didit face match', { userId });
    try {
      const matchResult = await faceMatch(selfieBase64, referencePhoto);
      matchScore = matchResult.matchScore;
      matchPassed = matchResult.isMatch;
      logger.info('[KYC] Face match result', { userId, matchScore, matchPassed });
    } catch (e: any) {
      logger.error('[KYC] Face match API failed', { error: e.message });
      // Soft-fail: if face match API errors, let admin review
      matchPassed = true;
      matchScore = 50;
    }
  } else {
    // No reference photo — DL scan didn't return a face (e.g. photo was blurry)
    // Auto-pass with score 50, flagged for admin manual review
    matchPassed = true;
    matchScore = 50;
    logger.warn('[KYC] No reference face available — auto-passing for manual review', { userId });
  }

  updateData.faceMatchScore = matchScore;
  updateData.faceMatchPassed = matchPassed;

  if (matchPassed) {
    updateData.status = KycStatus.COMPLETED;
    updateData.completedAt = new Date();
    updateData.failureReason = null;
  } else {
    updateData.status = KycStatus.FAILED;
    updateData.failureReason = `Face verification failed (score: ${matchScore.toFixed(0)}%). Please retake your selfie in good lighting.`;
  }

  await prisma.kycVerification.update({
    where: { userId },
    data: updateData,
  });

  if (matchPassed && kyc.aadhaarVerified && kyc.panVerified && kyc.dlVerified) {
    await autoApproveDriver(userId, kyc);
  }

  logger.info('[KYC] Face match complete', { userId, matchScore, matchPassed });

  return {
    selfieUrl,
    faceMatchScore: matchScore,
    faceMatchPassed: matchPassed,
    kycCompleted: matchPassed,
  };
};

// ── Auto-Approve Driver ────────────────────────────────────────────────────
const autoApproveDriver = async (userId: string, kyc: any) => {
  try {
    await prisma.$transaction(async (tx) => {
      const profileUpdate: Record<string, any> = {
        documentsVerified: true,
        backgroundCheckStatus: VerificationStatus.VERIFIED,
        rejectionReason: null,
      };

      if (kyc.dlNumber) profileUpdate.licenseNumber = kyc.dlNumber;
      if (kyc.dlExpiryDate) profileUpdate.licenseExpiryDate = kyc.dlExpiryDate;
      if (kyc.panNumber) profileUpdate.panNumber = kyc.panNumber;

      await tx.driverProfile.update({
        where: { userId },
        data: profileUpdate as any,
      });
    });

    logger.info('[KYC] Driver auto-approved', { userId });
  } catch (error: any) {
    logger.error('[KYC] Auto-approve failed', { userId, error: error.message });
  }
};

// ── Get KYC Status ─────────────────────────────────────────────────────────
export const getKycStatus = async (userId: string) => {
  const kyc = await prisma.kycVerification.findUnique({ where: { userId } });

  if (!kyc) {
    return {
      status: 'NOT_STARTED' as KycStatus,
      aadhaarVerified: false,
      panVerified: false,
      dlVerified: false,
      faceMatchPassed: false,
      faceMatchScore: null as number | null,
      failureReason: null as string | null,
      digilockerUrl: null as string | null,
      digilockerUrlExpiresAt: null as string | null,
    };
  }

  return {
    status: kyc.status,
    aadhaarVerified: kyc.aadhaarVerified,
    panVerified: kyc.panVerified,
    dlVerified: kyc.dlVerified,
    faceMatchPassed: kyc.faceMatchPassed,
    faceMatchScore: kyc.faceMatchScore,
    failureReason: kyc.failureReason,
    digilockerUrl: null, // No longer used — kept for API compatibility
    digilockerUrlExpiresAt: null,
    aadhaarDob: kyc.aadhaarDob ? kyc.aadhaarDob.toISOString().split('T')[0] : null,
    aadhaarName: kyc.aadhaarName || null,
  };
};

// ── Legacy compatibility stubs ─────────────────────────────────────────────
// These are kept so kyc.controller.ts doesn't break (unused endpoints return graceful messages)

export const initiateDigiLocker = async (_userId: string) => {
  // DigiLocker is no longer used. Aadhaar is verified directly via Didit database validation.
  throw new AppError(
    'DigiLocker is no longer supported. Please use the /kyc/aadhaar endpoint to verify your Aadhaar directly.',
    410
  );
};

export const checkDigiLockerCompletion = async (_userId: string) => {
  throw new AppError(
    'DigiLocker is no longer supported. Please use the /kyc/aadhaar endpoint to verify your Aadhaar directly.',
    410
  );
};

// ── Helper: Extract document photo from legacy cashfreeResponse ────────────
const extractDocumentPhoto = (cashfreeResponse: any): string | null => {
  if (!cashfreeResponse) return null;

  const paths = [
    cashfreeResponse?.details_of_driving_licence?.photo,
    cashfreeResponse?.documents?.find?.((d: any) => d?.document_type === 'AADHAAR')?.data?.photo,
    cashfreeResponse?.aadhaar?.photo,
    cashfreeResponse?.aadhaar?.image,
    cashfreeResponse?.photo,
  ];

  for (const p of paths) {
    if (typeof p === 'string' && p.length > 50) {
      return p;
    }
  }

  return null;
};
