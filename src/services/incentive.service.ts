import prisma from '../config/database';

export class IncentiveService {
    /**
     * Get active incentives available for drivers
     */
    static async getActiveIncentives(): Promise<any[]> {
        const now = new Date();
        const incentives = await prisma.driverIncentive.findMany({
            where: {
                isActive: true,
                OR: [
                    { validFrom: null, validUntil: null },
                    { validFrom: { lte: now }, validUntil: { gte: now } },
                    { validFrom: { lte: now }, validUntil: null },
                    { validFrom: null, validUntil: { gte: now } },
                ],
            } as any,
            orderBy: { requiredRides: 'asc' } as any,
        });
        return incentives as any[];
    }

    /**
     * Get driver's incentive progress for current period
     */
    static async getDriverProgress(driverId: string) {
        const incentives = await this.getActiveIncentives();
        const now = new Date();

        const progressList = await Promise.all(
            incentives.map(async (incentive) => {
                const { periodStart, periodEnd } = this.getPeriodDates(incentive.period, now);

                let progress = await (prisma as any).driverIncentiveProgress.findUnique({
                    where: {
                        driverId_incentiveId_periodStart: {
                            driverId,
                            incentiveId: incentive.id,
                            periodStart,
                        },
                    },
                });

                // Create progress record if doesn't exist
                if (!progress) {
                    progress = await (prisma as any).driverIncentiveProgress.create({
                        data: {
                            driverId,
                            incentiveId: incentive.id,
                            periodStart,
                            periodEnd,
                            completedRides: 0,
                        },
                    });
                }

                return {
                    incentive: {
                        id: incentive.id,
                        name: incentive.name,
                        description: incentive.description,
                        requiredRides: incentive.requiredRides,
                        bonusAmount: Number(incentive.bonusAmount),
                        period: incentive.period,
                    },
                    progress: {
                        completedRides: progress.completedRides,
                        isCompleted: progress.isCompleted,
                        bonusPaid: progress.bonusPaid,
                        remaining: Math.max(0, incentive.requiredRides - progress.completedRides),
                    },
                    periodEnd,
                };
            })
        );

        return progressList;
    }

    /**
     * Increment ride count for driver incentives (called after ride completion)
     */
    static async incrementRideCount(driverId: string): Promise<{
        bonusEarned: number;
        completedIncentives: string[];
    }> {
        const incentives = await this.getActiveIncentives();
        const now = new Date();
        let totalBonusEarned = 0;
        const completedIncentives: string[] = [];

        for (const incentive of incentives) {
            const { periodStart, periodEnd } = this.getPeriodDates(incentive.period, now);

            const progress = await (prisma as any).driverIncentiveProgress.upsert({
                where: {
                    driverId_incentiveId_periodStart: {
                        driverId,
                        incentiveId: incentive.id,
                        periodStart,
                    },
                },
                update: {
                    completedRides: { increment: 1 },
                },
                create: {
                    driverId,
                    incentiveId: incentive.id,
                    periodStart,
                    periodEnd,
                    completedRides: 1,
                },
            });

            // Check if incentive is now completed
            if (progress.completedRides >= incentive.requiredRides && !progress.isCompleted) {
                await (prisma as any).driverIncentiveProgress.update({
                    where: { id: progress.id },
                    data: { isCompleted: true },
                });
                totalBonusEarned += Number(incentive.bonusAmount);
                completedIncentives.push(incentive.name);
            }
        }

        return { bonusEarned: totalBonusEarned, completedIncentives };
    }

    private static getPeriodDates(period: string, now: Date): { periodStart: Date; periodEnd: Date } {
        const start = new Date(now);
        const end = new Date(now);

        switch (period) {
            case 'DAILY':
                start.setHours(0, 0, 0, 0);
                end.setHours(23, 59, 59, 999);
                break;
            case 'WEEKLY':
                const dayOfWeek = start.getDay();
                start.setDate(start.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
                start.setHours(0, 0, 0, 0);
                end.setDate(start.getDate() + 6);
                end.setHours(23, 59, 59, 999);
                break;
            case 'MONTHLY':
                start.setDate(1);
                start.setHours(0, 0, 0, 0);
                end.setMonth(end.getMonth() + 1, 0);
                end.setHours(23, 59, 59, 999);
                break;
        }

        return { periodStart: start, periodEnd: end };
    }
}
