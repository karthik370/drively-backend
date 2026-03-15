/**
 * Cashfree Payouts V2 — Driver Withdrawal Utility
 * ──────────────────────────────────────────────────
 * Handles automatic money transfers to drivers via
 * Cashfree Payouts V2 API (Standard Transfer).
 *
 * V2 Docs: https://docs.cashfree.com/docs/payouts-standard-transfer
 *
 * Auth Headers:
 *   x-client-id      → Client ID from Cashfree Dashboard
 *   x-client-secret   → Client Secret from Cashfree Dashboard
 *   X-Cf-Signature    → RSA encrypted "clientId.unixTimestamp" (public key 2FA)
 *   x-api-version     → "2024-01-01"
 *
 * Endpoints:
 *   POST   /payout/transfers              → Create a transfer
 *   GET    /payout/transfers/:transferId   → Get transfer status
 *
 * Base URLs:
 *   Test:  https://sandbox.cashfree.com/payout
 *   Prod:  https://api.cashfree.com/payout
 *
 * transfer_mode valid values (lowercase):
 *   "banktransfer" | "upi" | "imps" | "neft" | "rtgs" | "card"
 *
 * beneficiary_details structure:
 *   {
 *     beneficiary_id: string (unique per beneficiary)
 *     beneficiary_name: string
 *     beneficiary_phone: string (10 digits)
 *     beneficiary_email: string
 *     beneficiary_instrument_details: {
 *       // For bank: bank_account_number + bank_ifsc
 *       // For UPI:  vpa
 *     }
 *   }
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

/**
 * Generate X-Cf-Signature header value.
 * Encrypts "clientId.unixTimestamp" with the RSA public key PEM.
 * Valid for 10 min (test) / 5 min (production).
 */
const generateCfSignature = (clientId: string): string => {
  const rawKey = process.env.CASHFREE_PAYOUT_PUBLIC_KEY;
  if (!rawKey) {
    throw new AppError('CASHFREE_PAYOUT_PUBLIC_KEY env var is not set.', 500);
  }

  // dotenv stores newlines as literal "\\n" — convert to real newlines for PEM
  const publicKeyPem = rawKey.replace(/\\n/g, '\n');

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${clientId}.${timestamp}`;

  const encrypted = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    },
    Buffer.from(payload),
  );

  return encrypted.toString('base64');
};

// ────────────────────────────────────────────────────────────────────────────
// V2 Headers
// ────────────────────────────────────────────────────────────────────────────

/** Build complete auth headers for every Cashfree V2 request. */
const getV2Headers = () => {
  const { clientId, clientSecret } = getPayoutConfig();
  const signature = generateCfSignature(clientId);

  return {
    'x-client-id': clientId,
    'x-client-secret': clientSecret,
    'X-Cf-Signature': signature,
    'x-api-version': '2024-01-01',
    'Content-Type': 'application/json',
  };
};

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface PayoutTransferParams {
  transferId: string;         // Must be unique, never reuse even for retries
  amount: number;             // In INR (e.g. 500.00)
  transferMode: 'upi' | 'banktransfer' | 'imps' | 'neft';
  // Beneficiary info
  beneName: string;           // Full name
  benePhone: string;          // 10-digit phone number
  beneEmail?: string;         // Optional email
  // UPI (required when transferMode is 'upi')
  beneVpa?: string;           // e.g. "name@upi"
  // Bank (required when transferMode is 'banktransfer' | 'imps' | 'neft')
  beneBankAccount?: string;   // Account number
  beneIfsc?: string;          // IFSC code
  remarks?: string;
}

export interface PayoutTransferResult {
  status: string;             // "SUCCESS" | "PENDING" | "ERROR" | "REVERSED" | "FAILED"
  referenceId?: string;       // Cashfree's cf_transfer_id
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
// Create Beneficiary — POST /payout/beneficiaries
// V2 requires beneficiary to exist BEFORE initiating a transfer.
// ────────────────────────────────────────────────────────────────────────────

const createBeneficiary = async (
  baseUrl: string,
  beneficiaryId: string,
  name: string,
  phone: string,
  email: string,
  instrumentDetails: Record<string, string>,
): Promise<{ success: boolean; message?: string }> => {
  const headers = getV2Headers();

  const body = {
    beneficiary_id: beneficiaryId,
    beneficiary_name: name || 'DriveMate Driver',
    beneficiary_phone: phone || '9999999999',
    beneficiary_email: email || 'driver@drivemate.app',
    beneficiary_instrument_details: instrumentDetails,
  };

  try {
    await axios.post(`${baseUrl}/beneficiaries`, body, {
      headers,
      timeout: 15_000,
    });
    logger.info('Cashfree V2 beneficiary created', { beneficiaryId });
    return { success: true };
  } catch (err: any) {
    const status = err?.response?.status;
    const errData = err?.response?.data;

    // 409 = beneficiary already exists — that's fine, proceed with transfer
    if (status === 409) {
      logger.info('Cashfree V2 beneficiary already exists, proceeding', { beneficiaryId });
      return { success: true };
    }

    logger.error('Cashfree V2 create beneficiary error', {
      beneficiaryId,
      httpStatus: status,
      error: JSON.stringify(errData),
    });
    return { success: false, message: errData?.message || 'Failed to create beneficiary' };
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Create Transfer — POST /payout/transfers
// Flow: Create/reuse beneficiary → Wait for propagation → Initiate transfer
// ────────────────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const initiatePayoutTransfer = async (
  params: PayoutTransferParams,
): Promise<PayoutTransferResult> => {
  const { baseUrl } = getPayoutConfig();

  // Build beneficiary_instrument_details based on transfer mode
  const instrumentDetails: Record<string, string> = {};

  if (params.transferMode === 'upi') {
    if (!params.beneVpa) {
      return { status: 'ERROR', message: 'UPI VPA is required for UPI transfers' };
    }
    instrumentDetails.vpa = params.beneVpa;
  } else {
    if (!params.beneBankAccount || !params.beneIfsc) {
      return { status: 'ERROR', message: 'Bank account number and IFSC are required for bank transfers' };
    }
    instrumentDetails.bank_account_number = params.beneBankAccount;
    instrumentDetails.bank_ifsc = params.beneIfsc;
  }

  // Sanitize and validate phone to 10 digits
  const phone = (params.benePhone || '').replace(/\D/g, '').slice(-10);
  if (phone.length !== 10) {
    return { status: 'ERROR', message: 'Invalid phone number — must be 10 digits' };
  }

  // Use a STABLE beneficiary ID per driver (not per transfer)
  // This way the beneficiary is created once and reused for all future payouts
  const beneficiaryId = `bene_driver_${phone}`;

  // ── Step 1: Create or reuse beneficiary ──
  const beneResult = await createBeneficiary(
    baseUrl,
    beneficiaryId,
    params.beneName,
    phone,
    params.beneEmail || 'driver@drivemate.app',
    instrumentDetails,
  );

  if (!beneResult.success) {
    return { status: 'ERROR', message: beneResult.message || 'Failed to register beneficiary' };
  }

  // Wait for Cashfree to propagate the beneficiary (2 seconds)
  await delay(2000);

  // ── Step 2: Initiate transfer — ONLY beneficiary_id, no other fields ──
  const headers = getV2Headers();

  const body = {
    transfer_id: params.transferId,
    transfer_amount: params.amount,
    transfer_mode: params.transferMode,
    remarks: params.remarks || 'DriveMate driver withdrawal',
    beneficiary_details: {
      beneficiary_id: beneficiaryId,  // ONLY the id — no other fields
    },
  };

  logger.info('Cashfree V2 transfer request', {
    transferId: params.transferId,
    amount: params.amount,
    mode: params.transferMode,
    beneficiaryId,
    body: JSON.stringify(body),
  });

  try {
    const res = await axios.post(`${baseUrl}/transfers`, body, {
      headers,
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

    // Return structured error instead of throwing
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
  const headers = getV2Headers();

  try {
    const res = await axios.get(`${baseUrl}/transfers/${transferId}`, {
      headers,
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
