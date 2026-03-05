import { Response } from 'express';
import Joi from 'joi';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { PaymentService } from '../services/payment.service';

const createOrderSchema = Joi.object({
  bookingId: Joi.string().required(),
});

const verifySchema = Joi.object({
  bookingId: Joi.string().required(),
  razorpay_order_id: Joi.string().required(),
  razorpay_payment_id: Joi.string().required(),
  razorpay_signature: Joi.string().required(),
});

export class PaymentController {
  static createOrder = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const { error, value } = createOrderSchema.validate(req.body);
    if (error) {
      throw new AppError(error.details[0].message, 400);
    }

    const result = await PaymentService.createOrder({
      userId: req.user.id,
      bookingId: value.bookingId,
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  });

  static verifyPayment = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const { error, value } = verifySchema.validate(req.body);
    if (error) {
      throw new AppError(error.details[0].message, 400);
    }

    const result = await PaymentService.verifyPayment({
      userId: req.user.id,
      bookingId: value.bookingId,
      razorpayOrderId: value.razorpay_order_id,
      razorpayPaymentId: value.razorpay_payment_id,
      razorpaySignature: value.razorpay_signature,
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  });

  static razorpayWebhook = asyncHandler(async (req: any, res: Response) => {
    const signature = typeof req.headers['x-razorpay-signature'] === 'string' ? req.headers['x-razorpay-signature'] : null;
    const rawBody = (req as any).rawBody as Buffer | undefined;

    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      throw new AppError('Raw body not available for webhook verification', 500);
    }

    const result = await PaymentService.handleRazorpayWebhook({
      rawBody,
      signature,
      payload: req.body,
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  });

  static getBookingPaymentStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const bookingId = String(req.params.bookingId || '');
    if (!bookingId) {
      throw new AppError('bookingId is required', 400);
    }

    const data = await PaymentService.getBookingPaymentStatus({
      userId: req.user.id,
      bookingId,
    });

    res.status(200).json({
      success: true,
      data,
    });
  });
}

export default PaymentController;
