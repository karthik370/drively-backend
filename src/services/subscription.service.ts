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
                planPrice: 500,
                validUntil: null,
                isExpired: true,
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

        return {
            hasSubscription: true,
            status: sub.status,
            planPrice: Number(sub.planPrice),
            validUntil: sub.validUntil,
            isExpired,
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

        const user = await prisma.user.findUnique({
            where: { id: params.driverId },
            select: { phoneNumber: true, email: true, firstName: true, lastName: true },
        });

        const planPrice = 500;
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
            update: {
                lastPaymentId: payment.id,
            },
            create: {
                driverId: params.driverId,
                status: SubscriptionStatus.INACTIVE,
                planPrice: new Prisma.Decimal(planPrice),
                lastPaymentId: payment.id,
            },
        });

        return {
            subscriptionId: sub.id,
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
}
