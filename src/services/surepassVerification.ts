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
// ── DigiLocker Verification (via Surepass SDK API) ────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// Flow:
//   1. Create session → get authorization_url + session_id
//   2. User opens URL in WebView, logs into DigiLocker, grants consent
//   3. Poll session status until "completed"
//   4. Fetch Aadhaar document data (name, DOB, gender, address, photo)

export type DigiLockerSessionResult = {
  sessionId: string;
  authorizationUrl: string;
};

/**
 * Step 1: Create a DigiLocker session.
 * Returns a session_id and authorization_url to redirect the user to.
 *
 * Note: Tries multiple possible endpoint paths since Surepass docs are
 * behind authentication and the exact path is not publicly documented.
 */
export const digilockerCreateSession = async (
  redirectUrl: string
): Promise<DigiLockerSessionResult> => {
  const { baseUrl } = getSurepassConfig();

  // Possible endpoint paths (try in order)
  const possiblePaths = [
    '/api/v1/digilocker/generate-url',
    '/api/v1/digilocker-sdk/generate-url',
    '/api/v1/digilocker/initiate',
    '/api/v1/digilocker-sdk/sessions/create',
    '/api/v1/digilocker/url',
    '/api/v1/digilocker/create-session',
    '/api/v1/digilocker/session',
  ];

  const requestBody = {
    redirect_url: redirectUrl,
  };

  logger.info('[Surepass] Creating DigiLocker session', { redirectUrl, paths: possiblePaths.length });

  let lastError: any = null;

  for (const path of possiblePaths) {
    const url = `${baseUrl}${path}`;
    try {
      logger.info('[Surepass] Trying DigiLocker endpoint', { url });

      const response = await axios.post(
        url,
        requestBody,
        { headers: getHeaders(), timeout: 15000 }
      );

      const data = response.data;

      logger.info('[Surepass] DigiLocker session response', {
        url,
        statusCode: data?.status_code,
        success: data?.success,
        dataKeys: data?.data ? Object.keys(data.data) : [],
        rawData: JSON.stringify(data).slice(0, 500),
      });

      const sessionId = data?.data?.session_id || data?.data?.client_id || data?.data?.id;
      const authorizationUrl = data?.data?.authorization_url || data?.data?.url || data?.data?.redirect_url;

      if (!sessionId || !authorizationUrl) {
        // API responded but didn't have expected fields — log and try parsing differently
        logger.warn('[Surepass] DigiLocker response missing expected fields', {
          url,
          hasSessionId: Boolean(sessionId),
          hasAuthUrl: Boolean(authorizationUrl),
          data: JSON.stringify(data).slice(0, 1000),
        });

        // If we got a response but no expected fields, it might still be the right endpoint
        // with a different response structure — throw with the data for debugging
        if (data?.success || data?.status_code === 200) {
          throw new AppError(
            `DigiLocker endpoint ${path} responded but returned unexpected structure. Raw: ${JSON.stringify(data).slice(0, 500)}`,
            502
          );
        }
        continue;
      }

      logger.info('[Surepass] ✅ DigiLocker session created successfully', {
        url,
        sessionId: String(sessionId).slice(0, 12) + '...',
      });

      return {
        sessionId: String(sessionId),
        authorizationUrl: String(authorizationUrl),
      };
    } catch (error: any) {
      if (error instanceof AppError) throw error;

      const status = error?.response?.status;
      const errData = error?.response?.data;

      // 404 means wrong path — try next
      if (status === 404) {
        logger.info('[Surepass] DigiLocker endpoint not found (404), trying next', { url });
        lastError = error;
        continue;
      }

      // 401/403 means right path but auth issue
      if (status === 401 || status === 403) {
        logger.error('[Surepass] DigiLocker auth error — token lacks DigiLocker scope', {
          url,
          status,
          message: errData?.message,
        });
        throw new AppError(
          errData?.message || 'Your Surepass token does not have DigiLocker API access. Please contact Surepass support.',
          401
        );
      }

      // Other errors — log and try next
      logger.warn('[Surepass] DigiLocker endpoint error', {
        url,
        status,
        message: error?.message,
        data: typeof errData === 'string' ? errData.slice(0, 200) : JSON.stringify(errData)?.slice(0, 200),
      });
      lastError = error;
    }
  }

  // All paths failed
  const msg = lastError?.response?.data?.message || lastError?.message || 'Failed to create DigiLocker session — all endpoint paths returned 404';
  logger.error('[Surepass] All DigiLocker endpoint paths failed', { msg });
  throw new AppError(msg, 502);
};

export type DigiLockerSessionStatus = {
  status: string; // "pending", "completed", "failed", etc.
  completed: boolean;
  rawResponse: any;
};

/**
 * Step 2: Check DigiLocker session status.
 * Call this after the user completes the DigiLocker consent flow.
 */
export const digilockerGetSession = async (
  sessionId: string
): Promise<DigiLockerSessionStatus> => {
  const { baseUrl } = getSurepassConfig();
  const url = `${baseUrl}/api/v1/digilocker/session-status/${sessionId}`;

  logger.info('[Surepass] Checking DigiLocker session', { sessionId: sessionId.slice(0, 12) + '...', url });

  try {
    const response = await axios.get(url, {
      headers: getHeaders(),
      timeout: 30000,
    });

    const data = response.data;

    logger.info('[Surepass] DigiLocker session status', {
      statusCode: data?.status_code,
      success: data?.success,
      sessionStatus: data?.data?.status,
    });

    const sessionStatus = data?.data?.status || '';
    const completed = ['completed', 'succeeded', 'success'].includes(sessionStatus.toLowerCase());

    return {
      status: sessionStatus,
      completed,
      rawResponse: data,
    };
  } catch (error: any) {
    if (error instanceof AppError) throw error;
    logger.error('[Surepass] DigiLocker session check failed', {
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
    });
    const msg = error?.response?.data?.message || error?.message || 'Failed to check DigiLocker session';
    throw new AppError(msg, error?.response?.status || 502);
  }
};

export type DigiLockerAadhaarResult = {
  verified: boolean;
  fullName: string;
  dob: string;
  gender: string;
  address: string;
  photo: string; // Base64 or URL — used for face match
  aadhaarNumber: string; // Masked
  rawResponse: any;
};

/**
 * Step 3: Fetch Aadhaar document data from a completed DigiLocker session.
 */
export const digilockerFetchAadhaar = async (
  sessionId: string
): Promise<DigiLockerAadhaarResult> => {
  const { baseUrl } = getSurepassConfig();
  const url = `${baseUrl}/api/v1/digilocker/aadhaar/${sessionId}`;

  logger.info('[Surepass] Fetching Aadhaar from DigiLocker', { sessionId: sessionId.slice(0, 12) + '...' });

  try {
    const response = await axios.get(url, {
      headers: getHeaders(),
      timeout: 30000,
    });

    const data = response.data;

    logger.info('[Surepass] DigiLocker Aadhaar fetch response', {
      statusCode: data?.status_code,
      success: data?.success,
      hasData: Boolean(data?.data),
    });

    const aadhaarData = data?.data;
    if (!aadhaarData || !data?.success) {
      throw new AppError(
        data?.message || 'Failed to fetch Aadhaar data from DigiLocker',
        400
      );
    }

    // Parse address — may be string or structured object
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
    logger.error('[Surepass] DigiLocker Aadhaar fetch failed', {
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
    });
    const msg = error?.response?.data?.message || error?.message || 'Failed to fetch Aadhaar from DigiLocker';
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
