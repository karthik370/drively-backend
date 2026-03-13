/**
 * Cashfree Payment Gateway — Shared Utility
 * ──────────────────────────────────────────
 * Uses the Cashfree REST API directly (via axios) for order creation
 * and the cashfree-pg SDK only for webhook verification.
 *
 * Direct REST calls give us full control over request/response handling
 * and avoid SDK version compatibility issues.
 */
import axios from 'axios';
import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

// ── Config ─────────────────────────────────────────────────────────────────
const getCashfreeConfig = () => {
  const appId = process.env.CASHFREE_APP_ID;
  const secretKey = process.env.CASHFREE_SECRET_KEY;
  const env = process.env.CASHFREE_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';

  if (!appId || !secretKey) {
    throw new AppError('Cashfree credentials are not configured (CASHFREE_APP_ID / CASHFREE_SECRET_KEY)', 500);
  }

  const baseUrl =
    env === 'PRODUCTION'
      ? 'https://api.cashfree.com/pg'
      : 'https://sandbox.cashfree.com/pg';

  return { appId, secretKey, env, baseUrl };
};

// ── Create Order ───────────────────────────────────────────────────────────
export type CashfreeOrderResult = {
  cfOrderId: string;
  orderId: string;
  paymentSessionId: string;
  orderAmount: number;
  orderCurrency: string;
};

/**
 * Creates a Cashfree order using the REST API directly.
 * @param amount — In **Rupees** (NOT paise). e.g. 500 for ₹500
 */
export const createCashfreeOrder = async (params: {
  orderId: string;
  amount: number;
  currency?: string;
  customerId: string;
  customerPhone: string;
  customerEmail?: string;
  customerName?: string;
  orderNote?: string;
  orderTags?: Record<string, string>;
}): Promise<CashfreeOrderResult> => {
  const { appId, secretKey, baseUrl } = getCashfreeConfig();

  const requestBody = {
    order_id: params.orderId,
    order_amount: params.amount,
    order_currency: params.currency || 'INR',
    customer_details: {
      customer_id: params.customerId,
      customer_phone: params.customerPhone,
      customer_email: params.customerEmail || undefined,
      customer_name: params.customerName || undefined,
    },
    order_note: params.orderNote,
    order_tags: params.orderTags,
  };

  logger.info('[Cashfree] Creating order', {
    orderId: params.orderId,
    amount: params.amount,
    url: `${baseUrl}/orders`,
  });

  const response = await axios.post(`${baseUrl}/orders`, requestBody, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-version': '2023-08-01',
      'x-client-id': appId,
      'x-client-secret': secretKey,
    },
  });

  const order = response.data;

  logger.info('[Cashfree] Order created', {
    order_id: order?.order_id,
    cf_order_id: order?.cf_order_id,
    payment_session_id: order?.payment_session_id ? 'present' : 'MISSING',
    order_status: order?.order_status,
  });

  const sessionId = order?.payment_session_id;
  const orderId = order?.order_id;

  if (!sessionId || !orderId) {
    logger.error('[Cashfree] Missing payment_session_id or order_id in response', {
      responseData: JSON.stringify(order, null, 2),
    });
    throw new AppError('Cashfree order creation failed — missing session/order ID', 500);
  }

  return {
    cfOrderId: String(order.cf_order_id || orderId),
    orderId: String(orderId),
    paymentSessionId: String(sessionId),
    orderAmount: Number(order.order_amount),
    orderCurrency: String(order.order_currency || 'INR'),
  };
};

// ── Verify Payment by fetching order status ────────────────────────────────
export type CashfreePaymentStatus = {
  isPaid: boolean;
  orderStatus: string;
  cfPaymentId?: string;
};

export const verifyCashfreePayment = async (orderId: string): Promise<CashfreePaymentStatus> => {
  const { appId, secretKey, baseUrl } = getCashfreeConfig();

  const response = await axios.get(`${baseUrl}/orders/${orderId}`, {
    headers: {
      'x-api-version': '2023-08-01',
      'x-client-id': appId,
      'x-client-secret': secretKey,
    },
  });

  const order = response.data;
  const status = String(order?.order_status || '').toUpperCase();
  const isPaid = status === 'PAID';

  // Try to get the cf_payment_id from payments
  let cfPaymentId: string | undefined;
  try {
    const paymentsResp = await axios.get(`${baseUrl}/orders/${orderId}/payments`, {
      headers: {
        'x-api-version': '2023-08-01',
        'x-client-id': appId,
        'x-client-secret': secretKey,
      },
    });
    const payments = paymentsResp.data;
    if (Array.isArray(payments) && payments.length > 0) {
      const successPayment = payments.find((p: any) => String(p.payment_status).toUpperCase() === 'SUCCESS');
      if (successPayment) {
        cfPaymentId = String(successPayment.cf_payment_id || '');
      }
    }
  } catch {
    // Payment fetch is optional — order status is enough
  }

  return { isPaid, orderStatus: status, cfPaymentId };
};

// ── Webhook Signature Verification ─────────────────────────────────────────
export const verifyCashfreeWebhook = (params: {
  signature: string;
  rawBody: string;
  timestamp: string;
}): boolean => {
  const { secretKey } = getCashfreeConfig();

  try {
    // Cashfree uses HMAC-SHA256 for webhook verification
    const payload = params.timestamp + params.rawBody;
    const expectedSignature = crypto
      .createHmac('sha256', secretKey)
      .update(payload)
      .digest('base64');

    return expectedSignature === params.signature;
  } catch {
    return false;
  }
};

/**
 * Generate a unique Cashfree-safe order ID.
 * Cashfree requires alphanumeric + `_` + `-` only, max 50 chars.
 */
export const generateOrderId = (prefix: string, uniquePart: string): string => {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `${prefix}_${uniquePart.slice(-8)}_${ts}_${rand}`.slice(0, 50);
};
