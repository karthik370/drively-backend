import Razorpay from 'razorpay';
import crypto from 'crypto';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { PaymentMethod, PaymentStatus } from '@prisma/client';

type RazorpayOrderResponse = {
  id: string;
  entity: 'order';
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string | null;
  status: string;
  attempts: number;
  notes: Record<string, any>;
  created_at: number;
};

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

const getWebhookSecret = (): string => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    throw new AppError('Razorpay webhook secret is not configured', 500);
  }
  return secret;
};

const toPaise = (amount: unknown): number => {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) {
    throw new AppError('Invalid amount', 400);
  }
  return Math.max(0, Math.round(n * 100));
};

export class PaymentService {
  static async createOrder(params: { userId: string; bookingId: string }) {
    const booking = await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: {
        id: true,
        customerId: true,
        totalAmount: true,
        paymentStatus: true,
        paymentMethod: true,
      },
    });

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    if (String(booking.customerId) !== String(params.userId)) {
      throw new AppError('Not authorized for this booking', 403);
    }

    if (booking.paymentStatus === PaymentStatus.PAID) {
      return {
        alreadyPaid: true,
        bookingId: booking.id,
      };
    }

    if (booking.paymentMethod === PaymentMethod.CASH) {
      throw new AppError('Cash payment does not require an online order', 400);
    }

    const amountPaise = toPaise(booking.totalAmount);
    if (amountPaise <= 0) {
      throw new AppError('Booking amount must be greater than 0', 400);
    }

    const razorpay = getRazorpayClient();

    const order = (await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: booking.id,
      notes: {
        bookingId: booking.id,
        userId: params.userId,
      },
    })) as unknown as RazorpayOrderResponse;

    const payment = await prisma.payment.create({
      data: {
        bookingId: booking.id,
        userId: params.userId,
        amount: booking.totalAmount,
        paymentMethod: booking.paymentMethod,
        status: PaymentStatus.PENDING,
        gatewayTransactionId: order.id,
        gatewayResponse: {
          razorpayOrderId: order.id,
          amount: order.amount,
          currency: order.currency,
          receipt: order.receipt,
          status: order.status,
          created_at: order.created_at,
        } as any,
      },
      select: { id: true },
    });

    await prisma.booking.update({
      where: { id: booking.id },
      data: {
        paymentId: payment.id,
        paymentStatus: PaymentStatus.PENDING,
      },
    });

    return {
      alreadyPaid: false,
      bookingId: booking.id,
      paymentId: payment.id,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID as string,
    };
  }

  static verifySignature(params: { orderId: string; paymentId: string; signature: string }): boolean {
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      throw new AppError('Razorpay credentials are not configured', 500);
    }

    const body = `${params.orderId}|${params.paymentId}`;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    return expected === params.signature;
  }

  static async verifyPayment(params: {
    userId: string;
    bookingId: string;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  }) {
    const booking = await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: {
        id: true,
        customerId: true,
        paymentStatus: true,
      },
    });

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    if (String(booking.customerId) !== String(params.userId)) {
      throw new AppError('Not authorized for this booking', 403);
    }

    const ok = this.verifySignature({
      orderId: params.razorpayOrderId,
      paymentId: params.razorpayPaymentId,
      signature: params.razorpaySignature,
    });

    if (!ok) {
      throw new AppError('Invalid payment signature', 400);
    }

    const result = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findFirst({
        where: {
          bookingId: booking.id,
          status: { in: [PaymentStatus.PENDING, PaymentStatus.PAID] },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (!payment) {
        throw new AppError('Payment record not found', 404);
      }

      if (payment.status === PaymentStatus.PAID && booking.paymentStatus === PaymentStatus.PAID) {
        return { alreadyPaid: true, paymentId: payment.id };
      }

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.PAID,
          processedAt: new Date(),
          gatewayResponse: {
            ...(typeof payment.gatewayResponse === 'object' && payment.gatewayResponse ? (payment.gatewayResponse as any) : {}),
            razorpayOrderId: params.razorpayOrderId,
            razorpayPaymentId: params.razorpayPaymentId,
            razorpaySignature: params.razorpaySignature,
            verifiedAt: new Date().toISOString(),
          } as any,
        },
      });

      await tx.booking.update({
        where: { id: booking.id },
        data: {
          paymentStatus: PaymentStatus.PAID,
          paymentId: payment.id,
        },
      });

      return { alreadyPaid: false, paymentId: payment.id };
    });

    return {
      bookingId: booking.id,
      paymentStatus: PaymentStatus.PAID,
      ...result,
    };
  }

  static verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    const secret = getWebhookSecret();
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return expected === signature;
  }

  static async handleRazorpayWebhook(params: { rawBody: Buffer; signature: string | null; payload: any }) {
    if (!params.signature) {
      throw new AppError('Missing Razorpay signature header', 400);
    }

    const ok = this.verifyWebhookSignature(params.rawBody, params.signature);
    if (!ok) {
      throw new AppError('Invalid webhook signature', 400);
    }

    const event = String(params.payload?.event ?? '');

    const paymentEntity = params.payload?.payload?.payment?.entity;
    const orderId = typeof paymentEntity?.order_id === 'string' ? paymentEntity.order_id : null;
    const gatewayPaymentId = typeof paymentEntity?.id === 'string' ? paymentEntity.id : null;

    if (!orderId) {
      return { received: true };
    }

    const payment = await prisma.payment.findFirst({
      where: {
        gatewayTransactionId: orderId,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!payment) {
      return { received: true };
    }

    if (event === 'payment.captured' || event === 'order.paid') {
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.PAID,
            processedAt: new Date(),
            gatewayResponse: {
              ...(typeof payment.gatewayResponse === 'object' && payment.gatewayResponse ? (payment.gatewayResponse as any) : {}),
              webhookEvent: event,
              razorpayPaymentId: gatewayPaymentId,
              webhookReceivedAt: new Date().toISOString(),
            } as any,
          },
        });

        if (payment.bookingId) {
          await tx.booking.update({
            where: { id: payment.bookingId },
            data: {
              paymentStatus: PaymentStatus.PAID,
              paymentId: payment.id,
            },
          });
        }
      });
    }

    return { received: true };
  }

  static async getBookingPaymentStatus(params: { userId: string; bookingId: string }) {
    const booking = await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: { id: true, customerId: true, paymentStatus: true, paymentMethod: true, paymentId: true },
    });

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    if (String(booking.customerId) !== String(params.userId)) {
      throw new AppError('Not authorized for this booking', 403);
    }

    return {
      bookingId: booking.id,
      paymentStatus: booking.paymentStatus,
      paymentMethod: booking.paymentMethod,
      paymentId: booking.paymentId,
    };
  }
}
