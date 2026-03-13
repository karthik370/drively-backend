import { Response } from 'express';
import Joi from 'joi';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { WalletService } from '../services/wallet.service';
import { PaymentMethod } from '@prisma/client';

const topupSchema = Joi.object({
  amount: Joi.number().positive().required(),
  paymentMethod: Joi.string().valid(...Object.values(PaymentMethod)).optional(),
});

const topupVerifySchema = Joi.object({
  cf_order_id: Joi.string().required(),
});

const walletPaySchema = Joi.object({
  bookingId: Joi.string().required(),
});

export class WalletController {
  static getBalance = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);
    const data = await WalletService.getBalance(req.user.id);
    res.status(200).json({ success: true, data });
  });

  static getTransactions = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const data = await WalletService.getTransactions(req.user.id, limit);
    res.status(200).json({ success: true, data });
  });

  static createTopupOrder = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const { error, value } = topupSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);

    const paymentMethod = (value.paymentMethod || PaymentMethod.UPI) as PaymentMethod;
    const data = await WalletService.createTopupOrder({
      userId: req.user.id,
      amount: value.amount,
      paymentMethod,
    });

    res.status(200).json({ success: true, data });
  });

  static verifyTopup = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const { error, value } = topupVerifySchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);

    const data = await WalletService.verifyTopup({
      userId: req.user.id,
      cfOrderId: value.cf_order_id,
    });

    res.status(200).json({ success: true, data });
  });

  static payBookingWithWallet = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const { error, value } = walletPaySchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);

    const data = await WalletService.payBookingWithWallet({
      userId: req.user.id,
      bookingId: value.bookingId,
    });

    res.status(200).json({ success: true, data });
  });
}

export default WalletController;
