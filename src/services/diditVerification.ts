/**
 * Didit Verification Suite — KYC APIs
 * ──────────────────────────────────────────────
 * Replaces SurePass with Didit (didit.me) for:
 *   - Aadhaar verification (database lookup against UIDAI)
 *   - PAN verification (database lookup against Income Tax Dept)
 *   - Driving License verification (database lookup against RTO/Sarathi)
 *   - Face Match (selfie vs document photo, 1:1 biometric)
 *
 * Didit API Docs: https://docs.didit.me
 *
 * Base URL (Standalone APIs): https://verification.didit.me
 * Auth: x-api-key header
 *
 * Note: Aadhaar via Didit = database validation (no OTP needed).
 *   The driver types their Aadhaar number → backend validates against UIDAI → instant.
 *   This replaces the DigiLocker multi-step OTP flow entirely.
 */
import axios from 'axios';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

// ── Config ─────────────────────────────────────────────────────────────────
const getDiditConfig = () => {
  const apiKey = process.env.DIDIT_API_KEY;
  const env = process.env.DIDIT_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';

  if (!apiKey) {
    throw new AppError(
      'Didit API key not configured (DIDIT_API_KEY)',
      500
    );
  }

  // Didit has one base URL for all standalone verification APIs
  const baseUrl = 'https://verification.didit.me';

  return { apiKey, env, baseUrl };
};

const getHeaders = () => {
  const { apiKey } = getDiditConfig();
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
  };
};

// ── Helper: DOB normalizer ──────────────────────────────────────────────────
// Converts various DOB formats to YYYY-MM-DD (what Didit expects)
const normalizeDob = (dob: string): string => {
  if (/^\d{2}-\d{2}-\d{4}$/.test(dob)) {
    const [d, m, y] = dob.split('-');
    return `${y}-${m}-${d}`;
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dob)) {
    const [d, m, y] = dob.split('/');
    return `${y}-${m}-${d}`;
  }
  return dob; // Assume already YYYY-MM-DD
};

// ══════════════════════════════════════════════════════════════════════════
// ── Aadhaar Verification (Database Validation — No OTP) ───────────────────
// ══════════════════════════════════════════════════════════════════════════
// This is a DIRECT database lookup against UIDAI via Didit.
// Unlike the old SurePass DigiLocker flow, no WebView or OTP is needed.
// Driver types Aadhaar number → backend validates immediately.

export type AadhaarVerificationResult = {
  verified: boolean;
  fullName: string;
  dob: string;
  gender: string;
  address: string;
  aadhaarNumber: string; // masked
  rawResponse: any;
};

export const verifyAadhaar = async (
  aadhaarNumber: string
): Promise<AadhaarVerificationResult> => {
  const { baseUrl } = getDiditConfig();
  const url = `${baseUrl}/v3/database-validation/`;

  // Mask for logging
  const masked = aadhaarNumber.replace(/^(\d{8})(\d{4})$/, 'XXXXXXXX$2');
  logger.info('[Didit] Verifying Aadhaar', { masked, url });

  try {
    const response = await axios.post(
      url,
      {
        issuing_state: 'IND',
        services: 'ind_aadhaar',
        personal_number: aadhaarNumber.trim(),  // Didit uses personal_number for Aadhaar
      },
      { headers: getHeaders(), timeout: 30000 }
    );

    const data = response.data;

    logger.info('[Didit] Aadhaar response', {
      status: data?.status,
      matchType: data?.match_type,
      hasSourceData: Boolean(data?.source_data),
    });

    // Didit returns: { status: "Approved"|"Declined", match_type, source_data: {...} }
    const sourceData = data?.source_data || data?.data || {};
    const isVerified = data?.status === 'Approved' || data?.match_type === 'FULL_MATCH';

    if (!isVerified) {
      throw new AppError(
        'Aadhaar verification failed. Please check your Aadhaar number and try again.',
        400
      );
    }

    // Parse address — can be object or string from Didit
    let address = '';
    if (sourceData?.address) {
      if (typeof sourceData.address === 'object') {
        address = [
          sourceData.address?.house,
          sourceData.address?.street,
          sourceData.address?.landmark,
          sourceData.address?.loc,
          sourceData.address?.vtc,
          sourceData.address?.district,
          sourceData.address?.state,
          sourceData.address?.country,
        ].filter(Boolean).join(', ');
      } else {
        address = String(sourceData.address);
      }
    } else {
      address = sourceData?.full_address || '';
    }

    return {
      verified: true,
      fullName: String(sourceData?.name || sourceData?.full_name || ''),
      dob: String(sourceData?.dob || sourceData?.date_of_birth || ''),
      gender: String(sourceData?.gender || ''),
      address,
      aadhaarNumber: String(sourceData?.masked_aadhaar || sourceData?.personal_number || ''),
      rawResponse: data,
    };
  } catch (error: any) {
    if (error instanceof AppError) throw error;

    // ── Handle Didit onboarding requirement ──────────────────────────────────
    // India KYC services need manual activation in Didit Business Console
    const errData = error?.response?.data;
    if (errData?.requires_onboarding?.length > 0) {
      logger.error('[Didit] India services not activated', {
        requires_onboarding: errData.requires_onboarding,
        message: 'Contact Didit support at https://wa.me/+19544659728 to activate ind_aadhaar',
      });
      throw new AppError(
        'Aadhaar verification service is not yet activated. Please contact support.',
        503
      );
    }

    logger.error('[Didit] Aadhaar verification failed', {
      status: error?.response?.status,
      data: JSON.stringify(errData),
      message: error?.message,
    });
    const msg =
      errData?.detail ||
      errData?.message ||
      (Array.isArray(errData?.services) ? errData.services[0] : null) ||
      error?.message ||
      'Aadhaar verification failed';
    throw new AppError(msg, error?.response?.status || 502);
  }
};


// ══════════════════════════════════════════════════════════════════════════
// ── PAN Verification ───────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
export type PanVerificationResult = {
  valid: boolean;
  registeredName: string;
  panType: string;
  rawResponse: any;
};

export const verifyPanStandalone = async (
  panNumber: string
): Promise<PanVerificationResult> => {
  const { baseUrl } = getDiditConfig();
  const url = `${baseUrl}/v3/database-validation/`;

  logger.info('[Didit] Verifying PAN', {
    pan: panNumber.slice(0, 4) + '******',
    url,
  });

  try {
    const response = await axios.post(
      url,
      {
        issuing_state: 'IND',
        services: 'ind_pan_permanent_account_number',  // Correct Didit service ID
        personal_number: panNumber.toUpperCase().trim(),
      },
      { headers: getHeaders(), timeout: 30000 }
    );

    const data = response.data;

    logger.info('[Didit] PAN response', {
      status: data?.status,
      matchType: data?.match_type,
    });

    const sourceData = data?.source_data || data?.data || {};
    const isValid = data?.status === 'Approved' || data?.match_type === 'FULL_MATCH';

    return {
      valid: isValid,
      registeredName: String(
        sourceData?.name ||
        sourceData?.full_name ||
        sourceData?.registered_name ||
        ''
      ),
      panType: String(sourceData?.category || sourceData?.type || ''),
      rawResponse: data,
    };
  } catch (error: any) {
    const errData = error?.response?.data;

    if (errData?.requires_onboarding?.length > 0) {
      logger.error('[Didit] PAN service not activated', { requires_onboarding: errData.requires_onboarding });
      throw new AppError('PAN verification service is not yet activated. Please contact support.', 503);
    }

    logger.error('[Didit] PAN verification failed', {
      status: error?.response?.status,
      data: JSON.stringify(errData),
      message: error?.message,
    });
    const msg =
      errData?.detail ||
      errData?.message ||
      (Array.isArray(errData?.services) ? errData.services[0] : null) ||
      error?.message ||
      'PAN verification failed';
    throw new AppError(msg, error?.response?.status || 502);
  }
};


// ══════════════════════════════════════════════════════════════════════════
// ── Driving License Verification ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
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
  dob: string // YYYY-MM-DD or DD-MM-YYYY — will be normalized
): Promise<DlVerificationResult> => {
  const { baseUrl } = getDiditConfig();
  const url = `${baseUrl}/v3/database-validation/`;

  // Normalize DOB to YYYY-MM-DD
  const formattedDob = normalizeDob(dob);

  // Validate date
  const parsedDate = new Date(formattedDob);
  if (isNaN(parsedDate.getTime())) {
    throw new AppError(`Invalid date of birth: ${dob}`, 400);
  }

  logger.info('[Didit] Verifying DL', {
    dl: dlNumber.slice(0, 4) + '****',
    dob: formattedDob,
    url,
  });

  try {
    const response = await axios.post(
      url,
      {
        issuing_state: 'IND',
        services: 'ind_drivers_licence',          // Correct Didit service ID
        personal_number: dlNumber.toUpperCase().trim(),
        date_of_birth: formattedDob,              // Didit uses date_of_birth
      },
      { headers: getHeaders(), timeout: 30000 }
    );

    const data = response.data;

    logger.info('[Didit] DL response', {
      status: data?.status,
      matchType: data?.match_type,
    });

    const dlData = data?.source_data || data?.data || {};
    const isValid = data?.status === 'Approved' || data?.match_type === 'FULL_MATCH';

    // Extract vehicle classes — can be array of strings or objects
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

    // Extract expiry date — may be in multiple fields
    const expiryDate =
      dlData?.doe ||
      dlData?.expiry_date ||
      dlData?.validity?.non_transport?.to ||
      dlData?.validity?.transport?.to ||
      '';

    return {
      valid: isValid,
      name: String(dlData?.name || dlData?.full_name || ''),
      dob: String(dlData?.dob || dlData?.date_of_birth || dob),
      issueDate: String(dlData?.doi || dlData?.issue_date || ''),
      expiryDate: String(expiryDate),
      vehicleClass,
      rawResponse: data,
    };
  } catch (error: any) {
    const errData = error?.response?.data;

    if (errData?.requires_onboarding?.length > 0) {
      logger.error('[Didit] DL service not activated', { requires_onboarding: errData.requires_onboarding });
      throw new AppError('Driving License verification service is not yet activated. Please contact support.', 503);
    }

    logger.error('[Didit] DL verification failed', {
      status: error?.response?.status,
      data: JSON.stringify(errData),
      message: error?.message,
    });
    const msg =
      errData?.detail ||
      errData?.message ||
      (Array.isArray(errData?.services) ? errData.services[0] : null) ||
      error?.message ||
      'Driving License verification failed';
    throw new AppError(`DL verification error: ${msg}`, error?.response?.status || 502);
  }
};


// ══════════════════════════════════════════════════════════════════════════
// ── Face Match (Selfie vs Document Photo) ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// POST /v3/face-match/
// Body: { source_image: base64, target_image: base64, rotate_image?: bool,
//         face_match_score_decline_threshold?: number (default 30) }
// Response: { status: "Approved"|"Declined", score: 0-100, request_id, warnings: [] }

export type FaceMatchResult = {
  matchScore: number; // 0-100
  isMatch: boolean;
  rawResponse: any;
};

export const faceMatch = async (
  selfieBase64: string,
  documentImageBase64: string
): Promise<FaceMatchResult> => {
  const { baseUrl } = getDiditConfig();
  const url = `${baseUrl}/v3/face-match/`;

  // Threshold: score must be strictly ABOVE this to be Approved (Didit default is 30)
  // We use a higher threshold (60) to be safe for production
  const threshold = parseInt(process.env.DIDIT_FACE_MATCH_THRESHOLD || '60', 10);

  logger.info('[Didit] Running face match', { url, threshold });

  try {
    // Clean base64 — remove data URI prefix if present
    const cleanSelfie = selfieBase64.replace(/^data:image\/\w+;base64,/, '');
    const cleanDoc = documentImageBase64.replace(/^data:image\/\w+;base64,/, '');

    const response = await axios.post(
      url,
      {
        source_image: cleanSelfie,    // selfie
        target_image: cleanDoc,       // document photo (Aadhaar/DL photo)
        rotate_image: true,           // handle portrait/landscape captures
        face_match_score_decline_threshold: threshold,
        save_api_request: true,       // persist to Didit console for review
      },
      { headers: getHeaders(), timeout: 60000 }
    );

    const data = response.data;

    logger.info('[Didit] Face match response', {
      status: data?.status,
      score: data?.score,
      warnings: data?.warnings,
    });

    // Didit returns: { status: "Approved"|"Declined", score: 0-100, request_id, warnings }
    const score = Number(data?.score ?? 0);
    const isMatch = data?.status === 'Approved';

    return {
      matchScore: score,
      isMatch,
      rawResponse: data,
    };
  } catch (error: any) {
    logger.error('[Didit] Face match failed', {
      status: error?.response?.status,
      data: JSON.stringify(error?.response?.data),
      message: error?.message,
    });
    throw new AppError(
      error?.response?.data?.detail ||
      error?.response?.data?.message ||
      'Face match failed',
      error?.response?.status || 502
    );
  }
};

// ── Liveness Check (optional — soft-fail) ──────────────────────────────────
// POST /v3/passive-liveness/
// Body: { image: base64 }
// Response: { status: "Approved"|"Declined", score: 0-100 }

export type FaceLivenessResult = {
  isLive: boolean;
  confidence: number;
  rawResponse: any;
};

export const faceLivenessCheck = async (
  imageBase64: string
): Promise<FaceLivenessResult> => {
  const { baseUrl } = getDiditConfig();
  const url = `${baseUrl}/v3/passive-liveness/`;

  logger.info('[Didit] Running face liveness check', { url });

  try {
    const cleanImage = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    const response = await axios.post(
      url,
      { image: cleanImage },
      { headers: getHeaders(), timeout: 60000 }
    );

    const data = response.data;

    logger.info('[Didit] Face liveness response', {
      status: data?.status,
      score: data?.score,
    });

    const isLive = data?.status === 'Approved';
    const score = Number(data?.score ?? 0);

    return {
      isLive,
      confidence: score,
      rawResponse: data,
    };
  } catch (error: any) {
    logger.error('[Didit] Face liveness check failed', {
      status: error?.response?.status,
      data: JSON.stringify(error?.response?.data),
      message: error?.message,
    });
    // Liveness is a soft-fail — don't block driver onboarding if API errors
    return {
      isLive: true,
      confidence: 0,
      rawResponse: { error: error?.message },
    };
  }
};
