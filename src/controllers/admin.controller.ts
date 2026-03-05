import { Response } from 'express';
import prisma from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { getSocketServer } from '../socket/io';
import { VerificationStatus } from '@prisma/client';

const hasSubmittedDocs = (p: any): boolean => {
  const licenseOk = typeof p?.licenseNumber === 'string' && p.licenseNumber.trim() && !p.licenseNumber.startsWith('PEND-');
  const aadhaarOk = typeof p?.aadhaarNumber === 'string' && p.aadhaarNumber.trim() && !p.aadhaarNumber.startsWith('PEND-AAD-');
  const panOk = typeof p?.panNumber === 'string' && p.panNumber.trim() && !p.panNumber.startsWith('PEND');

  const licenseImgOk = typeof p?.licenseImageUrl === 'string' && p.licenseImageUrl.trim().length > 0;
  const aadhaarImgOk = typeof p?.aadhaarImageUrl === 'string' && p.aadhaarImageUrl.trim().length > 0;
  const panImgOk = typeof p?.panImageUrl === 'string' && p.panImageUrl.trim().length > 0;

  const selfieOk = typeof p?.user?.profileImage === 'string' && p.user.profileImage.trim().length > 0;

  return Boolean(licenseOk && aadhaarOk && panOk && licenseImgOk && aadhaarImgOk && panImgOk && selfieOk);
};

export class AdminController {
  static getPendingDriverVerifications = asyncHandler(async (_req: AuthRequest, res: Response) => {
    const profiles = await prisma.driverProfile.findMany({
      where: {
        documentsVerified: false,
        backgroundCheckStatus: VerificationStatus.PENDING,
      } as any,
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            profileImage: true,
            createdAt: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });

    const data = profiles
      .filter((p) => hasSubmittedDocs(p))
      .map((p) => ({
        driverId: p.userId,
        name: `${p.user.firstName} ${p.user.lastName}`.trim(),
        phoneNumber: p.user.phoneNumber,
        submittedAt: p.updatedAt,
        status: p.backgroundCheckStatus,
      }));

    res.status(200).json({ success: true, data });
  });

  static getDriverVerificationDetails = asyncHandler(async (req: AuthRequest, res: Response) => {
    const driverId = String(req.params.driverId || '');
    if (!driverId) {
      throw new AppError('driverId is required', 400);
    }

    const profile = await prisma.driverProfile.findUnique({
      where: { userId: driverId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            profileImage: true,
            createdAt: true,
          },
        },
      },
    });

    if (!profile) {
      throw new AppError('Driver profile not found', 404);
    }

    res.status(200).json({
      success: true,
      data: {
        driverId: profile.userId,
        user: profile.user,
        documentsVerified: profile.documentsVerified,
        backgroundCheckStatus: profile.backgroundCheckStatus,
        submitted: hasSubmittedDocs(profile),
        licenseNumber: profile.licenseNumber,
        licenseExpiryDate: profile.licenseExpiryDate,
        licenseImageUrl: profile.licenseImageUrl,
        aadhaarNumber: profile.aadhaarNumber,
        aadhaarImageUrl: profile.aadhaarImageUrl,
        panNumber: profile.panNumber,
        panImageUrl: profile.panImageUrl,
        updatedAt: profile.updatedAt,
      },
    });
  });

  static verifyDriverDocuments = asyncHandler(async (req: AuthRequest, res: Response) => {
    const driverId = String(req.params.driverId || '');
    if (!driverId) {
      throw new AppError('driverId is required', 400);
    }

    const approved = Boolean((req.body as any)?.approved);
    const reasonRaw = (req.body as any)?.reason;
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
    const isExperienced = Boolean((req.body as any)?.isExperienced);

    const profile = await prisma.driverProfile.findUnique({
      where: { userId: driverId },
      include: {
        user: {
          select: {
            profileImage: true,
          },
        },
      },
    });
    if (!profile) {
      throw new AppError('Driver profile not found', 404);
    }

    if (!hasSubmittedDocs(profile)) {
      throw new AppError('Driver has not submitted all required documents', 409);
    }

    const updated = await prisma.driverProfile.update({
      where: { userId: driverId },
      data: {
        documentsVerified: approved,
        backgroundCheckStatus: approved ? VerificationStatus.VERIFIED : VerificationStatus.REJECTED,
        isExperienced: approved ? isExperienced : false,
      } as any,
      select: {
        userId: true,
        documentsVerified: true,
        backgroundCheckStatus: true,
        isExperienced: true,
        updatedAt: true,
      } as any,
    });

    try {
      const io = getSocketServer();
      io.to(`user:${driverId}`).emit('driver:verification-updated', {
        driverId,
        documentsVerified: updated.documentsVerified,
        backgroundCheckStatus: updated.backgroundCheckStatus,
        isExperienced: (updated as any).isExperienced,
        reason: approved ? undefined : reason || undefined,
        updatedAt: updated.updatedAt,
      });
    } catch {
    }

    res.status(200).json({
      success: true,
      message: approved ? 'Driver verified' : 'Driver rejected',
      data: {
        driverId,
        documentsVerified: updated.documentsVerified,
        backgroundCheckStatus: updated.backgroundCheckStatus,
        isExperienced: (updated as any).isExperienced,
      },
    });
  });

  static getPendingRefunds = asyncHandler(async (_req: AuthRequest, res: Response) => {
    const rows = await (prisma as any).driverRefund.findMany({
      where: { status: 'PENDING' as any } as any,
      include: {
        booking: { select: { id: true, bookingNumber: true, status: true, cancelledAt: true, createdAt: true } },
        driver: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, phoneNumber: true } },
          },
        },
      } as any,
      orderBy: { createdAt: 'desc' } as any,
      take: 200,
    });

    const data = rows.map((r: any) => ({
      refundId: String(r.id),
      bookingId: String(r.bookingId),
      bookingNumber: String(r.booking?.bookingNumber ?? ''),
      bookingStatus: String(r.booking?.status ?? ''),
      driverId: String(r.driverId),
      driverName: `${String(r.driver?.user?.firstName ?? '')} ${String(r.driver?.user?.lastName ?? '')}`.trim(),
      driverPhoneNumber: String(r.driver?.user?.phoneNumber ?? ''),
      upiId: String(r.upiId ?? ''),
      amount: Number(r.amount ?? 0),
      createdAt: r.createdAt,
    }));

    res.status(200).json({ success: true, data });
  });

  static markRefundPaid = asyncHandler(async (req: AuthRequest, res: Response) => {
    const refundId = String(req.params.refundId || '');
    if (!refundId) {
      throw new AppError('refundId is required', 400);
    }

    const refund = await (prisma as any).driverRefund.findUnique({
      where: { id: refundId },
      include: {
        booking: { select: { id: true, bookingNumber: true } },
        driver: { include: { user: { select: { firstName: true, lastName: true, phoneNumber: true } } } },
      } as any,
    } as any);

    if (!refund) {
      throw new AppError('Refund not found', 404);
    }

    if (String((refund as any).status) !== 'PENDING') {
      throw new AppError('Refund is not pending', 409);
    }

    const updated = await (prisma as any).driverRefund.update({
      where: { id: refundId },
      data: { status: 'PAID' as any, paidAt: new Date() } as any,
      select: { id: true, bookingId: true, driverId: true, amount: true, paidAt: true },
    } as any);

    const driverId = String((updated as any).driverId);
    const amount = Number((updated as any).amount ?? 0);

    try {
      await prisma.notification.create({
        data: {
          userId: driverId,
          type: 'SYSTEM' as any,
          title: 'Refund paid',
          body: `Refund of ₹${amount || 30} paid for this trip`,
          data: {
            kind: 'driver_refund_paid',
            bookingId: String((updated as any).bookingId),
            refundId: String((updated as any).id),
            amount,
          } as any,
        },
      });
    } catch {
    }

    try {
      const io = getSocketServer();
      io.to(`user:${driverId}`).emit('driver:refund-paid', {
        bookingId: String((updated as any).bookingId),
        refundId: String((updated as any).id),
        amount,
        message: `Refund of ₹${amount || 30} paid for this trip`,
      });
    } catch {
    }

    res.status(200).json({
      success: true,
      message: 'Refund marked as paid',
      data: { refundId: String((updated as any).id) },
    });
  });
}

export default AdminController;
