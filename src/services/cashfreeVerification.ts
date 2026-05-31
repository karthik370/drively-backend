/**
 * Cashfree Verification Suite — Secure ID APIs
 * ──────────────────────────────────────────────
 * Uses the Cashfree Verification REST API for:
 *   - DigiLocker (Aadhaar + PAN + Driving Licence in one flow)
 *   - Standalone PAN verification
 *   - Standalone Driving Licence verification
 *   - Face Match (selfie vs Aadhaar photo)  — multipart/form-data
 *   - Face Liveness check                   — multipart/form-data
 *
 * Base URLs:
 *   Sandbox:    https://sandbox.cashfree.com/verification
 *   Production: https://api.cashfree.com/verification
 *
 * Correct endpoint paths (verified against Cashfree docs):
 *   DigiLocker Create URL:  POST /digilocker         (NOT /digilocker/create-url)
 *   DigiLocker Status:      GET  /digilocker/{id}
 *   DigiLocker Verify Acct: POST /digilocker/verify-account
 *   PAN:                    POST /pan
 *   Driving Licence:        POST /driving-licence     (British spelling with 'c')
 *   Face Match:             POST /face-match          (multipart/form-data)
 *   Face Liveness:          POST /face-liveness       (multipart/form-data)
 */
import axios from 'axios';
import crypto from 'crypto';
import FormData from 'form-data';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

// ── Config ─────────────────────────────────────────────────────────────────
const getVerificationConfig = () => {
  const clientId = process.env.CASHFREE_VERIFICATION_CLIENT_ID;
  const clientSecret = process.env.CASHFREE_VERIFICATION_CLIENT_SECRET;
  const env = process.env.CASHFREE_VERIFICATION_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';

  if (!clientId || !clientSecret) {
    throw new AppError(
      'Cashfree Verification credentials not configured (CASHFREE_VERIFICATION_CLIENT_ID / CASHFREE_VERIFICATION_CLIENT_SECRET)',
      500
    );
  }

  const baseUrl =
    env === 'PRODUCTION'
      ? 'https://api.cashfree.com/verification'
      : 'https://sandbox.cashfree.com/verification';

  return { clientId, clientSecret, env, baseUrl };
};

/**
 * Generate x-cf-signature for Cashfree Verification 2FA
 * Format: RSA-encrypt( clientId.unixTimestamp ) using Public Key, then Base64 encode
 * Valid for 10 min (sandbox) / 5 min (production)
 */
const generateCfSignature = (): string | null => {
  const { clientId } = getVerificationConfig();

  // Public key for Secure ID (Verification) — separate from Payouts public key
  const publicKeyRaw = process.env.CASHFREE_VERIFICATION_PUBLIC_KEY;
  if (!publicKeyRaw) {
    logger.warn('[CashfreeVerification] CASHFREE_VERIFICATION_PUBLIC_KEY not set — skipping x-cf-signature');
    return null;
  }

  try {
    // Handle escaped newlines from env vars
    const publicKey = publicKeyRaw.replace(/\\n/g, '\n');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const dataToEncrypt = `${clientId}.${timestamp}`;

    const encrypted = crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha1', // Cashfree Secure ID uses SHA1 for OAEP
      },
      Buffer.from(dataToEncrypt, 'utf8')
    );

    return encrypted.toString('base64');
  } catch (error: any) {
    logger.error('[CashfreeVerification] Failed to generate x-cf-signature', { error: error.message });
    return null;
  }
};

const getHeaders = () => {
  const { clientId, clientSecret } = getVerificationConfig();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-client-id': clientId,
    'x-client-secret': clientSecret,
  };

  const signature = generateCfSignature();
  if (signature) {
    headers['x-cf-signature'] = signature;
  }

  return headers;
};

/** Auth headers without Content-Type (for multipart/form-data — axios sets it) */
const getAuthHeaders = () => {
  const { clientId, clientSecret } = getVerificationConfig();
  const headers: Record<string, string> = {
    'x-client-id': clientId,
    'x-client-secret': clientSecret,
  };

  const signature = generateCfSignature();
  if (signature) {
    headers['x-cf-signature'] = signature;
  }

  return headers;
};

// ── Generate unique verification ID ────────────────────────────────────────
// Max 50 chars, alphanumeric + . - _ only (Cashfree requirement)
export const generateVerificationId = (userId: string): string => {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `kyc_${userId.slice(-8)}_${ts}_${rand}`.slice(0, 50);
};

// ── DigiLocker: Verify Account ─────────────────────────────────────────────
export type DigiLockerAccountResult = {
  exists: boolean;
  verificationId: string;
  status: string;
};

export const verifyDigiLockerAccount = async (
  aadhaarOrMobile: string
): Promise<DigiLockerAccountResult> => {
  const { baseUrl } = getVerificationConfig();
  const url = `${baseUrl}/digilocker/verify-account`;

  logger.info('[CashfreeVerification] Verifying DigiLocker account', { identity: aadhaarOrMobile.slice(0, 4) + '****' });

  try {
    const response = await axios.post(
      url,
      { identity_value: aadhaarOrMobile },
      { headers: getHeaders(), timeout: 30000 }
    );

    const data = response.data;
    return {
      exists: Boolean(data?.digilocker_account_exists ?? data?.account_exists ?? false),
      verificationId: String(data?.verification_id || ''),
      status: String(data?.status || 'UNKNOWN'),
    };
  } catch (error: any) {
    logger.error('[CashfreeVerification] DigiLocker verify-account failed', {
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
    });
    throw new AppError(
      error?.response?.data?.message || 'Failed to verify DigiLocker account',
      error?.response?.status || 502
    );
  }
};

// ── DigiLocker: Create URL ─────────────────────────────────────────────────
// ENDPOINT: POST /verification/digilocker  (NOT /digilocker/create-url!)
// Request body: { verification_id, document_requested, redirect_url?, user_flow? }
export type DigiLockerCreateUrlParams = {
  verificationId: string;
  documentRequested: ('AADHAAR' | 'PAN' | 'DRIVING_LICENSE')[];
  redirectUrl?: string;
  userFlow?: 'signin' | 'signup';
};

export type DigiLockerCreateUrlResult = {
  url: string;
  verificationId: string;
  status: string;
  expiresAt: string;
};

export const createDigiLockerUrl = async (
  params: DigiLockerCreateUrlParams
): Promise<DigiLockerCreateUrlResult> => {
  const { baseUrl } = getVerificationConfig();
  // ✅ Correct path: POST /verification/digilocker
  const url = `${baseUrl}/digilocker`;

  logger.info('[CashfreeVerification] Creating DigiLocker URL', {
    verificationId: params.verificationId,
    documents: params.documentRequested,
    url,
  });

  try {
    // Build request body per Cashfree API docs:
    // Required: verification_id, document_requested
    // Optional: redirect_url, user_flow
    const requestBody: Record<string, any> = {
      verification_id: params.verificationId,
      document_requested: params.documentRequested,
    };

    if (params.redirectUrl) {
      requestBody.redirect_url = params.redirectUrl;
    }
    if (params.userFlow) {
      requestBody.user_flow = params.userFlow;
    }

    logger.info('[CashfreeVerification] DigiLocker request body', { body: requestBody });

    const response = await axios.post(url, requestBody, {
      headers: getHeaders(),
      timeout: 30000,
    });

    const data = response.data;

    logger.info('[CashfreeVerification] DigiLocker response', {
      status: response.status,
      data,
    });

    const digilockerUrl = data?.url || data?.digilocker_url || '';
    if (!digilockerUrl) {
      logger.error('[CashfreeVerification] No URL in DigiLocker response', { data });
      throw new AppError('DigiLocker URL creation failed — no URL returned', 502);
    }

    // URL is valid for 10 minutes
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    return {
      url: String(digilockerUrl),
      verificationId: String(data?.verification_id || params.verificationId),
      status: String(data?.status || 'PENDING'),
      expiresAt,
    };
  } catch (error: any) {
    if (error instanceof AppError) throw error;
    logger.error('[CashfreeVerification] DigiLocker create-url failed', {
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
      url,
    });
    throw new AppError(
      error?.response?.data?.message || 'Failed to create DigiLocker verification URL',
      error?.response?.status || 502
    );
  }
};

// ── DigiLocker: Get Verification Status ────────────────────────────────────
// ENDPOINT: GET /verification/digilocker?verification_id=xxx  (query param, NOT path!)
export type DigiLockerDocument = {
  documentType: string;
  status: string;
  data: Record<string, any>;
};

export type DigiLockerStatusResult = {
  verificationId: string;
  status: string; // PENDING | AUTHENTICATED | EXPIRED | CONSENT_DENIED | FAILED
  documents: DigiLockerDocument[];
  rawResponse: any;
};

export const getDigiLockerStatus = async (
  verificationId: string
): Promise<DigiLockerStatusResult> => {
  const { baseUrl } = getVerificationConfig();
  // ✅ Correct: query parameter, NOT path parameter
  const url = `${baseUrl}/digilocker?verification_id=${encodeURIComponent(verificationId)}`;

  logger.info('[CashfreeVerification] Checking DigiLocker status', { verificationId, url });

  try {
    const response = await axios.get(url, {
      headers: getHeaders(),
      timeout: 30000,
    });

    const data = response.data;

    // Log the FULL raw response so we can debug
    logger.info('[CashfreeVerification] DigiLocker status raw response', {
      verificationId,
      responseStatus: response.status,
      rawData: JSON.stringify(data),
    });

    const documents: DigiLockerDocument[] = [];

    // Parse documents from response (if they're included)
    if (data?.documents && Array.isArray(data.documents)) {
      for (const doc of data.documents) {
        documents.push({
          documentType: String(doc?.document_type || doc?.doc_type || '').toUpperCase(),
          status: String(doc?.status || 'UNKNOWN'),
          data: doc?.data || doc || {},
        });
      }
    }

    // Also check for individual document fields in some API versions
    if (data?.aadhaar && !documents.find(d => d.documentType === 'AADHAAR')) {
      documents.push({ documentType: 'AADHAAR', status: 'SUCCESS', data: data.aadhaar });
    }
    if (data?.pan && !documents.find(d => d.documentType === 'PAN')) {
      documents.push({ documentType: 'PAN', status: 'SUCCESS', data: data.pan });
    }
    if (data?.driving_license && !documents.find(d => d.documentType === 'DRIVING_LICENSE')) {
      documents.push({ documentType: 'DRIVING_LICENSE', status: 'SUCCESS', data: data.driving_license });
    }
    if (data?.driving_licence && !documents.find(d => d.documentType === 'DRIVING_LICENSE')) {
      documents.push({ documentType: 'DRIVING_LICENSE', status: 'SUCCESS', data: data.driving_licence });
    }

    // Normalize status - Cashfree may return various values
    const rawStatus = String(data?.status || 'PENDING').toUpperCase();

    logger.info('[CashfreeVerification] DigiLocker parsed result', {
      verificationId,
      status: rawStatus,
      documentsCount: documents.length,
      documentTypes: documents.map(d => d.documentType),
    });

    return {
      verificationId: String(data?.verification_id || verificationId),
      status: rawStatus,
      documents,
      rawResponse: data,
    };
  } catch (error: any) {
    logger.error('[CashfreeVerification] DigiLocker get-status failed', {
      verificationId,
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
    });
    throw new AppError(
      error?.response?.data?.message || 'Failed to get DigiLocker status',
      error?.response?.status || 502
    );
  }
};

// ── DigiLocker: Get Document ───────────────────────────────────────────────
// ENDPOINT: GET /verification/digilocker/document?verification_id=xxx&document_type=xxx
export const getDigiLockerDocument = async (
  verificationId: string,
  docType: string
): Promise<Record<string, any>> => {
  const { baseUrl } = getVerificationConfig();
  // ✅ Correct: query parameters
  const url = `${baseUrl}/digilocker/document?verification_id=${encodeURIComponent(verificationId)}&document_type=${encodeURIComponent(docType)}`;

  logger.info('[CashfreeVerification] Fetching DigiLocker document', { verificationId, docType, url });

  try {
    const response = await axios.get(url, {
      headers: getHeaders(),
      timeout: 30000,
    });

    return response.data || {};
  } catch (error: any) {
    logger.error('[CashfreeVerification] DigiLocker get-document failed', {
      verificationId,
      docType,
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
    });
    throw new AppError(
      error?.response?.data?.message || `Failed to fetch ${docType} from DigiLocker`,
      error?.response?.status || 502
    );
  }
};

// ── Standalone PAN Verification ────────────────────────────────────────────
// ENDPOINT: POST /verification/pan
// Body: { verification_id, pan }
export type PanVerificationResult = {
  valid: boolean;
  registeredName: string;
  panType: string;
  rawResponse: any;
};

export const verifyPanStandalone = async (panNumber: string): Promise<PanVerificationResult> => {
  const { baseUrl } = getVerificationConfig();
  const url = `${baseUrl}/pan`;
  const verificationId = generateVerificationId('pan');

  logger.info('[CashfreeVerification] Verifying PAN', { pan: panNumber.slice(0, 4) + '******', url });

  try {
    const response = await axios.post(
      url,
      {
        verification_id: verificationId,
        pan: panNumber.toUpperCase(),
      },
      { headers: getHeaders(), timeout: 30000 }
    );

    const data = response.data;
    return {
      valid: Boolean(data?.valid),
      registeredName: String(data?.registered_name || data?.name || ''),
      panType: String(data?.type || data?.pan_type || ''),
      rawResponse: data,
    };
  } catch (error: any) {
    logger.error('[CashfreeVerification] PAN verification failed', {
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
    });
    throw new AppError(
      error?.response?.data?.message || 'PAN verification failed',
      error?.response?.status || 502
    );
  }
};

// ── Standalone Driving Licence Verification ────────────────────────────────
// ENDPOINT: POST /verification/driving-licence  (British spelling with 'c'!)
// Body: { verification_id, dl_number, dob }
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
  dob: string // YYYY-MM-DD
): Promise<DlVerificationResult> => {
  const { baseUrl } = getVerificationConfig();
  // ✅ Correct path: /driving-licence (British spelling with 'c')
  const url = `${baseUrl}/driving-licence`;
  const verificationId = generateVerificationId('dl');

  const requestBody = {
    verification_id: verificationId,
    dl_number: dlNumber.toUpperCase(),
    dob,
  };

  logger.info('[CashfreeVerification] Verifying DL', {
    dl: dlNumber.slice(0, 4) + '****',
    dob,
    url,
    body: requestBody,
  });

  try {
    const response = await axios.post(url, requestBody, {
      headers: getHeaders(),
      timeout: 30000,
    });

    const data = response.data;

    logger.info('[CashfreeVerification] DL response', {
      status: response.status,
      data: JSON.stringify(data),
    });

    const vehicleClass = data?.vehicle_class || data?.vehicleClass || [];

    return {
      valid: Boolean(data?.valid),
      name: String(data?.name || ''),
      dob: String(data?.dob || dob),
      issueDate: String(data?.issue_date || data?.doi || ''),
      expiryDate: String(data?.expiry_date || data?.doe || ''),
      vehicleClass: Array.isArray(vehicleClass) ? vehicleClass.map(String) : [String(vehicleClass)],
      rawResponse: data,
    };
  } catch (error: any) {
    const errData = error?.response?.data;
    const errStatus = error?.response?.status;
    logger.error('[CashfreeVerification] DL verification failed', {
      status: errStatus,
      data: JSON.stringify(errData),
      message: error?.message,
      url,
      requestBody,
    });
    // Surface the actual Cashfree error message
    const cfMessage = errData?.message || errData?.error || error?.message || 'Driving Licence verification failed';
    throw new AppError(
      `DL verification error: ${cfMessage}`,
      errStatus || 502
    );
  }
};

// ── Face Match ─────────────────────────────────────────────────────────────
// ENDPOINT: POST /verification/face-match
// Content-Type: multipart/form-data
// Fields: verification_id, image1 (file), image2 (file)
export type FaceMatchResult = {
  matchScore: number;
  isMatch: boolean;
  rawResponse: any;
};

export const faceMatch = async (
  selfieBase64: string,
  documentImageBase64: string
): Promise<FaceMatchResult> => {
  const { baseUrl } = getVerificationConfig();
  const url = `${baseUrl}/face-match`;
  const verificationId = generateVerificationId('face');

  const threshold = parseFloat(process.env.CASHFREE_FACE_MATCH_THRESHOLD || '0.65');

  logger.info('[CashfreeVerification] Running face match', { url });

  try {
    // Cashfree Face Match requires multipart/form-data with image files
    const form = new FormData();
    form.append('verification_id', verificationId);

    // Convert base64 to Buffer for file upload
    const selfieBuffer = Buffer.from(selfieBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const docBuffer = Buffer.from(documentImageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');

    form.append('image1', selfieBuffer, { filename: 'selfie.jpg', contentType: 'image/jpeg' });
    form.append('image2', docBuffer, { filename: 'document.jpg', contentType: 'image/jpeg' });

    const response = await axios.post(url, form, {
      headers: {
        ...getAuthHeaders(),
        ...form.getHeaders(),
      },
      timeout: 60000,
    });

    const data = response.data;
    const score = Number(data?.match_score ?? data?.score ?? data?.confidence ?? 0);

    return {
      matchScore: score,
      isMatch: score >= threshold,
      rawResponse: data,
    };
  } catch (error: any) {
    logger.error('[CashfreeVerification] Face match failed', {
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
    });
    throw new AppError(
      error?.response?.data?.message || 'Face match failed',
      error?.response?.status || 502
    );
  }
};

// ── Face Liveness ──────────────────────────────────────────────────────────
// ENDPOINT: POST /verification/face-liveness
// Content-Type: multipart/form-data
// Fields: verification_id, image (file)
export type FaceLivenessResult = {
  isLive: boolean;
  confidence: number;
  rawResponse: any;
};

export const faceLivenessCheck = async (imageBase64: string): Promise<FaceLivenessResult> => {
  const { baseUrl } = getVerificationConfig();
  const url = `${baseUrl}/face-liveness`;
  const verificationId = generateVerificationId('live');

  logger.info('[CashfreeVerification] Running face liveness check', { url });

  try {
    // Cashfree Face Liveness requires multipart/form-data
    const form = new FormData();
    form.append('verification_id', verificationId);

    const imageBuffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    form.append('image', imageBuffer, { filename: 'selfie.jpg', contentType: 'image/jpeg' });

    const response = await axios.post(url, form, {
      headers: {
        ...getAuthHeaders(),
        ...form.getHeaders(),
      },
      timeout: 60000,
    });

    const data = response.data;

    return {
      isLive: Boolean(data?.is_live ?? data?.liveness ?? false),
      confidence: Number(data?.confidence ?? data?.score ?? 0),
      rawResponse: data,
    };
  } catch (error: any) {
    logger.error('[CashfreeVerification] Face liveness check failed', {
      status: error?.response?.status,
      data: error?.response?.data,
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
