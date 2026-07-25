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
import { v2 as cloudinary } from 'cloudinary';
import { KycStatus, VerificationStatus } from '@prisma/client';
import prisma from '../config/database';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Didit embeds the session language in the URL path:
 *   https://verify.didit.me/hi/session/abc → https://verify.didit.me/en/session/abc
 *
 * This ensures that any stored session URL (including older ones created before
 * we pinned language:'en') always opens in English.
 */
function normalizeDiditUrl(url: string): string {
  // Match pattern: https://verify.didit.me/{lang}/session/{id}
  // where {lang} is a 2-5 char locale code
  return url.replace(
    /^(https?:\/\/[^/]+)\/[a-z]{2,5}(\/session\/)/i,
    '$1/en$2'
  );
}


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

  // Normalise URL to English — Didit embeds the language in the URL path segment
  // e.g. https://verify.didit.me/hi/session/... → https://verify.didit.me/en/session/...
  const normalizedUrl = normalizeDiditUrl(url);

  // Store session_id + normalised URL in DB.
  // IMPORTANT: do NOT downgrade status if user is already REVIEW_PENDING or COMPLETED
  // (Didit returns the same session idempotently — its own "status" field may say "Not Started"
  //  even when the user has completed all steps and is under manual review)
  try {
    const existing = await prisma.kycVerification.findUnique({ where: { userId } });
    const keepStatus = existing?.status === KycStatus.REVIEW_PENDING
                    || existing?.status === KycStatus.COMPLETED;

    await prisma.kycVerification.upsert({
      where:  { userId },
      update: {
        diditSessionId:  session_id,
        diditSessionUrl: normalizedUrl,
        ...(keepStatus ? {} : { status: KycStatus.IN_PROGRESS }),
      },
      create: {
        userId,
        diditSessionId:  session_id,
        diditSessionUrl: normalizedUrl,
        status:          KycStatus.IN_PROGRESS,
      },
    });
  } catch (dbErr: any) {
    logger.warn('[Didit Session] Could not store session_id in DB', { userId, err: dbErr?.message });
  }

  return {
    sessionId:       session_id,
    verificationUrl: normalizedUrl,
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
  userId: string,
  verificationUrl?: string   // optional — mobile sends it back so we can backfill if DB has null
): Promise<ConfirmSessionResult> => {
  const { apiKey, baseUrl } = getDiditConfig();

  // Backfill diditSessionUrl in DB if it's null (sessions created before the column existed)
  if (verificationUrl) {
    const normalizedUrl = normalizeDiditUrl(verificationUrl);
    await prisma.kycVerification.updateMany({
      where: { userId, diditSessionUrl: null },
      data:  { diditSessionUrl: normalizedUrl },
    }).catch(() => {}); // non-fatal
  }

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
      faceMatchScore:  faceMatch?.score ?? null,
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
      faceMatchScore:  faceMatch?.score ?? null,
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

  // ── Auto-upload selfie from Didit face_match to Cloudinary ──────────────
  // Didit face_match field mapping (confirmed by user):
  //   source_image = portrait cropped from ID document (NOT the selfie!)
  //   target_image = liveness selfie captured by camera (THIS is what we want)
  //   score        = face match similarity score
  const rawTargetImage = faceMatch?.target_image;
  const selfieUrl: string | undefined =
    typeof rawTargetImage === 'string' ? rawTargetImage :
    typeof rawTargetImage?.url === 'string' ? rawTargetImage.url :
    typeof rawTargetImage?.href === 'string' ? rawTargetImage.href :
    undefined;

  // Log both images for debugging
  const rawSourceImage = faceMatch?.source_image;
  logger.info('[Didit] face_match data', {
    userId,
    score:            faceMatch?.score,
    status:           faceMatch?.status,
    source_image_val: typeof rawSourceImage === 'string'
                        ? rawSourceImage.slice(0, 80)
                        : JSON.stringify(rawSourceImage)?.slice(0, 120),
    target_image_type: typeof rawTargetImage,
    target_image_val:  typeof rawTargetImage === 'string'
                         ? rawTargetImage.slice(0, 80)
                         : JSON.stringify(rawTargetImage)?.slice(0, 120),
    warnings:         faceMatch?.warnings,
  });

  if (selfieUrl) {
    try {
      logger.info('[Didit] Auto-uploading liveness selfie (target_image) to Cloudinary', {
        userId,
        selfieUrl: selfieUrl.slice(0, 80) + '...',
      });

      const uploadResult = await cloudinary.uploader.upload(selfieUrl, {
        folder:        `drivemate/${userId}/kyc-selfie`,
        public_id:     `selfie_${Date.now()}`,
        resource_type: 'image',
        overwrite:     true,
      });

      const cloudinaryUrl = uploadResult.secure_url;
      logger.info('[Didit] Selfie uploaded to Cloudinary', { userId, url: cloudinaryUrl });

      await prisma.user.update({
        where: { id: userId },
        data:  { profileImage: cloudinaryUrl },
      });

      logger.info('[Didit] user.profileImage updated from liveness selfie', { userId });
    } catch (err: any) {
      logger.error('[Didit] Failed to auto-upload selfie from Didit', { userId, error: err?.message });
    }
  } else {
    logger.warn('[Didit] target_image (liveness selfie) not found in face_matches — profile photo not auto-set', {
      userId,
      faceMatchKeys: Object.keys(faceMatch || {}),
    });
  }
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
