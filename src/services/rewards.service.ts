import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';

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
     * Redeem coins for discount on a booking
     */
    static async redeemCoins(userId: string, coinsToSpend: number, bookingId: string): Promise<{
        coinsSpent: number;
        discountAmount: number;
    }> {
        const balance = await this.getBalance(userId);
        if (coinsToSpend > balance) {
            throw new AppError(`Insufficient coins. Balance: ${balance}, requested: ${coinsToSpend}`, 400);
        }

        const discountAmount = Math.floor(coinsToSpend / COINS_TO_RUPEE_RATIO);
        const newBalance = balance - coinsToSpend;

        await prisma.rewardsCoin.create({
            data: {
                userId,
                amount: -coinsToSpend,
                type: 'SPENT',
                reason: `Redeemed ${coinsToSpend} coins for ₹${discountAmount} discount on ride`,
                bookingId,
                balanceAfter: newBalance,
            },
        });

        return { coinsSpent: coinsToSpend, discountAmount };
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
