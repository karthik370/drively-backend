import crypto from 'crypto';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';

const REFERRAL_REWARDS = {
    DRIVER: { referrer: 500, referred: 250 },  // ₹500 for referring, ₹250 for new driver
    CUSTOMER: { referrer: 100, referred: 50 },  // ₹100 for referring, ₹50 for new customer
};

export class ReferralService {
    /**
     * Generate a referral code for a user
     */
    static async generateReferralCode(userId: string, type: 'DRIVER' | 'CUSTOMER'): Promise<{
        referralCode: string;
        rewardAmount: number;
        referredReward: number;
    }> {
        // Check if user already has a referral code of this type
        const existing = await prisma.referral.findFirst({
            where: { referrerUserId: userId, referralType: type, status: 'PENDING' },
        });

        if (existing) {
            return {
                referralCode: existing.referralCode,
                rewardAmount: Number(existing.rewardAmount),
                referredReward: Number(existing.referredReward),
            };
        }

        const code = `DM${type.charAt(0)}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const rewards = REFERRAL_REWARDS[type];

        const referral = await prisma.referral.create({
            data: {
                referrerUserId: userId,
                referralCode: code,
                referralType: type,
                rewardAmount: rewards.referrer,
                referredReward: rewards.referred,
                expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
            },
        });

        return {
            referralCode: referral.referralCode,
            rewardAmount: Number(referral.rewardAmount),
            referredReward: Number(referral.referredReward),
        };
    }

    /**
     * Apply a referral code when a new user signs up
     */
    static async applyReferralCode(referralCode: string, newUserId: string): Promise<void> {
        const referral = await prisma.referral.findUnique({
            where: { referralCode },
        });

        if (!referral) throw new AppError('Invalid referral code', 404);
        if (referral.status !== 'PENDING') throw new AppError('Referral code already used or expired', 400);
        if (referral.expiresAt && referral.expiresAt < new Date()) throw new AppError('Referral code expired', 400);
        if (referral.referrerUserId === newUserId) throw new AppError('Cannot use your own referral code', 400);

        await prisma.referral.update({
            where: { id: referral.id },
            data: {
                referredUserId: newUserId,
                status: 'COMPLETED',
                completedAt: new Date(),
            },
        });
    }

    /**
     * Get referral stats for a user
     */
    static async getReferralStats(userId: string) {
        const [totalReferrals, completedReferrals, totalEarned] = await Promise.all([
            prisma.referral.count({ where: { referrerUserId: userId } }),
            prisma.referral.count({ where: { referrerUserId: userId, status: { in: ['COMPLETED', 'REWARDED'] } } }),
            prisma.referral.aggregate({
                where: { referrerUserId: userId, status: 'REWARDED' },
                _sum: { rewardAmount: true },
            }),
        ]);

        // Get active codes
        const activeCodes = await prisma.referral.findMany({
            where: { referrerUserId: userId, status: 'PENDING' },
            select: { referralCode: true, referralType: true, rewardAmount: true, referredReward: true, expiresAt: true },
        });

        return {
            totalReferrals,
            completedReferrals,
            totalEarned: Number(totalEarned._sum.rewardAmount ?? 0),
            activeCodes,
        };
    }
}
