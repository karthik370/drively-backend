import { Response } from 'express';
import { v2 as cloudinary } from 'cloudinary';
import prisma from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { PayoutStatus, VerificationStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

const toNumber = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return n;
};

const isFiniteNumber = (n: number) => Number.isFinite(n);

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

// ─── Cloudinary config ───────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── Upload config ───────────────────────────────────────────────────────────
const allowedKinds = new Set(['driver-selfie', 'driver-license', 'driver-aadhaar', 'driver-pan', 'profile-image', 'customer-profile']);
const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
// ─────────────────────────────────────────────────────────────────────────────

export class DriverController {
  static uploadImage = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    // Native multipart uploads put formData fields in req.body and the binary file in req.file
    const { kind } = req.body || {};
    const file = req.file;

    if (!file) {
      throw new AppError('File image data is required', 400);
    }
    if (!kind || !allowedKinds.has(kind)) {
      throw new AppError('Invalid kind', 400);
    }

    const mimeType = file.mimetype;
    if (!mimeType || !allowedMimeTypes.has(mimeType)) {
      throw new AppError('Invalid mimeType', 400);
    }

    const folder = `drivemate/${req.user.id}/${kind}`;
    const publicId = `${Date.now()}-${uuidv4()}`;

    logger.info('Uploading local file to Cloudinary...', { folder, publicId, size: file.size, mime: mimeType, path: file.path });

    try {
      const result = await cloudinary.uploader.upload(file.path, {
        folder,
        public_id: publicId,
        resource_type: 'image',
        overwrite: true,
      });

      // Cleanup local file immediately after upload
      const fs = require('fs');
      try {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      } catch (cleanupErr) {
        logger.error('Failed to delete temporary local file', { path: file.path, error: cleanupErr });
      }

      logger.info('Cloudinary upload successful', { folder, publicId, url: result.secure_url });

      res.status(200).json({
        success: true,
        data: { key: result.public_id, fileUrl: result.secure_url },
      });
    } catch (err: any) {
      logger.error('Cloudinary stream upload failed', { folder, publicId, error: err?.message });
      throw new AppError('Failed to store image', 502);
    }
  });

  static goOnline = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const profile = await prisma.driverProfile.findUnique({ where: { userId: req.user.id } });

    if (!profile) {
      throw new AppError('Driver profile not found', 404);
    }

    if (!profile.documentsVerified) {
      throw new AppError('Driver verification pending', 409);
    }

    // Enforce active subscription
    const sub = await prisma.driverSubscription.findUnique({ where: { driverId: req.user.id } });
    const now = new Date();
    const hasActiveSub = sub?.status === 'ACTIVE' && sub?.validUntil && sub.validUntil > now;

    if (!hasActiveSub) {
      throw new AppError('Active subscription required to go online', 403);
    }

    await prisma.driverProfile.update({
      where: { userId: req.user.id },
      data: { isOnline: true, isAvailable: true } as any,
    });

    res.status(200).json({
      success: true,
      message: 'Driver is online',
      data: { isOnline: true, isAvailable: true },
    });
  });

  static goOffline = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const profile = await prisma.driverProfile.findUnique({ where: { userId: req.user.id } });
    if (!profile) {
      throw new AppError('Driver profile not found', 404);
    }

    await prisma.driverProfile.update({
      where: { userId: req.user.id },
      data: { isOnline: false, isAvailable: false } as any,
    });

    res.status(200).json({
      success: true,
      message: 'Driver is offline',
      data: { isOnline: false, isAvailable: false },
    });
  });

  static getDocumentsStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const profile = await prisma.driverProfile.findUnique({
      where: { userId: req.user.id },
      select: {
        userId: true,
        documentsVerified: true,
        backgroundCheckStatus: true,
        user: {
          select: {
            profileImage: true,
          },
        },
        licenseNumber: true,
        licenseImageUrl: true,
        licenseExpiryDate: true,
        aadhaarNumber: true,
        aadhaarImageUrl: true,
        panNumber: true,
        panImageUrl: true,
        updatedAt: true,
      },
    });

    if (!profile) {
      throw new AppError('Driver profile not found', 404);
    }

    res.status(200).json({
      success: true,
      data: {
        driverId: profile.userId,
        documentsVerified: profile.documentsVerified,
        backgroundCheckStatus: profile.backgroundCheckStatus,
        submitted: hasSubmittedDocs(profile),
        updatedAt: profile.updatedAt,
      },
    });
  });

  static submitDocuments = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const licenseNumber = typeof (req.body as any)?.licenseNumber === 'string' ? (req.body as any).licenseNumber.trim() : '';
    const aadhaarNumber = typeof (req.body as any)?.aadhaarNumber === 'string' ? (req.body as any).aadhaarNumber.trim() : '';
    const panNumber = typeof (req.body as any)?.panNumber === 'string' ? (req.body as any).panNumber.trim() : '';

    const licenseExpiryDateRaw = (req.body as any)?.licenseExpiryDate;
    const licenseExpiryDate = new Date(String(licenseExpiryDateRaw || ''));

    const licenseImageUrl = typeof (req.body as any)?.licenseImageUrl === 'string' ? (req.body as any).licenseImageUrl.trim() : '';
    const aadhaarImageUrl = typeof (req.body as any)?.aadhaarImageUrl === 'string' ? (req.body as any).aadhaarImageUrl.trim() : '';
    const panImageUrl = typeof (req.body as any)?.panImageUrl === 'string' ? (req.body as any).panImageUrl.trim() : '';

    const profileImage = typeof (req.body as any)?.profileImage === 'string' ? (req.body as any).profileImage.trim() : '';

    if (!licenseNumber || !aadhaarNumber || !panNumber) {
      throw new AppError('Missing required document numbers', 400);
    }

    if (!licenseImageUrl || !aadhaarImageUrl || !panImageUrl) {
      throw new AppError('Missing required document images', 400);
    }

    if (!profileImage) {
      throw new AppError('Missing required selfie', 400);
    }

    if (Number.isNaN(licenseExpiryDate.getTime())) {
      throw new AppError('Invalid licenseExpiryDate', 400);
    }

    const current = await prisma.driverProfile.findUnique({ where: { userId: req.user.id } });
    if (!current) {
      throw new AppError('Driver profile not found', 404);
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: req.user!.id },
        data: { profileImage } as any,
      });

      return tx.driverProfile.update({
        where: { userId: req.user!.id },
        data: {
          licenseNumber,
          licenseExpiryDate,
          licenseImageUrl,
          aadhaarNumber,
          aadhaarImageUrl,
          panNumber,
          panImageUrl,
          documentsVerified: false,
          backgroundCheckStatus: VerificationStatus.PENDING,
        } as any,
        select: {
          userId: true,
          documentsVerified: true,
          backgroundCheckStatus: true,
          updatedAt: true,
        },
      });
    });

    res.status(200).json({
      success: true,
      message: 'Documents submitted for verification',
      data: {
        driverId: updated.userId,
        documentsVerified: updated.documentsVerified,
        backgroundCheckStatus: updated.backgroundCheckStatus,
        submitted: true,
        updatedAt: updated.updatedAt,
      },
    });
  });

  static updateAvailability = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const isAvailable = Boolean((req.body as any)?.isAvailable);

    const profile = await prisma.driverProfile.findUnique({ where: { userId: req.user.id } });
    if (!profile) {
      throw new AppError('Driver profile not found', 404);
    }

    if (!profile.isOnline && isAvailable) {
      throw new AppError('Driver must be online to be available', 409);
    }

    const updated = await prisma.driverProfile.update({
      where: { userId: req.user.id },
      data: { isAvailable } as any,
      select: { isOnline: true, isAvailable: true },
    });

    res.status(200).json({
      success: true,
      message: 'Availability updated',
      data: updated,
    });
  });

  static getAvailability = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const profile = await prisma.driverProfile.findUnique({
      where: { userId: req.user.id },
      select: { isOnline: true, isAvailable: true },
    });

    if (!profile) {
      throw new AppError('Driver profile not found', 404);
    }

    res.status(200).json({ success: true, data: profile });
  });

  static getEarnings = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const period = String(req.query.period || 'today');
    const now = new Date();

    const start = new Date(now);
    if (period === 'week') {
      start.setDate(now.getDate() - 7);
    } else if (period === 'month') {
      start.setMonth(now.getMonth() - 1);
    } else {
      start.setHours(0, 0, 0, 0);
    }

    const [profile, bookings] = await Promise.all([
      prisma.driverProfile.findUnique({
        where: { userId: req.user.id },
        select: {
          totalEarnings: true,
          pendingEarnings: true,
          totalTrips: true,
        },
      }),
      prisma.booking.findMany({
        where: {
          driverId: req.user.id,
          status: 'COMPLETED',
          completedAt: { gte: start },
        } as any,
        select: {
          id: true,
          driverEarnings: true,
          completedAt: true,
        },
      }),
    ]);

    if (!profile) {
      throw new AppError('Driver profile not found', 404);
    }

    const earnings = bookings.reduce((sum, b) => sum + Number(b.driverEarnings || 0), 0);

    res.status(200).json({
      success: true,
      data: {
        period,
        from: start.toISOString(),
        to: now.toISOString(),
        earnings: Math.round(earnings),
        trips: bookings.length,
        totalEarnings: Number(profile.totalEarnings),
        pendingEarnings: Number(profile.pendingEarnings),
      },
    });
  });

  static getEarningsBreakdown = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const startDate = String(req.query.startDate || '');
    const endDate = String(req.query.endDate || '');

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new AppError('Invalid startDate/endDate', 400);
    }

    if (end.getTime() < start.getTime()) {
      throw new AppError('endDate must be after startDate', 400);
    }

    const bookings = await prisma.booking.findMany({
      where: {
        driverId: req.user.id,
        status: 'COMPLETED',
        completedAt: { gte: start, lte: end },
      } as any,
      orderBy: { completedAt: 'desc' },
      select: {
        id: true,
        bookingNumber: true,
        completedAt: true,
        driverEarnings: true,
        totalAmount: true,
        platformCommission: true,
      },
    });

    const totals = bookings.reduce(
      (acc, b) => {
        acc.driverEarnings += Number(b.driverEarnings || 0);
        acc.gross += Number(b.totalAmount || 0);
        acc.commission += Number(b.platformCommission || 0);
        return acc;
      },
      { driverEarnings: 0, gross: 0, commission: 0 }
    );

    res.status(200).json({
      success: true,
      data: {
        from: start.toISOString(),
        to: end.toISOString(),
        totals: {
          gross: Math.round(totals.gross),
          commission: Math.round(totals.commission),
          driverEarnings: Math.round(totals.driverEarnings),
        },
        bookings: bookings.map((b) => ({
          id: b.id,
          bookingNumber: b.bookingNumber,
          completedAt: b.completedAt,
          gross: Number(b.totalAmount || 0),
          commission: Number(b.platformCommission || 0),
          driverEarnings: Number(b.driverEarnings || 0),
        })),
      },
    });
  });

  static requestPayout = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const amount = toNumber((req.body as any)?.amount);
    const method = String((req.body as any)?.method || 'BANK_TRANSFER');

    if (!isFiniteNumber(amount) || amount <= 0) {
      throw new AppError('Invalid amount', 400);
    }

    if (method !== 'BANK_TRANSFER' && method !== 'UPI') {
      throw new AppError('Invalid payout method', 400);
    }

    const profile = await prisma.driverProfile.findUnique({ where: { userId: req.user.id } });
    if (!profile) {
      throw new AppError('Driver profile not found', 404);
    }

    const pending = Number(profile.pendingEarnings);
    if (amount > pending) {
      throw new AppError('Insufficient pending balance', 400);
    }

    const now = new Date();
    const payout = await prisma.driverPayout.create({
      data: {
        driverId: req.user.id,
        amount,
        payoutPeriodStart: now,
        payoutPeriodEnd: now,
        payoutMethod: method,
        status: PayoutStatus.PENDING,
      } as any,
    });

    await prisma.driverProfile.update({
      where: { userId: req.user.id },
      data: { pendingEarnings: Math.max(0, pending - amount) } as any,
    });

    res.status(201).json({
      success: true,
      message: 'Payout request created',
      data: {
        id: payout.id,
        amount: Number(payout.amount),
        status: payout.status,
        method,
        createdAt: payout.createdAt,
      },
    });
  });

  static getMetrics = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const profile = await prisma.driverProfile.findUnique({
      where: { userId: req.user.id },
      select: {
        totalTrips: true,
        acceptanceRate: true,
        cancellationRate: true,
        averageResponseTime: true,
        totalEarnings: true,
        pendingEarnings: true,
        isOnline: true,
        isAvailable: true,
      },
    });

    if (!profile) {
      throw new AppError('Driver profile not found', 404);
    }

    res.status(200).json({
      success: true,
      data: {
        totalTrips: profile.totalTrips,
        acceptanceRate: Number(profile.acceptanceRate),
        cancellationRate: Number(profile.cancellationRate),
        averageResponseTime: profile.averageResponseTime,
        totalEarnings: Number(profile.totalEarnings),
        pendingEarnings: Number(profile.pendingEarnings),
        isOnline: profile.isOnline,
        isAvailable: profile.isAvailable,
      },
    });
  });

  static getTrips = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const page = Math.max(1, Math.floor(toNumber(req.query.page) || 1));
    const limit = Math.max(1, Math.min(50, Math.floor(toNumber(req.query.limit) || 20)));

    const [items, total] = await Promise.all([
      prisma.booking.findMany({
        where: { driverId: req.user.id } as any,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          bookingNumber: true,
          status: true,
          pickupAddress: true,
          dropAddress: true,
          totalAmount: true,
          driverEarnings: true,
          createdAt: true,
          completedAt: true,
        },
      }),
      prisma.booking.count({ where: { driverId: req.user.id } as any }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        page,
        limit,
        total,
        items: items.map((b) => ({
          id: b.id,
          bookingNumber: b.bookingNumber,
          status: b.status,
          pickupAddress: b.pickupAddress,
          dropAddress: b.dropAddress,
          totalAmount: Number(b.totalAmount || 0),
          driverEarnings: Number(b.driverEarnings || 0),
          createdAt: b.createdAt,
          completedAt: b.completedAt,
        })),
      },
    });
  });
}

export default DriverController;
