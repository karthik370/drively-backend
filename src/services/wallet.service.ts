import { Prisma, PaymentMethod, PaymentStatus, WalletTransactionReason, WalletTransactionStatus, WalletTransactionType } from '@prisma/client';
import crypto from 'crypto';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import Razorpay from 'razorpay';

const toAmountNumber = (amount: unknown) => {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new AppError('Invalid amount', 400);
  }
  return Math.round(n * 100) / 100;
};

const toDecimal = (amount: number) => new Prisma.Decimal(amount);

const getRazorpayClient = (): Razorpay => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new AppError('Razorpay credentials are not configured', 500);
  }

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
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

export class WalletService {
  static async getBalance(userId: string) {
    const profile = await prisma.customerProfile.findUnique({
      where: { userId },
      select: { walletBalance: true },
    });

    if (!profile) {
      throw new AppError('Customer profile not found', 404);
    }

    return {
      balance: Number(profile.walletBalance || 0),
      currency: 'INR',
    };
  }

  static async getTransactions(userId: string, limit = 50) {
    const txs = await prisma.walletTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, limit)),
    });

    return txs.map((t) => ({
      id: t.id,
      type: t.type,
      reason: t.reason,
      status: t.status,
      amount: Number(t.amount),
      balanceAfter: Number(t.balanceAfter),
      bookingId: t.bookingId,
      paymentId: t.paymentId,
      createdAt: t.createdAt,
      meta: t.meta,
    }));
  }

  static async createTopupOrder(params: { userId: string; amount: number; paymentMethod: PaymentMethod }) {
    const amount = toAmountNumber(params.amount);

    const profile = await prisma.customerProfile.findUnique({
      where: { userId: params.userId },
      select: { walletBalance: true },
    });

    if (!profile) {
      throw new AppError('Customer profile not found', 404);
    }

    const razorpay = getRazorpayClient();
    const amountPaise = Math.round(amount * 100);

    const receipt = `wtop_${params.userId.slice(-8)}_${Date.now()}`;

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt,
      notes: {
        purpose: 'WALLET_TOPUP',
        userId: params.userId,
      },
    });

    const payment = await prisma.payment.create({
      data: {
        bookingId: null,
        userId: params.userId,
        amount: toDecimal(amount),
        paymentMethod: params.paymentMethod,
        status: PaymentStatus.PENDING,
        gatewayTransactionId: String((order as any).id),
        gatewayResponse: {
          razorpayOrderId: String((order as any).id),
          receipt,
          purpose: 'WALLET_TOPUP',
        } as any,
      },
    });

    await prisma.walletTransaction.create({
      data: {
        userId: params.userId,
        type: WalletTransactionType.CREDIT,
        reason: WalletTransactionReason.TOPUP,
        status: WalletTransactionStatus.PENDING,
        amount: toDecimal(amount),
        balanceAfter: profile.walletBalance,
        paymentId: payment.id,
        meta: {
          razorpayOrderId: String((order as any).id),
        } as any,
      },
    });

    return {
      paymentId: payment.id,
      orderId: String((order as any).id),
      amount: Number((order as any).amount),
      currency: String((order as any).currency || 'INR'),
      keyId: process.env.RAZORPAY_KEY_ID as string,
    };
  }

  static async verifyTopup(params: {
    userId: string;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  }) {
    const ok = verifyRazorpaySignature({
      orderId: params.razorpayOrderId,
      paymentId: params.razorpayPaymentId,
      signature: params.razorpaySignature,
    });

    if (!ok) {
      throw new AppError('Invalid payment signature', 400);
    }

    return await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findFirst({
        where: {
          userId: params.userId,
          gatewayTransactionId: params.razorpayOrderId,
        },
        orderBy: { createdAt: 'desc' },
      });

      if (!payment) {
        throw new AppError('Payment record not found', 404);
      }

      if (payment.status === PaymentStatus.PAID) {
        const bal = await tx.customerProfile.findUnique({ where: { userId: params.userId }, select: { walletBalance: true } });
        return { alreadyPaid: true, balance: Number(bal?.walletBalance || 0) };
      }

      const amount = Number(payment.amount);

      const profile = await tx.customerProfile.findUnique({
        where: { userId: params.userId },
        select: { walletBalance: true },
      });

      if (!profile) {
        throw new AppError('Customer profile not found', 404);
      }

      const nextBalance = new Prisma.Decimal(profile.walletBalance).plus(payment.amount);

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

      await tx.customerProfile.update({
        where: { userId: params.userId },
        data: { walletBalance: nextBalance },
      });

      await tx.walletTransaction.updateMany({
        where: { paymentId: payment.id, status: WalletTransactionStatus.PENDING },
        data: {
          status: WalletTransactionStatus.COMPLETED,
          balanceAfter: nextBalance,
        },
      });

      return { alreadyPaid: false, credited: amount, balance: Number(nextBalance) };
    });
  }

  static async payBookingWithWallet(params: { userId: string; bookingId: string }) {
    return await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: params.bookingId },
        select: { id: true, customerId: true, totalAmount: true, paymentStatus: true },
      });

      if (!booking) {
        throw new AppError('Booking not found', 404);
      }

      if (String(booking.customerId) !== String(params.userId)) {
        throw new AppError('Not authorized for this booking', 403);
      }

      if (booking.paymentStatus === PaymentStatus.PAID) {
        const bal = await tx.customerProfile.findUnique({ where: { userId: params.userId }, select: { walletBalance: true } });
        return { alreadyPaid: true, balance: Number(bal?.walletBalance || 0) };
      }

      const profile = await tx.customerProfile.findUnique({
        where: { userId: params.userId },
        select: { walletBalance: true },
      });

      if (!profile) {
        throw new AppError('Customer profile not found', 404);
      }

      const amount = new Prisma.Decimal(booking.totalAmount);
      if (profile.walletBalance.lt(amount)) {
        throw new AppError('Insufficient wallet balance', 400);
      }

      const nextBalance = profile.walletBalance.minus(amount);

      const payment = await tx.payment.create({
        data: {
          bookingId: booking.id,
          userId: params.userId,
          amount,
          paymentMethod: PaymentMethod.WALLET,
          status: PaymentStatus.PAID,
          processedAt: new Date(),
          gatewayResponse: { purpose: 'BOOKING_WALLET' } as any,
        },
        select: { id: true },
      });

      await tx.customerProfile.update({
        where: { userId: params.userId },
        data: { walletBalance: nextBalance },
      });

      await tx.walletTransaction.create({
        data: {
          userId: params.userId,
          type: WalletTransactionType.DEBIT,
          reason: WalletTransactionReason.BOOKING_PAYMENT,
          status: WalletTransactionStatus.COMPLETED,
          amount,
          balanceAfter: nextBalance,
          bookingId: booking.id,
          paymentId: payment.id,
        },
      });

      await tx.booking.update({
        where: { id: booking.id },
        data: {
          paymentStatus: PaymentStatus.PAID,
          paymentId: payment.id,
        },
      });

      return { alreadyPaid: false, balance: Number(nextBalance) };
    });
  }
}
