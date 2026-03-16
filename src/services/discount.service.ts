import { MembershipType } from '@prisma/client';
import prisma from '../config/database';

/** Membership flat discounts */
const MEMBERSHIP_DISCOUNTS: Record<string, number> = {
  [MembershipType.BASIC]: 30,
  [MembershipType.PREMIUM]: 50,
};

/** Streak tiers: rides in last 7 days → discount percentage */
const STREAK_TIERS = [
  { rides: 12, pct: 10 },
  { rides: 8, pct: 7 },
  { rides: 5, pct: 5 },
  { rides: 3, pct: 2 },
];

export type DiscountPreview = {
  membershipType: string;
  membershipDiscount: number;
  membershipLabel: string | null;
  streakRides: number;
  streakPct: number;
  streakDiscount: number;
  streakLabel: string | null;
  nextStreakTier: { rides: number; pct: number } | null;
  totalDiscount: number;
  finalAmount: number;
  requireExperienced: boolean;
  isPremium: boolean;
  favoriteDriverIds: string[];
};

export class DiscountService {
  /**
   * Get a preview of all applicable discounts for a customer.
   */
  static async getDiscountPreview(userId: string, fareAmount: number): Promise<DiscountPreview> {
    const profile = await prisma.customerProfile.findUnique({
      where: { userId },
      select: {
        membershipType: true,
        membershipExpiryDate: true,
        favoriteDriverIds: true,
      },
    });

    // ── Membership ──
    let membershipType = String(profile?.membershipType || 'NONE');
    const expiry = profile?.membershipExpiryDate ? new Date(profile.membershipExpiryDate) : null;
    const isExpired = expiry ? expiry.getTime() < Date.now() : true;

    if (membershipType !== 'NONE' && isExpired) {
      membershipType = 'NONE';
    }

    const membershipDiscount = MEMBERSHIP_DISCOUNTS[membershipType] ?? 0;
    const membershipLabel = membershipDiscount > 0
      ? `${membershipType} member — ₹${membershipDiscount} off`
      : null;

    const isPremium = membershipType === MembershipType.PREMIUM;
    const requireExperienced = isPremium;

    // ── Streak ──
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const streakRides = await prisma.booking.count({
      where: {
        customerId: userId,
        status: 'COMPLETED',
        completedAt: { gte: sevenDaysAgo },
      },
    });

    let streakPct = 0;
    let currentTierIndex = -1;
    for (let i = 0; i < STREAK_TIERS.length; i++) {
      if (streakRides >= STREAK_TIERS[i].rides) {
        streakPct = STREAK_TIERS[i].pct;
        currentTierIndex = i;
        break;
      }
    }

    const afterMembership = Math.max(0, fareAmount - membershipDiscount);
    const streakDiscount = streakPct > 0 ? Math.round((afterMembership * streakPct) / 100) : 0;
    const streakLabel = streakPct > 0
      ? `Streak bonus (${streakRides} rides) — ${streakPct}% off`
      : null;

    // Next tier for progress display
    let nextStreakTier: { rides: number; pct: number } | null = null;
    if (currentTierIndex < 0) {
      nextStreakTier = STREAK_TIERS[STREAK_TIERS.length - 1]; // first tier to reach
    } else if (currentTierIndex > 0) {
      nextStreakTier = STREAK_TIERS[currentTierIndex - 1]; // next higher tier
    }

    const totalDiscount = membershipDiscount + streakDiscount;
    const finalAmount = Math.max(0, Math.round((fareAmount - totalDiscount) * 100) / 100);

    return {
      membershipType,
      membershipDiscount,
      membershipLabel,
      streakRides,
      streakPct,
      streakDiscount,
      streakLabel,
      nextStreakTier,
      totalDiscount,
      finalAmount,
      requireExperienced,
      isPremium,
      favoriteDriverIds: Array.isArray(profile?.favoriteDriverIds) ? profile.favoriteDriverIds : [],
    };
  }

  /**
   * Apply discounts during booking creation.
   * Returns the discount amounts and flags to store in the booking.
   */
  static async applyDiscounts(userId: string, fareAmount: number) {
    const preview = await this.getDiscountPreview(userId, fareAmount);
    return {
      membershipDiscount: preview.membershipDiscount,
      streakDiscount: preview.streakDiscount,
      totalDiscount: preview.totalDiscount,
      finalAmount: preview.finalAmount,
      requireExperienced: preview.requireExperienced,
      favoriteDriverIds: preview.favoriteDriverIds,
      isPremium: preview.isPremium,
      breakdown: {
        membershipType: preview.membershipType,
        membershipDiscount: preview.membershipDiscount,
        streakRides: preview.streakRides,
        streakPct: preview.streakPct,
        streakDiscount: preview.streakDiscount,
      },
    };
  }
}
