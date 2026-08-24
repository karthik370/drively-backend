import { PaymentMethod, PaymentStatus, Prisma, SubscriptionStatus } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { createCashfreeOrder, verifyCashfreePayment, generateOrderId } from './cashfree';
import { logger } from '../utils/logger';

export class SubscriptionService {
    static async getSubscriptionStatus(driverId: string) {
        const sub = await prisma.driverSubscription.findUnique({
            where: { driverId },
        });

        if (!sub) {
            return {
                hasSubscription: false,
                status: SubscriptionStatus.INACTIVE,
                planPrice: 50,
                validUntil: null,
                isExpired: true,
                freeMonthsEarned: 0,
                freeMonthsUsed: 0,
                freeMonthsRemaining: 0,
            };
        }

        const now = new Date();
        const isExpired = sub.validUntil ? now > sub.validUntil : true;

        if (isExpired && sub.status === SubscriptionStatus.ACTIVE) {
            await prisma.driverSubscription.update({
                where: { id: sub.id },
                data: { status: SubscriptionStatus.EXPIRED },
            });
            sub.status = SubscriptionStatus.EXPIRED;
        }

        const freeMonthsEarned = (sub as any).freeMonthsEarned ?? 0;
        const freeMonthsUsed = (sub as any).freeMonthsUsed ?? 0;
        const freeMonthsRemaining = Math.max(0, freeMonthsEarned - freeMonthsUsed);

        return {
            hasSubscription: true,
            status: sub.status,
            planPrice: Number(sub.planPrice),
            validUntil: sub.validUntil,
            isExpired,
            freeMonthsEarned,
            freeMonthsUsed,
            freeMonthsRemaining,
        };
    }

    static async createSubscriptionOrder(params: { driverId: string; paymentMethod: PaymentMethod }) {
        const driver = await prisma.driverProfile.findUnique({
            where: { userId: params.driverId },
            select: { userId: true },
        });

        if (!driver) {
            throw new AppError('Driver profile not found', 404);
        }

        // ── Check for unused referral free months first ──────────────────────
        const existingSub = await prisma.driverSubscription.findUnique({
            where: { driverId: params.driverId },
        });
        const freeMonthsEarned = (existingSub as any)?.freeMonthsEarned ?? 0;
        const freeMonthsUsed = (existingSub as any)?.freeMonthsUsed ?? 0;
        const freeMonthsRemaining = Math.max(0, freeMonthsEarned - freeMonthsUsed);

        if (freeMonthsRemaining > 0) {
            // Auto-activate one free month without payment
            const now = new Date();
            const currentExpiry = existingSub?.status === SubscriptionStatus.ACTIVE && existingSub.validUntil && existingSub.validUntil > now
                ? existingSub.validUntil
                : now;
            const newValidUntil = new Date(currentExpiry.getTime() + 30 * 24 * 60 * 60 * 1000);

            const updatedSub = await prisma.driverSubscription.update({
                where: { driverId: params.driverId },
                data: {
                    status: SubscriptionStatus.ACTIVE,
                    validUntil: newValidUntil,
                    freeMonthsUsed: { increment: 1 },
                } as any,
            });

            logger.info(`[Subscription] Free month activated for driver ${params.driverId} until ${newValidUntil.toISOString()}`);

            return {
                subscriptionId: updatedSub.id,
                isFreeMonth: true,
                freeMonthsRemaining: freeMonthsRemaining - 1,
                validUntil: newValidUntil,
                message: `1 free month activated! Valid until ${newValidUntil.toLocaleDateString('en-IN')}`,
            };
        }

        // ── Normal paid flow ─────────────────────────────────────────────────
        const user = await prisma.user.findUnique({
            where: { id: params.driverId },
            select: { phoneNumber: true, email: true, firstName: true, lastName: true },
        });

        const planPrice = 50;
        const cfOrderId = generateOrderId('dsub', params.driverId);

        let cfOrder;
        try {
            cfOrder = await createCashfreeOrder({
                orderId: cfOrderId,
                amount: planPrice,
                customerId: params.driverId,
                customerPhone: user?.phoneNumber || '9999999999',
                customerEmail: user?.email || undefined,
                customerName: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || undefined,
                orderNote: 'Driver Subscription',
                orderTags: {
                    purpose: 'DRIVER_SUBSCRIPTION',
                    driverId: params.driverId,
                },
            });
        } catch (error: any) {
            logger.error('Failed to create Cashfree order for Driver Subscription', {
                driverId: params.driverId,
                errorPayload: error?.message || error,
            });
            throw new AppError(`Cashfree Order Creation Failed: ${error?.message || 'Unknown error'}`, 500);
        }

        const payment = await prisma.payment.create({
            data: {
                bookingId: null,
                userId: params.driverId,
                amount: planPrice,
                paymentMethod: params.paymentMethod,
                status: PaymentStatus.PENDING,
                gatewayTransactionId: cfOrder.orderId,
                gatewayResponse: {
                    cfOrderId: cfOrder.cfOrderId,
                    orderId: cfOrder.orderId,
                    paymentSessionId: cfOrder.paymentSessionId,
                    purpose: 'DRIVER_SUBSCRIPTION',
                } as any,
            },
        });

        const sub = await prisma.driverSubscription.upsert({
            where: { driverId: params.driverId },
            update: { lastPaymentId: payment.id },
            create: {
                driverId: params.driverId,
                status: SubscriptionStatus.INACTIVE,
                planPrice: new Prisma.Decimal(planPrice),
                lastPaymentId: payment.id,
            },
        });

        return {
            subscriptionId: sub.id,
            isFreeMonth: false,
            orderId: cfOrder.orderId,
            paymentSessionId: cfOrder.paymentSessionId,
            amount: cfOrder.orderAmount,
            currency: cfOrder.orderCurrency,
        };
    }

    static async verifySubscriptionPayment(params: {
        driverId: string;
        cfOrderId: string;
    }) {
        const cfStatus = await verifyCashfreePayment(params.cfOrderId);
        if (!cfStatus.isPaid) {
            throw new AppError(`Payment not completed. Status: ${cfStatus.orderStatus}`, 400);
        }

        return await prisma.$transaction(async (tx) => {
            const sub = await tx.driverSubscription.findUnique({
                where: { driverId: params.driverId },
            });

            if (!sub) {
                throw new AppError('Subscription record not found', 404);
            }

            const paymentId = sub.lastPaymentId;
            if (!paymentId) {
                throw new AppError('Payment not linked to subscription', 500);
            }

            const payment = await tx.payment.findUnique({ where: { id: paymentId } });
            if (!payment) {
                throw new AppError('Payment record not found', 404);
            }

            if (payment.status === PaymentStatus.PAID && sub.status === SubscriptionStatus.ACTIVE) {
                return {
                    status: sub.status,
                    validUntil: sub.validUntil,
                };
            }

            await tx.payment.update({
                where: { id: payment.id },
                data: {
                    status: PaymentStatus.PAID,
                    processedAt: new Date(),
                    gatewayResponse: {
                        ...(typeof payment.gatewayResponse === 'object' && payment.gatewayResponse ? (payment.gatewayResponse as any) : {}),
                        cfPaymentId: cfStatus.cfPaymentId,
                        orderStatus: cfStatus.orderStatus,
                        verifiedAt: new Date().toISOString(),
                    } as any,
                },
            });

            const now = new Date();
            let newValidUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
            if (sub.status === SubscriptionStatus.ACTIVE && sub.validUntil && sub.validUntil > now) {
                newValidUntil = new Date(sub.validUntil.getTime() + 30 * 24 * 60 * 60 * 1000);
            }

            const updatedSub = await tx.driverSubscription.update({
                where: { id: sub.id },
                data: {
                    status: SubscriptionStatus.ACTIVE,
                    validUntil: newValidUntil
                },
            });

            logger.info(`Driver ${params.driverId} activated subscription until ${newValidUntil}`);

            return {
                status: updatedSub.status,
                validUntil: updatedSub.validUntil,
            };
        });
    }

    /**
     * activateFromPayment — called by the webhook handler and reconciliation job
     * when we already KNOW the payment succeeded (no need to re-query Cashfree).
     * Idempotent: safe to call multiple times for the same payment.
     */
    static async activateFromPayment(
        driverId: string,
        paymentId: string,
        cfPaymentId?: string | null,
    ): Promise<void> {
        await prisma.$transaction(async (tx) => {
            const sub = await tx.driverSubscription.findUnique({
                where: { driverId },
            });

            // Guard: already active with a future expiry — nothing to do
            if (
                sub?.status === SubscriptionStatus.ACTIVE &&
                sub.validUntil &&
                sub.validUntil > new Date()
            ) {
                return;
            }

            // Mark payment PAID (idempotent — won't error if already PAID)
            await tx.payment.update({
                where: { id: paymentId },
                data: {
                    status: PaymentStatus.PAID,
                    processedAt: new Date(),
                    gatewayResponse: {
                        ...(sub ? {} : {}),
                        cfPaymentId: cfPaymentId ?? null,
                        activatedAt: new Date().toISOString(),
                    } as any,
                },
            });

            const now = new Date();
            const currentExpiry = sub?.status === SubscriptionStatus.ACTIVE && sub.validUntil && sub.validUntil > now
                ? sub.validUntil
                : now;
            const newValidUntil = new Date(currentExpiry.getTime() + 30 * 24 * 60 * 60 * 1000);

            await tx.driverSubscription.upsert({
                where: { driverId },
                update: {
                    status: SubscriptionStatus.ACTIVE,
                    validUntil: newValidUntil,
                    lastPaymentId: paymentId,
                },
                create: {
                    driverId,
                    status: SubscriptionStatus.ACTIVE,
                    planPrice: new Prisma.Decimal(50),
                    validUntil: newValidUntil,
                    lastPaymentId: paymentId,
                },
            });

            logger.info(`[Subscription] Activated for driver ${driverId} until ${newValidUntil.toISOString()}`);
        });
    }
}
