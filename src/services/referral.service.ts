import crypto from 'crypto';
import { Prisma, WalletTransactionType, WalletTransactionReason, WalletTransactionStatus } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { sendExpoPushNotification } from './expoPush.service';

// ── Reward amounts ──────────────────────────────────────────────────────────
const REFERRAL_REWARDS = {
    DRIVER:   { referrer: 100, referred: 75  },   // ₹100 for referrer, ₹75 for new driver
    CUSTOMER: { referrer: 100, referred: 50  },    // ₹100 for referrer, ₹50 for new customer
};

export class ReferralService {

    // ────────────────────────────────────────────────────────────────────────
    // 1.  GET / CREATE the user's permanent referral code
    // ────────────────────────────────────────────────────────────────────────
    static async getOrCreateCode(userId: string, type: 'DRIVER' | 'CUSTOMER') {
        // Check Referral table for an existing active code of this type
        const existing = await prisma.referral.findFirst({
            where: { referrerUserId: userId, referralType: type, status: 'PENDING' },
        });

        if (existing) {
            return {
                referralCode: existing.referralCode,
                type: existing.referralType,
                rewardAmount: Number(existing.rewardAmount),
                referredReward: Number(existing.referredReward),
            };
        }

        // Generate a new permanent code  (DMC = customer, DMD = driver)
        const prefix = type === 'DRIVER' ? 'DMD' : 'DMC';
        const code = `${prefix}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const rewards = REFERRAL_REWARDS[type];

        const referral = await prisma.referral.create({
            data: {
                referrerUserId: userId,
                referralCode: code,
                referralType: type,
                rewardAmount: rewards.referrer,
                referredReward: rewards.referred,
                expiresAt: null, // permanent — no expiry
            },
        });

        return {
            referralCode: referral.referralCode,
            type: referral.referralType,
            rewardAmount: Number(referral.rewardAmount),
            referredReward: Number(referral.referredReward),
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // 2.  APPLY a referral code  (new user enters code)
    //     This only LINKS the user — reward happens after first ride
    // ────────────────────────────────────────────────────────────────────────
    static async applyReferralCode(referralCode: string, newUserId: string): Promise<{
        applied: boolean;
        referrerName: string;
        rewardOnFirstTrip: number;
    }> {
        const code = referralCode.trim().toUpperCase();

        // Find the referral code
        const referral = await prisma.referral.findUnique({
            where: { referralCode: code },
            include: {
                referrerUser: { select: { firstName: true, lastName: true } },
            },
        });

        if (!referral) throw new AppError('Invalid referral code', 404);
        if (referral.expiresAt && referral.expiresAt < new Date()) throw new AppError('Referral code has expired', 400);
        if (referral.referrerUserId === newUserId) throw new AppError('You cannot use your own referral code', 400);

        // Check if this user already used a referral code
        const alreadyReferred = await prisma.referral.findFirst({
            where: { referredUserId: newUserId, status: { in: ['COMPLETED', 'REWARDED'] } },
        });
        if (alreadyReferred) throw new AppError('You have already used a referral code', 400);

        // Validate type match — customer code for customers, driver code for drivers
        const newUser = await prisma.user.findUnique({
            where: { id: newUserId },
            select: { userType: true },
        });
        if (!newUser) throw new AppError('User not found', 404);

        const isNewUserDriver = newUser.userType === 'DRIVER' || newUser.userType === 'BOTH';
        const isNewUserCustomer = newUser.userType === 'CUSTOMER' || newUser.userType === 'BOTH';

        if (referral.referralType === 'DRIVER' && !isNewUserDriver) {
            throw new AppError('This is a driver referral code. Register as a driver to use it.', 400);
        }
        if (referral.referralType === 'CUSTOMER' && !isNewUserCustomer) {
            throw new AppError('This is a customer referral code. Register as a customer to use it.', 400);
        }

        // Create a new referral record for this specific referral event
        // (the original code stays PENDING so it can be reused for more referrals)
        await prisma.referral.create({
            data: {
                referrerUserId: referral.referrerUserId,
                referredUserId: newUserId,
                referralCode: `${code}_${newUserId.slice(0, 8)}`, // unique per event
                referralType: referral.referralType,
                rewardAmount: referral.rewardAmount,
                referredReward: referral.referredReward,
                status: 'COMPLETED', // applied, waiting for first ride to become REWARDED
            },
        });

        const referrerName = [referral.referrerUser.firstName, referral.referrerUser.lastName]
            .filter(Boolean).join(' ') || 'Your friend';

        logger.info('Referral code applied', {
            code, newUserId, referrerId: referral.referrerUserId, type: referral.referralType,
        });

        return {
            applied: true,
            referrerName,
            rewardOnFirstTrip: Number(referral.referredReward),
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // 3.  PROCESS FIRST-TRIP REWARD
    //     Called from booking completion. If the user was referred and this is
    //     their first completed trip → credit both wallets.
    // ────────────────────────────────────────────────────────────────────────
    static async processFirstTripReward(userId: string, bookingId: string): Promise<void> {
        // Find pending (COMPLETED but not yet REWARDED) referral for this user
        const referral = await prisma.referral.findFirst({
            where: { referredUserId: userId, status: 'COMPLETED' },
        });

        if (!referral) return; // Not a referred user, nothing to do

        // Check this is actually their first completed trip
        const completedTrips = await prisma.booking.count({
            where: {
                OR: [
                    { customerId: userId, status: 'COMPLETED' },
                    { driverId: userId, status: 'COMPLETED' },
                ],
            },
        });

        if (completedTrips > 1) {
            // Not their first trip — they may have been rewarded already or applied code late
            return;
        }

        const referrerReward = Number(referral.rewardAmount);
        const referredReward = Number(referral.referredReward);
        const isDriverReferral = referral.referralType === 'DRIVER';

        await prisma.$transaction(async (tx) => {
            // Mark referral as REWARDED
            await tx.referral.update({
                where: { id: referral.id },
                data: { status: 'REWARDED', completedAt: new Date() },
            });

            if (isDriverReferral) {
                // ── Driver-to-Driver: credit driver wallet (pendingEarnings) ──
                if (referrerReward > 0) {
                    await tx.driverProfile.updateMany({
                        where: { userId: referral.referrerUserId },
                        data: {
                            totalEarnings: { increment: referrerReward },
                            pendingEarnings: { increment: referrerReward },
                        } as any,
                    });
                }
                if (referredReward > 0) {
                    await tx.driverProfile.updateMany({
                        where: { userId: userId },
                        data: {
                            totalEarnings: { increment: referredReward },
                            pendingEarnings: { increment: referredReward },
                        } as any,
                    });
                }
            } else {
                // ── Customer-to-Customer: credit customer wallet ──
                if (referrerReward > 0) {
                    const referrerProfile = await tx.customerProfile.findUnique({
                        where: { userId: referral.referrerUserId },
                        select: { walletBalance: true },
                    });
                    if (referrerProfile) {
                        const newBal = referrerProfile.walletBalance.plus(new Prisma.Decimal(referrerReward));
                        await tx.customerProfile.update({
                            where: { userId: referral.referrerUserId },
                            data: { walletBalance: newBal },
                        });
                        await tx.walletTransaction.create({
                            data: {
                                userId: referral.referrerUserId,
                                type: WalletTransactionType.CREDIT,
                                reason: WalletTransactionReason.REWARD,
                                status: WalletTransactionStatus.COMPLETED,
                                amount: new Prisma.Decimal(referrerReward),
                                balanceAfter: newBal,
                                bookingId,
                                meta: { source: 'referral', referralId: referral.id } as any,
                            },
                        });
                    }
                }

                if (referredReward > 0) {
                    const referredProfile = await tx.customerProfile.findUnique({
                        where: { userId },
                        select: { walletBalance: true },
                    });
                    if (referredProfile) {
                        const newBal = referredProfile.walletBalance.plus(new Prisma.Decimal(referredReward));
                        await tx.customerProfile.update({
                            where: { userId },
                            data: { walletBalance: newBal },
                        });
                        await tx.walletTransaction.create({
                            data: {
                                userId,
                                type: WalletTransactionType.CREDIT,
                                reason: WalletTransactionReason.REWARD,
                                status: WalletTransactionStatus.COMPLETED,
                                amount: new Prisma.Decimal(referredReward),
                                balanceAfter: newBal,
                                bookingId,
                                meta: { source: 'referral', referralId: referral.id } as any,
                            },
                        });
                    }
                }
            }
        });

        logger.info('Referral reward processed', {
            referralId: referral.id,
            referrerId: referral.referrerUserId,
            referredId: userId,
            type: referral.referralType,
            referrerReward,
            referredReward,
            bookingId,
        });

        // Send push notifications (fire-and-forget)
        try {
            const referredUser = await prisma.user.findUnique({
                where: { id: userId },
                select: { firstName: true },
            });
            const referredName = referredUser?.firstName || 'Your referral';

            // Notify referrer
            await sendExpoPushNotification({
                userIds: [referral.referrerUserId],
                title: '🎉 Referral reward!',
                body: isDriverReferral
                    ? `${referredName} completed their first ride! ₹${referrerReward} has been added to your driver wallet.`
                    : `${referredName} completed their first ride! ₹${referrerReward} has been added to your wallet.`,
                data: { kind: 'referral_reward', amount: String(referrerReward) },
            });

            // Notify referred
            await sendExpoPushNotification({
                userIds: [userId],
                title: '🎉 Welcome bonus!',
                body: isDriverReferral
                    ? `Congratulations on your first ride! ₹${referredReward} referral bonus has been added to your driver wallet.`
                    : `Congratulations on your first ride! ₹${referredReward} referral bonus has been added to your wallet.`,
                data: { kind: 'referral_reward', amount: String(referredReward) },
            });
        } catch (e) {
            logger.warn('Failed to send referral reward notifications', { error: e });
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 4.  GET referral stats
    // ────────────────────────────────────────────────────────────────────────
    static async getReferralStats(userId: string) {
        const [totalReferrals, completedReferrals, rewardedReferrals, totalEarned, recentReferrals] = await Promise.all([
            // People who applied this user's code
            prisma.referral.count({
                where: { referrerUserId: userId, referredUserId: { not: null } },
            }),
            prisma.referral.count({
                where: { referrerUserId: userId, status: { in: ['COMPLETED', 'REWARDED'] } },
            }),
            prisma.referral.count({
                where: { referrerUserId: userId, status: 'REWARDED' },
            }),
            prisma.referral.aggregate({
                where: { referrerUserId: userId, status: 'REWARDED' },
                _sum: { rewardAmount: true },
            }),
            // Recent referrals with names
            prisma.referral.findMany({
                where: { referrerUserId: userId, referredUserId: { not: null } },
                orderBy: { createdAt: 'desc' },
                take: 20,
                include: {
                    referredUser: { select: { firstName: true, lastName: true } },
                },
            }),
        ]);

        // Check if this user has applied someone else's referral code
        const myReferral = await prisma.referral.findFirst({
            where: { referredUserId: userId, status: { in: ['COMPLETED', 'REWARDED'] } },
            include: {
                referrerUser: { select: { firstName: true, lastName: true } },
            },
        });

        return {
            totalReferrals,
            completedReferrals,
            rewardedReferrals,
            totalEarned: Number(totalEarned._sum.rewardAmount ?? 0),
            recentReferrals: recentReferrals.map(r => ({
                id: r.id,
                name: [r.referredUser?.firstName, r.referredUser?.lastName].filter(Boolean).join(' ') || 'Unknown',
                type: r.referralType,
                status: r.status,
                reward: Number(r.rewardAmount),
                createdAt: r.createdAt,
                completedAt: r.completedAt,
            })),
            myReferral: myReferral ? {
                referrerName: [myReferral.referrerUser.firstName, myReferral.referrerUser.lastName].filter(Boolean).join(' '),
                status: myReferral.status,
                reward: Number(myReferral.referredReward),
            } : null,
        };
    }
}
