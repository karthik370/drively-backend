import { Response } from 'express';
import Joi from 'joi';
import { PaymentMethod } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { TipService } from '../services/tip.service';

const createSchema = Joi.object({
  bookingId: Joi.string().required(),
  amount: Joi.number().positive().required(),
  paymentMethod: Joi.string().valid(...Object.values(PaymentMethod)).required(),
});

const walletPaySchema = Joi.object({
  tipId: Joi.string().required(),
});

const orderSchema = Joi.object({
  tipId: Joi.string().required(),
});

const verifySchema = Joi.object({
  tipId: Joi.string().required(),
  cf_order_id: Joi.string().required(),
});

export class TipController {
  static create = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const { error, value } = createSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);

    const data = await TipService.createTip({
      customerId: req.user.id,
      bookingId: value.bookingId,
      amount: value.amount,
      paymentMethod: value.paymentMethod as PaymentMethod,
    });

    res.status(201).json({ success: true, data });
  });

  static payWithWallet = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const { error, value } = walletPaySchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);

    const data = await TipService.payTipWithWallet({
      customerId: req.user.id,
      tipId: value.tipId,
    });

    res.status(200).json({ success: true, data });
  });

  static createOrder = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const { error, value } = orderSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);

    const data = await TipService.createTipOrder({
      customerId: req.user.id,
      tipId: value.tipId,
    });

    res.status(200).json({ success: true, data });
  });

  static verify = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const { error, value } = verifySchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);

    const data = await TipService.verifyTipPayment({
      customerId: req.user.id,
      tipId: value.tipId,
      cfOrderId: value.cf_order_id,
    });

    res.status(200).json({ success: true, data });
  });
}

export default TipController;
