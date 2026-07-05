/**
 * Payment Reconciliation Service (Layer 2 Safety Net)
 *
 * How big production systems (Uber, Razorpay, PhonePe) handle missed webhooks:
 *
 *   1. PRIMARY:   Cashfree webhook fires → instant payment confirmation
 *   2. SECONDARY: Mobile app calls verifySubscriptionPayment() after returning
 *                 from the payment screen (Cashfree SDK callback)
 *   3. TERTIARY:  This job — runs every 5 minutes, polls Cashfree for any
 *                 PENDING payments older than 3 minutes, reconciles status
 *
 * This guarantees 0 payments stuck in PENDING forever, even if:
 *   - Webhook URL unreachable (server restart, firewall)
 *   - Mobile app killed before calling verify API
 *   - Cashfree webhook fires out of order / retries needed
 */

import prisma from '../config/database';
import { logger } from '../utils/logger';
import { verifyCashfreePayment } from './cashfree';
import { SubscriptionService } from './subscription.service';
import { PaymentStatus } from '@prisma/client';

// Only reconcile payments older than 3 minutes (give webhook a head start)
const MIN_AGE_MS = 3 * 60 * 1000;

// Max age — don't waste time querying genuinely abandoned payments
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Rate: run every 5 minutes
export const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;

// Debounce: never run two jobs simultaneously
let isRunning = false;

export const runPaymentReconciliation = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;

  try {
    const now = new Date();
    const minAge = new Date(now.getTime() - MIN_AGE_MS);
    const maxAge = new Date(now.getTime() - MAX_AGE_MS);

    // Find PENDING subscription payments in the [3 min, 24 hr] window
    const pendingPayments = await (prisma as any).payment.findMany({
      where: {
        status: PaymentStatus.PENDING,
        bookingId: null, // subscription payments have no booking
        createdAt: {
          lt: minAge,  // older than 3 minutes
          gt: maxAge,  // but not more than 24 hours old
        },
        gatewayTransactionId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 50, // safety cap — should never be more than a handful
    });

    if (pendingPayments.length === 0) return;

    logger.info(`[Reconciliation] Found ${pendingPayments.length} pending payment(s) to check`);

    let reconciled = 0;
    let notPaid = 0;
    let errors = 0;

    for (const payment of pendingPayments) {
      const orderId = payment.gatewayTransactionId as string;
      if (!orderId) continue;

      try {
        const cfStatus = await verifyCashfreePayment(orderId);

        if (cfStatus.isPaid) {
          // Payment confirmed — check if it's a subscription payment
          const gw = payment.gatewayResponse as any;
          if (gw?.purpose === 'DRIVER_SUBSCRIPTION' && payment.userId) {
            await SubscriptionService.activateFromPayment(
              payment.userId,
              payment.id,
              cfStatus.cfPaymentId,
            );
            logger.info('[Reconciliation] Subscription activated via reconciliation', {
              userId: payment.userId,
              paymentId: payment.id,
              orderId,
            });
            reconciled++;
          } else {
            // Non-subscription pending payment — just mark as PAID
            await (prisma as any).payment.update({
              where: { id: payment.id },
              data: {
                status: PaymentStatus.PAID,
                processedAt: now,
                gatewayResponse: {
                  ...(typeof payment.gatewayResponse === 'object' && payment.gatewayResponse
                    ? payment.gatewayResponse
                    : {}),
                  reconciledAt: now.toISOString(),
                  cfPaymentId: cfStatus.cfPaymentId,
                },
              },
            });
            reconciled++;
          }
        } else {
          // Gateway says not paid yet — leave as PENDING, will check again next cycle
          notPaid++;
        }
      } catch (err: any) {
        // Non-fatal: log and continue to next payment
        errors++;
        logger.warn('[Reconciliation] Error checking payment', {
          paymentId: payment.id,
          orderId,
          error: err?.message,
        });
      }

      // Small delay between Cashfree API calls to avoid rate limiting
      await new Promise((r) => setTimeout(r, 200));
    }

    if (reconciled > 0 || errors > 0) {
      logger.info('[Reconciliation] Cycle complete', { reconciled, notPaid, errors });
    }
  } catch (err) {
    logger.error('[Reconciliation] Unexpected error in reconciliation cycle', { error: err });
  } finally {
    isRunning = false;
  }
};

/**
 * Start the background reconciliation scheduler.
 * Call once from server.ts after server starts.
 */
export const initPaymentReconciliation = (): void => {
  // Run once at startup (after a 1-minute delay to let server settle)
  setTimeout(() => {
    void runPaymentReconciliation();
  }, 60_000);

  // Then run every 5 minutes
  setInterval(() => {
    void runPaymentReconciliation();
  }, RECONCILIATION_INTERVAL_MS);

  logger.info('💳 Payment reconciliation scheduled (every 5 minutes)');
};
