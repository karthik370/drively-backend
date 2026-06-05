/**
 * Surepass Verification Suite — KYC APIs
 * ──────────────────────────────────────────────
 * Uses Surepass for:
 *   - Aadhaar verification (via DigiLocker consent flow)
 *   - PAN verification (standalone API)
 *   - Driving License verification (standalone API)
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

// ══════════════════════════════════════════════════════════════════════════
// ── DigiLocker Verification (via Surepass DigiBoost SDK) ──────────────────
// ══════════════════════════════════════════════════════════════════════════
// Flow (from official Surepass DigiBoost Web SDK):
//   1. Backend calls POST /api/v1/digilocker/initialize → gets { client_id, token }
//   2. Frontend loads DigiBoost SDK with that token → opens DigiLocker popup
//   3. User consents in popup → SDK fires onSuccess callback
//   4. Backend calls GET /api/v1/digilocker/download-aadhaar/{client_id} → gets Aadhaar XML data
//
// IMPORTANT: DigiLocker uses a DIFFERENT domain: sandbox.surepass.app (not sandbox.surepass.io)

const getDigiLockerBaseUrl = () => {
  const env = process.env.SUREPASS_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';
  return env === 'PRODUCTION'
    ? 'https://kyc-api.surepass.app'
    : 'https://sandbox.surepass.app';
};

export type DigiLockerSessionResult = {
  clientId: string;    // Used to download Aadhaar later
  sdkToken: string;    // JWT token (for web SDK usage)
  digilockerUrl: string; // Direct URL to open in WebView
  expirySeconds: number;
};

/**
 * Step 1: Initialize a DigiLocker session.
 * Returns a client_id, SDK token, and a direct URL for the DigiLocker consent flow.
 * The URL can be loaded directly in a mobile WebView.
 */
export const digilockerCreateSession = async (
  _redirectUrl?: string
): Promise<DigiLockerSessionResult> => {
  const baseUrl = getDigiLockerBaseUrl();
  const url = `${baseUrl}/api/v1/digilocker/initialize`;

  logger.info('[Surepass] Initializing DigiLocker session', { url });

  try {
    const response = await axios.post(
      url,
      {
        data: {
          signup_flow: true,
          skip_main_screen: false,
        },
      },
      { headers: getHeaders(), timeout: 30000 }
    );

    const data = response.data;

    logger.info('[Surepass] DigiLocker initialize response', {
      statusCode: data?.status_code,
      success: data?.success,
      hasToken: Boolean(data?.data?.token),
      hasClientId: Boolean(data?.data?.client_id),
      hasUrl: Boolean(data?.data?.url),
      expirySeconds: data?.data?.expiry_seconds,
      rawKeys: data?.data ? Object.keys(data.data) : [],
      digilockerUrl: data?.data?.url ? data.data.url.slice(0, 80) + '...' : null,
    });

    const clientId = data?.data?.client_id;
    const sdkToken = data?.data?.token;
    const digilockerUrl = data?.data?.url;
    const expirySeconds = data?.data?.expiry_seconds || 600;

    if (!clientId || !sdkToken) {
      throw new AppError(
        data?.message || 'Failed to initialize DigiLocker — missing client_id or token',
        502
      );
    }

    return {
      clientId: String(clientId),
      sdkToken: String(sdkToken),
      digilockerUrl: digilockerUrl ? String(digilockerUrl) : '',
      expirySeconds: Number(expirySeconds),
    };
  } catch (error: any) {
    if (error instanceof AppError) throw error;
    logger.error('[Surepass] DigiLocker initialize failed', {
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
    });
    const msg = error?.response?.data?.message || error?.message || 'Failed to initialize DigiLocker';
    throw new AppError(msg, error?.response?.status || 502);
  }
};

export type DigiLockerAadhaarResult = {
  verified: boolean;
  fullName: string;
  dob: string;
  gender: string;
  address: string;
  photo: string; // Base64 profile_image from Aadhaar XML — used for face match
  aadhaarNumber: string; // Masked (XXXXXXXX1234)
  rawResponse: any;
};

/**
 * Step 2: Download Aadhaar XML data after DigiLocker verification is complete.
 * Called after the frontend SDK fires onSuccess.
 */
export const digilockerFetchAadhaar = async (
  clientId: string
): Promise<DigiLockerAadhaarResult> => {
  const baseUrl = getDigiLockerBaseUrl();
  const url = `${baseUrl}/api/v1/digilocker/download-aadhaar/${clientId}`;

  logger.info('[Surepass] Downloading Aadhaar from DigiLocker', { clientId: clientId.slice(0, 20) + '...' });

  try {
    const response = await axios.get(url, {
      headers: getHeaders(),
      timeout: 30000,
    });

    const data = response.data;

    logger.info('[Surepass] DigiLocker Aadhaar download response', {
      statusCode: data?.status_code,
      success: data?.success,
      hasData: Boolean(data?.data),
      dataKeys: data?.data ? Object.keys(data.data) : [],
    });

    if (!data?.success || !data?.data) {
      throw new AppError(
        data?.message || 'Failed to download Aadhaar data from DigiLocker',
        400
      );
    }

    // Aadhaar data can be in data.aadhaar_xml_data or data directly
    const aadhaarData = data.data.aadhaar_xml_data || data.data;
    const metadata = data.data.digilocker_metadata || {};

    // Parse address — structured object from Aadhaar XML
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
            aadhaarData.address?.po,
            aadhaarData.address?.state,
            aadhaarData.address?.country,
          ].filter(Boolean).join(', ')
        : String(aadhaarData.address))
      : (aadhaarData?.full_address || '');

    return {
      verified: true,
      fullName: String(aadhaarData?.full_name || metadata?.name || ''),
      dob: String(aadhaarData?.dob || metadata?.dob || ''),
      gender: String(aadhaarData?.gender || metadata?.gender || ''),
      address,
      photo: String(aadhaarData?.profile_image || ''),
      aadhaarNumber: String(aadhaarData?.masked_aadhaar || ''),
      rawResponse: data,
    };
  } catch (error: any) {
    if (error instanceof AppError) throw error;
    logger.error('[Surepass] DigiLocker Aadhaar download failed', {
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
    });
    const msg = error?.response?.data?.message || error?.message || 'Failed to download Aadhaar from DigiLocker';
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

  // Surepass DL API expects DOB in YYYY-MM-DD format
  let formattedDob = dob;
  if (/^\d{2}-\d{2}-\d{4}$/.test(dob)) {
    // Convert DD-MM-YYYY to YYYY-MM-DD
    const [d, m, y] = dob.split('-');
    formattedDob = `${y}-${m}-${d}`;
  } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dob)) {
    // Convert DD/MM/YYYY to YYYY-MM-DD
    const [d, m, y] = dob.split('/');
    formattedDob = `${y}-${m}-${d}`;
  }

  // Validate the date is real
  const parsedDate = new Date(formattedDob);
  if (isNaN(parsedDate.getTime())) {
    throw new AppError(`Invalid date of birth: ${dob}`, 400);
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
  matchScore: number; // 0-100 percentage (confidence)
  isMatch: boolean;
  rawResponse: any;
};

export const faceMatch = async (
  selfieBase64: string,
  documentImageBase64: string
): Promise<FaceMatchResult> => {
  const { baseUrl, apiToken } = getSurepassConfig();
  // Correct endpoint: /api/v1/face/face-match (NOT /face-match/face-match)
  const url = `${baseUrl}/api/v1/face/face-match`;

  const threshold = parseFloat(process.env.SUREPASS_FACE_MATCH_THRESHOLD || '70');

  logger.info('[Surepass] Running face match', { url, threshold });

  try {
    // Clean base64 — remove data URI prefix if present
    const cleanSelfie = selfieBase64.replace(/^data:image\/\w+;base64,/, '');
    const cleanDoc = documentImageBase64.replace(/^data:image\/\w+;base64,/, '');

    // Convert base64 to Buffers for multipart upload
    const selfieBuffer = Buffer.from(cleanSelfie, 'base64');
    const docBuffer = Buffer.from(cleanDoc, 'base64');

    // Build multipart/form-data using FormData
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('selfie', selfieBuffer, {
      filename: 'selfie.jpg',
      contentType: 'image/jpeg',
    });
    form.append('id_card', docBuffer, {
      filename: 'id_card.jpg',
      contentType: 'image/jpeg',
    });

    const response = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${apiToken}`,
      },
      timeout: 60000,
    });

    const data = response.data;

    logger.info('[Surepass] Face match response', {
      statusCode: data?.status_code,
      success: data?.success,
      matchData: JSON.stringify(data?.data),
    });

    const matchData = data?.data;

    // Response: { match_status: true/false, confidence: 82.87 }
    const score = Number(
      matchData?.confidence ?? matchData?.match_score ?? matchData?.score ?? 0
    );
    const isMatchResult = matchData?.match_status ?? matchData?.is_match ?? (score >= threshold);

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
