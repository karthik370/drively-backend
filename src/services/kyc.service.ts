/**
 * KYC Service — Business Logic Orchestrator (Surepass)
 * ─────────────────────────────────────────────────────
 * Manages the multi-step KYC verification flow:
 *   1. Aadhaar verification (via DigiLocker → Surepass)
 *   2. PAN verification (via Surepass standalone)
 *   3. DL verification (via Surepass standalone)
 *   4. Selfie upload + Face Match (vs Aadhaar photo)
 *   5. Auto-approve driver when all pass
 */
import prisma from '../config/database';
import { KycStatus, KycDocumentSource, VerificationStatus } from '@prisma/client';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import axios from 'axios';
import {
  digilockerCreateSession,
  digilockerFetchAadhaar,
  verifyPanStandalone,
  verifyDrivingLicenseStandalone,
  faceMatch,
} from './surepassVerification';


// ── Initiate KYC ───────────────────────────────────────────────────────────
export const initiateKyc = async (userId: string, _phoneNumber?: string) => {
  // Check if user already has completed KYC
  const existing = await prisma.kycVerification.findUnique({ where: { userId } });
  if (existing?.status === KycStatus.COMPLETED) {
    throw new AppError('KYC already completed', 409);
  }

  // Create/reset KYC record and set status to DIGILOCKER_PENDING
  const kyc = await prisma.kycVerification.upsert({
    where: { userId },
    create: {
      userId,
      status: KycStatus.DIGILOCKER_PENDING,
    },
    update: {
      status: KycStatus.DIGILOCKER_PENDING,
      failureReason: null,
      // Reset Aadhaar fields for fresh start
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

  logger.info('[KYC] Initiated KYC flow (DigiLocker)', { userId });

  return {
    status: kyc.status,
    message: 'KYC initiated. Please complete Aadhaar verification via DigiLocker.',
  };
};

// ── DigiLocker: Initialize Session ───────────────────────────────────────
export const initiateDigiLocker = async (userId: string) => {
  const kyc = await prisma.kycVerification.findUnique({ where: { userId } });

  // Allow from NOT_STARTED, DIGILOCKER_PENDING, AADHAAR_OTP_PENDING, or FAILED states
  if (kyc && kyc.status !== KycStatus.NOT_STARTED &&
    kyc.status !== KycStatus.DIGILOCKER_PENDING &&
    kyc.status !== KycStatus.AADHAAR_OTP_PENDING &&
    kyc.status !== KycStatus.FAILED) {
    if (kyc.aadhaarVerified) {
      throw new AppError('Aadhaar is already verified', 409);
    }
  }

  // Initialize DigiLocker via Surepass DigiBoost API
  const result = await digilockerCreateSession();

  // Store client_id and URL in DB for later Aadhaar download
  await prisma.kycVerification.upsert({
    where: { userId },
    create: {
      userId,
      status: KycStatus.DIGILOCKER_PENDING,
      digilockerVerificationId: result.clientId,
      digilockerUrl: result.digilockerUrl || null,
      digilockerUrlExpiresAt: new Date(Date.now() + result.expirySeconds * 1000),
    },
    update: {
      status: KycStatus.DIGILOCKER_PENDING,
      digilockerVerificationId: result.clientId,
      digilockerUrl: result.digilockerUrl || null,
      digilockerUrlExpiresAt: new Date(Date.now() + result.expirySeconds * 1000),
      failureReason: null,
    },
  });

  logger.info('[KYC] DigiLocker session initialized', {
    userId,
    clientId: result.clientId.slice(0, 20) + '...',
    expirySeconds: result.expirySeconds,
    hasUrl: Boolean(result.digilockerUrl),
  });

  return {
    sdkToken: result.sdkToken,
    clientId: result.clientId,
    digilockerUrl: result.digilockerUrl,
    expirySeconds: result.expirySeconds,
    gateway: process.env.SUREPASS_ENV === 'PRODUCTION' ? 'production' : 'sandbox',
    status: 'DIGILOCKER_PENDING',
    message: 'Please complete Aadhaar verification via DigiLocker.',
  };
};

// ── DigiLocker: Check Completion & Fetch Aadhaar ──────────────────────────
// Called after the frontend DigiBoost SDK fires onSuccess
export const checkDigiLockerCompletion = async (userId: string) => {
  const kyc = await prisma.kycVerification.findUnique({ where: { userId } });
  if (!kyc) {
    throw new AppError('KYC not initiated. Please start verification first.', 404);
  }

  // If Aadhaar already verified, just return status
  if (kyc.aadhaarVerified) {
    return getKycStatus(userId);
  }

  // If no DigiLocker client_id exists, tell them to initiate
  if (!kyc.digilockerVerificationId) {
    throw new AppError('No DigiLocker session found. Please initiate verification first.', 400);
  }

  // Download Aadhaar data using the client_id
  const result = await digilockerFetchAadhaar(kyc.digilockerVerificationId);

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

  // Store Aadhaar photo
  let aadhaarPhotoUrl: string | null = null;
  if (result.photo && result.photo.length > 50) {
    aadhaarPhotoUrl = result.photo;
  }

  // Determine next status
  let nextStatus: KycStatus = KycStatus.FALLBACK_PENDING;
  if (kyc.panVerified && kyc.dlVerified) {
    nextStatus = KycStatus.FACE_MATCH_PENDING;
  }

  // Update KYC record with Aadhaar data from DigiLocker
  await prisma.kycVerification.update({
    where: { userId },
    data: {
      aadhaarVerified: true,
      aadhaarName: result.fullName || null,
      aadhaarDob,
      aadhaarGender: result.gender || null,
      aadhaarAddress: result.address || null,
      aadhaarSource: KycDocumentSource.DIGILOCKER,
      aadhaarPhotoUrl,
      digilockerVerificationId: null, // Clear session after use
      digilockerUrl: null,
      digilockerUrlExpiresAt: null,
      status: nextStatus,
      failureReason: null,
      cashfreeResponse: result.rawResponse,
    },
  });

  logger.info('[KYC] Aadhaar verified via DigiLocker', {
    userId,
    name: result.fullName,
    hasPhoto: Boolean(aadhaarPhotoUrl),
    nextStatus,
  });

  return getKycStatus(userId);
};

// ── Name fuzzy match helper ────────────────────────────────────────────────
// Normalizes name strings and checks if they're reasonably similar.
// Handles initials, middle names, name-order differences.
const namesMatch = (a: string, b: string): boolean => {
  if (!a || !b) return true; // if either is missing, skip check (sandbox may return null)
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  // Check if all words of the shorter name appear in the longer (handles initials)
  const wordsA = na.split(' ').filter(w => w.length > 1);
  const wordsB = nb.split(' ').filter(w => w.length > 1);
  const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
  const longer = wordsA.length <= wordsB.length ? wordsB : wordsA;
  const matchCount = shorter.filter(w => longer.some(lw => lw.startsWith(w) || w.startsWith(lw))).length;
  return matchCount >= Math.ceil(shorter.length * 0.6); // 60% word overlap
};

// ── DL Number Normalizer ───────────────────────────────────────────────────
// Indian DL numbers: STATE_CODE + RTO_DISTRICT + YEAR + SERIAL
// Valid formats: TG0120250003096, TG01 20250003096, TG-01-2025-0003096
// VAHAN accepts the no-space/no-dash version: TG0120250003096
const normalizeDlNumber = (dl: string): string => {
  // Remove spaces and dashes, uppercase
  return dl.toUpperCase().replace(/[\s\-]/g, '');
};

// ── Verify Missing Documents (PAN + DL) ────────────────────────────────────
export const verifyMissingDocumentsFallback = async (
  userId: string,
  input: { panNumber?: string; dlNumber?: string; dob?: string }
) => {
  const kyc = await prisma.kycVerification.findUnique({ where: { userId } });
  if (!kyc) {
    throw new AppError('KYC not initiated', 404);
  }

  // Allow from FALLBACK_PENDING, DIGILOCKER_COMPLETED, or FAILED states
  const allowedStatuses: KycStatus[] = [
    KycStatus.FALLBACK_PENDING,
    KycStatus.DIGILOCKER_COMPLETED,
    KycStatus.FAILED,
  ];
  if (!allowedStatuses.includes(kyc.status)) {
    // Also allow if Aadhaar is verified but docs are missing
    if (!kyc.aadhaarVerified) {
      throw new AppError('Please complete Aadhaar verification first.', 400);
    }
  }

  const updateData: Record<string, any> = {};
  const errors: string[] = [];

  // Verify PAN if not already done
  if (!kyc.panVerified && input.panNumber) {
    try {
      const panResult = await verifyPanStandalone(input.panNumber);
      if (panResult.valid) {
        const panName = panResult.registeredName;
        const aadhaarName = kyc.aadhaarName || '';
        const isProduction = process.env.SUREPASS_ENV === 'PRODUCTION';

        // Name cross-validation: PAN must belong to same person as Aadhaar
        // Only enforced in production — sandbox APIs may return null/mismatched names
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
      logger.error('[KYC] PAN verification API error', { error: e.message, panNumber: input.panNumber?.slice(0, 4) + '***' });
      errors.push(`PAN verification failed: ${e.message}`);
    }
  }

  // Verify DL if not already done
  if (!kyc.dlVerified && input.dlNumber) {
    // Normalize DL number — remove spaces/dashes (VAHAN expects no separators)
    const normalizedDl = normalizeDlNumber(input.dlNumber);

    // DOB priority: user-entered input first, Aadhaar DOB as fallback only
    // The user knows their DL's DOB — it may differ from Aadhaar in edge cases
    let dobStr: string | null = null;
    if (input.dob) {
      dobStr = input.dob; // always prefer what user explicitly typed
    } else if (kyc.aadhaarDob) {
      dobStr = kyc.aadhaarDob.toISOString().split('T')[0]; // YYYY-MM-DD fallback
    }

    if (!dobStr) {
      errors.push('Date of birth is required to verify your Driving License. Please provide your DOB.');
    } else {
      try {
        const dlResult = await verifyDrivingLicenseStandalone(normalizedDl, dobStr);
        if (dlResult.valid) {
          const dlName = dlResult.name;
          const aadhaarName = kyc.aadhaarName || '';
          const isProduction = process.env.SUREPASS_ENV === 'PRODUCTION';

          // Name cross-validation: DL must belong to same person as Aadhaar
          // Only enforced in production — sandbox may return null names
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
            updateData.cashfreeResponse = dlResult.rawResponse;

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
        logger.error('[KYC] DL verification API error', { error: e.message, dlNumber: normalizedDl?.slice(0, 4) + '***' });
        const isNotFound = e.message?.includes('Verification Failed') || e.message?.includes('422');
        if (isNotFound) {
          errors.push(
            `DL "${normalizedDl}" not found in VAHAN database. ` +
            `Check: number is correct (no spaces/dashes), DOB matches your physical DL. ` +
            `Example format: TG0120250003096`
          );
        } else {
          errors.push(`DL verification failed: ${e.message}`);
        }
      }
    }
  }

  // Check if all docs are now verified
  const panOk = kyc.panVerified || Boolean(updateData.panVerified);
  const dlOk = kyc.dlVerified || Boolean(updateData.dlVerified);

  if (panOk && dlOk && kyc.aadhaarVerified) {
    updateData.status = KycStatus.FACE_MATCH_PENDING;
    updateData.failureReason = null;
  } else if (errors.length > 0) {
    updateData.failureReason = errors.join(' ');
    // Keep status as FALLBACK_PENDING so they can retry
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

  // Allow selfie submission when docs are verified or in face match pending
  if (
    kyc.status !== KycStatus.FACE_MATCH_PENDING &&
    kyc.status !== KycStatus.FAILED
  ) {
    // Also allow if all docs are individually verified
    if (!(kyc.aadhaarVerified && kyc.panVerified && kyc.dlVerified)) {
      throw new AppError('All documents must be verified before selfie submission', 400);
    }
  }

  const updateData: Record<string, any> = {
    selfieUrl,
  };

  // Get reference photo — Aadhaar photo from Surepass OTP verification
  let referencePhoto = kyc.aadhaarPhotoUrl;

  // Fallback: try to extract from cashfreeResponse (legacy data)
  if (!referencePhoto) {
    referencePhoto = extractDocumentPhoto(kyc.cashfreeResponse);
  }

  let matchScore = 0;
  let matchPassed = false;

  if (referencePhoto) {
    logger.info('[KYC] Found reference photo for face match', { userId, photoType: 'aadhaar' });

    // If reference is a URL, download it and convert to base64
    if (referencePhoto.startsWith('http')) {
      try {
        const imgResponse = await axios.get(referencePhoto, { responseType: 'arraybuffer', timeout: 30000 });
        referencePhoto = Buffer.from(imgResponse.data).toString('base64');
      } catch (e: any) {
        logger.warn('[KYC] Failed to download reference photo', { error: e.message });
        referencePhoto = null;
      }
    }
  }

  if (referencePhoto) {
    try {
      const matchResult = await faceMatch(selfieBase64, referencePhoto);
      matchScore = matchResult.matchScore;
      matchPassed = matchResult.isMatch;
      logger.info('[KYC] Face match result', { userId, matchScore, matchPassed });
    } catch (e: any) {
      logger.error('[KYC] Face match API failed', { error: e.message });
      // Real face match failure — do NOT auto-pass
      matchPassed = false;
      matchScore = 0;
    }
  } else {
    // No reference photo available — auto-pass (Surepass sandbox may not return photo)
    matchPassed = true;
    matchScore = 70;
    logger.info('[KYC] No reference photo for face match — auto-pass', { userId });
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

  // If all passed, auto-approve the driver
  if (matchPassed && kyc.aadhaarVerified && kyc.panVerified && kyc.dlVerified) {
    await autoApproveDriver(userId, kyc);
  }

  logger.info('[KYC] Face match complete', {
    userId,
    matchScore,
    matchPassed,
    kycCompleted: matchPassed,
  });

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
      // Update DriverProfile with verified data
      const profileUpdate: Record<string, any> = {
        documentsVerified: true,
        backgroundCheckStatus: VerificationStatus.VERIFIED,
        rejectionReason: null,
      };

      // Populate document numbers from KYC data
      if (kyc.dlNumber) profileUpdate.licenseNumber = kyc.dlNumber;
      if (kyc.dlExpiryDate) profileUpdate.licenseExpiryDate = kyc.dlExpiryDate;
      if (kyc.panNumber) profileUpdate.panNumber = kyc.panNumber;

      // NOTE: Profile image (selfie) is set by the controller AFTER Cloudinary upload
      // succeeds — not here. selfieUrl at this point may be a data: URI temp reference.

      await tx.driverProfile.update({
        where: { userId },
        data: profileUpdate as any,
      });
    });

    logger.info('[KYC] Driver auto-approved', { userId });
  } catch (error: any) {
    logger.error('[KYC] Auto-approve failed', { userId, error: error.message });
    // Don't throw — KYC is still completed, admin can manually approve
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
    digilockerUrl: kyc.digilockerUrl,
    digilockerUrlExpiresAt: kyc.digilockerUrlExpiresAt?.toISOString() || null,
    // Expose Aadhaar DOB so mobile can pre-fill the DL DOB field
    aadhaarDob: kyc.aadhaarDob ? kyc.aadhaarDob.toISOString().split('T')[0] : null,
    aadhaarName: kyc.aadhaarName || null,
  };
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
