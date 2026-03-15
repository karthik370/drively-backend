/**
 * Cashfree Payouts V2 — Driver Withdrawal Utility
 * ──────────────────────────────────────────────────
 * Handles automatic money transfers to drivers via
 * Cashfree Payouts V2 API (Standard Transfer).
 *
 * Auth: x-client-id + x-client-secret + X-Cf-Signature (RSA public key 2FA)
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

  // V2 base URLs
  const baseUrl =
    env === 'PRODUCTION'
      ? 'https://api.cashfree.com/payout'
      : 'https://sandbox.cashfree.com/payout';

  return { clientId, clientSecret, env, baseUrl };
};

// ── RSA Signature for Public Key 2FA ───────────────────────────────────────

/**
 * Generate X-Cf-Signature using RSA public key encryption.
 * Encrypts "clientId.unixTimestamp" with the public key PEM.
 * Required because user has enabled Public Key 2FA on Cashfree dashboard.
 */
const generateCfSignature = (clientId: string): string => {
  const rawKey = process.env.CASHFREE_PAYOUT_PUBLIC_KEY;
  if (!rawKey) {
    throw new AppError(
      'CASHFREE_PAYOUT_PUBLIC_KEY is not set.',
      500,
    );
  }

  // dotenv stores \n as literal "\\n" — convert to real newlines for valid PEM
  const publicKeyPem = rawKey.replace(/\\n/g, '\n');

  const timestamp = Math.floor(Date.now() / 1000);
  const dataToSign = `${clientId}.${timestamp}`;

  const encrypted = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    },
    Buffer.from(dataToSign),
  );

  return encrypted.toString('base64');
};

/**
 * Get V2 auth headers including RSA signature for 2FA.
 */
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

// ── Standard Transfer (V2) ─────────────────────────────────────────────────

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
  acknowledged?: number;
}

/**
 * Initiate a standard transfer to a beneficiary.
 * POST /payout/transfers (V2 API)
 */
export const initiatePayoutTransfer = async (
  params: PayoutTransferParams,
): Promise<PayoutTransferResult> => {
  const { baseUrl } = getPayoutConfig();
  const headers = getV2Headers();

  const beneficiary: any = {
    beneficiary_id: `bene_${params.transferId}`,
    beneficiary_name: params.beneName,
    beneficiary_phone: params.benePhone,
    beneficiary_email: params.beneEmail || 'driver@drivemate.app',
  };

  if (params.transferMode === 'upi') {
    beneficiary.beneficiary_vpa = params.beneVpa;
  } else {
    beneficiary.beneficiary_account_number = params.beneBankAccount;
    beneficiary.beneficiary_ifsc = params.beneIfsc;
  }

  const body = {
    transfer_id: params.transferId,
    transfer_amount: params.amount,
    transfer_mode: params.transferMode === 'upi' ? 'UPI' : 'BANKTRANSFER',
    remarks: params.remarks || 'DriveMate driver withdrawal',
    beneficiary_details: beneficiary,
  };

  try {
    const res = await axios.post(`${baseUrl}/transfers`, body, {
      headers,
      timeout: 30_000,
    });

    const resData = res.data;

    logger.info('Cashfree Payout V2 transfer response', {
      transferId: params.transferId,
      status: resData?.status,
      message: resData?.message,
      cfTransferId: resData?.cf_transfer_id,
      fullBody: JSON.stringify(resData),
    });

    return {
      status: resData?.status || 'ERROR',
      referenceId: resData?.cf_transfer_id?.toString() || resData?.transfer_id || undefined,
      message: resData?.message || undefined,
    };
  } catch (err: any) {
    const errData = err?.response?.data;
    logger.error('Cashfree Payout V2 transfer error', {
      transferId: params.transferId,
      status: err?.response?.status,
      error: JSON.stringify(errData) || err?.message,
    });

    if (errData) {
      return {
        status: 'ERROR',
        subCode: String(err?.response?.status || ''),
        message: errData?.message || errData?.error || 'Transfer failed',
      };
    }

    throw new AppError(
      errData?.message || 'Failed to initiate payout transfer',
      500,
    );
  }
};

// ── Get Transfer Status (V2) ───────────────────────────────────────────────

export interface PayoutTransferStatus {
  status: string;
  referenceId?: string;
  reason?: string;
  acknowledged?: number;
  transferMode?: string;
  amount?: number;
}

/**
 * Get the status of a previously initiated transfer.
 * GET /payout/transfers/:transferId (V2 API)
 */
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
      acknowledged: data?.status === 'SUCCESS' ? 1 : 0,
      transferMode: data?.transfer_mode || undefined,
      amount: data?.transfer_amount ? Number(data.transfer_amount) : undefined,
    };
  } catch (err: any) {
    logger.error('Cashfree Payout V2 getTransferStatus error', {
      transferId,
      error: err?.response?.data || err?.message,
    });
    throw new AppError('Failed to get payout transfer status', 500);
  }
};
