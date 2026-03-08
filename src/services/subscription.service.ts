import { PaymentMethod, PaymentStatus, Prisma, SubscriptionStatus } from '@prisma/client';
import crypto from 'crypto';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import Razorpay from 'razorpay';
import { logger } from '../utils/logger';

const getRazorpayClient = (): Razorpay => {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
        throw new AppError('Razorpay credentials are not configured', 500);
    }
    return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

const verifyRazorpaySignature = (params: { orderId: string; paymentId: string; signature: string }) => {
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
        throw new AppError('Razorpay credentials are not configured', 500);
    }
    const body = `${params.orderId}|${params.paymentId}`;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    return expected === params.signature;
};

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

        // Automatically update status if expired but record still shows ACTIVE
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

        const planPrice = 500; // Fixed ₹500/month
        const razorpay = getRazorpayClient();
        const amountPaise = planPrice * 100;
        const receipt = `driversub:${params.driverId}:${Date.now()}`;

        let order: any;
        try {
            order = await razorpay.orders.create({
                amount: amountPaise,
                currency: 'INR',
                receipt,
                notes: {
                    purpose: 'DRIVER_SUBSCRIPTION',
                    driverId: params.driverId,
                },
            });
        } catch (error: any) {
            logger.error('Failed to create Razorpay order for Driver Subscription', {
                driverId: params.driverId,
                errorPayload: error?.error || error?.message || error,
            });
            throw new AppError(`Razorpay Order Creation Failed: ${error?.error?.description || error?.message || 'Unknown error'}`, 500);
        }

        const payment = await prisma.payment.create({
            data: {
                bookingId: null,
                userId: params.driverId,
                amount: planPrice,
                paymentMethod: params.paymentMethod,
                status: PaymentStatus.PENDING,
                gatewayTransactionId: String((order as any).id),
                gatewayResponse: {
                    razorpayOrderId: String((order as any).id),
                    receipt,
                    purpose: 'DRIVER_SUBSCRIPTION',
                } as any,
            },
        });

        // Ensure a subscription record exists (even if inactive)
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
            orderId: String((order as any).id),
            amount: Number((order as any).amount),
            currency: String((order as any).currency || 'INR'),
            keyId: process.env.RAZORPAY_KEY_ID as string,
        };
    }

    static async verifySubscriptionPayment(params: {
        driverId: string;
        razorpayOrderId: string;
        razorpayPaymentId: string;
        razorpaySignature: string;
    }) {
        const ok = verifyRazorpaySignature({
            orderId: params.razorpayOrderId,
            paymentId: params.razorpayPaymentId,
            signature: params.razorpaySignature,
        });

        if (!ok) {
            throw new AppError('Invalid payment signature', 400);
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

            // If already paid, just return current status idempotently
            if (payment.status === PaymentStatus.PAID && sub.status === SubscriptionStatus.ACTIVE) {
                return {
                    status: sub.status,
                    validUntil: sub.validUntil,
                };
            }

            // Mark payment as PAID
            await tx.payment.update({
                where: { id: payment.id },
                data: {
                    status: PaymentStatus.PAID,
                    processedAt: new Date(),
                    gatewayResponse: {
                        ...(typeof payment.gatewayResponse === 'object' && payment.gatewayResponse ? (payment.gatewayResponse as any) : {}),
                        razorpayPaymentId: params.razorpayPaymentId,
                        razorpaySignature: params.razorpaySignature,
                        verifiedAt: new Date().toISOString(),
                    } as any,
                },
            });

            // Calculate new expiry (30 days from now)
            const now = new Date();
            // If they already have an active sub, add 30 days to the existing expiry
            // Otherwise, start 30 days from today
            let newValidUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
            if (sub.status === SubscriptionStatus.ACTIVE && sub.validUntil && sub.validUntil > now) {
                newValidUntil = new Date(sub.validUntil.getTime() + 30 * 24 * 60 * 60 * 1000);
            }

            // Activate subscription
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
