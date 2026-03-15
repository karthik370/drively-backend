import { Prisma, WalletTransactionType, WalletTransactionReason, WalletTransactionStatus } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

const COINS_PER_RIDE = 10;           // Earn 10 coins per completed ride
const COINS_PER_100_SPENT = 5;       // Earn 5 coins per ₹100 spent
const COINS_TO_RUPEE_RATIO = 10;     // 10 coins = ₹1 discount

export class RewardsService {
    /**
     * Get user's coin balance
     */
    static async getBalance(userId: string): Promise<number> {
        const result = await prisma.rewardsCoin.aggregate({
            where: { userId },
            _sum: { amount: true },
        });
        return Number(result._sum.amount ?? 0);
    }

    /**
     * Get coin transaction history
     */
    static async getHistory(userId: string, limit = 50) {
        const transactions = await prisma.rewardsCoin.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });

        return transactions.map((t) => ({
            id: t.id,
            amount: t.amount,
            type: t.type,
            reason: t.reason,
            bookingId: t.bookingId,
            balanceAfter: t.balanceAfter,
            createdAt: t.createdAt,
        }));
    }

    /**
     * Award coins for a completed ride
     */
    static async awardRideCoins(userId: string, bookingId: string, fareAmount: number): Promise<number> {
        const rideCoins = COINS_PER_RIDE;
        const fareCoins = Math.floor(fareAmount / 100) * COINS_PER_100_SPENT;
        const totalCoins = rideCoins + fareCoins;

        if (totalCoins <= 0) return 0;

        const currentBalance = await this.getBalance(userId);
        const newBalance = currentBalance + totalCoins;

        await prisma.rewardsCoin.create({
            data: {
                userId,
                amount: totalCoins,
                type: 'EARNED',
                reason: `Earned for ride #${bookingId.slice(0, 8)} (${rideCoins} ride + ${fareCoins} fare bonus)`,
                bookingId,
                balanceAfter: newBalance,
                expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year expiry
            },
        });

        return totalCoins;
    }

    /**
     * Award bonus coins (referral, streak, etc.)
     */
    static async awardBonusCoins(userId: string, amount: number, reason: string): Promise<number> {
        const currentBalance = await this.getBalance(userId);
        const newBalance = currentBalance + amount;

        await prisma.rewardsCoin.create({
            data: {
                userId,
                amount,
                type: 'BONUS',
                reason,
                balanceAfter: newBalance,
                expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
            },
        });

        return newBalance;
    }

    /**
     * Redeem coins for wallet credit
     * Coins are deducted and equivalent ₹ is added to customer wallet
     */
    static async redeemCoins(userId: string, coinsToSpend: number, bookingId?: string): Promise<{
        coinsSpent: number;
        discountAmount: number;
        walletBalance: number;
    }> {
        const balance = await this.getBalance(userId);
        if (coinsToSpend > balance) {
            throw new AppError(`Insufficient coins. Balance: ${balance}, requested: ${coinsToSpend}`, 400);
        }

        if (coinsToSpend < COINS_TO_RUPEE_RATIO) {
            throw new AppError(`Minimum ${COINS_TO_RUPEE_RATIO} coins required to redeem (= ₹1)`, 400);
        }

        const discountAmount = Math.floor(coinsToSpend / COINS_TO_RUPEE_RATIO);
        const newCoinBalance = balance - coinsToSpend;

        // Use transaction to atomically deduct coins AND credit wallet
        const result = await prisma.$transaction(async (tx) => {
            // 1. Record coin spend
            await tx.rewardsCoin.create({
                data: {
                    userId,
                    amount: -coinsToSpend,
                    type: 'SPENT',
                    reason: `Redeemed ${coinsToSpend} coins for ₹${discountAmount} wallet credit`,
                    bookingId: bookingId || undefined,
                    balanceAfter: newCoinBalance,
                },
            });

            // 2. Credit customer wallet
            const profile = await tx.customerProfile.findUnique({
                where: { userId },
                select: { walletBalance: true },
            });

            if (!profile) {
                throw new AppError('Customer profile not found', 404);
            }

            const creditAmount = new Prisma.Decimal(discountAmount);
            const nextWalletBalance = profile.walletBalance.plus(creditAmount);

            await tx.customerProfile.update({
                where: { userId },
                data: { walletBalance: nextWalletBalance },
            });

            // 3. Record wallet transaction
            await tx.walletTransaction.create({
                data: {
                    userId,
                    type: WalletTransactionType.CREDIT,
                    reason: WalletTransactionReason.REWARD,
                    status: WalletTransactionStatus.COMPLETED,
                    amount: creditAmount,
                    balanceAfter: nextWalletBalance,
                    bookingId: bookingId || undefined,
                    meta: {
                        coinsSpent: coinsToSpend,
                        coinBalance: newCoinBalance,
                    } as any,
                },
            });

            return { walletBalance: Number(nextWalletBalance) };
        });

        logger.info('Coins redeemed for wallet credit', {
            userId, coinsSpent: coinsToSpend, discountAmount, newCoinBalance,
        });

        return { coinsSpent: coinsToSpend, discountAmount, walletBalance: result.walletBalance };
    }

    /**
     * Get summary for UI display
     */
    static async getSummary(userId: string) {
        const [balance, totalEarned, totalSpent, recentHistory] = await Promise.all([
            this.getBalance(userId),
            prisma.rewardsCoin.aggregate({
                where: { userId, type: { in: ['EARNED', 'BONUS'] } },
                _sum: { amount: true },
            }),
            prisma.rewardsCoin.aggregate({
                where: { userId, type: 'SPENT' },
                _sum: { amount: true },
            }),
            this.getHistory(userId, 10),
        ]);

        return {
            balance,
            totalEarned: Number(totalEarned._sum.amount ?? 0),
            totalSpent: Math.abs(Number(totalSpent._sum.amount ?? 0)),
            discountValue: Math.floor(balance / COINS_TO_RUPEE_RATIO),
            recentHistory,
        };
    }
}
