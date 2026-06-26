import prisma from '../config/database';
import crypto from 'crypto';
import { Prisma, PaymentMethod, PaymentStatus } from '@prisma/client';
import { AppError } from '../middleware/errorHandler';
import { initiatePayoutTransfer } from './cashfreePayout';
import { createCashfreeOrder, verifyCashfreePayment, generateOrderId } from './cashfree';
import { logger } from '../utils/logger';

/** Trip-type platform fee constants */
const PLATFORM_FEES: Record<string, number> = {
    ONE_WAY: 10,
    ROUND_TRIP: 20,
    OUTSTATION: 30,
    AIRPORT: 10,
    SCHEDULE: 10,
};

export class DriverWalletService {
    /**
     * Get driver's wallet summary (earnings, pending, available for payout)
     */
    static async getWalletSummary(userId: string) {
        const profile = await prisma.driverProfile.findUnique({
            where: { userId },
            select: {
                totalEarnings: true,
                pendingEarnings: true,
                walletTopupTotal: true,
                platformFeesTotal: true,
                bankAccountNumber: true,
                bankIfscCode: true,
                bankAccountHolderName: true,
                upiId: true,
            },
        });

        if (!profile) throw new AppError('Driver profile not found', 404);

        const totalEarnings = Number(profile.totalEarnings || 0);
        const walletTopupTotal = Number((profile as any).walletTopupTotal || 0);
        const platformFeesTotal = Number((profile as any).platformFeesTotal || 0);

        // Calculate total paid out (COMPLETED payouts)
        const paidOut = await prisma.driverPayout.aggregate({
            where: { driverId: userId, status: 'COMPLETED' },
            _sum: { amount: true },
        });
        const totalPaidOut = Number(paidOut._sum.amount ?? 0);

        // Check pending/processing payout requests
        const pendingPayouts = await prisma.driverPayout.aggregate({
            where: { driverId: userId, status: { in: ['PENDING', 'PROCESSING'] } },
            _sum: { amount: true },
        });
        const pendingPayoutsAmount = Number(pendingPayouts._sum.amount ?? 0);

        // Net balance = all credits (earnings + topups) minus all debits (payouts + platform fees)
        // This can go NEGATIVE (platform fees charged even before earnings)
        const netBalance = totalEarnings + walletTopupTotal - totalPaidOut - platformFeesTotal;
        const availableBalance = netBalance; // can be negative

        // Withdrawable: only positive balance minus locked-in-flight payouts
        const withdrawableBalance = Math.max(0, netBalance - pendingPayoutsAmount);

        // Gate: driver is blocked from accepting bookings if balance <= -50
        const BLOCK_THRESHOLD = -50;
        const isBlocked = netBalance <= BLOCK_THRESHOLD;
        const amountToSettle = isBlocked ? Math.abs(netBalance - BLOCK_THRESHOLD) : 0;

        return {
            totalEarnings,
            walletTopupTotal,
            platformFeesTotal,
            availableBalance,
            withdrawableBalance,
            totalPaidOut,
            pendingPayoutsAmount,
            isBlocked,
            amountToSettle: Math.ceil(amountToSettle),
            netBalance,
            payoutMethods: {
                bank: (profile.bankAccountNumber && !profile.bankAccountNumber.startsWith('PEND'))
                    ? {
                        accountNumber: `****${profile.bankAccountNumber.slice(-4)}`,
                        ifsc: profile.bankIfscCode,
                        holderName: profile.bankAccountHolderName,
                    }
                    : null,
                upiId: (profile.upiId && profile.upiId.trim() && !profile.upiId.startsWith('PEND'))
                    ? profile.upiId
                    : null,
            },
        };
    }

    /**
     * Credit platform subsidy to driver for CASH trips.
     * Called immediately after "Collect Cash" — bridges the gap between what
     * customer paid physically (discounted fare) and what driver should earn (full fare).
     *
     * Idempotency: checks Payment table for existing DRIVER_SUBSIDY record for this bookingId.
     * Safe to call multiple times — second call is a no-op.
     */
    static async creditSubsidy(params: {
        driverId: string;
        bookingId: string;
        amount: number;
        reason: string;
    }): Promise<void> {
        if (params.amount <= 0) return; // no subsidy needed

        try {
            // Idempotency guard — prevent double-crediting
            const existing = await prisma.payment.findFirst({
                where: {
                    bookingId: params.bookingId,
                    userId: params.driverId,
                    gatewayResponse: { path: ['purpose'], equals: 'DRIVER_SUBSIDY' },
                },
            });
            if (existing) {
                logger.info('[DriverWallet] Subsidy already credited, skipping', { bookingId: params.bookingId, driverId: params.driverId });
                return;
            }

            await prisma.$transaction(async (tx) => {
                // Credit totalEarnings so it shows up in wallet balance
                await tx.driverProfile.update({
                    where: { userId: params.driverId },
                    data: {
                        totalEarnings: { increment: params.amount },
                        pendingEarnings: { increment: params.amount },
                    } as any,
                });

                // Audit trail — visible in wallet transaction history
                await tx.payment.create({
                    data: {
                        bookingId: params.bookingId,
                        userId: params.driverId,
                        amount: new Prisma.Decimal(params.amount),
                        paymentMethod: PaymentMethod.WALLET,
                        status: PaymentStatus.PAID,
                        processedAt: new Date(),
                        gatewayResponse: {
                            purpose: 'DRIVER_SUBSIDY',
                            reason: params.reason,
                            amount: params.amount,
                            driverId: params.driverId,
                            creditedAt: new Date().toISOString(),
                        } as any,
                    },
                });
            });

            logger.info('[DriverWallet] Platform subsidy credited', {
                driverId: params.driverId,
                bookingId: params.bookingId,
                amount: params.amount,
                reason: params.reason,
            });
        } catch (err: any) {
            logger.error('[DriverWallet] Failed to credit subsidy', {
                driverId: params.driverId,
                bookingId: params.bookingId,
                amount: params.amount,
                error: err?.message,
            });
            // Non-critical — don't fail the cash collection flow
        }
    }

    /**
     * Deduct platform fee from driver wallet when trip completes.
     * Increments platformFeesTotal — reduces net balance (can go negative).
     * Idempotent: checked by bookingId in payment metadata.
     */
    static async deductPlatformFee(driverId: string, bookingId: string, tripType: string): Promise<void> {
        const feeAmount = PLATFORM_FEES[tripType?.toUpperCase()] ?? PLATFORM_FEES['ONE_WAY'];
        if (feeAmount <= 0) return;

        try {
            // Idempotency: check if fee already deducted for this booking
            const existing = await prisma.payment.findFirst({
                where: {
                    bookingId,
                    gatewayResponse: { path: ['purpose'], equals: 'DRIVER_PLATFORM_FEE' },
                },
            });
            if (existing) {
                logger.info('[DriverWallet] Platform fee already deducted', { bookingId, driverId });
                return;
            }

            await prisma.$transaction(async (tx) => {
                await (tx.driverProfile as any).update({
                    where: { userId: driverId },
                    data: {
                        platformFeesTotal: { increment: feeAmount },
                    },
                });

                // Record the deduction as a Payment record for audit trail
                await tx.payment.create({
                    data: {
                        bookingId,
                        userId: driverId,
                        amount: new Prisma.Decimal(feeAmount),
                        paymentMethod: PaymentMethod.WALLET,
                        status: PaymentStatus.PAID,
                        processedAt: new Date(),
                        gatewayResponse: {
                            purpose: 'DRIVER_PLATFORM_FEE',
                            tripType,
                            feeAmount,
                            driverId,
                        } as any,
                    },
                });
            });

            logger.info('[DriverWallet] Platform fee deducted', { driverId, bookingId, tripType, feeAmount });
        } catch (err: any) {
            logger.error('[DriverWallet] Failed to deduct platform fee', { driverId, bookingId, feeAmount, error: err?.message });
            // Non-critical — don't fail the trip completion
        }
    }

    /**
     * Create a Cashfree top-up order for driver wallet (identical pattern to customer wallet top-up).
     */
    static async createTopupOrder(params: { userId: string; amount: number; paymentMethod: PaymentMethod }) {
        const amount = Math.round(params.amount * 100) / 100;
        if (!Number.isFinite(amount) || amount <= 0) throw new AppError('Invalid amount', 400);

        const profile = await prisma.driverProfile.findUnique({
            where: { userId: params.userId },
            select: { userId: true },
        });
        if (!profile) throw new AppError('Driver profile not found', 404);

        const user = await prisma.user.findUnique({
            where: { id: params.userId },
            select: { phoneNumber: true, email: true, firstName: true, lastName: true },
        });

        const cfOrderId = generateOrderId('dwtop', params.userId);

        const cfOrder = await createCashfreeOrder({
            orderId: cfOrderId,
            amount,
            customerId: params.userId,
            customerPhone: user?.phoneNumber || '9999999999',
            customerEmail: user?.email || undefined,
            customerName: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || undefined,
            orderNote: 'Driver Wallet Topup',
            orderTags: {
                purpose: 'DRIVER_WALLET_TOPUP',
                userId: params.userId,
            },
        });

        const payment = await prisma.payment.create({
            data: {
                bookingId: null,
                userId: params.userId,
                amount: new Prisma.Decimal(amount),
                paymentMethod: params.paymentMethod,
                status: PaymentStatus.PENDING,
                gatewayTransactionId: cfOrder.orderId,
                gatewayResponse: {
                    cfOrderId: cfOrder.cfOrderId,
                    orderId: cfOrder.orderId,
                    paymentSessionId: cfOrder.paymentSessionId,
                    purpose: 'DRIVER_WALLET_TOPUP',
                } as any,
            },
        });

        return {
            paymentId: payment.id,
            orderId: cfOrder.orderId,
            paymentSessionId: cfOrder.paymentSessionId,
            amount: cfOrder.orderAmount,
            currency: cfOrder.orderCurrency,
        };
    }

    /**
     * Verify driver wallet top-up after Cashfree payment completes.
     * Credits walletTopupTotal — increases net balance.
     */
    static async verifyTopup(params: { userId: string; cfOrderId: string }) {
        const cfStatus = await verifyCashfreePayment(params.cfOrderId);
        if (!cfStatus.isPaid) {
            throw new AppError(`Payment not completed. Status: ${cfStatus.orderStatus}`, 400);
        }

        return await prisma.$transaction(async (tx) => {
            const payment = await tx.payment.findFirst({
                where: {
                    userId: params.userId,
                    gatewayTransactionId: params.cfOrderId,
                },
                orderBy: { createdAt: 'desc' },
            });

            if (!payment) throw new AppError('Payment record not found', 404);

            // Idempotent: already processed
            if (payment.status === PaymentStatus.PAID) {
                const prof = await tx.driverProfile.findUnique({ where: { userId: params.userId }, select: { walletTopupTotal: true, totalEarnings: true, platformFeesTotal: true } });
                const wt = Number((prof as any)?.walletTopupTotal || 0);
                const te = Number(prof?.totalEarnings || 0);
                const pf = Number((prof as any)?.platformFeesTotal || 0);
                return { alreadyPaid: true, balance: te + wt - pf };
            }

            const amount = Number(payment.amount);

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

            await (tx.driverProfile as any).update({
                where: { userId: params.userId },
                data: {
                    walletTopupTotal: { increment: amount },
                },
            });

            const updatedProf = await tx.driverProfile.findUnique({
                where: { userId: params.userId },
                select: { totalEarnings: true, walletTopupTotal: true, platformFeesTotal: true } as any,
            });
            const newBalance = Number((updatedProf as any)?.totalEarnings || 0)
                + Number((updatedProf as any)?.walletTopupTotal || 0)
                - Number((updatedProf as any)?.platformFeesTotal || 0);

            logger.info('[DriverWallet] Topup credited', { userId: params.userId, amount, newBalance });
            return { alreadyPaid: false, credited: amount, balance: newBalance };
        });
    }

    /**
     * Get driver's wallet transaction history
     */
    static async getTransactionHistory(userId: string, limit = 50) {
        // Get booking earnings — only wallet-affecting rides (non-CASH payment methods).
        // For CASH rides: the cash is collected physically by the driver (never enters wallet).
        // The platform subsidy for CASH rides is shown separately as PLATFORM_SUBSIDY.
        const bookings = await prisma.booking.findMany({
            where: {
                driverId: userId,
                status: 'COMPLETED',
                // CASH rides: cash never hits wallet. Only wallet/UPI/card earnings are wallet credits.
                paymentMethod: { not: 'CASH' } as any,
            },
            select: {
                id: true,
                bookingNumber: true,
                driverEarnings: true,
                platformCommission: true,
                totalAmount: true,
                completedAt: true,
                pickupAddress: true,
                dropAddress: true,
                tripType: true,
                paymentMethod: true,
            },
            orderBy: { completedAt: 'desc' },
            take: limit,
        });

        // Get payouts
        const payouts = await prisma.driverPayout.findMany({
            where: { driverId: userId },
            orderBy: { createdAt: 'desc' },
            take: 20,
        });

        // Get tips received
        const tips = await prisma.tip.findMany({
            where: { driverId: userId, status: 'PAID' },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: {
                id: true,
                amount: true,
                createdAt: true,
                booking: {
                    select: { bookingNumber: true },
                },
            },
        });

        // Get platform fee deductions (from Payment records)
        const feePayments = await prisma.payment.findMany({
            where: {
                userId,
                gatewayResponse: { path: ['purpose'], equals: 'DRIVER_PLATFORM_FEE' },
            },
            orderBy: { processedAt: 'desc' },
            take: 30,
            select: { id: true, amount: true, bookingId: true, processedAt: true, gatewayResponse: true },
        });

        // Get platform subsidy credits (cash trips — platform topped up driver wallet)
        const subsidyPayments = await prisma.payment.findMany({
            where: {
                userId,
                status: 'PAID',
                gatewayResponse: { path: ['purpose'], equals: 'DRIVER_SUBSIDY' },
            },
            orderBy: { processedAt: 'desc' },
            take: 30,
            select: { id: true, amount: true, bookingId: true, processedAt: true, gatewayResponse: true },
        });

        // Get wallet topup payments
        const topupPayments = await prisma.payment.findMany({
            where: {
                userId,
                status: 'PAID',
                gatewayResponse: { path: ['purpose'], equals: 'DRIVER_WALLET_TOPUP' },
            },
            orderBy: { processedAt: 'desc' },
            take: 20,
            select: { id: true, amount: true, processedAt: true },
        });

        // Merge into a unified timeline
        const transactions: any[] = [];

        // Map bookingId → platform fee for display
        const feeByBookingId: Record<string, number> = {};
        for (const f of feePayments) {
            if (f.bookingId) feeByBookingId[f.bookingId] = Number(f.amount);
        }

        for (const b of bookings) {
            const tripFee = feeByBookingId[b.id] ?? (PLATFORM_FEES[(b as any).tripType?.toUpperCase()] ?? 0);
            const pb = typeof (b as any).pricingBreakdown === 'object' && (b as any).pricingBreakdown
                ? (b as any).pricingBreakdown as any : {};
            const subsidy = Number(pb?.platformSubsidy ?? pb?.discounts?.platformSubsidy ?? 0);

            transactions.push({
                id: b.id,
                type: 'RIDE_EARNING',
                amount: Number(b.driverEarnings),
                description: `Ride #${b.bookingNumber?.slice(0, 8) ?? b.id.slice(0, 8)}`,
                subtext: b.pickupAddress
                    ? `${(b.pickupAddress as string).substring(0, 40)}...`
                    : undefined,
                commission: Number(b.platformCommission),
                platformFee: tripFee,
                platformSubsidy: subsidy,
                customerFare: Number(b.totalAmount), // what customer paid
                date: b.completedAt || new Date(),
            });
            // Platform fee deduction as separate line
            if (tripFee > 0) {
                transactions.push({
                    id: `fee_${b.id}`,
                    type: 'PLATFORM_FEE',
                    amount: -tripFee,
                    description: `Platform fee — Ride #${b.bookingNumber?.slice(0, 8) ?? b.id.slice(0, 8)}`,
                    subtext: `${(b as any).tripType ?? ''} trip charge`,
                    date: b.completedAt || new Date(),
                });
            }
        }

        // Subsidy credits from Payment records (CASH trips only)
        for (const sub of subsidyPayments) {
            const gr = typeof sub.gatewayResponse === 'object' && sub.gatewayResponse
                ? (sub.gatewayResponse as any) : {};
            transactions.push({
                id: `subsidy_${sub.id}`,
                type: 'PLATFORM_SUBSIDY',
                amount: Number(sub.amount),
                description: `Platform subsidy — Ride #${sub.bookingId?.slice(0, 8) ?? '?'}`,
                subtext: gr.reason || 'Membership/streak discount absorbed by platform',
                date: sub.processedAt || new Date(),
            });
        }

        for (const top of topupPayments) {
            transactions.push({
                id: `topup_${top.id}`,
                type: 'WALLET_TOPUP',
                amount: Number(top.amount),
                description: 'Wallet top-up',
                subtext: 'Added via Cashfree',
                date: top.processedAt || new Date(),
            });
        }

        for (const p of payouts) {
            const pStatus = p.status;
            // Only COMPLETED payouts are actual deductions from balance
            const isDeducted = pStatus === 'COMPLETED';
            transactions.push({
                id: p.id,
                type: 'PAYOUT',
                amount: isDeducted ? -Number(p.amount) : Number(p.amount),
                description:
                    pStatus === 'COMPLETED'
                        ? 'Withdrawal successful'
                        : pStatus === 'PROCESSING'
                            ? 'Withdrawal processing'
                            : pStatus === 'FAILED'
                                ? 'Withdrawal failed'
                                : 'Withdrawal requested',
                subtext: p.upiId ? `UPI: ${p.upiId}` : 'Bank transfer',
                status: pStatus,
                date: p.processedAt || p.createdAt,
            });
        }

        for (const t of tips) {
            transactions.push({
                id: t.id,
                type: 'TIP',
                amount: Number(t.amount),
                description: `Tip for ride #${t.booking?.bookingNumber?.slice(0, 8) ?? ''}`,
                date: t.createdAt,
            });
        }

        // Sort by date descending
        transactions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        return transactions.slice(0, limit);
    }

    /**
     * Request a payout (withdrawal) to bank or UPI
     */
    static async requestPayout(
        userId: string,
        amount: number,
        method: 'BANK' | 'UPI',
        details?: { upiId?: string; bankAccountNumber?: string; bankIfscCode?: string; bankAccountHolderName?: string }
    ): Promise<{ payoutId: string; status: string; message?: string }> {
        const profile = await prisma.driverProfile.findUnique({
            where: { userId },
            select: {
                totalEarnings: true,
                bankAccountNumber: true,
                bankAccountHolderName: true,
                bankIfscCode: true,
                upiId: true,
            },
        });

        if (!profile) throw new AppError('Driver profile not found', 404);

        // Update profile if details provided
        if (details && (details.upiId || details.bankAccountNumber)) {
            await prisma.driverProfile.update({
                where: { userId },
                data: {
                    ...(details.upiId && { upiId: details.upiId }),
                    ...(details.bankAccountNumber && { bankAccountNumber: details.bankAccountNumber }),
                    ...(details.bankIfscCode && { bankIfscCode: details.bankIfscCode }),
                    ...(details.bankAccountHolderName && { bankAccountHolderName: details.bankAccountHolderName }),
                }
            });
            // Update local profile object so the rest of the function uses it
            if (details.upiId) profile.upiId = details.upiId;
            if (details.bankAccountNumber) profile.bankAccountNumber = details.bankAccountNumber;
            if (details.bankIfscCode) profile.bankIfscCode = details.bankIfscCode;
            if (details.bankAccountHolderName) profile.bankAccountHolderName = details.bankAccountHolderName;
        }

        if (method === 'UPI' && !profile.upiId) {
            throw new AppError('UPI ID not set. Please provide a valid UPI ID.', 400);
        }
        if (method === 'UPI' && profile.upiId && !profile.upiId.includes('@')) {
            throw new AppError('Invalid UPI ID format. Must be like yourname@upi or 9999999999@ybl', 400);
        }
        if (method === 'BANK' && !profile.bankAccountNumber) {
            throw new AppError('Bank account not set. Please provide Bank Details.', 400);
        }

        // Calculate available balance
        const paidOut = await prisma.driverPayout.aggregate({
            where: { driverId: userId, status: 'COMPLETED' },
            _sum: { amount: true },
        });
        const pendingPayouts = await prisma.driverPayout.aggregate({
            where: { driverId: userId, status: { in: ['PENDING', 'PROCESSING'] } },
            _sum: { amount: true },
        });

        const totalPaidOut = Number(paidOut._sum.amount ?? 0);
        const pendingAmount = Number(pendingPayouts._sum.amount ?? 0);
        const totalEarnings = Number(profile.totalEarnings || 0);
        const withdrawable = Math.max(0, totalEarnings - totalPaidOut - pendingAmount);

        if (amount > withdrawable) {
            throw new AppError(`Insufficient balance. Available: ₹${withdrawable.toFixed(2)}`, 400);
        }

        if (amount < 100) {
            throw new AppError('Minimum withdrawal amount is ₹100', 400);
        }

        const now = new Date();
        const payout = await prisma.driverPayout.create({
            data: {
                driverId: userId,
                amount,
                frequency: 'DAILY',
                periodStart: now,
                periodEnd: now,
                status: 'PENDING',
                upiId: method === 'UPI' ? profile.upiId : undefined,
                bankAccountId: method === 'BANK' ? profile.bankAccountNumber : undefined,
            },
        });

        // Fetch driver name and phone for Cashfree
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { firstName: true, lastName: true, phoneNumber: true, email: true },
        });

        const beneName = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : 'Driver';
        const benePhone = user?.phoneNumber || '9999999999';
        const beneEmail = user?.email || undefined;

        // Initiate transfer via Cashfree Payouts
        try {
            const transferId = `PAY_${payout.id.replace(/-/g, '').slice(0, 30)}`;

            const result = await initiatePayoutTransfer({
                transferId,
                amount,
                driverId: userId,
                transferMode: method === 'UPI' ? 'upi' : 'banktransfer',
                beneName,
                benePhone,
                beneEmail,
                beneVpa: method === 'UPI' ? (profile.upiId || undefined) : undefined,
                beneBankAccount: method === 'BANK' ? (profile.bankAccountNumber || undefined) : undefined,
                beneIfsc: method === 'BANK' ? (profile.bankIfscCode || undefined) : undefined,
                remarks: `DriveMate withdrawal - ${payout.id}`,
                forceRecreate: !!(details && (details.upiId || details.bankAccountNumber)),
            });

            if (result.status === 'SUCCESS' || result.status === 'PENDING' || result.status === 'RECEIVED') {
                // Cashfree accepted the transfer
                await prisma.driverPayout.update({
                    where: { id: payout.id },
                    data: {
                        status: 'PROCESSING',
                        transactionRef: transferId,
                    },
                });
                return { payoutId: payout.id, status: 'PROCESSING', message: 'Transfer initiated successfully' };
            } else {
                // Cashfree rejected the transfer
                await prisma.driverPayout.update({
                    where: { id: payout.id },
                    data: {
                        status: 'FAILED',
                        failureReason: result.message || 'Transfer rejected by payment provider',
                    },
                });
                return { payoutId: payout.id, status: 'FAILED', message: result.message || 'Transfer failed' };
            }
        } catch (err: any) {
            logger.error('Cashfree payout initiation failed', { payoutId: payout.id, error: err?.message });

            // Mark as FAILED in DB
            await prisma.driverPayout.update({
                where: { id: payout.id },
                data: {
                    status: 'FAILED',
                    failureReason: err?.message || 'Transfer initiation failed',
                },
            });

            return { payoutId: payout.id, status: 'FAILED', message: err?.message || 'Transfer failed' };
        }
    }

    /**
     * Save / update driver's UPI ID for QR code payments.
     * Creates a driver_profiles row if none exists (some drivers skip onboarding steps).
     */
    static async saveUpiId(userId: string, upiId: string) {
        await prisma.driverProfile.upsert({
            where: { userId },
            update: { upiId },
            create: {
                userId,
                upiId,
                totalEarnings: 0,
                pendingEarnings: 0,
                totalTrips: 0,
                rating: 5.0,
                totalRatings: 0,
                isVerified: false,
                isAvailable: false,
            } as any,
        });
        logger.info('[DriverWallet] UPI ID saved', { userId, upiId });
        return { upiId };
    }

    /**
     * Get payout history
     */
    static async getPayoutHistory(userId: string, limit = 20) {
        return prisma.driverPayout.findMany({
            where: { driverId: userId },
            orderBy: { createdAt: 'desc' },
            take: limit,
            select: {
                id: true,
                amount: true,
                frequency: true,
                status: true,
                upiId: true,
                bankAccountId: true,
                processedAt: true,
                failureReason: true,
                createdAt: true,
            },
        });
    }

    /**
     * Handle Cashfree Payout Webhook
     * Called when Cashfree sends transfer status updates (SUCCESS, FAILED, REVERSED, etc.)
     * This is the ONLY way payout status moves from PROCESSING → COMPLETED or FAILED
     */
    static async handlePayoutWebhook(payload: any, signature: string | null, rawBody: string) {
        // Verify webhook signature using Cashfree's client secret
        const clientSecret = process.env.CASHFREE_PAYOUT_CLIENT_SECRET;
        if (!clientSecret) {
            logger.error('CASHFREE_PAYOUT_CLIENT_SECRET not set, cannot verify payout webhook');
            throw new AppError('Webhook verification failed', 500);
        }

        // Cashfree Payouts webhook uses HMAC-SHA256 with client_secret as key
        if (!signature) {
            logger.warn('Payout webhook missing signature header');
            throw new AppError('Webhook signature required', 401);
        }

        const computed = crypto
            .createHmac('sha256', clientSecret)
            .update(rawBody)
            .digest('base64');

        if (computed !== signature) {
            logger.warn('Payout webhook signature mismatch', { received: signature, computed });
            throw new AppError('Invalid webhook signature', 401);
        }

        logger.info('Payout webhook received', { payload: JSON.stringify(payload) });

        // Cashfree payout webhook structure:
        // { event: "TRANSFER_SUCCESS" | "TRANSFER_FAILED" | ..., transferId: "...", ... }
        const event = payload?.event || payload?.type || '';
        const transferData = payload?.data || payload;
        const transferId = transferData?.transfer_id || transferData?.transferId || '';
        const cfReferenceId = transferData?.referenceId || transferData?.cf_transfer_id || '';
        const cfStatus = transferData?.status || '';
        const reason = transferData?.status_description || transferData?.reason || transferData?.message || '';

        if (!transferId && !cfReferenceId) {
            logger.warn('Payout webhook missing transferId', { payload: JSON.stringify(payload) });
            return { received: true };
        }

        // Find the payout by transactionRef — search by our transferId first, then Cashfree's referenceId
        let payout = await prisma.driverPayout.findFirst({
            where: { transactionRef: transferId },
        });
        if (!payout && cfReferenceId) {
            payout = await prisma.driverPayout.findFirst({
                where: { transactionRef: cfReferenceId },
            });
        }

        if (!payout) {
            logger.warn('Payout webhook: no matching payout found', { transferId });
            return { received: true };
        }

        // Already in terminal state — ignore duplicate webhooks
        if (payout.status === 'COMPLETED' || payout.status === 'FAILED') {
            logger.info('Payout webhook: already in terminal state, ignoring', {
                payoutId: payout.id, currentStatus: payout.status, webhookEvent: event,
            });
            return { received: true };
        }

        // Determine new status based on Cashfree event/status
        const successEvents = ['TRANSFER_SUCCESS', 'SUCCESS'];
        const failEvents = ['TRANSFER_FAILED', 'TRANSFER_REVERSED', 'TRANSFER_REJECTED', 'FAILED', 'REVERSED', 'REJECTED'];

        const isSuccess = successEvents.includes(event) || cfStatus === 'SUCCESS';
        const isFail = failEvents.includes(event) || ['FAILED', 'REVERSED', 'REJECTED'].includes(cfStatus);

        if (isSuccess) {
            await prisma.driverPayout.update({
                where: { id: payout.id },
                data: {
                    status: 'COMPLETED',
                    processedAt: new Date(),
                },
            });
            logger.info('Payout marked COMPLETED via webhook', {
                payoutId: payout.id, transferId, amount: Number(payout.amount),
            });
        } else if (isFail) {
            await prisma.driverPayout.update({
                where: { id: payout.id },
                data: {
                    status: 'FAILED',
                    failureReason: reason || `Transfer ${event}`,
                },
            });
            logger.info('Payout marked FAILED via webhook', {
                payoutId: payout.id, transferId, reason, event,
            });
        } else {
            logger.info('Payout webhook: unhandled event, ignoring', {
                payoutId: payout.id, event, cfStatus,
            });
        }

        return { received: true };
    }
}
