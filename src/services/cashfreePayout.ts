/**
 * Cashfree Payouts V2 — Driver Withdrawal Utility
 * ──────────────────────────────────────────────────
 * Handles automatic money transfers to drivers via
 * Cashfree Payouts V2 API (Standard Transfer).
 *
 * V2 uses direct x-client-id / x-client-secret headers.
 * No separate authorize step or bearer token needed.
 *
 * Separate from cashfree.ts (Payment Gateway for collecting money).
 * This service is for SENDING money to drivers.
 */
import axios from 'axios';
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

  // V2 uses different base URLs than V1
  const baseUrl =
    env === 'PRODUCTION'
      ? 'https://api.cashfree.com/payout'
      : 'https://sandbox.cashfree.com/payout';

  return { clientId, clientSecret, env, baseUrl };
};

/**
 * Get common V2 auth headers — no token needed, just client ID + secret.
 */
const getV2Headers = () => {
  const { clientId, clientSecret } = getPayoutConfig();
  return {
    'x-client-id': clientId,
    'x-client-secret': clientSecret,
    'x-api-version': '2024-01-01',
    'Content-Type': 'application/json',
  };
};

// ── Standard Transfer (V2) ─────────────────────────────────────────────────

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

  // Build beneficiary details based on transfer mode
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

    // If Cashfree returns a structured error, return it gracefully
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
