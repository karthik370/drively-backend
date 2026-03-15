/**
 * Cashfree Payouts V2 — Driver Withdrawal Utility
 * ──────────────────────────────────────────────────
 * Handles automatic money transfers to drivers via
 * Cashfree Payouts V2 API (Standard Transfer).
 *
 * Flow:
 *   1. Create beneficiary (POST /payout/beneficiary)
 *      - If 409 (already exists) and details changed → delete + recreate
 *   2. Poll beneficiary status until VERIFIED (GET /payout/beneficiary/:id)
 *   3. Initiate transfer (POST /payout/transfers)
 *
 * Auth Headers:
 *   x-client-id      → Client ID from Cashfree Dashboard
 *   x-client-secret  → Client Secret from Cashfree Dashboard
 *   X-Cf-Signature   → RSA encrypted "clientId.unixTimestamp" (public key 2FA)
 *   x-api-version    → "2024-01-01"
 *
 * Endpoints:
 *   POST   /payout/beneficiary             → Create a beneficiary (singular!)
 *   GET    /payout/beneficiary/:id         → Get beneficiary status
 *   DELETE /payout/beneficiary/:id         → Remove beneficiary (for re-creation)
 *   POST   /payout/transfers               → Create a transfer (plural!)
 *   GET    /payout/transfers/:transferId   → Get transfer status
 *
 * Base URLs:
 *   Test:  https://sandbox.cashfree.com/payout
 *   Prod:  https://api.cashfree.com/payout
 *
 * transfer_mode valid values (lowercase):
 *   "banktransfer" | "upi" | "imps" | "neft" | "rtgs" | "card"
 *
 * Sandbox test VPAs:
 *   "success@upi" → verifies successfully
 *   "failure@upi" → fails verification
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
      'Cashfree Payout credentials not configured. Set CASHFREE_PAYOUT_CLIENT_ID and CASHFREE_PAYOUT_CLIENT_SECRET.',
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
  const payload = `${clientId}.${timestamp}`;

  const encrypted = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(payload),
  );

  return encrypted.toString('base64');
};

// ────────────────────────────────────────────────────────────────────────────
// V2 Headers (fresh signature each call)
// ────────────────────────────────────────────────────────────────────────────

const getV2Headers = () => {
  const { clientId, clientSecret } = getPayoutConfig();
  return {
    'x-client-id': clientId,
    'x-client-secret': clientSecret,
    'X-Cf-Signature': generateCfSignature(clientId),
    'x-api-version': '2024-01-01',
    'Content-Type': 'application/json',
  };
};

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface PayoutTransferParams {
  transferId: string;
  amount: number;
  transferMode: 'upi' | 'banktransfer' | 'imps' | 'neft';
  beneName: string;
  benePhone: string;
  beneEmail?: string;
  beneVpa?: string;
  beneBankAccount?: string;
  beneIfsc?: string;
  remarks?: string;
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

/** Create a beneficiary. Returns success=true if created or already exists. */
const createBeneficiary = async (
  baseUrl: string,
  beneficiaryId: string,
  name: string,
  phone: string,
  email: string,
  instrumentDetails: Record<string, string>,
): Promise<{ success: boolean; alreadyExists?: boolean; message?: string }> => {
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
    logger.info('Cashfree V2 beneficiary created', {
      beneficiaryId,
      httpStatus: res.status,
      response: JSON.stringify(res.data),
    });
    return { success: true, alreadyExists: false };
  } catch (err: any) {
    const status = err?.response?.status;
    const errData = err?.response?.data;

    // 409 = already exists — fine, will reuse
    if (status === 409) {
      logger.info('Cashfree V2 beneficiary already exists', { beneficiaryId });
      return { success: true, alreadyExists: true };
    }

    logger.error('Cashfree V2 create beneficiary error', {
      beneficiaryId,
      httpStatus: status,
      error: JSON.stringify(errData),
    });
    return { success: false, message: errData?.message || 'Failed to create beneficiary' };
  }
};

/** Delete a beneficiary (to recreate with updated UPI/Bank details). */
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
// Poll Beneficiary Status — wait until VERIFIED
// ────────────────────────────────────────────────────────────────────────────

const waitForBeneficiaryVerified = async (
  baseUrl: string,
  beneficiaryId: string,
  maxAttempts = 10,
  intervalMs = 2000,
): Promise<boolean> => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await axios.get(`${baseUrl}/beneficiary/${beneficiaryId}`, {
        headers: getV2Headers(),
        timeout: 10_000,
      });

      const beneStatus = res.data?.beneficiary_status;
      logger.info('Cashfree beneficiary status check', { beneficiaryId, beneStatus, attempt });

      if (beneStatus === 'VERIFIED') return true;
      if (['INVALID', 'FAILED', 'CANCELLED', 'DELETED'].includes(beneStatus)) {
        logger.error('Cashfree beneficiary verification failed', { beneficiaryId, beneStatus });
        return false;
      }
      // INITIATED — keep polling
    } catch (err: any) {
      logger.warn('Cashfree beneficiary status check error', {
        beneficiaryId,
        attempt,
        error: err?.response?.data?.message || err?.message,
      });
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  logger.error('Cashfree beneficiary VERIFIED timeout after max attempts', { beneficiaryId, maxAttempts });
  return false;
};

// ────────────────────────────────────────────────────────────────────────────
// Create Transfer — POST /payout/transfers
// Full flow: Create/reuse beneficiary → Poll VERIFIED → Transfer
// ────────────────────────────────────────────────────────────────────────────

export const initiatePayoutTransfer = async (
  params: PayoutTransferParams,
): Promise<PayoutTransferResult> => {
  const { baseUrl } = getPayoutConfig();

  // Build beneficiary_instrument_details
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

  // Validate phone
  const phone = (params.benePhone || '').replace(/\D/g, '').slice(-10);
  if (phone.length !== 10) {
    return { status: 'ERROR', message: 'Invalid phone number — must be 10 digits' };
  }

  // Stable beneficiary ID per driver phone
  const beneficiaryId = `bene_driver_${phone}`;

  // ── Step 1: Create or reuse beneficiary ──
  const beneResult = await createBeneficiary(
    baseUrl, beneficiaryId, params.beneName, phone,
    params.beneEmail || 'driver@drivemate.app', instrumentDetails,
  );

  // If already exists, driver may have changed UPI/bank details →
  // delete old beneficiary and recreate with new details
  if (beneResult.alreadyExists) {
    logger.info('Beneficiary exists — deleting and recreating with latest details', { beneficiaryId });
    await deleteBeneficiary(baseUrl, beneficiaryId);
    // Small wait for deletion propagation
    await new Promise(r => setTimeout(r, 1000));

    const recreateResult = await createBeneficiary(
      baseUrl, beneficiaryId, params.beneName, phone,
      params.beneEmail || 'driver@drivemate.app', instrumentDetails,
    );

    if (!recreateResult.success) {
      return { status: 'ERROR', message: recreateResult.message || 'Failed to update beneficiary details' };
    }
  }

  if (!beneResult.success && !beneResult.alreadyExists) {
    return { status: 'ERROR', message: beneResult.message || 'Failed to register beneficiary' };
  }

  // ── Step 2: Poll until beneficiary is VERIFIED ──
  const isVerified = await waitForBeneficiaryVerified(baseUrl, beneficiaryId);
  if (!isVerified) {
    return {
      status: 'ERROR',
      message: 'Beneficiary verification failed or timed out. Please check your UPI ID / bank details and try again.',
    };
  }

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
    const httpStatus = err?.response?.status;

    logger.error('Cashfree V2 transfer error', {
      transferId: params.transferId,
      httpStatus,
      type: errData?.type,
      code: errData?.code,
      message: errData?.message,
      fullError: JSON.stringify(errData),
    });

    return {
      status: 'ERROR',
      subCode: errData?.code || String(httpStatus || ''),
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
    throw new AppError('Failed to get payout transfer status', 500);
  }
};
