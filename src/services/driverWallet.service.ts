import prisma from '../config/database';
import crypto from 'crypto';
import { Prisma, PaymentMethod, PaymentStatus } from '@prisma/client';
import { AppError } from '../middleware/errorHandler';
import { createCashfreeOrder, verifyCashfreePayment, generateOrderId } from './cashfree';
import { sendExpoPushNotification } from './expoPush.service';
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
        // Fetch ALL completed bookings for this driver.
        // We need ALL of them to generate PLATFORM_FEE entries (applicable to every ride).
        // We will only emit RIDE_EARNING entries for non-CASH rides:
        //   - CASH rides: cash is collected physically by driver (never enters wallet).
        //     Wallet is affected by: PLATFORM_FEE (deducted) + PLATFORM_SUBSIDY (credited).
        //   - Non-CASH rides: the earning IS credited to wallet.
        //     Wallet is affected by: RIDE_EARNING (credited) + PLATFORM_FEE (deducted).
        const allBookings = await prisma.booking.findMany({
            where: {
                driverId: userId,
                status: 'COMPLETED',
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

        for (const b of allBookings) {
            const isCashRide = String((b as any).paymentMethod || '').toUpperCase() === 'CASH';
            const tripFee = feeByBookingId[b.id] ?? (PLATFORM_FEES[(b as any).tripType?.toUpperCase()] ?? 0);
            const pb = typeof (b as any).pricingBreakdown === 'object' && (b as any).pricingBreakdown
                ? (b as any).pricingBreakdown as any : {};
            const subsidy = Number(pb?.platformSubsidy ?? pb?.discounts?.platformSubsidy ?? 0);

            // RIDE_EARNING: only for wallet/UPI/card rides (cash stays with driver physically)
            if (!isCashRide) {
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
            }

            // PLATFORM_FEE: applies to ALL rides (cash and non-cash both deduct from wallet)
            if (tripFee > 0) {
                transactions.push({
                    id: `fee_${b.id}`,
                    type: 'PLATFORM_FEE',
                    amount: -tripFee,
                    description: `Platform fee — Ride #${b.bookingNumber?.slice(0, 8) ?? b.id.slice(0, 8)}`,
                    subtext: `${isCashRide ? 'Cash' : (b as any).paymentMethod} ${(b as any).tripType ?? ''} trip charge`,
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
            const methodSubtext = p.upiId ? `UPI: ${p.upiId}` : p.bankAccountId ? `Bank: ****${p.bankAccountId.slice(-4)}` : 'Bank transfer';
            transactions.push({
                id: p.id,
                type: 'PAYOUT',
                amount: isDeducted ? -Number(p.amount) : Number(p.amount),
                description:
                    pStatus === 'COMPLETED'
                        ? 'Withdrawal completed'
                        : pStatus === 'PROCESSING'
                            ? 'Withdrawal processing'
                            : pStatus === 'FAILED'
                                ? `Withdrawal declined${p.failureReason ? `: ${p.failureReason.slice(0, 40)}` : ''}`
                                : 'Withdrawal pending admin approval',
                subtext: methodSubtext,
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

        // Save/update UPI or bank details if provided
        if (details && (details.upiId || details.bankAccountNumber)) {
            await prisma.driverProfile.update({
                where: { userId },
                data: {
                    ...(details.upiId && { upiId: details.upiId }),
                    ...(details.bankAccountNumber && { bankAccountNumber: details.bankAccountNumber }),
                    ...(details.bankIfscCode && { bankIfscCode: details.bankIfscCode }),
                    ...(details.bankAccountHolderName && { bankAccountHolderName: details.bankAccountHolderName }),
                },
            });
            if (details.upiId) profile.upiId = details.upiId;
            if (details.bankAccountNumber) profile.bankAccountNumber = details.bankAccountNumber;
            if (details.bankIfscCode) profile.bankIfscCode = details.bankIfscCode;
            if (details.bankAccountHolderName) profile.bankAccountHolderName = details.bankAccountHolderName;
        }

        // Validate payout method details
        if (method === 'UPI' && !profile.upiId) {
            throw new AppError('UPI ID not set. Please provide a valid UPI ID.', 400);
        }
        if (method === 'UPI' && profile.upiId && !profile.upiId.includes('@')) {
            throw new AppError('Invalid UPI ID format. Must be like yourname@upi or 9999999999@ybl', 400);
        }
        if (method === 'BANK' && (!profile.bankAccountNumber || profile.bankAccountNumber.startsWith('PEND'))) {
            throw new AppError('Bank account not set. Please provide your bank details.', 400);
        }

        // Validate minimum
        if (amount < 100) throw new AppError('Minimum withdrawal amount is ₹100', 400);

        // Calculate withdrawable balance (re-validate server-side)
        const paidOut = await prisma.driverPayout.aggregate({
            where: { driverId: userId, status: 'COMPLETED' },
            _sum: { amount: true },
        });
        const pendingPayouts = await prisma.driverPayout.aggregate({
            where: { driverId: userId, status: { in: ['PENDING', 'PROCESSING'] } },
            _sum: { amount: true },
        });
        const walletTopupTotal = Number((await prisma.driverProfile.findUnique({
            where: { userId },
            select: { walletTopupTotal: true, platformFeesTotal: true } as any,
        }) as any)?.walletTopupTotal ?? 0);
        const platformFeesTotal = Number((await prisma.driverProfile.findUnique({
            where: { userId },
            select: { platformFeesTotal: true } as any,
        }) as any)?.platformFeesTotal ?? 0);

        const totalEarnings = Number(profile.totalEarnings || 0);
        const totalPaidOut = Number(paidOut._sum.amount ?? 0);
        const pendingAmount = Number(pendingPayouts._sum.amount ?? 0);
        const netBalance = totalEarnings + walletTopupTotal - platformFeesTotal - totalPaidOut;
        const withdrawable = Math.max(0, netBalance - pendingAmount);

        if (amount > withdrawable) {
            throw new AppError(`Insufficient balance. Available to withdraw: ₹${withdrawable.toFixed(0)}`, 400);
        }

        // Create PENDING payout record — amount is now locked
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

        // Fetch driver info for notification
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { firstName: true, lastName: true, phoneNumber: true },
        });
        const driverName = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : 'Driver';
        const payoutDetail = method === 'UPI'
            ? `UPI: ${profile.upiId}`
            : `Bank: ****${profile.bankAccountNumber?.slice(-4)}`;

        // Notify ALL admin users via Expo push
        // We find admins by looking up the ADMIN_PHONE_NUMBERS env var, then finding their user IDs
        await DriverWalletService.notifyAdminsOfWithdrawalRequest({
            payoutId: payout.id,
            driverName,
            amount,
            payoutDetail,
        });

        logger.info('[DriverWallet] Payout requested', { payoutId: payout.id, userId, amount, method });
        return {
            payoutId: payout.id,
            status: 'PENDING',
            message: 'Withdrawal request sent to admin. You will be notified once processed.',
        };
    }

    /**
     * Notify all admin users when a driver requests a withdrawal.
     * Looks up admin phone numbers from ADMIN_PHONE_NUMBERS env, finds their user IDs,
     * then sends Expo push to all of them.
     */
    private static async notifyAdminsOfWithdrawalRequest(params: {
        payoutId: string;
        driverName: string;
        amount: number;
        payoutDetail: string;
    }): Promise<void> {
        try {
            const raw = String(
                process.env.ADMIN_PHONE_NUMBERS ||
                process.env.ADMIN_PHONES ||
                process.env.ADMIN_PHONE ||
                process.env.ADMIN_ALLOWLIST ||
                ''
            ).trim();
            if (!raw) {
                logger.warn('[DriverWallet] No ADMIN_PHONE_NUMBERS configured — skipping admin notification');
                return;
            }

            // Normalize to last-10-digits
            const adminPhones = raw.split(',').map(p => p.replace(/\D/g, '').slice(-10)).filter(p => p.length === 10);
            if (!adminPhones.length) return;

            // Find admin user IDs by their phone numbers (last 10 digits match)
            const adminUsers = await prisma.user.findMany({
                where: {
                    OR: adminPhones.map(phone => ({ phoneNumber: { endsWith: phone } })),
                },
                select: { id: true },
            });

            if (!adminUsers.length) {
                logger.warn('[DriverWallet] Admin phone numbers found but no matching users in DB');
                return;
            }

            const adminIds = adminUsers.map(u => u.id);
            await sendExpoPushNotification({
                userIds: adminIds,
                title: '💸 New Withdrawal Request',
                body: `${params.driverName} requested ₹${params.amount.toFixed(0)} — ${params.payoutDetail}`,
                data: {
                    kind: 'admin_withdrawal_request',
                    payoutId: params.payoutId,
                    screen: 'AdminWithdrawalRequests',
                },
            });
            logger.info('[DriverWallet] Admin notified of withdrawal request', { payoutId: params.payoutId, adminIds });
        } catch (err: any) {
            logger.error('[DriverWallet] Failed to notify admins', { error: err?.message });
            // Non-fatal — don't fail the withdrawal request
        }
    }

    /**
     * [ADMIN ONLY] Get all pending withdrawal requests with full driver details.
     */
    static async getPendingPayoutsForAdmin() {
        const payouts = await prisma.driverPayout.findMany({
            where: { status: { in: ['PENDING', 'PROCESSING'] } },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                amount: true,
                status: true,
                upiId: true,
                bankAccountId: true,
                createdAt: true,
                driverId: true,
            },
        });

        // Fetch driver profiles and user info for each payout
        const driverIds = [...new Set(payouts.map(p => p.driverId))];
        const [profiles, users] = await Promise.all([
            prisma.driverProfile.findMany({
                where: { userId: { in: driverIds } },
                select: {
                    userId: true,
                    upiId: true,
                    bankAccountNumber: true,
                    bankIfscCode: true,
                    bankAccountHolderName: true,
                } as any,
            }),
            prisma.user.findMany({
                where: { id: { in: driverIds } },
                select: { id: true, firstName: true, lastName: true, phoneNumber: true },
            }),
        ]);

        const profileMap = new Map(profiles.map((p: any) => [p.userId, p]));
        const userMap = new Map(users.map(u => [u.id, u]));

        return payouts.map(p => {
            const profile = profileMap.get(p.driverId) as any;
            const user = userMap.get(p.driverId);
            const name = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : 'Unknown';
            return {
                payoutId: p.id,
                amount: Number(p.amount),
                status: p.status,
                createdAt: p.createdAt,
                driverId: p.driverId,
                driverName: name,
                driverPhone: user?.phoneNumber || '',
                // UPI or bank stored on the payout at request time
                upiId: p.upiId || (profile as any)?.upiId || null,
                bankAccountNumber: p.bankAccountId || (profile as any)?.bankAccountNumber || null,
                bankIfscCode: (profile as any)?.bankIfscCode || null,
                bankAccountHolderName: (profile as any)?.bankAccountHolderName || null,
                payoutMethod: p.upiId ? 'UPI' : 'BANK',
            };
        });
    }

    /**
     * [ADMIN ONLY] Approve a withdrawal request.
     * Marks COMPLETED → deducts from wallet (totalPaidOut increases), notifies driver.
     */
    static async approvePayout(payoutId: string): Promise<void> {
        const payout = await prisma.driverPayout.findUnique({
            where: { id: payoutId },
            include: { driver: { select: { id: true, firstName: true, lastName: true } } },
        });
        if (!payout) throw new AppError('Payout request not found', 404);
        if (payout.status === 'COMPLETED') throw new AppError('Payout already completed', 400);
        if (payout.status === 'FAILED') throw new AppError('Payout was already rejected', 400);

        await prisma.driverPayout.update({
            where: { id: payoutId },
            data: {
                status: 'COMPLETED',
                processedAt: new Date(),
                transactionRef: `MANUAL_${Date.now()}`,
            },
        });

        // Notify the driver
        await sendExpoPushNotification({
            userIds: [payout.driverId],
            title: '✅ Withdrawal Processed',
            body: `₹${Number(payout.amount).toFixed(0)} has been transferred to your ${payout.upiId ? 'UPI' : 'bank account'}.`,
            data: {
                kind: 'payout_approved',
                payoutId,
                screen: 'DriverWallet',
            },
        });

        logger.info('[DriverWallet] Payout approved by admin', { payoutId, driverId: payout.driverId, amount: Number(payout.amount) });
    }

    /**
     * [ADMIN ONLY] Reject a withdrawal request.
     * Marks FAILED → amount unlocked (FAILED payouts not counted in pendingAmount).
     */
    static async rejectPayout(payoutId: string, reason?: string): Promise<void> {
        const payout = await prisma.driverPayout.findUnique({
            where: { id: payoutId },
        });
        if (!payout) throw new AppError('Payout request not found', 404);
        if (payout.status === 'COMPLETED') throw new AppError('Cannot reject an already completed payout', 400);
        if (payout.status === 'FAILED') throw new AppError('Payout already rejected', 400);

        const failureReason = reason?.trim() || 'Rejected by admin';

        await prisma.driverPayout.update({
            where: { id: payoutId },
            data: {
                status: 'FAILED',
                failureReason,
            },
        });

        // Notify the driver — amount is now unlocked
        await sendExpoPushNotification({
            userIds: [payout.driverId],
            title: '❌ Withdrawal Declined',
            body: `₹${Number(payout.amount).toFixed(0)} withdrawal was declined. Reason: ${failureReason}`,
            data: {
                kind: 'payout_rejected',
                payoutId,
                screen: 'DriverWallet',
            },
        });

        logger.info('[DriverWallet] Payout rejected by admin', { payoutId, driverId: payout.driverId, reason: failureReason });
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
