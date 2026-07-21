/**
 * Didit Session Service
 * ─────────────────────
 * Creates and manages Didit Hosted Verification Sessions.
 * Sessions use a Workflow (defined in Didit Console) to run
 * ID Verification + Face Match entirely inside Didit's own UI.
 * Your app just opens the URL and waits for the deep-link callback.
 *
 * API: POST https://verification.didit.me/v3/session/
 * Docs: https://docs.didit.me
 */
import axios from 'axios';
import crypto from 'crypto';
import { KycStatus, VerificationStatus } from '@prisma/client';
import prisma from '../config/database';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';

// ── Config ───────────────────────────────────────────────────────────────────

const getDiditConfig = () => {
  const apiKey = process.env.DIDIT_API_KEY;
  const workflowId = process.env.DIDIT_WORKFLOW_ID;
  if (!apiKey)      throw new AppError('DIDIT_API_KEY not configured', 500);
  if (!workflowId)  throw new AppError('DIDIT_WORKFLOW_ID not configured', 500);

  // Validate UUID format — reject anything else with a clear error
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(workflowId)) {
    throw new AppError(
      `DIDIT_WORKFLOW_ID must be a valid UUID (got "${workflowId.substring(0, 30)}…"). ` +
      'Copy the Workflow ID from business.didit.me → Workflows → your workflow.',
      500
    );
  }

  return { apiKey, workflowId, baseUrl: 'https://verification.didit.me' };
};

const WEBHOOK_SECRET = process.env.DIDIT_WEBHOOK_SECRET || '';

// ── Types ────────────────────────────────────────────────────────────────────

export type CreateSessionResult = {
  sessionId: string;
  verificationUrl: string;
  status: string;
};

export type ConfirmSessionResult = {
  sessionId: string;
  status: string;           // Approved | Declined | In Review | In Progress | Not Started ...
  kycCompleted: boolean;    // true only when status === 'Approved' and DB was updated
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
 * If an unfinished session already exists for this userId, Didit returns the
 * same session (idempotent via vendor_data).
 */
export const createDiditSession = async (
  userId: string,
  callbackUrl?: string
): Promise<CreateSessionResult> => {
  const { apiKey, workflowId, baseUrl } = getDiditConfig();

  // Deep-link callback — Didit appends ?verificationSessionId=xxx&status=Approved
  const callback = callbackUrl || 'drivegaadi://kyc-callback';

  logger.info('[Didit Session] Creating verification session', { userId, workflowId, callback });

  let response: any;
  try {
    response = await axios.post(
      `${baseUrl}/v3/session/`,
      {
        workflow_id:  workflowId,
        vendor_data:  `user-${userId}`,
        callback,
        callback_method: 'both',
        language: 'en',
      },
      {
        headers: {
          'x-api-key':    apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
  } catch (err: any) {
    const diditError = err?.response?.data;
    logger.error('[Didit Session] Didit API returned an error', {
      status:   err?.response?.status,
      error:    diditError,
      workflow: workflowId,
      userId,
    });
    throw new AppError(
      diditError?.message ||
      diditError?.detail  ||
      (typeof diditError?.workflow_id === 'string' ? diditError.workflow_id : null) ||
      (Array.isArray(diditError?.workflow_id) ? diditError.workflow_id[0] : null) ||
      `Didit API error: ${err?.response?.status ?? err?.message}`,
      err?.response?.status ?? 500
    );
  }

  const { session_id, url, status } = response.data;

  logger.info('[Didit Session] Session created', { userId, session_id, status, url });

  // Store session_id + URL in DB for cross-reference on webhook and session resume
  await prisma.kycVerification.upsert({
    where:  { userId },
    update: {
      diditSessionId:  session_id,
      diditSessionUrl: url,
      status:          KycStatus.IN_PROGRESS,
    },
    create: {
      userId,
      diditSessionId:  session_id,
      diditSessionUrl: url,
      status:          KycStatus.IN_PROGRESS,
    },
  }).catch((dbErr) => {
    // Non-fatal — webhook still works via vendor_data
    logger.warn('[Didit Session] Could not store session_id in DB', { userId, err: dbErr?.message });
  });

  return {
    sessionId:       session_id,
    verificationUrl: url,
    status,
  };
};

// ── Session Confirm (called from mobile after deep-link callback) ────────────

/**
 * Fetch the decision from Didit and update the DB if Approved/Declined.
 * This is the "belt and suspenders" — the webhook ALSO updates the DB,
 * but the mobile app calls this immediately after the callback redirect
 * so the user doesn't have to wait for the webhook.
 */
export const confirmDiditSession = async (
  sessionId: string,
  userId: string
): Promise<ConfirmSessionResult> => {
  const { apiKey, baseUrl } = getDiditConfig();

  logger.info('[Didit Confirm] Fetching decision', { sessionId, userId });

  let decision: any;
  try {
    const response = await axios.get(
      `${baseUrl}/v3/session/${sessionId}/decision/`,
      {
        headers: { 'x-api-key': apiKey },
        timeout: 10000,
      }
    );
    decision = response.data;
  } catch (err: any) {
    logger.error('[Didit Confirm] Failed to fetch decision', {
      sessionId,
      status: err?.response?.status,
      error:  err?.response?.data,
    });
    throw new AppError(
      `Could not fetch verification result: ${err?.response?.status ?? err?.message}`,
      err?.response?.status ?? 500
    );
  }

  const status = decision.status; // Approved | Declined | In Review | In Progress | Not Started
  logger.info('[Didit Confirm] Decision received', { sessionId, status });

  if (status === 'Approved') {
    await markKycCompleted(userId, sessionId, decision);
    return { sessionId, status, kycCompleted: true };
  }

  if (status === 'Declined') {
    await markKycFailed(userId, sessionId, decision);
    return { sessionId, status, kycCompleted: false };
  }

  if (status === 'In Review') {
    await markKycInReview(userId, sessionId);
    return { sessionId, status, kycCompleted: false };
  }

  if (status === 'In Progress' || status === 'Not Started') {
    await markKycInProgress(userId, sessionId);
    return { sessionId, status, kycCompleted: false };
  }

  // Expired, Abandoned, etc.
  return { sessionId, status, kycCompleted: false };
};

// ── Retrieve Session Decision (raw) ──────────────────────────────────────────

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

// ── DB Mutation Helpers ─────────────────────────────────────────────────────

async function markKycCompleted(userId: string, sessionId: string, decision: any) {
  const faceMatch = decision?.face_matches?.[0];

  await prisma.kycVerification.upsert({
    where:  { userId },
    update: {
      status:          KycStatus.COMPLETED,
      aadhaarVerified: true,
      panVerified:     true,
      dlVerified:      true,
      faceMatchPassed: true,
      faceMatchScore:  faceMatch?.similarity_score ?? null,
      diditSessionId:  sessionId,
      completedAt:     new Date(),
      failureReason:   null,
    },
    create: {
      userId,
      status:          KycStatus.COMPLETED,
      aadhaarVerified: true,
      panVerified:     true,
      dlVerified:      true,
      faceMatchPassed: true,
      faceMatchScore:  faceMatch?.similarity_score ?? null,
      diditSessionId:  sessionId,
      completedAt:     new Date(),
      failureReason:   null,
    },
  });

  await prisma.driverProfile.updateMany({
    where: { userId },
    data:  {
      documentsVerified:     true,
      backgroundCheckStatus: VerificationStatus.VERIFIED,
    },
  });

  logger.info('[Didit] KYC marked COMPLETED', { userId, sessionId });
}

async function markKycFailed(userId: string, sessionId: string, decision: any) {
  const reason = decision?.id_verifications?.[0]?.warnings?.join(', ')
    || decision?.face_matches?.[0]?.warnings?.join(', ')
    || 'Verification declined by Didit.';

  await prisma.kycVerification.upsert({
    where:  { userId },
    update: {
      status:         KycStatus.FAILED,
      failureReason:  reason,
      diditSessionId: sessionId,
    },
    create: {
      userId,
      status:         KycStatus.FAILED,
      failureReason:  reason,
      diditSessionId: sessionId,
    },
  });

  logger.info('[Didit] KYC marked FAILED', { userId, sessionId, reason });
}

async function markKycInReview(userId: string, sessionId: string) {
  await prisma.kycVerification.upsert({
    where:  { userId },
    update: {
      status:         KycStatus.REVIEW_PENDING,
      diditSessionId: sessionId,
      failureReason:  null,
    },
    create: {
      userId,
      status:         KycStatus.REVIEW_PENDING,
      diditSessionId: sessionId,
    },
  });

  logger.info('[Didit] KYC marked REVIEW_PENDING', { userId, sessionId });
}

async function markKycInProgress(userId: string, sessionId: string) {
  // Only update if not already in a terminal state
  const existing = await prisma.kycVerification.findUnique({ where: { userId } });
  if (existing && ['COMPLETED', 'REVIEW_PENDING'].includes(existing.status)) {
    return; // Don't downgrade from a higher state
  }

  await prisma.kycVerification.upsert({
    where:  { userId },
    update: {
      status:         KycStatus.IN_PROGRESS,
      diditSessionId: sessionId,
    },
    create: {
      userId,
      status:         KycStatus.IN_PROGRESS,
      diditSessionId: sessionId,
    },
  });

  logger.info('[Didit] KYC marked IN_PROGRESS', { userId, sessionId });
}

// ── Webhook Signature Verification ──────────────────────────────────────────

export const verifyWebhookSignature = (
  body: Record<string, any>,
  signatureV2: string | undefined,
  signatureSimple: string | undefined,
  timestamp: string | undefined
): boolean => {
  if (!WEBHOOK_SECRET) {
    logger.warn('[Didit Webhook] DIDIT_WEBHOOK_SECRET not set — skipping signature verification');
    return true;
  }
  if (!timestamp) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
    logger.warn('[Didit Webhook] Timestamp too old (replay attack?)', { timestamp, now });
    return false;
  }

  // V2 signature (recommended — signs full body)
  if (signatureV2) {
    const canonical = JSON.stringify(sortKeysDeep(shortenFloats(body)));
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
      .update(canonical, 'utf8')
      .digest('hex');
    if (timingSafeEqual(expected, signatureV2)) return true;
  }

  // Simple signature (envelope only)
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
      logger.warn('[Didit Webhook] Verified with Simple signature — decision body unverified');
      return true;
    }
  }

  return false;
};

// ── Webhook Event Handler ────────────────────────────────────────────────────

export const handleDiditWebhookEvent = async (payload: WebhookPayload): Promise<void> => {
  const { webhook_type, status, vendor_data, session_id, decision } = payload;

  logger.info('[Didit Webhook] Received event', { webhook_type, status, vendor_data, session_id });

  if (webhook_type !== 'status.updated') {
    logger.info('[Didit Webhook] Ignoring non-status event', { webhook_type });
    return;
  }

  const userId = vendor_data?.startsWith('user-') ? vendor_data.slice(5) : null;
  if (!userId) {
    logger.warn('[Didit Webhook] Could not extract userId from vendor_data', { vendor_data });
    return;
  }

  if (status === 'Approved') {
    await markKycCompleted(userId, session_id, decision);
  } else if (status === 'Declined') {
    await markKycFailed(userId, session_id, decision);
  } else if (status === 'In Review') {
    await markKycInReview(userId, session_id);
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
