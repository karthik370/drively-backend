import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { initiatePayoutTransfer } from './cashfreePayout';
import { logger } from '../utils/logger';

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
                bankAccountNumber: true,
                bankIfscCode: true,
                bankAccountHolderName: true,
                upiId: true,
            },
        });

        if (!profile) throw new AppError('Driver profile not found', 404);

        const totalEarnings = Number(profile.totalEarnings || 0);
        const pendingEarnings = Number(profile.pendingEarnings || 0);

        // Calculate total paid out
        const paidOut = await prisma.driverPayout.aggregate({
            where: { driverId: userId, status: 'COMPLETED' },
            _sum: { amount: true },
        });
        const totalPaidOut = Number(paidOut._sum.amount ?? 0);

        // Available for withdrawal = total earnings - total paid out
        const availableBalance = Math.max(0, totalEarnings - totalPaidOut);

        // Check pending payout requests
        const pendingPayouts = await prisma.driverPayout.aggregate({
            where: { driverId: userId, status: { in: ['PENDING', 'PROCESSING'] } },
            _sum: { amount: true },
        });
        const pendingPayoutsAmount = Number(pendingPayouts._sum.amount ?? 0);

        // Withdrawable = available - pending payout requests
        const withdrawableBalance = Math.max(0, availableBalance - pendingPayoutsAmount);

        return {
            totalEarnings,
            pendingEarnings,
            availableBalance,
            withdrawableBalance,
            totalPaidOut,
            pendingPayoutsAmount,
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
     * Get driver's wallet transaction history
     */
    static async getTransactionHistory(userId: string, limit = 50) {
        // Get booking earnings
        const bookings = await prisma.booking.findMany({
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

        // Merge into a unified timeline
        const transactions: any[] = [];

        for (const b of bookings) {
            transactions.push({
                id: b.id,
                type: 'RIDE_EARNING',
                amount: Number(b.driverEarnings),
                description: `Ride #${b.bookingNumber?.slice(0, 8) ?? b.id.slice(0, 8)}`,
                subtext: b.pickupAddress
                    ? `${(b.pickupAddress as string).substring(0, 40)}...`
                    : undefined,
                commission: Number(b.platformCommission),
                totalFare: Number(b.totalAmount),
                date: b.completedAt || new Date(),
            });
        }

        for (const p of payouts) {
            transactions.push({
                id: p.id,
                type: 'PAYOUT',
                amount: -Number(p.amount),
                description:
                    p.status === 'COMPLETED'
                        ? 'Payout completed'
                        : p.status === 'PROCESSING'
                            ? 'Payout processing'
                            : p.status === 'FAILED'
                                ? 'Payout failed'
                                : 'Payout requested',
                subtext: p.upiId ? `UPI: ${p.upiId}` : 'Bank transfer',
                status: p.status,
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

            if (result.status === 'SUCCESS' || result.status === 'PENDING') {
                // Cashfree accepted the transfer
                await prisma.driverPayout.update({
                    where: { id: payout.id },
                    data: {
                        status: 'PROCESSING',
                        transactionRef: result.referenceId || transferId,
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
}
