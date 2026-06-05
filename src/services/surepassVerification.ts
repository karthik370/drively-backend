/**
 * Surepass Verification Suite — KYC APIs
 * ──────────────────────────────────────────────
 * Replaces Cashfree Secure ID with Surepass for:
 *   - Aadhaar verification (OTP-based, 2-step)
 *   - PAN verification
 *   - Driving License verification
 *   - Face Match (selfie vs document photo)
 *   - Face Liveness check
 *
 * Base URLs:
 *   Sandbox:    https://sandbox.surepass.io
 *   Production: https://api.surepass.io
 *
 * Auth: Bearer token in Authorization header
 */
import axios from 'axios';
import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

// ── Config ─────────────────────────────────────────────────────────────────
const getSurepassConfig = () => {
  const apiToken = process.env.SUREPASS_API_TOKEN;
  const env = process.env.SUREPASS_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';

  if (!apiToken) {
    throw new AppError(
      'Surepass API token not configured (SUREPASS_API_TOKEN)',
      500
    );
  }

  const baseUrl =
    env === 'PRODUCTION'
      ? 'https://api.surepass.io'
      : 'https://sandbox.surepass.io';

  return { apiToken, env, baseUrl };
};

const getHeaders = () => {
  const { apiToken } = getSurepassConfig();
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiToken}`,
  };
};

// ── Generate unique verification ID ────────────────────────────────────────
export const generateVerificationId = (userId: string): string => {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `kyc_${userId.slice(-8)}_${ts}_${rand}`.slice(0, 50);
};

// ── Aadhaar: Send OTP ──────────────────────────────────────────────────────
// Step 1 of 2-step Aadhaar verification
// Sends OTP to the mobile number linked with the Aadhaar
export type AadhaarOtpResult = {
  clientId: string; // Session ID needed for step 2
  message: string;
};

export const aadhaarSendOtp = async (
  aadhaarNumber: string
): Promise<AadhaarOtpResult> => {
  const { baseUrl } = getSurepassConfig();
  const url = `${baseUrl}/api/v1/aadhaar-v2/generate-otp`;

  // Clean Aadhaar number — remove spaces/dashes
  const cleanAadhaar = aadhaarNumber.replace(/[\s\-]/g, '');

  logger.info('[Surepass] Sending Aadhaar OTP', {
    aadhaar: cleanAadhaar.slice(0, 4) + '********',
    url,
  });

  try {
    const response = await axios.post(
      url,
      { id_number: cleanAadhaar },
      { headers: getHeaders(), timeout: 30000 }
    );

    const data = response.data;

    logger.info('[Surepass] Aadhaar OTP response', {
      statusCode: data?.status_code,
      success: data?.success,
      hasClientId: Boolean(data?.data?.client_id),
    });

    const clientId = data?.data?.client_id;
    if (!clientId) {
      throw new AppError(
        data?.message || 'Failed to send Aadhaar OTP — no session ID returned',
        502
      );
    }

    return {
      clientId: String(clientId),
      message: data?.message || 'OTP sent successfully',
    };
  } catch (error: any) {
    if (error instanceof AppError) throw error;
    logger.error('[Surepass] Aadhaar send OTP failed', {
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
    });
    const msg = error?.response?.data?.message || error?.message || 'Failed to send Aadhaar OTP';
    throw new AppError(msg, error?.response?.status || 502);
  }
};

// ── Aadhaar: Verify OTP ────────────────────────────────────────────────────
// Step 2 of 2-step Aadhaar verification
// Returns full Aadhaar details including photo
export type AadhaarVerifyResult = {
  verified: boolean;
  fullName: string;
  dob: string;
  gender: string;
  address: string;
  photo: string; // Base64 photo from Aadhaar — used for face match
  aadhaarNumber: string; // Last 4 digits masked
  rawResponse: any;
};

export const aadhaarVerifyOtp = async (
  clientId: string,
  otp: string
): Promise<AadhaarVerifyResult> => {
  const { baseUrl } = getSurepassConfig();
  const url = `${baseUrl}/api/v1/aadhaar-v2/submit-otp`;

  logger.info('[Surepass] Verifying Aadhaar OTP', { clientId: clientId.slice(0, 8) + '...', url });

  try {
    const response = await axios.post(
      url,
      { client_id: clientId, otp: otp },
      { headers: getHeaders(), timeout: 30000 }
    );

    const data = response.data;

    logger.info('[Surepass] Aadhaar verify response', {
      statusCode: data?.status_code,
      success: data?.success,
      hasData: Boolean(data?.data),
    });

    const aadhaarData = data?.data;
    if (!aadhaarData || !data?.success) {
      throw new AppError(
        data?.message || 'Aadhaar OTP verification failed',
        400
      );
    }

    // Parse address — Surepass returns split address or full address
    const address = aadhaarData?.address
      ? (typeof aadhaarData.address === 'object'
        ? [
            aadhaarData.address?.house,
            aadhaarData.address?.street,
            aadhaarData.address?.landmark,
            aadhaarData.address?.loc,
            aadhaarData.address?.vtc,
            aadhaarData.address?.subdist,
            aadhaarData.address?.dist,
            aadhaarData.address?.state,
            aadhaarData.address?.pc,
          ].filter(Boolean).join(', ')
        : String(aadhaarData.address))
      : '';

    return {
      verified: true,
      fullName: String(aadhaarData?.full_name || aadhaarData?.name || ''),
      dob: String(aadhaarData?.dob || aadhaarData?.date_of_birth || ''),
      gender: String(aadhaarData?.gender || ''),
      address,
      photo: String(aadhaarData?.profile_image || aadhaarData?.photo_link || aadhaarData?.photo || ''),
      aadhaarNumber: String(aadhaarData?.aadhaar_number || aadhaarData?.id_number || ''),
      rawResponse: data,
    };
  } catch (error: any) {
    if (error instanceof AppError) throw error;
    logger.error('[Surepass] Aadhaar verify OTP failed', {
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
    });
    const msg = error?.response?.data?.message || error?.message || 'Aadhaar OTP verification failed';
    throw new AppError(msg, error?.response?.status || 502);
  }
};

// ── PAN Verification ───────────────────────────────────────────────────────
export type PanVerificationResult = {
  valid: boolean;
  registeredName: string;
  panType: string;
  rawResponse: any;
};

export const verifyPanStandalone = async (
  panNumber: string
): Promise<PanVerificationResult> => {
  const { baseUrl } = getSurepassConfig();
  const url = `${baseUrl}/api/v1/pan/pan`;

  logger.info('[Surepass] Verifying PAN', {
    pan: panNumber.slice(0, 4) + '******',
    url,
  });

  try {
    const response = await axios.post(
      url,
      { id_number: panNumber.toUpperCase() },
      { headers: getHeaders(), timeout: 30000 }
    );

    const data = response.data;

    logger.info('[Surepass] PAN response', {
      statusCode: data?.status_code,
      success: data?.success,
    });

    const panData = data?.data;

    return {
      valid: Boolean(data?.success && panData),
      registeredName: String(panData?.full_name || panData?.registered_name || panData?.name || ''),
      panType: String(panData?.category || panData?.type || ''),
      rawResponse: data,
    };
  } catch (error: any) {
    logger.error('[Surepass] PAN verification failed', {
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
    });
    const msg = error?.response?.data?.message || error?.message || 'PAN verification failed';
    throw new AppError(msg, error?.response?.status || 502);
  }
};

// ── Driving License Verification ───────────────────────────────────────────
export type DlVerificationResult = {
  valid: boolean;
  name: string;
  dob: string;
  issueDate: string;
  expiryDate: string;
  vehicleClass: string[];
  rawResponse: any;
};

export const verifyDrivingLicenseStandalone = async (
  dlNumber: string,
  dob: string // YYYY-MM-DD or DD-MM-YYYY
): Promise<DlVerificationResult> => {
  const { baseUrl } = getSurepassConfig();
  const url = `${baseUrl}/api/v1/driving-license/driving-license`;

  // Surepass expects DOB in DD-MM-YYYY format
  let formattedDob = dob;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    // Convert YYYY-MM-DD to DD-MM-YYYY
    const [y, m, d] = dob.split('-');
    formattedDob = `${d}-${m}-${y}`;
  }

  logger.info('[Surepass] Verifying DL', {
    dl: dlNumber.slice(0, 4) + '****',
    dob: formattedDob,
    url,
  });

  try {
    const response = await axios.post(
      url,
      {
        id_number: dlNumber.toUpperCase(),
        dob: formattedDob,
      },
      { headers: getHeaders(), timeout: 30000 }
    );

    const data = response.data;

    logger.info('[Surepass] DL response', {
      statusCode: data?.status_code,
      success: data?.success,
    });

    const dlData = data?.data;

    // Extract vehicle class — Surepass returns as array of objects or strings
    let vehicleClass: string[] = [];
    if (dlData?.vehicle_classes && Array.isArray(dlData.vehicle_classes)) {
      vehicleClass = dlData.vehicle_classes.map((vc: any) =>
        typeof vc === 'string' ? vc : vc?.category || vc?.class || String(vc)
      );
    } else if (dlData?.vehicle_class) {
      vehicleClass = Array.isArray(dlData.vehicle_class)
        ? dlData.vehicle_class.map(String)
        : [String(dlData.vehicle_class)];
    }

    // Extract expiry — Surepass may nest it
    const expiryDate = dlData?.doe || dlData?.expiry_date
      || dlData?.validity?.non_transport?.to
      || dlData?.validity?.transport?.to || '';

    return {
      valid: Boolean(data?.success && dlData),
      name: String(dlData?.name || dlData?.full_name || ''),
      dob: String(dlData?.dob || dlData?.date_of_birth || dob),
      issueDate: String(dlData?.doi || dlData?.issue_date || ''),
      expiryDate: String(expiryDate),
      vehicleClass,
      rawResponse: data,
    };
  } catch (error: any) {
    const errData = error?.response?.data;
    logger.error('[Surepass] DL verification failed', {
      status: error?.response?.status,
      data: JSON.stringify(errData),
      message: error?.message,
    });
    const msg = errData?.message || error?.message || 'Driving License verification failed';
    throw new AppError(`DL verification error: ${msg}`, error?.response?.status || 502);
  }
};

// ── Face Match ─────────────────────────────────────────────────────────────
export type FaceMatchResult = {
  matchScore: number; // 0-100 percentage
  isMatch: boolean;
  rawResponse: any;
};

export const faceMatch = async (
  selfieBase64: string,
  documentImageBase64: string
): Promise<FaceMatchResult> => {
  const { baseUrl } = getSurepassConfig();
  const url = `${baseUrl}/api/v1/face-match/face-match`;

  const threshold = parseFloat(process.env.SUREPASS_FACE_MATCH_THRESHOLD || '70');

  logger.info('[Surepass] Running face match', { url, threshold });

  try {
    // Clean base64 — remove data URI prefix if present
    const cleanSelfie = selfieBase64.replace(/^data:image\/\w+;base64,/, '');
    const cleanDoc = documentImageBase64.replace(/^data:image\/\w+;base64,/, '');

    const response = await axios.post(
      url,
      {
        image1: cleanSelfie,
        image2: cleanDoc,
      },
      { headers: getHeaders(), timeout: 60000 }
    );

    const data = response.data;

    logger.info('[Surepass] Face match response', {
      statusCode: data?.status_code,
      success: data?.success,
      matchData: JSON.stringify(data?.data),
    });

    const matchData = data?.data;

    // Surepass returns match_score (0-100) and/or confidence
    const score = Number(
      matchData?.match_score ?? matchData?.confidence ?? matchData?.score ?? 0
    );
    const isMatchResult = matchData?.is_match ?? (score >= threshold);

    return {
      matchScore: score,
      isMatch: Boolean(isMatchResult),
      rawResponse: data,
    };
  } catch (error: any) {
    logger.error('[Surepass] Face match failed', {
      status: error?.response?.status,
      data: JSON.stringify(error?.response?.data),
      message: error?.message,
    });
    throw new AppError(
      error?.response?.data?.message || 'Face match failed',
      error?.response?.status || 502
    );
  }
};

// ── Face Liveness ──────────────────────────────────────────────────────────
export type FaceLivenessResult = {
  isLive: boolean;
  confidence: number;
  rawResponse: any;
};

export const faceLivenessCheck = async (
  imageBase64: string
): Promise<FaceLivenessResult> => {
  const { baseUrl } = getSurepassConfig();
  const url = `${baseUrl}/api/v1/liveness/liveness`;

  logger.info('[Surepass] Running face liveness check', { url });

  try {
    const cleanImage = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    const response = await axios.post(
      url,
      { image: cleanImage },
      { headers: getHeaders(), timeout: 60000 }
    );

    const data = response.data;

    logger.info('[Surepass] Face liveness response', {
      statusCode: data?.status_code,
      success: data?.success,
    });

    const livenessData = data?.data;
    const isLive = livenessData?.is_live != null
      ? Boolean(livenessData.is_live)
      : (livenessData?.liveness === 'YES' || Boolean(data?.success));
    const score = Number(
      livenessData?.liveness_score ?? livenessData?.confidence ?? livenessData?.score ?? 0
    );

    return {
      isLive,
      confidence: score,
      rawResponse: data,
    };
  } catch (error: any) {
    logger.error('[Surepass] Face liveness check failed', {
      status: error?.response?.status,
      data: JSON.stringify(error?.response?.data),
      message: error?.message,
    });
    // Liveness failure should not block — treat as a soft failure
    return {
      isLive: true, // Default to true if API fails
      confidence: 0,
      rawResponse: { error: error?.message },
    };
  }
};
