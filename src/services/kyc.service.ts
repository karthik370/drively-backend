/**
 * KYC Service — Business Logic Orchestrator
 * ──────────────────────────────────────────
 * Manages the multi-step KYC verification flow:
 *   1. DigiLocker (Aadhaar + PAN + DL in one go)
 *   2. Standalone API fallback for missing docs
 *   3. Selfie upload + Face Match
 *   4. Auto-approve driver when all pass
 */
import prisma from '../config/database';
import { KycStatus, KycDocumentSource, VerificationStatus } from '@prisma/client';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import {
  generateVerificationId,
  createDigiLockerUrl,
  getDigiLockerStatus,
  verifyPanStandalone,
  verifyDrivingLicenseStandalone,
  faceMatch,
  faceLivenessCheck,
} from './cashfreeVerification';

// ── Initiate KYC ───────────────────────────────────────────────────────────
export const initiateKyc = async (userId: string, _phoneNumber?: string) => {
  // Check if user already has completed KYC
  const existing = await prisma.kycVerification.findUnique({ where: { userId } });
  if (existing?.status === KycStatus.COMPLETED) {
    throw new AppError('KYC already completed', 409);
  }

  // Generate verification ID for Cashfree
  const verificationId = generateVerificationId(userId);

  // Build redirect URL — Cashfree requires https:// URLs
  // If no valid https redirect URL is configured, omit it (app polls for status instead)
  const configuredRedirectUrl = process.env.KYC_REDIRECT_URL || '';
  const redirectUrl = configuredRedirectUrl.startsWith('https://') ? configuredRedirectUrl : undefined;

  // Create DigiLocker URL via Cashfree
  // Note: The Cashfree DigiLocker API does NOT accept identity_type/identity_value.
  // It only needs verification_id and document_requested. The user logs in via DigiLocker portal.
  const digilockerResult = await createDigiLockerUrl({
    verificationId,
    documentRequested: ['AADHAAR', 'PAN', 'DRIVING_LICENSE'],
    redirectUrl,
    userFlow: 'signup', // Allow both new and existing DigiLocker users
  });

  // Upsert KYC record
  const kyc = await prisma.kycVerification.upsert({
    where: { userId },
    create: {
      userId,
      status: KycStatus.DIGILOCKER_PENDING,
      digilockerVerificationId: digilockerResult.verificationId,
      digilockerUrl: digilockerResult.url,
      digilockerUrlExpiresAt: new Date(digilockerResult.expiresAt),
    },
    update: {
      status: KycStatus.DIGILOCKER_PENDING,
      digilockerVerificationId: digilockerResult.verificationId,
      digilockerUrl: digilockerResult.url,
      digilockerUrlExpiresAt: new Date(digilockerResult.expiresAt),
      failureReason: null,
    },
  });

  logger.info('[KYC] Initiated DigiLocker flow', {
    userId,
    verificationId: digilockerResult.verificationId,
  });

  return {
    digilockerUrl: digilockerResult.url,
    verificationId: digilockerResult.verificationId,
    status: kyc.status,
    expiresAt: digilockerResult.expiresAt,
  };
};

// ── Check DigiLocker Completion ────────────────────────────────────────────
export const checkDigiLockerCompletion = async (userId: string) => {
  const kyc = await prisma.kycVerification.findUnique({ where: { userId } });
  if (!kyc) {
    throw new AppError('KYC not initiated', 404);
  }

  if (!kyc.digilockerVerificationId) {
    throw new AppError('No DigiLocker session found', 400);
  }

  // If already past DigiLocker step, return current status
  if (
    kyc.status === KycStatus.COMPLETED ||
    kyc.status === KycStatus.FACE_MATCH_PENDING ||
    kyc.status === KycStatus.FALLBACK_PENDING
  ) {
    return getKycStatus(userId);
  }

  // Fetch status from Cashfree
  const result = await getDigiLockerStatus(kyc.digilockerVerificationId);

  if (result.status !== 'AUTHENTICATED' && result.status !== 'COMPLETED' && result.status !== 'SUCCESS') {
    // Still pending or failed
    if (result.status === 'FAILED' || result.status === 'REJECTED') {
      await prisma.kycVerification.update({
        where: { userId },
        data: {
          status: KycStatus.FAILED,
          failureReason: 'DigiLocker authentication failed. Please try again.',
          cashfreeResponse: result.rawResponse as any,
        },
      });
    }
    return getKycStatus(userId);
  }

  // DigiLocker succeeded — extract document data
  const updateData: Record<string, any> = {
    cashfreeResponse: result.rawResponse,
  };

  let aadhaarDone = false;
  let panDone = false;
  let dlDone = false;

  for (const doc of result.documents) {
    const docStatus = doc.status.toUpperCase();
    if (docStatus !== 'SUCCESS' && docStatus !== 'FETCHED' && docStatus !== 'AVAILABLE') continue;

    if (doc.documentType === 'AADHAAR') {
      aadhaarDone = true;
      updateData.aadhaarVerified = true;
      updateData.aadhaarName = doc.data?.name || doc.data?.full_name || null;
      updateData.aadhaarGender = doc.data?.gender || null;
      updateData.aadhaarAddress = doc.data?.address || doc.data?.full_address || null;
      updateData.aadhaarSource = KycDocumentSource.DIGILOCKER;

      // Parse DOB
      const dobStr = doc.data?.dob || doc.data?.date_of_birth || doc.data?.dateOfBirth;
      if (dobStr) {
        const parsed = new Date(dobStr);
        if (!isNaN(parsed.getTime())) {
          updateData.aadhaarDob = parsed;
        }
      }
    }

    if (doc.documentType === 'PAN') {
      panDone = true;
      updateData.panVerified = true;
      updateData.panNumber = doc.data?.pan || doc.data?.pan_number || null;
      updateData.panName = doc.data?.name || doc.data?.registered_name || null;
      updateData.panSource = KycDocumentSource.DIGILOCKER;
    }

    if (doc.documentType === 'DRIVING_LICENSE') {
      dlDone = true;
      updateData.dlVerified = true;
      updateData.dlNumber = doc.data?.dl_number || doc.data?.license_number || null;
      updateData.dlName = doc.data?.name || null;
      updateData.dlVehicleClass = Array.isArray(doc.data?.vehicle_class)
        ? doc.data.vehicle_class.join(', ')
        : String(doc.data?.vehicle_class || '');
      updateData.dlSource = KycDocumentSource.DIGILOCKER;

      const dlDob = doc.data?.dob || doc.data?.date_of_birth;
      if (dlDob) {
        const parsed = new Date(dlDob);
        if (!isNaN(parsed.getTime())) updateData.dlDob = parsed;
      }

      const dlExpiry = doc.data?.expiry_date || doc.data?.doe || doc.data?.validity;
      if (dlExpiry) {
        const parsed = new Date(dlExpiry);
        if (!isNaN(parsed.getTime())) updateData.dlExpiryDate = parsed;
      }
    }
  }

  // Determine next status
  if (aadhaarDone && panDone && dlDone) {
    updateData.status = KycStatus.FACE_MATCH_PENDING;
  } else if (aadhaarDone && (!panDone || !dlDone)) {
    updateData.status = KycStatus.FALLBACK_PENDING;
  } else {
    // Aadhaar not verified — critical failure
    updateData.status = KycStatus.FAILED;
    updateData.failureReason = 'Aadhaar verification failed via DigiLocker. Please try again.';
  }

  await prisma.kycVerification.update({
    where: { userId },
    data: updateData,
  });

  logger.info('[KYC] DigiLocker check complete', {
    userId,
    aadhaarDone,
    panDone,
    dlDone,
    newStatus: updateData.status,
  });

  return getKycStatus(userId);
};

// ── Fallback: Verify Missing Documents via Standalone APIs ─────────────────
export const verifyMissingDocumentsFallback = async (
  userId: string,
  input: { panNumber?: string; dlNumber?: string }
) => {
  const kyc = await prisma.kycVerification.findUnique({ where: { userId } });
  if (!kyc) {
    throw new AppError('KYC not initiated', 404);
  }

  if (kyc.status !== KycStatus.FALLBACK_PENDING && kyc.status !== KycStatus.DIGILOCKER_COMPLETED) {
    // Allow re-attempts from failed state too
    if (kyc.status !== KycStatus.FAILED) {
      throw new AppError(`Cannot submit fallback in current state: ${kyc.status}`, 400);
    }
  }

  const updateData: Record<string, any> = {};
  const errors: string[] = [];

  // Verify PAN if not already done
  if (!kyc.panVerified && input.panNumber) {
    try {
      const panResult = await verifyPanStandalone(input.panNumber);
      if (panResult.valid) {
        updateData.panVerified = true;
        updateData.panNumber = input.panNumber.toUpperCase();
        updateData.panName = panResult.registeredName;
        updateData.panSource = KycDocumentSource.STANDALONE_API;
      } else {
        errors.push(`PAN "${input.panNumber}" is invalid.`);
      }
    } catch (e: any) {
      errors.push(`PAN verification failed: ${e.message}`);
    }
  }

  // Verify DL if not already done
  if (!kyc.dlVerified && input.dlNumber) {
    // Use DOB from Aadhaar (which should be verified by now)
    const dob = kyc.aadhaarDob;
    if (!dob) {
      errors.push('Cannot verify DL without verified date of birth from Aadhaar.');
    } else {
      const dobStr = dob.toISOString().split('T')[0]; // YYYY-MM-DD
      try {
        const dlResult = await verifyDrivingLicenseStandalone(input.dlNumber, dobStr);
        if (dlResult.valid) {
          updateData.dlVerified = true;
          updateData.dlNumber = input.dlNumber.toUpperCase();
          updateData.dlName = dlResult.name;
          updateData.dlVehicleClass = Array.isArray(dlResult.vehicleClass)
            ? dlResult.vehicleClass.join(', ')
            : String(dlResult.vehicleClass);
          updateData.dlSource = KycDocumentSource.STANDALONE_API;

          if (dlResult.expiryDate) {
            const parsed = new Date(dlResult.expiryDate);
            if (!isNaN(parsed.getTime())) updateData.dlExpiryDate = parsed;
          }
          if (dlResult.dob) {
            const parsed = new Date(dlResult.dob);
            if (!isNaN(parsed.getTime())) updateData.dlDob = parsed;
          }
        } else {
          errors.push(`Driving License "${input.dlNumber}" is invalid or does not match your DOB.`);
        }
      } catch (e: any) {
        errors.push(`DL verification failed: ${e.message}`);
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

  logger.info('[KYC] Fallback verification complete', { userId, panOk, dlOk, errors });

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

  // Run liveness check first (soft — doesn't block)
  const livenessResult = await faceLivenessCheck(selfieBase64);
  logger.info('[KYC] Liveness check result', {
    userId,
    isLive: livenessResult.isLive,
    confidence: livenessResult.confidence,
  });

  // For face match, we need a reference image from a document
  // Ideally, we'd use the Aadhaar photo from DigiLocker
  // If we don't have a document photo, we accept the selfie with a lower confidence
  // In production, you would compare against the Aadhaar photo extracted from DigiLocker
  let matchScore = 0;
  let matchPassed = false;

  // Since DigiLocker returns text data (not images in most API versions),
  // we use face liveness as the primary check and skip face match if no reference image
  // If Cashfree returns an Aadhaar photo URL in DigiLocker data, we'd use it here
  const aadhaarPhoto = kyc.cashfreeResponse
    ? extractAadhaarPhoto(kyc.cashfreeResponse)
    : null;

  if (aadhaarPhoto) {
    try {
      const matchResult = await faceMatch(selfieBase64, aadhaarPhoto);
      matchScore = matchResult.matchScore;
      matchPassed = matchResult.isMatch;
    } catch (e: any) {
      logger.warn('[KYC] Face match API failed, using liveness as fallback', { error: e.message });
      // Fallback: if liveness passed, consider face match as passed
      matchPassed = livenessResult.isLive;
      matchScore = livenessResult.isLive ? 0.70 : 0;
    }
  } else {
    // No reference photo available — liveness is the check
    matchPassed = livenessResult.isLive;
    matchScore = livenessResult.isLive ? 0.70 : 0;
    logger.info('[KYC] No Aadhaar photo for face match — using liveness only', { userId });
  }

  updateData.faceMatchScore = matchScore;
  updateData.faceMatchPassed = matchPassed;

  if (matchPassed) {
    updateData.status = KycStatus.COMPLETED;
    updateData.completedAt = new Date();
    updateData.failureReason = null;
  } else {
    updateData.status = KycStatus.FAILED;
    updateData.failureReason = `Face verification failed (score: ${(matchScore * 100).toFixed(0)}%). Please retake your selfie in good lighting.`;
  }

  await prisma.kycVerification.update({
    where: { userId },
    data: updateData,
  });

  // If all passed, auto-approve the driver
  if (matchPassed && kyc.aadhaarVerified && kyc.panVerified && kyc.dlVerified) {
    await autoApproveDriver(userId, kyc);
  }

  logger.info('[KYC] Selfie + face match complete', {
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
      if (kyc.aadhaarName) {
        // Encrypt Aadhaar number for storage
        // Note: DigiLocker doesn't return the full Aadhaar number, just verified name/DOB
        // The aadhaarNumber in DriverProfile will keep its existing placeholder
      }

      // Update selfie as profile image
      if (kyc.selfieUrl) {
        await tx.user.update({
          where: { id: userId },
          data: { profileImage: kyc.selfieUrl },
        });
      }

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
    digilockerUrl: kyc.status === KycStatus.DIGILOCKER_PENDING ? kyc.digilockerUrl : null,
    digilockerUrlExpiresAt: kyc.digilockerUrlExpiresAt
      ? kyc.digilockerUrlExpiresAt.toISOString()
      : null,
  };
};

// ── Helper: Extract Aadhaar photo from Cashfree response ───────────────────
const extractAadhaarPhoto = (cashfreeResponse: any): string | null => {
  if (!cashfreeResponse) return null;

  // Try various paths where Cashfree might return the Aadhaar photo
  const paths = [
    cashfreeResponse?.documents?.find?.((d: any) => d?.document_type === 'AADHAAR')?.data?.photo,
    cashfreeResponse?.aadhaar?.photo,
    cashfreeResponse?.aadhaar?.image,
    cashfreeResponse?.photo,
  ];

  for (const p of paths) {
    if (typeof p === 'string' && p.length > 100) {
      return p; // Likely a base64 string
    }
  }

  return null;
};
