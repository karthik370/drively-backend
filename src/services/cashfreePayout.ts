/**
 * Cashfree Payouts — Driver Withdrawal Utility
 * ──────────────────────────────────────────────
 * Handles automatic money transfers to drivers via
 * Cashfree Payouts API v1 (directTransfer).
 *
 * Uses PUBLIC KEY authentication (no IP whitelisting needed).
 *
 * Separate from cashfree.ts (Payment Gateway for collecting money).
 * This service is for SENDING money to drivers.
 */
import axios from 'axios';
import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

// ── Config ─────────────────────────────────────────────────────────────────

const getPayoutConfig = () => {
  const clientId = process.env.CASHFREE_PAYOUT_CLIENT_ID;
  const clientSecret = process.env.CASHFREE_PAYOUT_CLIENT_SECRET;
  const env = process.env.CASHFREE_PAYOUT_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'TEST';

  if (!clientId || !clientSecret) {
    throw new AppError(
      'Cashfree Payout credentials are not configured (CASHFREE_PAYOUT_CLIENT_ID / CASHFREE_PAYOUT_CLIENT_SECRET)',
      500,
    );
  }

  const baseUrl =
    env === 'PRODUCTION'
      ? 'https://payout-api.cashfree.com'
      : 'https://payout-gamma.cashfree.com';

  return { clientId, clientSecret, env, baseUrl };
};

// ── RSA Signature for Public Key Auth ──────────────────────────────────────

/**
 * Generate X-Cf-Signature using RSA public key encryption.
 * Encrypts "clientId.unixTimestamp" with the public key PEM.
 * Valid for 10 min (test) / 5 min (production).
 */
const generateCfSignature = (clientId: string): string => {
  const rawKey = process.env.CASHFREE_PAYOUT_PUBLIC_KEY;
  if (!rawKey) {
    throw new AppError(
      'CASHFREE_PAYOUT_PUBLIC_KEY is not set. Download public key from Cashfree Payouts dashboard → Developers → Two-Factor Authentication → Public Key.',
      500,
    );
  }

  // dotenv stores \n as literal "\\n" — convert to real newlines
  const publicKeyPem = rawKey.replace(/\\n/g, '\n');

  const timestamp = Math.floor(Date.now() / 1000); // UNIX timestamp
  const dataToSign = `${clientId}.${timestamp}`;

  // RSA encrypt using the public key
  const encrypted = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    },
    Buffer.from(dataToSign),
  );

  return encrypted.toString('base64');
};

// ── Token Cache ────────────────────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

/**
 * Get authorization bearer token — cached for ~4 minutes.
 * POST /payout/v1/authorize
 * Uses public key signature (X-Cf-Signature) instead of IP whitelisting.
 */
export const getPayoutAuthToken = async (): Promise<string> => {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const { clientId, clientSecret, baseUrl } = getPayoutConfig();

  // Generate RSA signature for public key auth
  const signature = generateCfSignature(clientId);

  try {
    const res = await axios.post(
      `${baseUrl}/payout/v1/authorize`,
      {},
      {
        headers: {
          'x-client-id': clientId,
          'x-client-secret': clientSecret,
          'X-Cf-Signature': signature,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      },
    );

    const data = res.data?.data;
    const token = data?.token;
    const expiresAt = data?.expiry; // ISO string

    if (!token) {
      logger.error('Cashfree Payout auth failed — no token in response', { body: res.data });
      throw new AppError('Cashfree Payout authorization failed', 500);
    }

    cachedToken = token;
    // Cache for 4 minutes (token valid ~5 min)
    tokenExpiresAt = expiresAt
      ? new Date(expiresAt).getTime() - 60_000
      : Date.now() + 4 * 60_000;

    return token;
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    logger.error('Cashfree Payout auth error', {
      message: err?.response?.data || err?.message,
    });
    throw new AppError('Failed to authenticate with Cashfree Payouts', 500);
  }
};

// ── Direct Transfer ────────────────────────────────────────────────────────

export interface PayoutTransferParams {
  transferId: string;     // Unique ID (e.g. "PAY_<payoutId>")
  amount: number;         // In rupees, e.g. 500.00
  transferMode: 'upi' | 'banktransfer' | 'imps' | 'neft';
  // Beneficiary details
  beneName: string;
  benePhone: string;
  beneEmail?: string;
  // UPI (if transferMode is 'upi')
  beneVpa?: string;
  // Bank (if transferMode is 'banktransfer' / 'imps' / 'neft')
  beneBankAccount?: string;
  beneIfsc?: string;
  remarks?: string;
}

export interface PayoutTransferResult {
  status: string;         // "SUCCESS" | "PENDING" | "ERROR"
  referenceId?: string;   // Cashfree's reference ID
  subCode?: string;
  message?: string;
  acknowledged?: number;  // 1 = beneficiary received, 0 = not yet
}

/**
 * Initiate a direct transfer to a beneficiary.
 * POST /payout/v1/directTransfer
 */
export const initiatePayoutTransfer = async (
  params: PayoutTransferParams,
): Promise<PayoutTransferResult> => {
  const { baseUrl } = getPayoutConfig();
  const token = await getPayoutAuthToken();

  const body: any = {
    amount: params.amount,
    transferId: params.transferId,
    transferMode: params.transferMode,
    remarks: params.remarks || 'DriveMate driver withdrawal',
    beneDetails: {
      name: params.beneName,
      phone: params.benePhone,
      email: params.beneEmail || 'driver@drivemate.app',
      address1: 'DriveMate Driver',
    },
  };

  // Add UPI or bank details
  if (params.transferMode === 'upi') {
    body.beneDetails.vpa = params.beneVpa;
  } else {
    body.beneDetails.bankAccount = params.beneBankAccount;
    body.beneDetails.ifsc = params.beneIfsc;
  }

  try {
    const res = await axios.post(`${baseUrl}/payout/v1/directTransfer`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    });

    const resData = res.data;

    logger.info('Cashfree Payout directTransfer response', {
      transferId: params.transferId,
      status: resData?.status,
      subCode: resData?.subCode,
      message: resData?.message,
      data: resData?.data,
      fullBody: JSON.stringify(resData),
    });

    return {
      status: resData?.status || 'ERROR',
      referenceId: resData?.data?.referenceId || undefined,
      subCode: resData?.subCode || undefined,
      message: resData?.message || undefined,
      acknowledged: resData?.data?.acknowledged ?? 0,
    };
  } catch (err: any) {
    const errData = err?.response?.data;
    logger.error('Cashfree Payout directTransfer error', {
      transferId: params.transferId,
      error: errData || err?.message,
    });

    // If Cashfree returns a structured error
    if (errData?.status === 'ERROR') {
      return {
        status: 'ERROR',
        subCode: errData?.subCode,
        message: errData?.message || 'Transfer failed',
      };
    }

    throw new AppError(
      errData?.message || 'Failed to initiate payout transfer',
      500,
    );
  }
};

// ── Get Transfer Status ────────────────────────────────────────────────────

export interface PayoutTransferStatus {
  status: string;         // "SUCCESS" | "PENDING" | "FAILED" | "REVERSED"
  referenceId?: string;
  reason?: string;
  acknowledged?: number;
  transferMode?: string;
  amount?: number;
}

/**
 * Get the status of a previously initiated transfer.
 * GET /payout/v1/getTransferStatus?transferId=X
 */
export const getPayoutTransferStatus = async (
  transferId: string,
): Promise<PayoutTransferStatus> => {
  const { baseUrl } = getPayoutConfig();
  const token = await getPayoutAuthToken();

  try {
    const res = await axios.get(`${baseUrl}/payout/v1/getTransferStatus`, {
      params: { transferId },
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    });

    const transfer = res.data?.data?.transfer;

    return {
      status: transfer?.status || res.data?.status || 'UNKNOWN',
      referenceId: transfer?.referenceId || undefined,
      reason: transfer?.reason || undefined,
      acknowledged: transfer?.acknowledged ?? 0,
      transferMode: transfer?.transferMode || undefined,
      amount: transfer?.amount ? Number(transfer.amount) : undefined,
    };
  } catch (err: any) {
    logger.error('Cashfree Payout getTransferStatus error', {
      transferId,
      error: err?.response?.data || err?.message,
    });
    throw new AppError('Failed to get payout transfer status', 500);
  }
};
