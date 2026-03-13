import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { SubscriptionService } from '../services/subscription.service';
import { PaymentMethod } from '@prisma/client';

export const getSubscriptionStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user || req.user.userType !== 'DRIVER') {
        throw new AppError('Only drivers can access subscriptions', 403);
    }

    const result = await SubscriptionService.getSubscriptionStatus(req.user.id);

    res.status(200).json({
        success: true,
        data: result,
    });
});

export const createSubscriptionOrder = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user || req.user.userType !== 'DRIVER') {
        throw new AppError('Only drivers can access subscriptions', 403);
    }

    const { paymentMethod } = req.body;

    if (!paymentMethod || !Object.values(PaymentMethod).includes(paymentMethod)) {
        throw new AppError('Valid paymentMethod is required', 400);
    }

    const result = await SubscriptionService.createSubscriptionOrder({
        driverId: req.user.id,
        paymentMethod,
    });

    res.status(200).json({
        success: true,
        data: result,
    });
});

export const verifySubscriptionPayment = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user || req.user.userType !== 'DRIVER') {
        throw new AppError('Only drivers can access subscriptions', 403);
    }

    const { cfOrderId } = req.body;

    if (!cfOrderId) {
        throw new AppError('Missing Cashfree order ID (cfOrderId)', 400);
    }

    const result = await SubscriptionService.verifySubscriptionPayment({
        driverId: req.user.id,
        cfOrderId,
    });

    res.status(200).json({
        success: true,
        data: result,
    });
});
