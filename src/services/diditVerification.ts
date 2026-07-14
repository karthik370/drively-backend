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
import FormData from 'form-data';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';


// ── Config ─────────────────────────────────────────────────────────────────
const getDiditConfig = () => {
  const apiKey = process.env.DIDIT_API_KEY;

  if (!apiKey) {
    throw new AppError('Didit API key not configured (DIDIT_API_KEY)', 500);
  }

  const baseUrl = 'https://verification.didit.me';
  return { apiKey, baseUrl };
};

// ── Helper: Build multipart form ────────────────────────────────────────────
// Didit database-validation API uses multipart/form-data, NOT JSON.
// The x-api-key goes in the header; all fields go as form fields.
const makeForm = (fields: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return form;
};

// ── Helper: Consistent Didit error handler ──────────────────────────────────
// Translates Didit API errors into friendly AppErrors for the client.
const handleDiditError = (error: any, service: string): never => {
  if (error instanceof AppError) throw error;

  const status  = error?.response?.status;
  const errData = error?.response?.data;

  // 403 = no credits in Didit wallet
  if (status === 403 || (typeof errData === 'string' && errData.includes('credits'))) {
    logger.error(`[Didit] No credits for ${service} — top up at https://business.didit.me`, { status });
    throw new AppError(
      'Verification service is temporarily unavailable. Please try again later.',
      503,
    );
  }

  // 400 + requires_onboarding = service not activated
  if (errData?.requires_onboarding?.length > 0) {
    logger.error(`[Didit] ${service} not activated`, { requires_onboarding: errData.requires_onboarding });
    throw new AppError(
      'Verification service is not yet activated. Please contact support.',
      503,
    );
  }

  // All other errors
  logger.error(`[Didit] ${service} failed`, {
    status,
    data: JSON.stringify(errData).slice(0, 300),
    message: error?.message,
  });
  throw new AppError(
    errData?.detail || errData?.message || errData?.error || error?.message || `${service} verification failed`,
    status || 502,
  );
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
// Docs: https://docs.didit.me/api-reference/database-validation/india/aadhaar
// Required: issuing_state, services, consent, full_name, date_of_birth,
//           personal_number (12-digit Aadhaar), pan
// All fields sent as multipart/form-data — NOT JSON.

export type AadhaarVerificationResult = {
  verified: boolean;
  fullName: string;
  dob: string;
  gender: string;
  address: string;
  aadhaarNumber: string;
  rawResponse: any;
};

export const verifyAadhaar = async (
  aadhaarNumber: string,
  fullName: string,
  dob: string,       // YYYY-MM-DD
  pan: string,       // Required by Didit alongside Aadhaar number
  userId?: string
): Promise<AadhaarVerificationResult> => {
  const { baseUrl, apiKey } = getDiditConfig();
  const url = `${baseUrl}/v3/database-validation/`;

  const masked = aadhaarNumber.replace(/^(\d{8})(\d{4})$/, 'XXXXXXXX$2');
  logger.info('[Didit] Verifying Aadhaar', { masked, url });

  const form = makeForm({
    issuing_state:   'IND',
    services:        'ind_aadhaar',
    consent:         'true',
    full_name:       fullName.trim(),
    date_of_birth:   normalizeDob(dob),
    personal_number: aadhaarNumber.replace(/\s/g, '').trim(),
    pan:             pan.trim().toUpperCase(),
    ...(userId ? { vendor_data: userId } : {}),
  });

  try {
    const response = await axios.post(url, form, {
      headers: { ...form.getHeaders(), 'x-api-key': apiKey },
      timeout: 30000,
    });

    const data = response.data;

    // Log FULL raw response so we can see exactly what Didit returns
    logger.info('[Didit] Aadhaar raw response', {
      status: data?.status,
      matchType: data?.match_type,
      request_id: data?.request_id,
      validationsCount: data?.validations?.length ?? 'undefined',
      // Full response for debugging (first call)
      rawData: JSON.stringify(data).slice(0, 800),
    });

    const validation  = data?.validations?.[0];
    const outcomeCode = validation?.outcome_code
      ?? (data?.validations?.length === 0 ? 'EMPTY_VALIDATIONS' : null)
      ?? data?.match_type
      ?? 'UNKNOWN';
    const fieldValidation = validation?.validation || {};

    // Didit status values:
    //   "Approved"  → MATCH (all fields matched)
    //   "In Review" → PARTIAL_MATCH (Aadhaar found, name/dob slightly off)
    //   "Declined"  → NO_MATCH (Aadhaar not found)
    // Accept both Approved and In Review
    const isVerified =
      data?.status === 'Approved'   ||   // MATCH
      data?.status === 'In Review'  ||   // PARTIAL_MATCH
      outcomeCode   === 'MATCH'     ||
      outcomeCode   === 'PARTIAL_MATCH';

    if (!isVerified) {
      const fieldDetails = Object.entries(fieldValidation)
        .filter(([_, v]) => v === 'no_match')
        .map(([k]) => k.replace(/_/g, ' '))
        .join(', ');

      const hint = fieldDetails
        ? `The following details did not match UIDAI records: ${fieldDetails}. Please check and try again.`
        : outcomeCode === 'EMPTY_VALIDATIONS'
          ? 'Aadhaar number not found in UIDAI records. Please verify your Aadhaar number is correct.'
          : `Aadhaar verification failed (${outcomeCode}). Please check your details and try again.`;

      logger.warn('[Didit] Aadhaar verification failed', {
        outcomeCode,
        diditStatus: data?.status,
        fieldValidation,
        masked,
      });
      throw new AppError(hint, 400);
    }

    // Extract source data (may be empty for partial/approved without detailed return)
    const sourceData = validation?.source_data || data?.source_data || {};

    if (outcomeCode === 'PARTIAL_MATCH' || data?.status === 'In Review') {
      logger.info('[Didit] Aadhaar PARTIAL_MATCH accepted', {
        fieldValidation,
        sourceName: sourceData?.full_name,
        inputName: fullName,
      });
    }

    let address = '';
    if (sourceData?.address && typeof sourceData.address === 'object') {
      address = [
        sourceData.address?.street_1,
        sourceData.address?.city,
        sourceData.address?.region,
        sourceData.address?.postal_code,
      ].filter(Boolean).join(', ');
    } else if (sourceData?.address) {
      address = String(sourceData.address);
    }

    return {
      verified: true,
      fullName: String(sourceData?.full_name || fullName),
      dob: String(sourceData?.date_of_birth || dob),
      gender: String(sourceData?.gender || ''),
      address,
      aadhaarNumber: masked,
      rawResponse: data,
    };
  } catch (error: any) {
    return handleDiditError(error, 'ind_aadhaar') as never;
  }
};


// ══════════════════════════════════════════════════════════════════════════
// ── PAN Verification ───────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// Docs: https://docs.didit.me/api-reference/database-validation/india/pan-permanent-account-number
// Required: issuing_state, services, consent, full_name, date_of_birth, pan
// All fields sent as multipart/form-data — NOT JSON.

export type PanVerificationResult = {
  valid: boolean;
  registeredName: string;
  panType: string;
  rawResponse: any;
};

export const verifyPanStandalone = async (
  panNumber: string,
  fullName: string,
  dob: string,      // YYYY-MM-DD
  userId?: string
): Promise<PanVerificationResult> => {
  const { baseUrl, apiKey } = getDiditConfig();
  const url = `${baseUrl}/v3/database-validation/`;

  logger.info('[Didit] Verifying PAN', { pan: panNumber.slice(0, 4) + '******', url });

  const form = makeForm({
    issuing_state: 'IND',
    services:      'ind_pan_permanent_account_number',
    consent:       'true',
    full_name:     fullName.trim(),
    date_of_birth: normalizeDob(dob),
    pan:           panNumber.trim().toUpperCase(),
    ...(userId ? { vendor_data: userId } : {}),
  });

  try {
    const response = await axios.post(url, form, {
      headers: { ...form.getHeaders(), 'x-api-key': apiKey },
      timeout: 30000,
    });

    const data = response.data;
    logger.info('[Didit] PAN response', {
      status: data?.status,
      validations: data?.validations?.map((v: any) => ({ outcome: v.outcome_code })),
    });

    const sourceData = data?.validations?.[0]?.source_data || data?.source_data || {};
    const outcomeCode = data?.validations?.[0]?.outcome_code || data?.match_type || 'UNKNOWN';
    const isValid = data?.status === 'Approved' ||
      outcomeCode === 'MATCH' ||
      outcomeCode === 'PARTIAL_MATCH';

    return {
      valid: isValid,
      registeredName: String(sourceData?.full_name || sourceData?.name || fullName),
      panType: String(sourceData?.category || sourceData?.type || ''),
      rawResponse: data,
    };
  } catch (error: any) {
    return handleDiditError(error, 'ind_pan_permanent_account_number') as never;
  }
};


// ══════════════════════════════════════════════════════════════════════════
// ── Driving License Verification ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// Docs: https://docs.didit.me/api-reference/database-validation/india/drivers-licence
// Required: issuing_state, services, consent, full_name, date_of_birth,
//           driver_license_number
// All fields sent as multipart/form-data — NOT JSON.

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
  fullName: string,
  dob: string,      // YYYY-MM-DD or DD-MM-YYYY — will be normalized
  userId?: string
): Promise<DlVerificationResult> => {
  const { baseUrl, apiKey } = getDiditConfig();
  const url = `${baseUrl}/v3/database-validation/`;

  const formattedDob = normalizeDob(dob);
  if (isNaN(new Date(formattedDob).getTime())) {
    throw new AppError(`Invalid date of birth: ${dob}`, 400);
  }

  logger.info('[Didit] Verifying DL', { dl: dlNumber.slice(0, 4) + '****', dob: formattedDob, url });

  const form = makeForm({
    issuing_state:          'IND',
    services:               'ind_drivers_licence',
    consent:                'true',
    full_name:              fullName.trim(),
    date_of_birth:          formattedDob,
    driver_license_number:  dlNumber.toUpperCase().trim(),
    ...(userId ? { vendor_data: userId } : {}),
  });

  try {
    const response = await axios.post(url, form, {
      headers: { ...form.getHeaders(), 'x-api-key': apiKey },
      timeout: 30000,
    });

    const data = response.data;
    logger.info('[Didit] DL response', {
      status: data?.status,
      validations: data?.validations?.map((v: any) => ({ outcome: v.outcome_code })),
    });

    const dlData = data?.validations?.[0]?.source_data || data?.source_data || {};
    const outcomeCode = data?.validations?.[0]?.outcome_code || data?.match_type || 'UNKNOWN';
    const isValid = data?.status === 'Approved' ||
      outcomeCode === 'MATCH' ||
      outcomeCode === 'PARTIAL_MATCH';

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

    const expiryDate = dlData?.expiry_date || dlData?.doe || '';

    return {
      valid: isValid,
      name: String(dlData?.full_name || fullName),
      dob: String(dlData?.date_of_birth || dob),
      issueDate: String(dlData?.issue_date || dlData?.doi || ''),
      expiryDate: String(expiryDate),
      vehicleClass,
      rawResponse: data,
    };
  } catch (error: any) {
    return handleDiditError(error, 'ind_drivers_licence') as never;
  }
};


// ══════════════════════════════════════════════════════════════════════════
// ── DL Photo Scan — Extract Face from Driving License ─────────────────────
// ══════════════════════════════════════════════════════════════════════════
// POST /v3/id-verification/  (multipart/form-data)
// Sends front image of DL → Didit OCR extracts: name, DL number, face photo
// We use the extracted face photo as reference for face match.
// save_api_request=false → portrait returned inline as base64 in response.

export type DLScanResult = {
  valid: boolean;
  facePhotoBase64: string | null; // extracted face from DL card
  dlNumber: string;
  name: string;
  dob: string;
  expiryDate: string;
  rawResponse: any;
};

export const scanDLForFace = async (
  dlFrontImageBase64: string
): Promise<DLScanResult> => {
  const { baseUrl, apiKey } = getDiditConfig();
  const url = `${baseUrl}/v3/id-verification/`;

  logger.info('[Didit] Scanning DL front image for face extraction', { url });

  try {
    // Didit ID verification requires multipart/form-data — not JSON
    const form = new FormData();

    // Convert base64 to buffer for multipart upload
    const cleanBase64 = dlFrontImageBase64.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(cleanBase64, 'base64');

    form.append('front_image', imageBuffer, {
      filename: 'dl_front.jpg',
      contentType: 'image/jpeg',
    });

    // save_api_request=false → face portrait returned inline as base64
    form.append('save_api_request', 'false');

    const response = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        'x-api-key': apiKey,
      },
      timeout: 60000,
    });

    const data = response.data;

    logger.info('[Didit] DL scan response', {
      status: data?.id_verification?.status,
      warnings: data?.id_verification?.warnings,
      hasFace: Boolean(data?.portrait),
    });

    const idVerif = data?.id_verification || {};
    const isValid = idVerif?.status === 'Approved';

    // Extracted fields
    const extractedData = data?.extracted_data || data?.data || {};
    const dlNumber = String(
      extractedData?.document_number ||
      extractedData?.dl_number ||
      ''
    );
    const name = String(
      extractedData?.full_name ||
      `${extractedData?.first_name || ''} ${extractedData?.last_name || ''}`.trim() ||
      ''
    );
    const dob = String(extractedData?.date_of_birth || extractedData?.dob || '');
    const expiryDate = String(extractedData?.expiration_date || extractedData?.expiry_date || '');

    // Face portrait — returned as base64 when save_api_request=false
    const facePhotoBase64 = data?.portrait || data?.face_image || null;

    if (facePhotoBase64) {
      logger.info('[Didit] DL face photo extracted successfully', { dlNumber });
    } else {
      logger.warn('[Didit] DL scan completed but no face photo returned', {
        warnings: idVerif?.warnings,
      });
    }

    return {
      valid: isValid,
      facePhotoBase64,
      dlNumber,
      name,
      dob,
      expiryDate,
      rawResponse: data,
    };
  } catch (error: any) {
    const errData = error?.response?.data;

    logger.error('[Didit] DL scan failed', {
      status: error?.response?.status,
      data: JSON.stringify(errData),
      message: error?.message,
    });

    const msg =
      errData?.detail ||
      errData?.message ||
      error?.message ||
      'DL photo scan failed';
    throw new AppError(msg, error?.response?.status || 502);
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

    const { baseUrl, apiKey } = getDiditConfig();
    const url = `${baseUrl}/v3/face-match/`;

    const response = await axios.post(
      url,
      {
        source_image: cleanSelfie,
        target_image: cleanDoc,
        rotate_image: true,
        face_match_score_decline_threshold: threshold,
        save_api_request: true,
      },
      { headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey }, timeout: 60000 }
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
  const { baseUrl, apiKey } = getDiditConfig();
  const url = `${baseUrl}/v3/passive-liveness/`;

  logger.info('[Didit] Running face liveness check', { url });

  try {
    const cleanImage = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    const response = await axios.post(
      url,
      { image: cleanImage },
      { headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey }, timeout: 60000 }
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
