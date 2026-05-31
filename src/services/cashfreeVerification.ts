/**
 * Cashfree Verification Suite — Secure ID APIs
 * ──────────────────────────────────────────────
 * Uses the Cashfree Verification REST API for:
 *   - DigiLocker (Aadhaar + PAN + Driving License in one flow)
 *   - Standalone PAN verification
 *   - Standalone Driving License verification
 *   - Face Match (selfie vs Aadhaar photo)
 *   - Face Liveness check
 *
 * Base URLs:
 *   Sandbox:    https://sandbox.cashfree.com/verification
 *   Production: https://api.cashfree.com/verification
 */
import axios from 'axios';
import crypto from 'crypto';
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

const getHeaders = () => {
  const { clientId, clientSecret } = getVerificationConfig();
  return {
    'Content-Type': 'application/json',
    'x-client-id': clientId,
    'x-client-secret': clientSecret,
  };
};

// ── Generate unique verification ID ────────────────────────────────────────
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
      error: error?.response?.data || error?.message,
    });
    throw new AppError(
      error?.response?.data?.message || 'Failed to verify DigiLocker account',
      error?.response?.status || 502
    );
  }
};

// ── DigiLocker: Create URL ─────────────────────────────────────────────────
export type DigiLockerCreateUrlParams = {
  verificationId: string;
  identityType: 'AADHAAR' | 'MOBILE';
  identityValue: string;
  documentRequested: ('AADHAAR' | 'PAN' | 'DRIVING_LICENSE')[];
  redirectUrl: string;
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
  const url = `${baseUrl}/digilocker/create-url`;

  logger.info('[CashfreeVerification] Creating DigiLocker URL', {
    verificationId: params.verificationId,
    documents: params.documentRequested,
  });

  try {
    const response = await axios.post(
      url,
      {
        verification_id: params.verificationId,
        identity_type: params.identityType,
        identity_value: params.identityValue,
        document_requested: params.documentRequested,
        redirect_url: params.redirectUrl,
      },
      { headers: getHeaders(), timeout: 30000 }
    );

    const data = response.data;

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
      error: error?.response?.data || error?.message,
    });
    throw new AppError(
      error?.response?.data?.message || 'Failed to create DigiLocker verification URL',
      error?.response?.status || 502
    );
  }
};

// ── DigiLocker: Get Verification Status ────────────────────────────────────
export type DigiLockerDocument = {
  documentType: string;
  status: string;
  data: Record<string, any>;
};

export type DigiLockerStatusResult = {
  verificationId: string;
  status: string; // PENDING | AUTHENTICATED | FAILED
  documents: DigiLockerDocument[];
  rawResponse: any;
};

export const getDigiLockerStatus = async (
  verificationId: string
): Promise<DigiLockerStatusResult> => {
  const { baseUrl } = getVerificationConfig();
  const url = `${baseUrl}/digilocker/${verificationId}`;

  logger.info('[CashfreeVerification] Checking DigiLocker status', { verificationId });

  try {
    const response = await axios.get(url, {
      headers: getHeaders(),
      timeout: 30000,
    });

    const data = response.data;
    const documents: DigiLockerDocument[] = [];

    // Parse documents from response
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

    return {
      verificationId: String(data?.verification_id || verificationId),
      status: String(data?.status || 'PENDING').toUpperCase(),
      documents,
      rawResponse: data,
    };
  } catch (error: any) {
    logger.error('[CashfreeVerification] DigiLocker get-status failed', {
      verificationId,
      error: error?.response?.data || error?.message,
    });
    throw new AppError(
      error?.response?.data?.message || 'Failed to get DigiLocker status',
      error?.response?.status || 502
    );
  }
};

// ── DigiLocker: Get Document ───────────────────────────────────────────────
export const getDigiLockerDocument = async (
  verificationId: string,
  docType: string
): Promise<Record<string, any>> => {
  const { baseUrl } = getVerificationConfig();
  const url = `${baseUrl}/digilocker/${verificationId}/document/${docType}`;

  logger.info('[CashfreeVerification] Fetching DigiLocker document', { verificationId, docType });

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
      error: error?.response?.data || error?.message,
    });
    throw new AppError(
      error?.response?.data?.message || `Failed to fetch ${docType} from DigiLocker`,
      error?.response?.status || 502
    );
  }
};

// ── Standalone PAN Verification ────────────────────────────────────────────
export type PanVerificationResult = {
  valid: boolean;
  registeredName: string;
  panType: string;
  rawResponse: any;
};

export const verifyPanStandalone = async (panNumber: string): Promise<PanVerificationResult> => {
  const { baseUrl } = getVerificationConfig();
  const url = `${baseUrl}/pan`;

  logger.info('[CashfreeVerification] Verifying PAN', { pan: panNumber.slice(0, 4) + '******' });

  try {
    const response = await axios.post(
      url,
      { pan: panNumber.toUpperCase() },
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
      error: error?.response?.data || error?.message,
    });
    throw new AppError(
      error?.response?.data?.message || 'PAN verification failed',
      error?.response?.status || 502
    );
  }
};

// ── Standalone Driving License Verification ────────────────────────────────
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
  const url = `${baseUrl}/driving-license`;

  logger.info('[CashfreeVerification] Verifying DL', { dl: dlNumber.slice(0, 4) + '****' });

  try {
    const response = await axios.post(
      url,
      { dl_number: dlNumber.toUpperCase(), dob },
      { headers: getHeaders(), timeout: 30000 }
    );

    const data = response.data;
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
    logger.error('[CashfreeVerification] DL verification failed', {
      error: error?.response?.data || error?.message,
    });
    throw new AppError(
      error?.response?.data?.message || 'Driving License verification failed',
      error?.response?.status || 502
    );
  }
};

// ── Face Match ─────────────────────────────────────────────────────────────
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

  const threshold = parseFloat(process.env.CASHFREE_FACE_MATCH_THRESHOLD || '0.65');

  logger.info('[CashfreeVerification] Running face match');

  try {
    const response = await axios.post(
      url,
      {
        first_image: selfieBase64,
        second_image: documentImageBase64,
      },
      { headers: getHeaders(), timeout: 60000 }
    );

    const data = response.data;
    const score = Number(data?.match_score ?? data?.score ?? data?.confidence ?? 0);

    return {
      matchScore: score,
      isMatch: score >= threshold,
      rawResponse: data,
    };
  } catch (error: any) {
    logger.error('[CashfreeVerification] Face match failed', {
      error: error?.response?.data || error?.message,
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

export const faceLivenessCheck = async (imageBase64: string): Promise<FaceLivenessResult> => {
  const { baseUrl } = getVerificationConfig();
  const url = `${baseUrl}/face-liveness`;

  logger.info('[CashfreeVerification] Running face liveness check');

  try {
    const response = await axios.post(
      url,
      { image: imageBase64 },
      { headers: getHeaders(), timeout: 60000 }
    );

    const data = response.data;

    return {
      isLive: Boolean(data?.is_live ?? data?.liveness ?? false),
      confidence: Number(data?.confidence ?? data?.score ?? 0),
      rawResponse: data,
    };
  } catch (error: any) {
    logger.error('[CashfreeVerification] Face liveness check failed', {
      error: error?.response?.data || error?.message,
    });
    // Liveness failure should not block — treat as a soft failure
    return {
      isLive: true, // Default to true if API fails
      confidence: 0,
      rawResponse: { error: error?.message },
    };
  }
};
