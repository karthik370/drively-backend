/**
 * Cashfree Payment Gateway — Shared Utility
 * ──────────────────────────────────────────
 * Centralises Cashfree client initialisation, order creation,
 * payment verification and webhook validation so every service
 * file can import helpers instead of duplicating boilerplate.
 */
import { Cashfree, CFEnvironment, CreateOrderRequest, OrderEntity } from 'cashfree-pg';
import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

// ── Singleton client ───────────────────────────────────────────────────────
let _client: Cashfree | null = null;

export const getCashfreeClient = (): Cashfree => {
  if (_client) return _client;

  const appId = process.env.CASHFREE_APP_ID;
  const secretKey = process.env.CASHFREE_SECRET_KEY;

  if (!appId || !secretKey) {
    throw new AppError('Cashfree credentials are not configured (CASHFREE_APP_ID / CASHFREE_SECRET_KEY)', 500);
  }

  const env =
    process.env.CASHFREE_ENV === 'PRODUCTION'
      ? CFEnvironment.PRODUCTION
      : CFEnvironment.SANDBOX;

  _client = new Cashfree(env, appId, secretKey);
  return _client;
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
 * Creates a Cashfree order.
 * @param amount  — In **Rupees** (NOT paise).  e.g. 500 for ₹500
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
  const cf = getCashfreeClient();

  const request: CreateOrderRequest = {
    order_id: params.orderId,
    order_amount: params.amount,
    order_currency: params.currency || 'INR',
    customer_details: {
      customer_id: params.customerId,
      customer_phone: params.customerPhone,
      customer_email: params.customerEmail,
      customer_name: params.customerName,
    },
    order_note: params.orderNote,
    order_tags: params.orderTags,
  };

  const response = await cf.PGCreateOrder(request);

  // cashfree-pg SDK v5 may return data at different nesting levels.
  // Try: response.data  →  response itself  →  response.data.data
  const raw = response as any;
  const order: any =
    (raw?.data?.payment_session_id ? raw.data : null) ||
    (raw?.payment_session_id ? raw : null) ||
    (raw?.data?.data?.payment_session_id ? raw.data.data : null) ||
    raw?.data ||
    raw;

  logger.info('[Cashfree] PGCreateOrder response', {
    responseKeys: Object.keys(raw || {}),
    dataKeys: Object.keys(raw?.data || {}),
    order_id: order?.order_id,
    cf_order_id: order?.cf_order_id,
    payment_session_id: order?.payment_session_id ? 'present' : 'MISSING',
  });

  const sessionId = order?.payment_session_id;
  const orderId = order?.order_id;

  if (!sessionId || !orderId) {
    logger.error('[Cashfree] Missing fields in order response', {
      fullResponse: JSON.stringify(raw?.data ?? raw, null, 2),
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
  const cf = getCashfreeClient();
  const response = await cf.PGFetchOrder(orderId);
  const order = response.data as OrderEntity;

  const status = String(order.order_status || '').toUpperCase();
  const isPaid = status === 'PAID';

  // Try to get the cf_payment_id from payments
  let cfPaymentId: string | undefined;
  try {
    const paymentsResp = await cf.PGOrderFetchPayments(orderId);
    const payments = paymentsResp.data;
    if (Array.isArray(payments) && payments.length > 0) {
      const successPayment = payments.find((p: any) => String(p.payment_status).toUpperCase() === 'SUCCESS');
      if (successPayment) {
        cfPaymentId = String((successPayment as any).cf_payment_id || '');
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
  const cf = getCashfreeClient();
  try {
    cf.PGVerifyWebhookSignature(params.signature, params.rawBody, params.timestamp);
    return true;
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
