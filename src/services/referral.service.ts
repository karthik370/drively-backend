import crypto from 'crypto';
import { Prisma, WalletTransactionType, WalletTransactionReason, WalletTransactionStatus, SubscriptionStatus } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { sendExpoPushNotification } from './expoPush.service';

// ── Reward amounts ──────────────────────────────────────────────────────────
const REFERRAL_REWARDS = {
    DRIVER:              { referrer: 100, referred: 75  },   // ₹100 for referrer, ₹75 for new driver
    CUSTOMER:            { referrer: 100, referred: 50  },   // ₹100 for referrer, ₹50 for new customer
    DRIVER_TO_CUSTOMER:  { referrer: 0,   referred: 0   },   // No wallet credit — only free subscription months
};

// ── Driver-to-Customer milestone thresholds ─────────────────────────────────
const CUSTOMER_REFERRAL_MILESTONES = [
    { count: 5,  freeMonths: 1 },
    { count: 10, freeMonths: 2 },
];

type ReferralType = 'DRIVER' | 'CUSTOMER' | 'DRIVER_TO_CUSTOMER';

export class ReferralService {

    // ────────────────────────────────────────────────────────────────────────
    // 1.  GET / CREATE the user's permanent referral code
    // ────────────────────────────────────────────────────────────────────────
    static async getOrCreateCode(userId: string, type: ReferralType) {
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

        // Generate a new permanent code
        // DMC = customer-to-customer, DMD = driver-to-driver, DMX = driver-to-customer
        const prefixMap: Record<ReferralType, string> = {
            DRIVER: 'DMD',
            CUSTOMER: 'DMC',
            DRIVER_TO_CUSTOMER: 'DMX',
        };
        const prefix = prefixMap[type];
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
    //     This only LINKS the user — reward happens after first qualifying ride
    // ────────────────────────────────────────────────────────────────────────
    static async applyReferralCode(referralCode: string, newUserId: string): Promise<{
        applied: boolean;
        referrerName: string;
        rewardOnFirstTrip: number;
        type: string;
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

        // Validate type match
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
        // DRIVER_TO_CUSTOMER: referrer must be driver, referred must be customer
        if (referral.referralType === 'DRIVER_TO_CUSTOMER' && !isNewUserCustomer) {
            throw new AppError('This code is for customers. Register as a customer to use it.', 400);
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
                status: 'COMPLETED', // applied, waiting for first qualifying ride to become REWARDED
            },
        });

        const referrerName = [referral.referrerUser.firstName, referral.referrerUser.lastName]
            .filter(Boolean).join(' ') || 'Your friend';

        logger.info('Referral code applied', {
            code, newUserId, referrerId: referral.referrerUserId, type: referral.referralType,
        });

        // For DRIVER_TO_CUSTOMER, the "reward" message is about free subscription, not wallet
        const rewardOnFirstTrip = referral.referralType === 'DRIVER_TO_CUSTOMER'
            ? 0
            : Number(referral.referredReward);

        return {
            applied: true,
            referrerName,
            rewardOnFirstTrip,
            type: referral.referralType,
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // 3.  PROCESS FIRST-TRIP REWARD
    //     Called from booking completion. If the user was referred and the
    //     referral hasn't been rewarded yet → validate trip → credit rewards.
    //     ⚠️ Anti-fraud guards prevent gaming via fake trips.
    //
    //     BUG FIX: Previously this checked completedTrips > 1 and returned,
    //     permanently losing the reward if the first trip didn't qualify.
    //     Now we check if the referral is already REWARDED instead — so any
    //     subsequent qualifying trip will still trigger the reward.
    // ────────────────────────────────────────────────────────────────────────
    static async processFirstTripReward(userId: string, bookingId: string): Promise<void> {
        // Find pending (COMPLETED but not yet REWARDED) referral for this user
        const referral = await prisma.referral.findFirst({
            where: { referredUserId: userId, status: 'COMPLETED' },
        });

        if (!referral) return; // Not a referred user or already rewarded

        // ── ANTI-FRAUD GUARDS ────────────────────────────────────────────────

        // Fetch the booking to validate it's a real trip
        const booking = await prisma.booking.findUnique({
            where: { id: bookingId },
            select: {
                customerId: true,
                driverId: true,
                startedAt: true,
                completedAt: true,
                actualDistance: true,
                estimatedDistance: true,
                totalAmount: true,
            },
        });

        if (!booking) {
            logger.warn('Referral reward skipped: booking not found', { bookingId, userId });
            return;
        }

        // Guard 1: Minimum trip duration ≥ 45 minutes
        const MIN_TRIP_DURATION_MS = 45 * 60 * 1000;
        if (booking.startedAt && booking.completedAt) {
            const durationMs = new Date(booking.completedAt).getTime() - new Date(booking.startedAt).getTime();
            if (durationMs < MIN_TRIP_DURATION_MS) {
                logger.info('Referral reward deferred: trip too short, will retry on next qualifying trip', {
                    bookingId, userId, durationMs, requiredMs: MIN_TRIP_DURATION_MS,
                });
                return; // Don't block — just skip this trip, reward stays COMPLETED for next qualifying trip
            }
        } else {
            logger.warn('Referral reward deferred: missing start/complete timestamps', { bookingId, userId });
            return;
        }

        // Guard 2: Minimum actual trip distance ≥ 5 km
        const MIN_TRIP_DISTANCE_KM = 5;
        const tripDistanceKm = booking.actualDistance ? Number(booking.actualDistance) : 0;
        if (tripDistanceKm < MIN_TRIP_DISTANCE_KM) {
            logger.info('Referral reward deferred: distance too short, will retry on next qualifying trip', {
                bookingId, userId, tripDistanceKm, requiredKm: MIN_TRIP_DISTANCE_KM,
            });
            return;
        }

        // Guard 3: Minimum fare ≥ ₹250
        const MIN_FARE_AMOUNT = 250;
        const fareAmount = Number(booking.totalAmount || 0);
        if (fareAmount < MIN_FARE_AMOUNT) {
            logger.info('Referral reward deferred: fare too low, will retry on next qualifying trip', {
                bookingId, userId, fareAmount, requiredFare: MIN_FARE_AMOUNT,
            });
            return;
        }

        // Guard 4: Self-referral block — referrer cannot be the driver of this trip
        if (booking.driverId && booking.driverId === referral.referrerUserId) {
            logger.warn('Referral reward BLOCKED: self-referral detected (referrer is the driver)', {
                bookingId, userId, referrerId: referral.referrerUserId, driverId: booking.driverId,
            });
            return;
        }
        // Also block if the referred user is the driver of their own first trip
        if (booking.customerId && booking.customerId === referral.referrerUserId) {
            logger.warn('Referral reward BLOCKED: referrer is the customer (reverse self-referral)', {
                bookingId, userId, referrerId: referral.referrerUserId, customerId: booking.customerId,
            });
            return;
        }

        // Guard 5: Daily reward cap — max 3 referral rewards per referrer per day
        const MAX_DAILY_REFERRAL_REWARDS = 3;
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayRewards = await prisma.referral.count({
            where: {
                referrerUserId: referral.referrerUserId,
                status: 'REWARDED',
                completedAt: { gte: todayStart },
            },
        });
        if (todayRewards >= MAX_DAILY_REFERRAL_REWARDS) {
            logger.warn('Referral reward BLOCKED: daily cap reached', {
                bookingId, userId, referrerId: referral.referrerUserId,
                todayRewards, maxDaily: MAX_DAILY_REFERRAL_REWARDS,
            });
            return;
        }

        // ── ALL GUARDS PASSED — proceed with reward ──────────────────────────

        const isDriverToCustomer = referral.referralType === 'DRIVER_TO_CUSTOMER';
        const isDriverReferral = referral.referralType === 'DRIVER';
        const referrerReward = Number(referral.rewardAmount);
        const referredReward = Number(referral.referredReward);

        await prisma.$transaction(async (tx) => {
            // Mark referral as REWARDED
            await tx.referral.update({
                where: { id: referral.id },
                data: { status: 'REWARDED', completedAt: new Date() },
            });

            if (isDriverToCustomer) {
                // ── Driver-to-Customer: NO wallet credits ──────────────────────
                // Just count up and check milestones
                await this.processCustomerReferralMilestone(tx, referral.referrerUserId);

            } else if (isDriverReferral) {
                // ── Driver-to-Driver: credit driver wallet (pendingEarnings) + transaction log ──
                if (referrerReward > 0) {
                    await tx.driverProfile.updateMany({
                        where: { userId: referral.referrerUserId },
                        data: {
                            totalEarnings: { increment: referrerReward },
                            pendingEarnings: { increment: referrerReward },
                        } as any,
                    });
                    // Create wallet transaction record for audit
                    const referrerDP = await tx.driverProfile.findUnique({
                        where: { userId: referral.referrerUserId },
                        select: { pendingEarnings: true },
                    });
                    if (referrerDP) {
                        await tx.walletTransaction.create({
                            data: {
                                userId: referral.referrerUserId,
                                type: WalletTransactionType.CREDIT,
                                reason: WalletTransactionReason.REWARD,
                                status: WalletTransactionStatus.COMPLETED,
                                amount: new Prisma.Decimal(referrerReward),
                                balanceAfter: referrerDP.pendingEarnings,
                                bookingId,
                                meta: { source: 'referral_driver', referralId: referral.id } as any,
                            },
                        });
                    }
                }
                if (referredReward > 0) {
                    await tx.driverProfile.updateMany({
                        where: { userId: userId },
                        data: {
                            totalEarnings: { increment: referredReward },
                            pendingEarnings: { increment: referredReward },
                        } as any,
                    });
                    const referredDP = await tx.driverProfile.findUnique({
                        where: { userId: userId },
                        select: { pendingEarnings: true },
                    });
                    if (referredDP) {
                        await tx.walletTransaction.create({
                            data: {
                                userId: userId,
                                type: WalletTransactionType.CREDIT,
                                reason: WalletTransactionReason.REWARD,
                                status: WalletTransactionStatus.COMPLETED,
                                amount: new Prisma.Decimal(referredReward),
                                balanceAfter: referredDP.pendingEarnings,
                                bookingId,
                                meta: { source: 'referral_driver_referred', referralId: referral.id } as any,
                            },
                        });
                    }
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

            if (isDriverToCustomer) {
                // Count how many DRIVER_TO_CUSTOMER referrals are now REWARDED for this referrer
                const rewardedCount = await prisma.referral.count({
                    where: { referrerUserId: referral.referrerUserId, referralType: 'DRIVER_TO_CUSTOMER', status: 'REWARDED' },
                });

                // Find next milestone
                const nextMilestone = CUSTOMER_REFERRAL_MILESTONES.find(m => rewardedCount < m.count);
                const hitMilestone = CUSTOMER_REFERRAL_MILESTONES.find(m => rewardedCount === m.count);

                if (hitMilestone) {
                    await sendExpoPushNotification({
                        userIds: [referral.referrerUserId],
                        title: '🎉 Free subscription earned!',
                        body: `${rewardedCount} customers referred! You earned ${hitMilestone.freeMonths} FREE month${hitMilestone.freeMonths > 1 ? 's' : ''} of subscription!`,
                        data: { kind: 'referral_milestone', freeMonths: String(hitMilestone.freeMonths) },
                    });
                } else if (nextMilestone) {
                    await sendExpoPushNotification({
                        userIds: [referral.referrerUserId],
                        title: '🎯 Customer referral success!',
                        body: `${referredName} completed their first ride! ${rewardedCount}/${nextMilestone.count} toward your free subscription month.`,
                        data: { kind: 'referral_progress', count: String(rewardedCount), target: String(nextMilestone.count) },
                    });
                }
            } else {
                // Notify referrer (existing wallet-credit types)
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
            }
        } catch (e) {
            logger.warn('Failed to send referral reward notifications', { error: e });
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 3a. Process customer-referral milestones → grant free subscription months
    //     Called inside the processFirstTripReward transaction.
    //     Milestones are cumulative: 5 = 1 month, 10 = 2 months total.
    // ────────────────────────────────────────────────────────────────────────
    private static async processCustomerReferralMilestone(
        tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
        driverId: string,
    ): Promise<void> {
        // Count total REWARDED DRIVER_TO_CUSTOMER referrals (including the one just marked)
        const rewardedCount = await tx.referral.count({
            where: { referrerUserId: driverId, referralType: 'DRIVER_TO_CUSTOMER', status: 'REWARDED' },
        });

        // Determine how many free months the driver has earned based on milestones
        let totalFreeMonths = 0;
        for (const milestone of CUSTOMER_REFERRAL_MILESTONES) {
            if (rewardedCount >= milestone.count) {
                totalFreeMonths = milestone.freeMonths;
            }
        }

        if (totalFreeMonths > 0) {
            // Upsert to ensure freeMonthsEarned is set correctly
            await (tx as any).driverSubscription.upsert({
                where: { driverId },
                update: { freeMonthsEarned: totalFreeMonths },
                create: {
                    driverId,
                    status: SubscriptionStatus.INACTIVE,
                    planPrice: new Prisma.Decimal(50),
                    freeMonthsEarned: totalFreeMonths,
                    freeMonthsUsed: 0,
                },
            });

            logger.info('Customer referral milestone updated', {
                driverId,
                rewardedCount,
                totalFreeMonths,
            });
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 4.  GET referral stats (for DRIVER and CUSTOMER same-type referrals)
    // ────────────────────────────────────────────────────────────────────────
    static async getReferralStats(userId: string) {
        const [totalReferrals, completedReferrals, rewardedReferrals, totalEarned, recentReferrals] = await Promise.all([
            // People who applied this user's code (exclude DRIVER_TO_CUSTOMER here)
            prisma.referral.count({
                where: {
                    referrerUserId: userId,
                    referredUserId: { not: null },
                    referralType: { in: ['DRIVER', 'CUSTOMER'] },
                },
            }),
            prisma.referral.count({
                where: {
                    referrerUserId: userId,
                    status: { in: ['COMPLETED', 'REWARDED'] },
                    referralType: { in: ['DRIVER', 'CUSTOMER'] },
                },
            }),
            prisma.referral.count({
                where: {
                    referrerUserId: userId,
                    status: 'REWARDED',
                    referralType: { in: ['DRIVER', 'CUSTOMER'] },
                },
            }),
            prisma.referral.aggregate({
                where: {
                    referrerUserId: userId,
                    status: 'REWARDED',
                    referralType: { in: ['DRIVER', 'CUSTOMER'] },
                },
                _sum: { rewardAmount: true },
            }),
            // Recent referrals with names
            prisma.referral.findMany({
                where: {
                    referrerUserId: userId,
                    referredUserId: { not: null },
                    referralType: { in: ['DRIVER', 'CUSTOMER'] },
                },
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

    // ────────────────────────────────────────────────────────────────────────
    // 5.  GET driver's customer-referral stats (milestone progress + free months)
    //     Drivers-only: shows their DRIVER_TO_CUSTOMER referral progress.
    // ────────────────────────────────────────────────────────────────────────
    static async getDriverCustomerReferralStats(driverId: string) {
        // Get or create the DRIVER_TO_CUSTOMER code for this driver
        const codeData = await this.getOrCreateCode(driverId, 'DRIVER_TO_CUSTOMER');

        const [totalReferred, rewardedCount, recentReferrals] = await Promise.all([
            // Customers who applied this driver's code
            prisma.referral.count({
                where: {
                    referrerUserId: driverId,
                    referredUserId: { not: null },
                    referralType: 'DRIVER_TO_CUSTOMER',
                },
            }),
            // Customers who completed a qualifying ride
            prisma.referral.count({
                where: {
                    referrerUserId: driverId,
                    referralType: 'DRIVER_TO_CUSTOMER',
                    status: 'REWARDED',
                },
            }),
            // Recent referrals
            prisma.referral.findMany({
                where: {
                    referrerUserId: driverId,
                    referredUserId: { not: null },
                    referralType: 'DRIVER_TO_CUSTOMER',
                },
                orderBy: { createdAt: 'desc' },
                take: 20,
                include: {
                    referredUser: { select: { firstName: true, lastName: true } },
                },
            }),
        ]);

        // Get subscription free month info
        const sub = await prisma.driverSubscription.findUnique({
            where: { driverId },
            select: { freeMonthsEarned: true, freeMonthsUsed: true },
        });

        const freeMonthsEarned = sub?.freeMonthsEarned ?? 0;
        const freeMonthsUsed = sub?.freeMonthsUsed ?? 0;
        const freeMonthsRemaining = Math.max(0, freeMonthsEarned - freeMonthsUsed);

        // Find next milestone
        const nextMilestone = CUSTOMER_REFERRAL_MILESTONES.find(m => rewardedCount < m.count) ?? null;
        const currentMilestone = [...CUSTOMER_REFERRAL_MILESTONES].reverse().find(m => rewardedCount >= m.count) ?? null;

        return {
            referralCode: codeData.referralCode,
            totalReferred,
            rewardedCount,
            freeMonthsEarned,
            freeMonthsUsed,
            freeMonthsRemaining,
            nextMilestone: nextMilestone ? {
                target: nextMilestone.count,
                freeMonths: nextMilestone.freeMonths,
                remaining: nextMilestone.count - rewardedCount,
            } : null,
            currentMilestone: currentMilestone ? {
                count: currentMilestone.count,
                freeMonths: currentMilestone.freeMonths,
            } : null,
            milestones: CUSTOMER_REFERRAL_MILESTONES.map(m => ({
                count: m.count,
                freeMonths: m.freeMonths,
                achieved: rewardedCount >= m.count,
            })),
            recentReferrals: recentReferrals.map(r => ({
                id: r.id,
                name: [r.referredUser?.firstName, r.referredUser?.lastName].filter(Boolean).join(' ') || 'Unknown',
                status: r.status,
                createdAt: r.createdAt,
                completedAt: r.completedAt,
            })),
        };
    }
}
