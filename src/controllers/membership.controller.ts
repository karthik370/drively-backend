import { Response } from 'express';
import Joi from 'joi';
import { MembershipType, PaymentMethod } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { MembershipService } from '../services/membership.service';

const createOrderSchema = Joi.object({
  membershipType: Joi.string().valid(...Object.values(MembershipType)).required(),
  paymentMethod: Joi.string().valid(...Object.values(PaymentMethod)).optional(),
});

const verifySchema = Joi.object({
  purchaseId: Joi.string().required(),
  razorpay_order_id: Joi.string().required(),
  razorpay_payment_id: Joi.string().required(),
  razorpay_signature: Joi.string().required(),
});

export class MembershipController {
  static listPlans = asyncHandler(async (_req: AuthRequest, res: Response) => {
    const data = await MembershipService.listPlans();
    res.status(200).json({ success: true, data });
  });

  static current = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);
    const data = await MembershipService.getCurrentMembership(req.user.id);
    res.status(200).json({ success: true, data });
  });

  static createOrder = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const { error, value } = createOrderSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);

    const paymentMethod = (value.paymentMethod || PaymentMethod.UPI) as PaymentMethod;

    const data = await MembershipService.createPurchaseOrder({
      userId: req.user.id,
      membershipType: value.membershipType as MembershipType,
      paymentMethod,
    });

    res.status(200).json({ success: true, data });
  });

  static verify = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const { error, value } = verifySchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);

    const data = await MembershipService.verifyPurchase({
      userId: req.user.id,
      purchaseId: value.purchaseId,
      razorpayOrderId: value.razorpay_order_id,
      razorpayPaymentId: value.razorpay_payment_id,
      razorpaySignature: value.razorpay_signature,
    });

    res.status(200).json({ success: true, data });
  });
}

export default MembershipController;
