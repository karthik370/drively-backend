import { MembershipPurchaseStatus, MembershipType, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { createCashfreeOrder, verifyCashfreePayment, generateOrderId } from './cashfree';

export class MembershipService {
  static async listPlans() {
    const plans = await prisma.membershipPlan.findMany({
      where: { isActive: true },
      orderBy: { price: 'asc' },
    });

    return plans.map((p) => ({
      id: p.id,
      type: p.type,
      title: p.title,
      description: p.description,
      price: Number(p.price),
      durationDays: p.durationDays,
      isActive: p.isActive,
    }));
  }

  static async createPurchaseOrder(params: { userId: string; membershipType: MembershipType; paymentMethod: PaymentMethod }) {
    if (params.membershipType === MembershipType.NONE) {
      throw new AppError('Invalid membership type', 400);
    }

    const plan = await prisma.membershipPlan.findUnique({
      where: { type: params.membershipType },
    });

    if (!plan || !plan.isActive) {
      throw new AppError('Membership plan not available', 404);
    }

    const customer = await prisma.customerProfile.findUnique({
      where: { userId: params.userId },
      select: { userId: true },
    });

    if (!customer) {
      throw new AppError('Customer profile not found', 404);
    }

    const user = await prisma.user.findUnique({
      where: { id: params.userId },
      select: { phoneNumber: true, email: true, firstName: true, lastName: true },
    });

    const cfOrderId = generateOrderId('mem', params.userId);

    const cfOrder = await createCashfreeOrder({
      orderId: cfOrderId,
      amount: Number(plan.price),
      customerId: params.userId,
      customerPhone: user?.phoneNumber || '9999999999',
      customerEmail: user?.email || undefined,
      customerName: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || undefined,
      orderNote: `Membership: ${plan.title}`,
      orderTags: {
        purpose: 'MEMBERSHIP',
        userId: params.userId,
        membershipType: plan.type,
      },
    });

    const payment = await prisma.payment.create({
      data: {
        bookingId: null,
        userId: params.userId,
        amount: plan.price,
        paymentMethod: params.paymentMethod,
        status: PaymentStatus.PENDING,
        gatewayTransactionId: cfOrder.orderId,
        gatewayResponse: {
          cfOrderId: cfOrder.cfOrderId,
          orderId: cfOrder.orderId,
          paymentSessionId: cfOrder.paymentSessionId,
          purpose: 'MEMBERSHIP',
          membershipType: plan.type,
        } as any,
      },
    });

    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

    const purchase = await prisma.membershipPurchase.create({
      data: {
        userId: params.userId,
        planId: plan.id,
        status: MembershipPurchaseStatus.PENDING,
        startsAt,
        endsAt,
        paymentId: payment.id,
      },
      select: { id: true },
    });

    return {
      purchaseId: purchase.id,
      orderId: cfOrder.orderId,
      paymentSessionId: cfOrder.paymentSessionId,
      amount: cfOrder.orderAmount,
      currency: cfOrder.orderCurrency,
    };
  }

  static async verifyPurchase(params: {
    userId: string;
    purchaseId: string;
    cfOrderId: string;
  }) {
    const cfStatus = await verifyCashfreePayment(params.cfOrderId);
    if (!cfStatus.isPaid) {
      throw new AppError(`Payment not completed. Status: ${cfStatus.orderStatus}`, 400);
    }

    return await prisma.$transaction(async (tx) => {
      const purchase = await tx.membershipPurchase.findUnique({
        where: { id: params.purchaseId },
        include: { plan: true },
      });

      if (!purchase || String(purchase.userId) !== String(params.userId)) {
        throw new AppError('Membership purchase not found', 404);
      }

      const paymentId = purchase.paymentId;
      if (!paymentId) {
        throw new AppError('Payment not linked to membership purchase', 500);
      }

      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) {
        throw new AppError('Payment record not found', 404);
      }

      if (payment.status !== PaymentStatus.PAID) {
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
      }

      await tx.membershipPurchase.update({
        where: { id: purchase.id },
        data: { status: MembershipPurchaseStatus.ACTIVE },
      });

      await tx.customerProfile.update({
        where: { userId: params.userId },
        data: {
          membershipType: purchase.plan.type,
          membershipExpiryDate: purchase.endsAt,
        } as any,
      });

      return {
        membershipType: purchase.plan.type,
        startsAt: purchase.startsAt,
        endsAt: purchase.endsAt,
      };
    });
  }

  static async getCurrentMembership(userId: string) {
    const profile = await prisma.customerProfile.findUnique({
      where: { userId },
      select: { membershipType: true, membershipExpiryDate: true },
    });

    if (!profile) {
      throw new AppError('Customer profile not found', 404);
    }

    return {
      membershipType: profile.membershipType,
      membershipExpiryDate: profile.membershipExpiryDate,
    };
  }

  static async ensureDefaultPlans() {
    const existing = await prisma.membershipPlan.findMany({ select: { id: true } });
    if (existing.length > 0) return;

    await prisma.membershipPlan.createMany({
      data: [
        {
          type: MembershipType.BASIC,
          title: 'Basic',
          description: 'Get ₹30 off on every ride you book. Save more the more you ride!',
          price: new Prisma.Decimal(199),
          durationDays: 30,
          isActive: true,
        },
        {
          type: MembershipType.PREMIUM,
          title: 'Premium',
          description: 'Get ₹50 off on every ride + free experienced driver on all bookings. The ultimate ride experience.',
          price: new Prisma.Decimal(399),
          durationDays: 30,
          isActive: true,
        },
      ],
    });
  }
}
