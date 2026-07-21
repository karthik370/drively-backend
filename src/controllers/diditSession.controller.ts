/**
 * Didit Session Controller
 * ─────────────────────────
 * POST /kyc/session/create              → Create a Didit hosted verification session
 * POST /kyc/session/:sessionId/confirm  → Confirm session decision (mobile calls after callback)
 * GET  /kyc/session/:sessionId/decision → Raw decision from Didit (optional polling)
 * POST /webhooks/didit                  → Receive Didit webhook events (public, no auth)
 */
import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import {
  createDiditSession,
  confirmDiditSession,
  getSessionDecision,
  verifyWebhookSignature,
  handleDiditWebhookEvent,
  WebhookPayload,
} from '../services/diditSession';

export class DiditSessionController {
  /**
   * POST /kyc/session/create
   * Creates a Didit hosted verification session for the authenticated driver.
   * Returns { verificationUrl, sessionId } — the app opens verificationUrl in a WebView.
   */
  static createSession = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const { callbackUrl } = req.body || {};
    const result = await createDiditSession(req.user.id, callbackUrl);

    res.status(201).json({
      success: true,
      message: 'Verification session created',
      data: {
        sessionId:       result.sessionId,
        verificationUrl: result.verificationUrl,
        status:          result.status,
      },
    });
  });

  /**
   * POST /kyc/session/:sessionId/confirm
   * Called by the mobile app AFTER the deep-link callback.
   * Fetches the decision from Didit and updates the DB (belt + suspenders with webhook).
   * Returns { sessionId, status, kycCompleted }.
   */
  static confirmSession = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const { sessionId } = req.params;
    if (!sessionId) throw new AppError('sessionId is required', 400);

    // Mobile sends back the verificationUrl so we can backfill DB if it was null
    // (sessions created before the diditSessionUrl column existed)
    const verificationUrl = typeof req.body?.verificationUrl === 'string'
      ? req.body.verificationUrl
      : undefined;

    const result = await confirmDiditSession(sessionId, req.user.id, verificationUrl);

    res.status(200).json({
      success: true,
      data: result,
    });
  });

  /**
   * GET /kyc/session/:sessionId/decision
   * Raw decision from Didit — used for optional polling.
   */
  static getDecision = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const { sessionId } = req.params;
    if (!sessionId) throw new AppError('sessionId is required', 400);

    const decision = await getSessionDecision(sessionId);

    res.status(200).json({
      success: true,
      data: {
        sessionId,
        status:   decision.status,
        decision: decision,
      },
    });
  });

  /**
   * POST /webhooks/didit
   * Public endpoint — Didit sends webhook events here.
   * Verifies HMAC-SHA256 signature, returns 200 immediately, processes async.
   */
  static handleWebhook = asyncHandler(async (req: Request, res: Response) => {
    const signatureV2      = req.headers['x-signature-v2'] as string | undefined;
    const signatureSimple  = req.headers['x-signature-simple'] as string | undefined;
    const timestamp        = req.headers['x-timestamp'] as string | undefined;
    const body             = req.body as Record<string, any>;

    logger.info('[Didit Webhook] Incoming', {
      webhook_type: body?.webhook_type,
      status:       body?.status,
      session_id:   body?.session_id,
      vendor_data:  body?.vendor_data,
    });

    const valid = verifyWebhookSignature(body, signatureV2, signatureSimple, timestamp);
    if (!valid) {
      logger.warn('[Didit Webhook] Invalid signature — rejecting');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // Return 200 immediately so Didit doesn't retry
    res.status(200).json({ ok: true });

    // Process asynchronously
    handleDiditWebhookEvent(body as WebhookPayload).catch((err) => {
      logger.error('[Didit Webhook] Processing failed', { error: err?.message, body });
    });
  });
}

export default DiditSessionController;
