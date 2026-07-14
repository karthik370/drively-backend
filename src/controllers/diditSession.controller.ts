/**
 * Didit Session Controller
 * ─────────────────────────
 * POST /kyc/session/create   → Create a Didit hosted verification session
 * GET  /kyc/session/status   → Poll session status (after callback)
 * POST /webhooks/didit       → Receive Didit webhook events (public, no auth)
 */
import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import {
  createDiditSession,
  getSessionDecision,
  verifyWebhookSignature,
  handleDiditWebhookEvent,
  WebhookPayload,
} from '../services/diditSession';

export class DiditSessionController {
  /**
   * POST /kyc/session/create
   * Creates a Didit hosted verification session for the authenticated driver.
   * Returns { verificationUrl, sessionId } — the app opens verificationUrl.
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
   * GET /kyc/session/:sessionId/decision
   * Poll Didit for the final decision on a session.
   * Used after the deep-link callback to confirm status server-side.
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
        decision: decision.decision,
      },
    });
  });

  /**
   * POST /webhooks/didit
   * Public endpoint — receives Didit webhook events.
   * Verifies HMAC-SHA256 signature before processing.
   * IMPORTANT: must be registered BEFORE express.json() on this route
   *            so we can read raw body for signature verification.
   *            In practice, express.json() already parsed it — we use X-Signature-V2
   *            which works on the re-serialized canonical JSON.
   */
  static handleWebhook = asyncHandler(async (req: Request, res: Response) => {
    const signatureV2     = req.headers['x-signature-v2'] as string | undefined;
    const signatureSimple  = req.headers['x-signature-simple'] as string | undefined;
    const timestamp       = req.headers['x-timestamp'] as string | undefined;
    const body            = req.body as Record<string, any>;

    logger.info('[Didit Webhook] Received', {
      webhook_type: body?.webhook_type,
      status:       body?.status,
      session_id:   body?.session_id,
      vendor_data:  body?.vendor_data,
    });

    // Verify signature
    const valid = verifyWebhookSignature(body, signatureV2, signatureSimple, timestamp);
    if (!valid) {
      logger.warn('[Didit Webhook] Invalid signature — rejecting');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // Return 200 immediately — process async so Didit doesn't retry
    res.status(200).json({ ok: true });

    // Process the event asynchronously
    handleDiditWebhookEvent(body as WebhookPayload).catch((err) => {
      logger.error('[Didit Webhook] Processing failed', { error: err?.message, body });
    });
  });
}

export default DiditSessionController;
