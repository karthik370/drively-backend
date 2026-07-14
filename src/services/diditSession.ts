/**
 * Didit Session Service
 * ─────────────────────
 * Creates and manages Didit Hosted Verification Sessions.
 * Sessions use a Workflow (defined in Didit Console) to run
 * ID Verification + Face Match entirely inside Didit's own UI.
 * Your app just opens the URL and waits for the deep-link callback.
 *
 * API: POST https://verification.didit.me/v3/session/
 * Docs: https://docs.didit.me/sessions-api/create-session
 */
import axios from 'axios';
import crypto from 'crypto';
import prisma from '../config/database';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';

// ── Config ───────────────────────────────────────────────────────────────────

const getDiditConfig = () => {
  const apiKey = process.env.DIDIT_API_KEY;
  const workflowId = process.env.DIDIT_WORKFLOW_ID;
  if (!apiKey)      throw new AppError('DIDIT_API_KEY not configured', 500);
  if (!workflowId)  throw new AppError('DIDIT_WORKFLOW_ID not configured', 500);
  return { apiKey, workflowId, baseUrl: 'https://verification.didit.me' };
};

const WEBHOOK_SECRET = process.env.DIDIT_WEBHOOK_SECRET || '';

// ── Types ────────────────────────────────────────────────────────────────────

export type CreateSessionResult = {
  sessionId: string;
  verificationUrl: string;
  status: string;
};

export type WebhookPayload = {
  event_id: string;
  webhook_type: string;
  session_id: string;
  status: string;
  vendor_data?: string;
  decision?: any;
  timestamp?: number;
};

// ── Session Creation ─────────────────────────────────────────────────────────

/**
 * Create a Didit Hosted Verification Session for a driver.
 * Uses idempotency: if an unfinished session already exists for this
 * userId+workflow, Didit returns the same session (no duplicate charges).
 */
export const createDiditSession = async (
  userId: string,
  callbackUrl?: string
): Promise<CreateSessionResult> => {
  const { apiKey, workflowId, baseUrl } = getDiditConfig();

  // Use the app's deep-link scheme for mobile callback
  // Didit appends: ?verificationSessionId=xxx&status=Approved
  const callback = callbackUrl || `drivegaadi://kyc-callback`;

  logger.info('[Didit Session] Creating verification session', { userId, workflowId, callback });

  const response = await axios.post(
    `${baseUrl}/v3/session/`,
    {
      workflow_id:      workflowId,
      vendor_data:      `user-${userId}`,       // binds session to your user
      callback,
      callback_method:  'both',                  // fires on both initiator + completer device
      language:         'hi',                    // Hindi for Indian drivers
      expected_details: {
        id_country:             'IND',
        expected_document_types: ['ID', 'DL'], // ID=Aadhaar, DL=Driving License
      },
    },
    {
      headers: {
        'x-api-key':    apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );

  const { session_id, url, status } = response.data;

  logger.info('[Didit Session] Session created', { userId, session_id, status });

  // Store session_id in DB so we can cross-reference on webhook arrival
  await prisma.kycVerification.upsert({
    where:  { userId },
    update: { diditSessionId: session_id },
    create: { userId, diditSessionId: session_id },
  }).catch((err) => {
    // Non-fatal: log and continue — webhook will still work via vendor_data
    logger.warn('[Didit Session] Could not store session_id', { userId, err: err?.message });
  });

  return {
    sessionId:       session_id,
    verificationUrl: url,
    status,
  };
};

// ── Retrieve Session Result ──────────────────────────────────────────────────

/**
 * Fetch the full decision for a session.
 * Use this to manually check status (e.g. on app foreground after callback).
 */
export const getSessionDecision = async (sessionId: string): Promise<any> => {
  const { apiKey, baseUrl } = getDiditConfig();

  const response = await axios.get(
    `${baseUrl}/v3/session/${sessionId}/decision/`,
    {
      headers: { 'x-api-key': apiKey },
      timeout: 10000,
    }
  );
  return response.data;
};

// ── Webhook Signature Verification ──────────────────────────────────────────

/**
 * Verify Didit webhook signature using X-Signature-V2 (recommended).
 * V2 signs sorted, unicode-preserved compact JSON — survives middleware re-encoding.
 */
export const verifyWebhookSignature = (
  body: Record<string, any>,
  signatureV2: string | undefined,
  signatureSimple: string | undefined,
  timestamp: string | undefined
): boolean => {
  if (!WEBHOOK_SECRET) {
    logger.warn('[Didit Webhook] DIDIT_WEBHOOK_SECRET not set — skipping signature verification');
    return true; // skip in dev if no secret configured
  }
  if (!timestamp) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
    logger.warn('[Didit Webhook] Timestamp too old (replay attack?)', { timestamp, now });
    return false;
  }

  // Try V2 first (recommended — full body authentication)
  if (signatureV2) {
    const canonical = JSON.stringify(sortKeysDeep(shortenFloats(body)));
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
      .update(canonical, 'utf8')
      .digest('hex');
    if (timingSafeEqual(expected, signatureV2)) return true;
  }

  // Fallback: Simple signature (envelope only — does not authenticate decision body)
  if (signatureSimple) {
    const canonical = [
      body.timestamp ?? '',
      body.session_id ?? '',
      body.status ?? '',
      body.webhook_type ?? '',
    ].join(':');
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
      .update(canonical)
      .digest('hex');
    if (timingSafeEqual(expected, signatureSimple)) {
      logger.warn('[Didit Webhook] Verified with Simple signature only — decision body unverified');
      return true;
    }
  }

  return false;
};

// ── Webhook Event Handler ────────────────────────────────────────────────────

/**
 * Process a verified Didit webhook event.
 * On "Approved" — marks the driver's KYC as COMPLETED in the DB.
 */
export const handleDiditWebhookEvent = async (payload: WebhookPayload): Promise<void> => {
  const { webhook_type, status, vendor_data, session_id, decision } = payload;

  logger.info('[Didit Webhook] Received event', { webhook_type, status, vendor_data, session_id });

  if (webhook_type !== 'status.updated') {
    logger.info('[Didit Webhook] Ignoring non-status event', { webhook_type });
    return;
  }

  // Extract userId from vendor_data (we set it as "user-{userId}")
  const userId = vendor_data?.startsWith('user-') ? vendor_data.slice(5) : null;
  if (!userId) {
    logger.warn('[Didit Webhook] Could not extract userId from vendor_data', { vendor_data });
    return;
  }

  if (status === 'Approved') {
    logger.info('[Didit Webhook] Session Approved — marking KYC complete', { userId });

    // Extract data from decision for record-keeping
    const faceMatch      = decision?.face_matches?.[0];

    await prisma.kycVerification.upsert({
      where:  { userId },
      update: {
        status:          'COMPLETED',
        aadhaarVerified: true,
        panVerified:     true,
        dlVerified:      true,
        faceMatchPassed: true,
        faceMatchScore:  faceMatch?.similarity_score ?? null,
        diditSessionId:  session_id,
        completedAt:     new Date(),
        failureReason:   null,
      },
      create: {
        userId,
        status:          'COMPLETED',
        aadhaarVerified: true,
        panVerified:     true,
        dlVerified:      true,
        faceMatchPassed: true,
        faceMatchScore:  faceMatch?.similarity_score ?? null,
        diditSessionId:  session_id,
        completedAt:     new Date(),
        failureReason:   null,
      },
    });

    // Also mark driver profile as documents verified
    await prisma.driverProfile.updateMany({
      where:  { userId },
      data:   { documentsVerified: true, backgroundCheckStatus: 'VERIFIED' },
    });

    logger.info('[Didit Webhook] KYC marked COMPLETED', { userId });

  } else if (status === 'Declined') {
    logger.info('[Didit Webhook] Session Declined', { userId });

    const reason = decision?.id_verifications?.[0]?.warnings?.join(', ')
      || decision?.face_matches?.[0]?.warnings?.join(', ')
      || 'Verification declined by Didit.';

    await prisma.kycVerification.upsert({
      where:  { userId },
      update: {
        status:        'FAILED',
        failureReason: reason,
        diditSessionId: session_id,
      },
      create: {
        userId,
        status:        'FAILED',
        failureReason: reason,
        diditSessionId: session_id,
      },
    });

  } else if (status === 'In Review') {
    logger.info('[Didit Webhook] Session In Review — manual review pending', { userId });
    // Optionally notify driver that their KYC is being reviewed
  } else {
    logger.info('[Didit Webhook] Unhandled status', { status, userId });
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function sortKeysDeep(obj: any): any {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc: any, key) => {
      acc[key] = sortKeysDeep(obj[key]);
      return acc;
    }, {});
  }
  return obj;
}

function shortenFloats(data: any): any {
  if (Array.isArray(data)) return data.map(shortenFloats);
  if (data !== null && typeof data === 'object') {
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, shortenFloats(v)]));
  }
  if (typeof data === 'number' && !Number.isInteger(data) && data % 1 === 0) {
    return Math.trunc(data);
  }
  return data;
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}
