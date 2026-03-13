import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { PaymentMethod, PaymentStatus } from '@prisma/client';
import { createCashfreeOrder, verifyCashfreePayment, verifyCashfreeWebhook, generateOrderId } from './cashfree';

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

    const amount = Number(booking.totalAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new AppError('Booking amount must be greater than 0', 400);
    }

    // Fetch customer details for Cashfree
    const user = await prisma.user.findUnique({
      where: { id: params.userId },
      select: { phoneNumber: true, email: true, firstName: true, lastName: true },
    });

    const cfOrderId = generateOrderId('book', booking.id);

    const cfOrder = await createCashfreeOrder({
      orderId: cfOrderId,
      amount,
      customerId: params.userId,
      customerPhone: user?.phoneNumber || '9999999999',
      customerEmail: user?.email || undefined,
      customerName: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || undefined,
      orderNote: `Booking ${booking.id}`,
      orderTags: {
        bookingId: booking.id,
        userId: params.userId,
      },
    });

    const payment = await prisma.payment.create({
      data: {
        bookingId: booking.id,
        userId: params.userId,
        amount: booking.totalAmount,
        paymentMethod: booking.paymentMethod,
        status: PaymentStatus.PENDING,
        gatewayTransactionId: cfOrder.orderId,
        gatewayResponse: {
          cfOrderId: cfOrder.cfOrderId,
          orderId: cfOrder.orderId,
          paymentSessionId: cfOrder.paymentSessionId,
          amount: cfOrder.orderAmount,
          currency: cfOrder.orderCurrency,
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
      orderId: cfOrder.orderId,
      paymentSessionId: cfOrder.paymentSessionId,
      amount: cfOrder.orderAmount,
      currency: cfOrder.orderCurrency,
    };
  }

  static async verifyPayment(params: {
    userId: string;
    bookingId: string;
    cfOrderId: string;
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

    // Ask Cashfree directly for the order status
    const cfStatus = await verifyCashfreePayment(params.cfOrderId);

    if (!cfStatus.isPaid) {
      throw new AppError(`Payment not completed. Order status: ${cfStatus.orderStatus}`, 400);
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
            cfPaymentId: cfStatus.cfPaymentId,
            orderStatus: cfStatus.orderStatus,
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

  static async handleCashfreeWebhook(params: { rawBody: string; signature: string | null; timestamp: string | null; payload: any }) {
    if (!params.signature || !params.timestamp) {
      throw new AppError('Missing Cashfree signature/timestamp header', 400);
    }

    const ok = verifyCashfreeWebhook({
      signature: params.signature,
      rawBody: params.rawBody,
      timestamp: params.timestamp,
    });
    if (!ok) {
      throw new AppError('Invalid webhook signature', 400);
    }

    const eventType = String(params.payload?.type ?? '');
    const orderData = params.payload?.data?.order;
    const paymentData = params.payload?.data?.payment;
    const orderId = orderData?.order_id || paymentData?.order?.order_id;
    const cfPaymentId = paymentData?.cf_payment_id;

    if (!orderId) {
      return { received: true };
    }

    const payment = await prisma.payment.findFirst({
      where: { gatewayTransactionId: orderId },
      orderBy: { createdAt: 'desc' },
    });

    if (!payment) {
      return { received: true };
    }

    if (eventType === 'PAYMENT_SUCCESS_WEBHOOK' || eventType === 'ORDER_PAID_WEBHOOK') {
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.PAID,
            processedAt: new Date(),
            gatewayResponse: {
              ...(typeof payment.gatewayResponse === 'object' && payment.gatewayResponse ? (payment.gatewayResponse as any) : {}),
              webhookEvent: eventType,
              cfPaymentId,
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
