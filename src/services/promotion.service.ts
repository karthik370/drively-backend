import { Prisma, PromotionType, UserType } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';

const nowUtc = () => new Date();

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

export class PromotionService {
  static async validatePromotion(params: { userId: string; code: string; amount: number; userType: UserType }) {
    const code = params.code.trim().toUpperCase();
    if (!code) {
      throw new AppError('Promo code is required', 400);
    }

    const promotion = await prisma.promotion.findUnique({
      where: { code },
      select: {
        id: true,
        code: true,
        type: true,
        value: true,
        maxDiscount: true,
        minOrderValue: true,
        usageLimitPerUser: true,
        totalUsageLimit: true,
        currentUsageCount: true,
        validFrom: true,
        validUntil: true,
        applicableFor: true,
        isActive: true,
      },
    });

    if (!promotion || !promotion.isActive) {
      throw new AppError('Invalid promo code', 400);
    }

    const now = nowUtc();
    if (promotion.validFrom && now < promotion.validFrom) {
      throw new AppError('Promo code is not active yet', 400);
    }
    if (promotion.validUntil && now > promotion.validUntil) {
      throw new AppError('Promo code has expired', 400);
    }

    if (promotion.applicableFor && promotion.applicableFor !== params.userType) {
      if (!(promotion.applicableFor === UserType.CUSTOMER && params.userType === UserType.BOTH)) {
        throw new AppError('Promo code is not applicable for this user', 400);
      }
    }

    const amount = params.amount;
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new AppError('Invalid booking amount', 400);
    }

    if (promotion.minOrderValue && new Prisma.Decimal(amount).lt(promotion.minOrderValue)) {
      throw new AppError('Minimum order value not met for this promo code', 400);
    }

    if (promotion.totalUsageLimit !== null && promotion.totalUsageLimit !== undefined) {
      const limit = Number(promotion.totalUsageLimit);
      const used = Number(promotion.currentUsageCount || 0);
      if (Number.isFinite(limit) && used >= limit) {
        throw new AppError('Promo code usage limit reached', 400);
      }
    }

    const perUserCount = await prisma.promotionRedemption.count({
      where: {
        promotionId: promotion.id,
        userId: params.userId,
      },
    });

    const perUserLimit = Number(promotion.usageLimitPerUser || 0);
    if (perUserLimit > 0 && perUserCount >= perUserLimit) {
      throw new AppError('Promo code usage limit reached for this user', 400);
    }

    if (promotion.type === PromotionType.FIRST_RIDE) {
      const completedTrips = await prisma.booking.count({
        where: {
          customerId: params.userId,
          status: 'COMPLETED',
        },
      });
      if (completedTrips > 0) {
        throw new AppError('Promo code is only valid for first ride', 400);
      }
    }

    const discountAmount = this.computeDiscount({
      type: promotion.type,
      value: Number(promotion.value),
      maxDiscount: promotion.maxDiscount ? Number(promotion.maxDiscount) : null,
      amount,
    });

    const finalAmount = Math.max(0, Math.round((amount - discountAmount) * 100) / 100);

    return {
      promotionId: promotion.id,
      code: promotion.code,
      type: promotion.type,
      discountAmount,
      finalAmount,
    };
  }

  static computeDiscount(params: { type: PromotionType; value: number; maxDiscount: number | null; amount: number }) {
    const amount = params.amount;

    let discount = 0;
    if (params.type === PromotionType.PERCENTAGE) {
      discount = (amount * params.value) / 100;
    } else if (params.type === PromotionType.FIXED_AMOUNT || params.type === PromotionType.CASHBACK) {
      discount = params.value;
    } else if (params.type === PromotionType.FIRST_RIDE) {
      discount = params.value;
    }

    discount = clamp(discount, 0, amount);

    if (params.maxDiscount !== null && Number.isFinite(params.maxDiscount)) {
      discount = Math.min(discount, params.maxDiscount);
    }

    return Math.round(discount * 100) / 100;
  }

  static async redeemPromotion(params: { userId: string; promotionId: string; bookingId: string; discountAmount: number }) {
    await prisma.$transaction(async (tx) => {
      await tx.promotion.update({
        where: { id: params.promotionId },
        data: { currentUsageCount: { increment: 1 } },
      });

      await tx.promotionRedemption.create({
        data: {
          promotionId: params.promotionId,
          userId: params.userId,
          bookingId: params.bookingId,
          discountAmount: new Prisma.Decimal(params.discountAmount),
        },
      });
    });
  }
}
