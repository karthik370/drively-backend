import { PaymentMethod, PaymentStatus, Prisma, TipStatus, WalletTransactionReason, WalletTransactionStatus, WalletTransactionType } from '@prisma/client';
import crypto from 'crypto';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import Razorpay from 'razorpay';

const getRazorpayClient = (): Razorpay => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new AppError('Razorpay credentials are not configured', 500);
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

const verifyRazorpaySignature = (params: { orderId: string; paymentId: string; signature: string }) => {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) {
    throw new AppError('Razorpay credentials are not configured', 500);
  }
  const body = `${params.orderId}|${params.paymentId}`;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return expected === params.signature;
};

const toAmount = (amount: unknown): number => {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new AppError('Invalid tip amount', 400);
  }
  return Math.round(n * 100) / 100;
};

export class TipService {
  static async createTip(params: { customerId: string; bookingId: string; amount: number; paymentMethod: PaymentMethod }) {
    const amount = toAmount(params.amount);

    const booking = await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: {
        id: true,
        status: true,
        customerId: true,
        driverId: true,
      },
    });

    if (!booking) throw new AppError('Booking not found', 404);
    if (String(booking.customerId) !== String(params.customerId)) throw new AppError('Not authorized', 403);
    if (!booking.driverId) throw new AppError('Driver not assigned', 400);

    if (booking.status !== 'COMPLETED') {
      throw new AppError('Tip is only allowed after trip completion', 400);
    }

    const existing = await prisma.tip.findFirst({
      where: { bookingId: booking.id, customerId: params.customerId },
    });

    if (existing) {
      throw new AppError('Tip already exists for this booking', 409);
    }

    const tip = await prisma.tip.create({
      data: {
        bookingId: booking.id,
        customerId: params.customerId,
        driverId: booking.driverId,
        amount: new Prisma.Decimal(amount),
        paymentMethod: params.paymentMethod,
        status: TipStatus.PENDING,
      },
    });

    return {
      tipId: tip.id,
      bookingId: booking.id,
      driverId: booking.driverId,
      amount,
      paymentMethod: tip.paymentMethod,
      status: tip.status,
    };
  }

  static async payTipWithWallet(params: { customerId: string; tipId: string }) {
    return await prisma.$transaction(async (tx) => {
      const tip = await tx.tip.findUnique({
        where: { id: params.tipId },
        include: { booking: { select: { customerId: true, driverId: true } } },
      });

      if (!tip) throw new AppError('Tip not found', 404);
      if (String(tip.customerId) !== String(params.customerId)) throw new AppError('Not authorized', 403);
      if (tip.status === TipStatus.PAID) return { alreadyPaid: true };

      const profile = await tx.customerProfile.findUnique({
        where: { userId: params.customerId },
        select: { walletBalance: true },
      });

      if (!profile) throw new AppError('Customer profile not found', 404);

      if (profile.walletBalance.lt(tip.amount)) {
        throw new AppError('Insufficient wallet balance', 400);
      }

      const nextBalance = profile.walletBalance.minus(tip.amount);

      const payment = await tx.payment.create({
        data: {
          bookingId: tip.bookingId,
          userId: params.customerId,
          amount: tip.amount,
          paymentMethod: PaymentMethod.WALLET,
          status: PaymentStatus.PAID,
          processedAt: new Date(),
          gatewayResponse: { purpose: 'TIP_WALLET', tipId: tip.id } as any,
        },
        select: { id: true },
      });

      await tx.customerProfile.update({
        where: { userId: params.customerId },
        data: { walletBalance: nextBalance },
      });

      await tx.walletTransaction.create({
        data: {
          userId: params.customerId,
          type: WalletTransactionType.DEBIT,
          reason: WalletTransactionReason.TIP,
          status: WalletTransactionStatus.COMPLETED,
          amount: tip.amount,
          balanceAfter: nextBalance,
          bookingId: tip.bookingId,
          paymentId: payment.id,
          meta: { tipId: tip.id } as any,
        },
      });

      await tx.tip.update({
        where: { id: tip.id },
        data: {
          status: TipStatus.PAID,
          paymentId: payment.id,
          processedAt: new Date(),
        },
      });

      await tx.driverProfile.update({
        where: { userId: tip.driverId },
        data: {
          totalEarnings: { increment: tip.amount },
          pendingEarnings: { increment: tip.amount },
        } as any,
      });

      return { alreadyPaid: false, paymentId: payment.id, balance: Number(nextBalance) };
    });
  }

  static async createTipOrder(params: { customerId: string; tipId: string }) {
    const tip = await prisma.tip.findUnique({
      where: { id: params.tipId },
      select: { id: true, customerId: true, amount: true, bookingId: true, status: true },
    });

    if (!tip) throw new AppError('Tip not found', 404);
    if (String(tip.customerId) !== String(params.customerId)) throw new AppError('Not authorized', 403);
    if (tip.status === TipStatus.PAID) return { alreadyPaid: true };

    const razorpay = getRazorpayClient();
    const amountPaise = Math.round(Number(tip.amount) * 100);
    const receipt = `tip:${tip.id}`;

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt,
      notes: {
        purpose: 'TIP',
        tipId: tip.id,
        bookingId: tip.bookingId,
        userId: params.customerId,
      },
    });

    const payment = await prisma.payment.create({
      data: {
        bookingId: tip.bookingId,
        userId: params.customerId,
        amount: tip.amount,
        paymentMethod: PaymentMethod.UPI,
        status: PaymentStatus.PENDING,
        gatewayTransactionId: String((order as any).id),
        gatewayResponse: { razorpayOrderId: String((order as any).id), purpose: 'TIP', tipId: tip.id } as any,
      },
      select: { id: true },
    });

    await prisma.tip.update({
      where: { id: tip.id },
      data: { paymentId: payment.id, paymentMethod: PaymentMethod.UPI },
    });

    return {
      alreadyPaid: false,
      tipId: tip.id,
      orderId: String((order as any).id),
      amount: Number((order as any).amount),
      currency: String((order as any).currency || 'INR'),
      keyId: process.env.RAZORPAY_KEY_ID as string,
    };
  }

  static async verifyTipPayment(params: {
    customerId: string;
    tipId: string;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  }) {
    const ok = verifyRazorpaySignature({
      orderId: params.razorpayOrderId,
      paymentId: params.razorpayPaymentId,
      signature: params.razorpaySignature,
    });

    if (!ok) throw new AppError('Invalid payment signature', 400);

    return await prisma.$transaction(async (tx) => {
      const tip = await tx.tip.findUnique({ where: { id: params.tipId } });
      if (!tip) throw new AppError('Tip not found', 404);
      if (String(tip.customerId) !== String(params.customerId)) throw new AppError('Not authorized', 403);

      if (tip.status === TipStatus.PAID) return { alreadyPaid: true };

      const payment = await tx.payment.findFirst({
        where: { id: tip.paymentId || undefined, gatewayTransactionId: params.razorpayOrderId },
        orderBy: { createdAt: 'desc' },
      });

      if (!payment) throw new AppError('Payment record not found', 404);

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.PAID,
          processedAt: new Date(),
          gatewayResponse: {
            ...(typeof payment.gatewayResponse === 'object' && payment.gatewayResponse ? (payment.gatewayResponse as any) : {}),
            razorpayPaymentId: params.razorpayPaymentId,
            razorpaySignature: params.razorpaySignature,
            verifiedAt: new Date().toISOString(),
          } as any,
        },
      });

      await tx.tip.update({
        where: { id: tip.id },
        data: {
          status: TipStatus.PAID,
          processedAt: new Date(),
        },
      });

      await tx.driverProfile.update({
        where: { userId: tip.driverId },
        data: {
          totalEarnings: { increment: tip.amount },
          pendingEarnings: { increment: tip.amount },
        } as any,
      });

      return { alreadyPaid: false, paymentId: payment.id };
    });
  }
}
