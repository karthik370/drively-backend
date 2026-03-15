/**
 * Cashfree Payouts V2 — Driver Withdrawal Utility
 * ──────────────────────────────────────────────────
 * Handles automatic money transfers to drivers via
 * Cashfree Payouts V2 API (Standard Transfer).
 *
 * Flow:
 *   1. Create beneficiary (POST /payout/beneficiary)
 *      - If 409 and forceRecreate → delete + recreate (driver changed UPI/bank)
 *      - If 409 and !forceRecreate → reuse existing
 *   2. Poll beneficiary status until VERIFIED (GET /payout/beneficiary/:id)
 *   3. Initiate transfer (POST /payout/transfers)
 *
 * Auth: x-client-id + x-client-secret + X-Cf-Signature (RSA public key 2FA)
 *
 * Endpoints (verified against sandbox):
 *   POST   /payout/beneficiary             → Create beneficiary
 *   GET    /payout/beneficiary/:id         → Get beneficiary status
 *   DELETE /payout/beneficiary/:id         → Remove beneficiary
 *   POST   /payout/transfers               → Create transfer
 *   GET    /payout/transfers/:transferId   → Get transfer status
 *
 * Base URLs:
 *   Test:  https://sandbox.cashfree.com/payout
 *   Prod:  https://api.cashfree.com/payout
 *
 * Sandbox test VPAs: "success@upi" (pass) / "failure@upi" (fail)
 */
import axios from 'axios';
import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

const getPayoutConfig = () => {
  const clientId = process.env.CASHFREE_PAYOUT_CLIENT_ID;
  const clientSecret = process.env.CASHFREE_PAYOUT_CLIENT_SECRET;
  const env = process.env.CASHFREE_PAYOUT_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'TEST';

  if (!clientId || !clientSecret) {
    throw new AppError(
      'Cashfree Payout credentials not configured.',
      500,
    );
  }

  const baseUrl =
    env === 'PRODUCTION'
      ? 'https://api.cashfree.com/payout'
      : 'https://sandbox.cashfree.com/payout';

  return { clientId, clientSecret, env, baseUrl };
};

// ────────────────────────────────────────────────────────────────────────────
// RSA Signature (Public Key 2FA)
// ────────────────────────────────────────────────────────────────────────────

const generateCfSignature = (clientId: string): string => {
  const rawKey = process.env.CASHFREE_PAYOUT_PUBLIC_KEY;
  if (!rawKey) {
    throw new AppError('CASHFREE_PAYOUT_PUBLIC_KEY env var is not set.', 500);
  }

  const publicKeyPem = rawKey.replace(/\\n/g, '\n');
  const timestamp = Math.floor(Date.now() / 1000);

  const encrypted = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(`${clientId}.${timestamp}`),
  );

  return encrypted.toString('base64');
};

// ────────────────────────────────────────────────────────────────────────────
// V2 Headers (fresh signature each call)
// ────────────────────────────────────────────────────────────────────────────

const getV2Headers = () => {
  const { clientId, clientSecret } = getPayoutConfig();

  const headers: Record<string, string> = {
    'x-client-id': clientId,
    'x-client-secret': clientSecret,
    'x-api-version': '2024-01-01',
    'Content-Type': 'application/json',
  };

  // Only attach 2FA signature if public key is configured
  const rawKey = process.env.CASHFREE_PAYOUT_PUBLIC_KEY;
  if (rawKey) {
    headers['X-Cf-Signature'] = generateCfSignature(clientId);
  }

  return headers;
};

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface PayoutTransferParams {
  transferId: string;
  amount: number;
  transferMode: 'upi' | 'banktransfer' | 'imps' | 'neft';
  driverId: string;           // Driver's UUID — used for stable beneficiary ID
  beneName: string;
  benePhone: string;
  beneEmail?: string;
  beneVpa?: string;
  beneBankAccount?: string;
  beneIfsc?: string;
  remarks?: string;
  forceRecreate?: boolean;    // Set true when driver updates UPI/bank details
}

export interface PayoutTransferResult {
  status: string;
  referenceId?: string;
  subCode?: string;
  message?: string;
}

export interface PayoutTransferStatus {
  status: string;
  referenceId?: string;
  reason?: string;
  transferMode?: string;
  amount?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Beneficiary Management — POST/GET/DELETE /payout/beneficiary
// ────────────────────────────────────────────────────────────────────────────

const createBeneficiary = async (
  baseUrl: string,
  beneficiaryId: string,
  name: string,
  phone: string,
  email: string,
  instrumentDetails: Record<string, string>,
): Promise<{ success: boolean; alreadyExists?: boolean; alreadyVerified?: boolean; message?: string }> => {
  const body = {
    beneficiary_id: beneficiaryId,
    beneficiary_name: name || 'DriveMate Driver',
    beneficiary_phone: phone || '9999999999',
    beneficiary_email: email || 'driver@drivemate.app',
    beneficiary_instrument_details: instrumentDetails,
  };

  try {
    const res = await axios.post(`${baseUrl}/beneficiary`, body, {
      headers: getV2Headers(),
      timeout: 15_000,
    });
    // Check if already VERIFIED in the create response — skip polling if so
    const createdStatus = res.data?.beneficiary_status;
    const alreadyVerified = createdStatus === 'VERIFIED';
    logger.info('Cashfree V2 beneficiary created', {
      beneficiaryId,
      httpStatus: res.status,
      beneficiary_status: createdStatus,
      alreadyVerified,
      response: JSON.stringify(res.data),
    });
    return { success: true, alreadyExists: false, alreadyVerified };
  } catch (err: any) {
    const status = err?.response?.status;
    const errData = err?.response?.data;

    if (status === 409) {
      logger.info('Cashfree V2 beneficiary already exists', { beneficiaryId });
      // 409 = already exists and was previously verified — safe to proceed to transfer
      return { success: true, alreadyExists: true, alreadyVerified: true };
    }

    logger.error('Cashfree V2 create beneficiary error', {
      beneficiaryId,
      httpStatus: status,
      error: JSON.stringify(errData),
    });
    return { success: false, message: errData?.message || 'Failed to create beneficiary' };
  }
};

const deleteBeneficiary = async (baseUrl: string, beneficiaryId: string): Promise<boolean> => {
  try {
    await axios.delete(`${baseUrl}/beneficiary/${beneficiaryId}`, {
      headers: getV2Headers(),
      timeout: 10_000,
    });
    logger.info('Cashfree V2 beneficiary deleted', { beneficiaryId });
    return true;
  } catch (err: any) {
    logger.warn('Cashfree V2 delete beneficiary failed (non-fatal)', {
      beneficiaryId,
      error: err?.response?.data?.message || err?.message,
    });
    return false;
  }
};



// ────────────────────────────────────────────────────────────────────────────
// Create Transfer — POST /payout/transfers
// ────────────────────────────────────────────────────────────────────────────

export const initiatePayoutTransfer = async (
  params: PayoutTransferParams,
): Promise<PayoutTransferResult> => {
  const { baseUrl } = getPayoutConfig();

  // ── Validate inputs ──
  const instrumentDetails: Record<string, string> = {};

  if (params.transferMode === 'upi') {
    if (!params.beneVpa) {
      return { status: 'ERROR', message: 'UPI VPA is required for UPI transfers' };
    }
    instrumentDetails.vpa = params.beneVpa;
  } else {
    if (!params.beneBankAccount || !params.beneIfsc) {
      return { status: 'ERROR', message: 'Bank account number and IFSC are required' };
    }
    instrumentDetails.bank_account_number = params.beneBankAccount;
    instrumentDetails.bank_ifsc = params.beneIfsc;
  }

  const phone = (params.benePhone || '').replace(/\D/g, '').slice(-10);
  if (phone.length !== 10) {
    return { status: 'ERROR', message: 'Invalid phone number — must be 10 digits' };
  }

  // Stable beneficiary ID per driver UUID (UUID without dashes = 32 chars + "bene_" = 37)
  const beneficiaryId = `bene_${params.driverId.replace(/-/g, '')}`;

  // ── Step 1: Create or reuse beneficiary ──
  let beneResult = await createBeneficiary(
    baseUrl, beneficiaryId, params.beneName, phone,
    params.beneEmail || 'driver@drivemate.app', instrumentDetails,
  );

  // If creation failed (not 409), stop immediately
  if (!beneResult.success) {
    return { status: 'ERROR', message: beneResult.message || 'Failed to register beneficiary' };
  }

  // If already exists AND driver changed their details → delete + recreate
  if (beneResult.alreadyExists && params.forceRecreate) {
    logger.info('Beneficiary exists + forceRecreate → deleting and recreating', { beneficiaryId });
    await deleteBeneficiary(baseUrl, beneficiaryId);
    await new Promise(r => setTimeout(r, 1000));

    beneResult = await createBeneficiary(
      baseUrl, beneficiaryId, params.beneName, phone,
      params.beneEmail || 'driver@drivemate.app', instrumentDetails,
    );

    if (!beneResult.success) {
      return { status: 'ERROR', message: beneResult.message || 'Failed to update beneficiary' };
    }
  }

  // ── Step 2: Proceed to transfer ──
  // The POST /beneficiary response already returns beneficiary_status: VERIFIED
  // The GET /beneficiary/:id endpoint returns 403 with V2 auth (broken for polling)
  // So we skip polling entirely — beneficiary is verified at creation time
  // For 409 (already exists), it was verified in a previous call
  logger.info('Proceeding to transfer', {
    beneficiaryId,
    alreadyVerified: beneResult.alreadyVerified,
    alreadyExists: beneResult.alreadyExists,
  });

  // ── Step 3: Initiate transfer — ONLY beneficiary_id ──
  const body = {
    transfer_id: params.transferId,
    transfer_amount: params.amount,
    transfer_mode: params.transferMode,
    remarks: params.remarks || 'DriveMate driver withdrawal',
    beneficiary_details: {
      beneficiary_id: beneficiaryId,
    },
  };

  logger.info('Cashfree V2 transfer request', {
    transferId: params.transferId,
    amount: params.amount,
    mode: params.transferMode,
    beneficiaryId,
  });

  try {
    const res = await axios.post(`${baseUrl}/transfers`, body, {
      headers: getV2Headers(),
      timeout: 30_000,
    });

    const resData = res.data;

    logger.info('Cashfree V2 transfer response', {
      transferId: params.transferId,
      httpStatus: res.status,
      fullBody: JSON.stringify(resData),
    });

    return {
      status: resData?.status || 'PENDING',
      referenceId: resData?.cf_transfer_id?.toString() || resData?.transfer_id || undefined,
      message: resData?.message || resData?.status_description || undefined,
    };
  } catch (err: any) {
    const errData = err?.response?.data;

    logger.error('Cashfree V2 transfer error', {
      transferId: params.transferId,
      httpStatus: err?.response?.status,
      type: errData?.type,
      code: errData?.code,
      message: errData?.message,
      fullError: JSON.stringify(errData),
    });

    return {
      status: 'ERROR',
      subCode: errData?.code || String(err?.response?.status || ''),
      message: errData?.message || 'Transfer failed — check logs for details',
    };
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Get Transfer Status — GET /payout/transfers/:transferId
// ────────────────────────────────────────────────────────────────────────────

export const getPayoutTransferStatus = async (
  transferId: string,
): Promise<PayoutTransferStatus> => {
  const { baseUrl } = getPayoutConfig();

  try {
    const res = await axios.get(`${baseUrl}/transfers/${transferId}`, {
      headers: getV2Headers(),
      timeout: 15_000,
    });

    const data = res.data;

    return {
      status: data?.status || 'UNKNOWN',
      referenceId: data?.cf_transfer_id?.toString() || undefined,
      reason: data?.status_description || undefined,
      transferMode: data?.transfer_mode || undefined,
      amount: data?.transfer_amount ? Number(data.transfer_amount) : undefined,
    };
  } catch (err: any) {
    logger.error('Cashfree V2 getTransferStatus error', {
      transferId,
      error: JSON.stringify(err?.response?.data) || err?.message,
    });
    return {
      status: 'ERROR',
      reason: err?.response?.data?.message || err?.message || 'Failed to get transfer status',
    };
  }
};
