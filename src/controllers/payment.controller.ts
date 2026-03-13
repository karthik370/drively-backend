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
  cf_order_id: Joi.string().required(),
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
      cfOrderId: value.cf_order_id,
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  });

  static cashfreeWebhook = asyncHandler(async (req: any, res: Response) => {
    const signature = typeof req.headers['x-webhook-signature'] === 'string' ? req.headers['x-webhook-signature'] : null;
    const timestamp = typeof req.headers['x-webhook-timestamp'] === 'string' ? req.headers['x-webhook-timestamp'] : null;
    const rawBody = (req as any).rawBody;

    if (!rawBody) {
      throw new AppError('Raw body not available for webhook verification', 500);
    }

    const rawBodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);

    const result = await PaymentService.handleCashfreeWebhook({
      rawBody: rawBodyStr,
      signature,
      timestamp,
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
