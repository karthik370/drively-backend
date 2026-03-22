import { Response } from 'express';
import { v2 as cloudinary } from 'cloudinary';
import prisma from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { PayoutStatus, VerificationStatus } from '@prisma/client';


const toNumber = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return n;
};

const isFiniteNumber = (n: number) => Number.isFinite(n);

const hasSubmittedDocs = (p: any): boolean => {
  const licenseImgOk = typeof p?.licenseImageUrl === 'string' && p.licenseImageUrl.trim().length > 0;
  const aadhaarImgOk = typeof p?.aadhaarImageUrl === 'string' && p.aadhaarImageUrl.trim().length > 0;
  const panImgOk = typeof p?.panImageUrl === 'string' && p.panImageUrl.trim().length > 0;

  const selfieOk = typeof p?.user?.profileImage === 'string' && p.user.profileImage.trim().length > 0;

  return Boolean(licenseImgOk && aadhaarImgOk && panImgOk && selfieOk);
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
    if (!req.user) throw new AppError('Not authenticated', 401);

    const { base64, kind, mimeType } = req.body || {};
    if (!base64 || typeof base64 !== 'string') throw new AppError('base64 image data is required', 400);
    if (!kind || !allowedKinds.has(kind)) throw new AppError('Invalid kind', 400);
    if (!mimeType || !allowedMimeTypes.has(mimeType)) throw new AppError('Invalid mimeType', 400);

    const folder = `drivemate/${req.user.id}/${kind}`;
    const publicId = `${Date.now()}`;
    logger.info('Uploading base64 image to Cloudinary...', { folder, publicId, mime: mimeType });

    try {
      const result = await cloudinary.uploader.upload(
        `data:${mimeType};base64,${base64}`,
        { folder, public_id: publicId, resource_type: 'image', overwrite: true }
      );
      logger.info('Cloudinary upload successful', { url: result.secure_url });
      res.status(200).json({ success: true, data: { key: result.public_id, fileUrl: result.secure_url } });
    } catch (err: any) {
      logger.error('Cloudinary upload failed', { error: err?.message });
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

    // Only use text fields if the frontend actually sends non-empty values.
    // If empty/missing, keep the existing unique placeholder set during signup
    // to avoid unique-constraint collisions across drivers.
    const licenseNumberRaw = typeof (req.body as any)?.licenseNumber === 'string' ? (req.body as any).licenseNumber.trim() : '';
    const aadhaarNumberRaw = typeof (req.body as any)?.aadhaarNumber === 'string' ? (req.body as any).aadhaarNumber.trim() : '';
    const panNumberRaw = typeof (req.body as any)?.panNumber === 'string' ? (req.body as any).panNumber.trim() : '';

    const licenseExpiryDateRaw = (req.body as any)?.licenseExpiryDate;
    const licenseExpiryDate = licenseExpiryDateRaw
      ? new Date(String(licenseExpiryDateRaw))
      : null;

    const licenseImageUrl = typeof (req.body as any)?.licenseImageUrl === 'string' ? (req.body as any).licenseImageUrl.trim() : '';
    const aadhaarImageUrl = typeof (req.body as any)?.aadhaarImageUrl === 'string' ? (req.body as any).aadhaarImageUrl.trim() : '';
    const panImageUrl = typeof (req.body as any)?.panImageUrl === 'string' ? (req.body as any).panImageUrl.trim() : '';

    const profileImage = typeof (req.body as any)?.profileImage === 'string' ? (req.body as any).profileImage.trim() : '';

    if (!licenseImageUrl || !aadhaarImageUrl || !panImageUrl) {
      throw new AppError('Missing required document images', 400);
    }

    if (!profileImage) {
      throw new AppError('Missing required selfie', 400);
    }

    if (licenseExpiryDate && Number.isNaN(licenseExpiryDate.getTime())) {
      throw new AppError('Invalid licenseExpiryDate', 400);
    }

    const current = await prisma.driverProfile.findUnique({ where: { userId: req.user.id } });
    if (!current) {
      throw new AppError('Driver profile not found', 404);
    }

    // Build update payload — only overwrite unique fields if non-empty values provided
    const profileUpdate: Record<string, any> = {
      licenseImageUrl,
      aadhaarImageUrl,
      panImageUrl,
      documentsVerified: false,
      backgroundCheckStatus: VerificationStatus.PENDING,
    };

    if (licenseExpiryDate) {
      profileUpdate.licenseExpiryDate = licenseExpiryDate;
    }

    // Only overwrite unique text fields if the frontend actually sent them
    if (licenseNumberRaw) profileUpdate.licenseNumber = licenseNumberRaw;
    if (aadhaarNumberRaw) profileUpdate.aadhaarNumber = aadhaarNumberRaw;
    if (panNumberRaw) profileUpdate.panNumber = panNumberRaw;

    const updated = await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: req.user!.id },
        data: { profileImage } as any,
      });

      return tx.driverProfile.update({
        where: { userId: req.user!.id },
        data: profileUpdate as any,
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
