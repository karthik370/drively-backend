import { Response } from 'express';
import Joi from 'joi';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import prisma from '../config/database';
import { PromotionService } from '../services/promotion.service';

const validateSchema = Joi.object({
  code: Joi.string().min(2).required(),
  amount: Joi.number().positive().required(),
});

export class PromotionController {
  static listActive = asyncHandler(async (_req: AuthRequest, res: Response) => {
    const now = new Date();
    const promos = await prisma.promotion.findMany({
      where: {
        isActive: true,
        validFrom: { lte: now },
        validUntil: { gte: now },
      },
      select: {
        id: true,
        code: true,
        type: true,
        value: true,
        maxDiscount: true,
        minOrderValue: true,
        description: true,
        termsConditions: true,
        validUntil: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.status(200).json({ success: true, data: promos });
  });

  static validate = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const { error, value } = validateSchema.validate(req.body);
    if (error) throw new AppError(error.details[0].message, 400);

    const data = await PromotionService.validatePromotion({
      userId: req.user.id,
      code: value.code,
      amount: value.amount,
      userType: req.user.userType,
    });

    res.status(200).json({ success: true, data });
  });
}

export default PromotionController;
