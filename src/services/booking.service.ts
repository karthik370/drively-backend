import { BookingStatus, CancelledBy, PaymentMethod, PaymentStatus, Prisma, TransmissionType, VehicleType } from '@prisma/client';
import prisma from '../config/database';

import { AppError } from '../middleware/errorHandler';
import { getSocketServer } from '../socket/io';
import { logger } from '../utils/logger';
import { sendExpoPushNotification } from './expoPush.service';
import { calculateDistance, getRoute } from '../utils/mapUtils';
import { computeFare, normalizeTripType } from '../utils/pricing';
import { MatchingService } from './matching.service';
import { enqueueScheduledBooking } from './scheduledBooking.service';
import { InvoiceService } from './invoice.service';
import { PromotionService } from './promotion.service';
import { RewardsService } from './rewards.service';
import { ReferralService } from './referral.service';
import { DiscountService } from './discount.service';
import { TripPhotoService } from './tripPhoto.service';
import { DriverWalletService } from './driverWallet.service';
import { WalletService } from './wallet.service';

// ── Cache Invalidation Helper ───────────────────────────────────────────────
// Call this whenever booking status changes so Redis never serves stale data.
// Safe to call fire-and-forget — errors are swallowed.
const invalidateBookingCaches = (userIds: (string | null | undefined)[]) => {
  void (async () => {
    try {
      const { redisClient } = await import('../config/redis');
      if (redisClient.status !== 'ready') return;
      const keys = userIds
        .filter(Boolean)
        .flatMap((id) => [`active_booking:${id}`, `avail_bookings:${id}`]);
      if (keys.length) await redisClient.del(...keys);
    } catch {
      // Non-fatal
    }
  })();
};

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

const HYDERABAD_ORR_POLYGON: Array<{ lat: number; lng: number }> = [
  { lat: 17.4269, lng: 78.3425 },
  { lat: 17.485, lng: 78.285 },
  { lat: 17.534, lng: 78.265 },
  { lat: 17.58, lng: 78.31 },
  { lat: 17.61, lng: 78.38 },
  { lat: 17.625, lng: 78.48 },
  { lat: 17.61, lng: 78.56 },
  { lat: 17.56, lng: 78.64 },
  { lat: 17.49, lng: 78.68 },
  { lat: 17.42, lng: 78.69 },
  { lat: 17.35, lng: 78.67 },
  { lat: 17.29, lng: 78.63 },
  { lat: 17.24, lng: 78.57 },
  { lat: 17.21, lng: 78.49 },
  { lat: 17.2, lng: 78.42 },
  { lat: 17.24, lng: 78.38 },
  { lat: 17.3233, lng: 78.376 },
  { lat: 17.39, lng: 78.35 },
  { lat: 17.42, lng: 78.35 },
];

const isPointInPolygon = (lat: number, lng: number, polygon: Array<{ lat: number; lng: number }>) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (!Array.isArray(polygon) || polygon.length < 3) return false;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;

    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
};

const computeDistanceKmFromLocations = (points: Array<{ lat: number; lng: number }>) => {
  if (!points.length) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    total += calculateDistance(a.lat, a.lng, b.lat, b.lng);
  }
  if (!Number.isFinite(total) || total < 0) return 0;
  return total;
};

export class BookingService {
  static rateBooking = async (params: {
    bookingId: string;
    customerId: string;
    rating: number;
    review?: string;
    categories?: any;
  }) => {
    const booking = await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: {
        id: true,
        status: true,
        customerId: true,
        driverId: true,
      },
    });

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    if (String(booking.customerId) !== String(params.customerId)) {
      throw new AppError('Not authorized for this booking', 403);
    }

    if (booking.status !== BookingStatus.COMPLETED) {
      throw new AppError('Rating is only allowed after trip completion', 400);
    }

    if (!booking.driverId) {
      throw new AppError('Driver not assigned', 400);
    }

    const ratingInt = clamp(Math.round(Number(params.rating)), 1, 5);

    const existing = await prisma.rating.findUnique({
      where: { bookingId: booking.id },
      select: { id: true },
    });
    if (existing?.id) {
      throw new AppError('Rating already submitted', 409);
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.rating.create({
        data: {
          bookingId: booking.id,
          ratedById: params.customerId,
          ratedUserId: booking.driverId as string,
          rating: ratingInt,
          review: params.review ? String(params.review) : null,
          categories: params.categories ?? undefined,
          isPublic: true,
        } as any,
      });

      await tx.booking.update({
        where: { id: booking.id },
        data: {
          customerRating: ratingInt,
          customerReview: params.review ? String(params.review) : null,
        } as any,
      });

      const driver = await tx.user.findUnique({
        where: { id: booking.driverId as string },
        select: { rating: true, totalRatings: true },
      });

      const prevAvg = driver?.rating ? Number(driver.rating) : 0;
      const prevCount = typeof driver?.totalRatings === 'number' ? Number(driver.totalRatings) : 0;
      const nextCount = Math.max(0, prevCount) + 1;
      const nextAvg = (Math.max(0, prevAvg) * Math.max(0, prevCount) + ratingInt) / nextCount;

      await tx.user.update({
        where: { id: booking.driverId as string },
        data: {
          rating: new Prisma.Decimal(nextAvg.toFixed(2)) as any,
          totalRatings: nextCount,
        },
      });

      return {
        bookingId: booking.id,
        ratedUserId: booking.driverId as string,
        rating: ratingInt,
        averageRating: Number(nextAvg.toFixed(2)),
        totalRatings: nextCount,
      };
    });

    try {
      const io = getSocketServer();
      io.to(`user:${result.ratedUserId}`).emit('user:profile-updated', {
        userId: result.ratedUserId,
        rating: result.averageRating,
        totalRatings: result.totalRatings,
      });
    } catch {
    }

    return result;
  };

  static listAvailableBookingsForDriver = async (params: {
    driverId: string;
    radiusKm?: number;
    limit?: number;
    maxAgeMinutes?: number;
  }) => {
    const limit = Number.isFinite(Number(params.limit)) ? Math.min(50, Math.max(1, Number(params.limit))) : 25;
    const maxAgeMinutesRaw = Number(params.maxAgeMinutes);
    const maxAgeMinutes = Number.isFinite(maxAgeMinutesRaw)
      ? maxAgeMinutesRaw === 0
        ? 0
        : Math.min(120, Math.max(1, maxAgeMinutesRaw))
      : 20;

    // ── Redis short-circuit cache (4 seconds) ──────────────────────────────
    // Drivers poll this every ~2-3s. Cache per-driver for 4s to absorb bursts
    // without hitting DB on every tick. Cache is invalidated when new bookings arrive.
    const { redisClient } = await import('../config/redis');
    const cacheKey = `avail_bookings:${params.driverId}`;
    if (redisClient.status === 'ready') {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) return JSON.parse(cached);
      } catch {
        // Redis miss — fall through to DB
      }
    }

    const driver = await prisma.driverProfile.findUnique({
      where: { userId: params.driverId },
      select: {
        userId: true,
        isOnline: true,
        isAvailable: true,
        currentLocationLat: true,
        currentLocationLng: true,
        currentLongitude: true,
        vehicleTypes: true,
        isExperienced: true,
      } as any,
    });

    if (driver && !driver.isAvailable) {
      return [];
    }

    const driverLat = driver
      ? driver.currentLocationLat
        ? Number(driver.currentLocationLat)
        : Number((driver as any).currentLatitude)
      : NaN;
    const driverLng = driver
      ? driver.currentLocationLng
        ? Number(driver.currentLocationLng)
        : Number((driver as any).currentLongitude)
      : NaN;

    const now = new Date();
    const since = maxAgeMinutes > 0 ? new Date(Date.now() - maxAgeMinutes * 60 * 1000) : null;

    // NOTE: Stale booking auto-cancel intentionally removed from this hot path.
    // It runs in createBooking and is also handled by the 6-hour threshold there.
    // Running updateMany on every driver poll was a major DB write load.

    const bookings = await prisma.booking.findMany({
      where: {
        driverId: null,
        status: { in: [BookingStatus.REQUESTED, BookingStatus.SEARCHING] },
        OR:
          maxAgeMinutes === 0
            ? [{ scheduledTime: null }, { scheduledTime: { gt: now } }]
            : [{ scheduledTime: null, updatedAt: { gte: since as Date } }, { scheduledTime: { gt: now } }],
      } as any,
      orderBy: [{ scheduledTime: 'asc' }, { updatedAt: 'desc' }],
      take: Math.min(200, limit * 10),
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        scheduledTime: true,
        pickupAddress: true,
        pickupLocationLat: true,
        pickupLocationLng: true,
        dropAddress: true,
        dropLocationLat: true,
        dropLocationLng: true,
        totalAmount: true,
        driverEarnings: true,
        vehicleType: true,
        transmissionType: true,
        tripType: true,
        pricingBreakdown: true,
        estimatedDuration: true,
        rejectedDriverIds: true,
        requireExperienced: true,
        experiencedDriverFee: true,
      } as any,
    });

    const driverVehicleTypes = Array.isArray((driver as any)?.vehicleTypes) ? ((driver as any).vehicleTypes as VehicleType[]) : [];

    const items = bookings
      .map((b: any) => {
        const rejected = Array.isArray((b as any)?.rejectedDriverIds) ? ((b as any).rejectedDriverIds as string[]) : [];
        if (rejected.includes(params.driverId)) {
          return null;
        }

        // Broadcast to ALL drivers immediately — no 15-minute wait.
        // If a non-experienced driver accepts, the ₹75 fee is stripped at acceptance time.
        // This maximises driver availability while being fair to all.

        const pickupLat = Number(b.pickupLocationLat);
        const pickupLng = Number(b.pickupLocationLng);
        if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) return null;

        if (driverVehicleTypes.length > 0 && b.vehicleType && !driverVehicleTypes.includes(b.vehicleType as VehicleType)) {
          return null;
        }

        const driverDistanceKm =
          Number.isFinite(driverLat) && Number.isFinite(driverLng) ? calculateDistance(driverLat, driverLng, pickupLat, pickupLng) : undefined;

        const dropLatRaw = b.dropLocationLat;
        const dropLngRaw = b.dropLocationLng;
        const dropLat = dropLatRaw !== null && dropLatRaw !== undefined ? Number(dropLatRaw) : NaN;
        const dropLng = dropLngRaw !== null && dropLngRaw !== undefined ? Number(dropLngRaw) : NaN;

        const createdAt = (b as any).updatedAt ?? (b as any).createdAt;

        return {
          bookingId: String(b.id),
          driverDistanceKm,
          etaMin: typeof b.estimatedDuration === 'number' ? Number(b.estimatedDuration) : undefined,
          distanceKm: typeof b.estimatedDistance === 'number' ? Number(b.estimatedDistance) : undefined,
          tripType: b.tripType ?? undefined,
          scheduledTime: b.scheduledTime ?? undefined,
          requestedHours:
            typeof b.pricingBreakdown === 'object' && b.pricingBreakdown
              ? (() => {
                const raw = (b.pricingBreakdown as any).packageHours ?? (b.pricingBreakdown as any).durationHours;
                const hours = Number(raw);
                return Number.isFinite(hours) && hours > 0 ? hours : undefined;
              })()
              : undefined,
          outstationTripType:
            typeof b.pricingBreakdown === 'object' && b.pricingBreakdown ? (b.pricingBreakdown as any).outstationTripType : undefined,
          pickup: {
            latitude: pickupLat,
            longitude: pickupLng,
            address: b.pickupAddress,
          },
          drop:
            Number.isFinite(dropLat) && Number.isFinite(dropLng)
              ? {
                latitude: dropLat,
                longitude: dropLng,
                address: b.dropAddress,
              }
              : null,
          // Driver sees their FULL earnings (platform absorbs discounts).
          // If booking requires experienced driver, driverEarnings includes the ₹75 fee.
          // If a normal driver ends up accepting, the fee is stripped at that time.
          fare: Number((b as any).driverEarnings || b.totalAmount || 0),
          customerFare: Number(b.totalAmount || 0),
          requireExperienced: Boolean((b as any).requireExperienced),
          experiencedDriverFee: Number((b as any).experiencedDriverFee || 0),
          vehicleType: b.vehicleType ?? undefined,
          transmissionType: (b as any).transmissionType ?? undefined,
          createdAt,
        };
      })
      .filter(Boolean) as any[];

    items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const result = items.slice(0, limit);

    // Store in Redis for 4 seconds — absorbs rapid repeat polls without DB hits
    if (redisClient.status === 'ready') {
      try {
        await redisClient.setex(cacheKey, 4, JSON.stringify(result));
      } catch {
        // Non-fatal — just skip caching
      }
    }

    return result;
  };

  static getBookingHistoryForUser = async (params: { userId: string; page?: number; limit?: number }) => {
    const page = Number.isFinite(params.page as number) && (params.page as number) > 0 ? Number(params.page) : 1;
    const limit = Number.isFinite(params.limit as number) && (params.limit as number) > 0 ? Number(params.limit) : 20;
    const take = Math.min(50, Math.max(1, limit));
    const skip = (page - 1) * take;

    const bookings = await prisma.booking.findMany({
      where: {
        OR: [{ customerId: params.userId }, { driverId: params.userId }],
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: {
        id: true,
        bookingNumber: true,
        status: true,
        pickupAddress: true,
        dropAddress: true,
        scheduledTime: true,
        totalAmount: true,
        discountAmount: true,
        driverEarnings: true,
        paymentMethod: true,
        paymentStatus: true,
        createdAt: true,
        completedAt: true,
        customerId: true,
        driverId: true,
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            rating: true,
            totalRatings: true,
            userType: true,
            isVerified: true,
            email: true,
          },
        },
        driver: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            rating: true,
            totalRatings: true,
            userType: true,
            isVerified: true,
            email: true,
          },
        },
      },
    });

    return {
      page,
      limit: take,
      bookings: bookings.map((b) => ({
        ...b,
        totalAmount: Number(b.totalAmount || 0),
        driverEarnings: Number(b.driverEarnings || 0),
        discountAmount: Number(b.discountAmount || 0),
      })),
    };
  };

  static createBooking = async (params: {
    customerId: string;
    pickup: { latitude: number; longitude: number; address: string };
    drop?: { latitude: number; longitude: number; address: string };
    vehicleType: VehicleType;
    transmissionType?: TransmissionType;
    paymentMethod: PaymentMethod;
    tripType?: unknown;
    outstationTripType?: unknown;
    requestedHours?: number;
    scheduledTime?: Date;
    specialRequests?: string;
    promoCode?: string;
    requireExperienced?: boolean;
  }) => {
    if (params.scheduledTime instanceof Date && Number.isFinite(params.scheduledTime.getTime())) {
      const minMs = Date.now() + 90 * 60 * 1000;
      if (params.scheduledTime.getTime() < minMs) {
        throw new AppError('Scheduled time must be at least 1 hour 30 minutes from now', 400);
      }
    }

    const tripType = normalizeTripType(params.tripType);
    const outstationTripTypeRaw = typeof params.outstationTripType === 'string' ? params.outstationTripType.trim().toUpperCase() : '';
    const outstationTripType = outstationTripTypeRaw === 'ROUND_TRIP' ? 'ROUND_TRIP' : outstationTripTypeRaw === 'ONE_WAY' ? 'ONE_WAY' : null;

    if (tripType === 'OUTSTATION') {
      if (!outstationTripType) {
        throw new AppError('Please select outstation trip type (Round Trip or One Way)', 400);
      }

      const requested = Number.isFinite(params.requestedHours as number) ? Number(params.requestedHours) : 12;

      const allowed =
        outstationTripType === 'ROUND_TRIP' ? [12, 16, 20, 24, 48, 72, 96, 120] : [12, 14, 16, 18];

      if (!allowed.includes(Math.round(requested))) {
        throw new AppError('Invalid outstation package hours', 400);
      }

      params.requestedHours = Math.round(requested);
    }

    const pickupLat = params.pickup.latitude;
    const pickupLng = params.pickup.longitude;

    const isSingleLocationRoundTrip = tripType === 'ROUND_TRIP';

    const dropLat = isSingleLocationRoundTrip ? pickupLat : params.drop?.latitude;
    const dropLng = isSingleLocationRoundTrip ? pickupLng : params.drop?.longitude;
    const dropAddress = isSingleLocationRoundTrip ? params.pickup.address : params.drop?.address;

    if (!isSingleLocationRoundTrip && (dropLat === undefined || dropLng === undefined)) {
      throw new AppError('Please select drop location', 400);
    }

    if (tripType === 'ONE_WAY' && dropLat !== undefined && dropLng !== undefined) {
      const pickupInside = isPointInPolygon(pickupLat, pickupLng, HYDERABAD_ORR_POLYGON);
      const dropInside = isPointInPolygon(dropLat, dropLng, HYDERABAD_ORR_POLYGON);
      if (!pickupInside || !dropInside) {
        throw new AppError('Not serviceable area. We will be available soon.', 400);
      }
    }

    let distanceMeters = 0;
    let durationSeconds = 0;
    let polyline: string | null = null;

    // Start promo user lookup in parallel with route calculation (saves ~200-400ms)
    const promoCode = (params.promoCode || '').trim();
    const promoUserPromise = promoCode
      ? prisma.user.findUnique({ where: { id: params.customerId }, select: { userType: true } })
      : Promise.resolve(null);

    if (!isSingleLocationRoundTrip && dropLat !== undefined && dropLng !== undefined) {
      try {
        const route = await getRoute(
          { latitude: pickupLat, longitude: pickupLng },
          { latitude: dropLat, longitude: dropLng }
        );
        distanceMeters = route.distance;
        durationSeconds = route.duration;
        polyline = route.polyline;
      } catch (error) {
        const distanceKm = calculateDistance(pickupLat, pickupLng, dropLat, dropLng);
        distanceMeters = Math.round(distanceKm * 1000);
        durationSeconds = Math.max(60, Math.round((distanceKm / 30) * 3600));
        polyline = null;
        logger.warn('Route calculation failed; using fallback estimate', { error });
      }
    }

    const fare = computeFare({
      tripType,
      distanceMeters,
      durationSeconds,
      requestedHours: params.requestedHours,
      isEstimate: true,
      outstationTripType: tripType === 'OUTSTATION' ? (outstationTripType as any) : undefined,
      outstationPlannedDistanceKm: tripType === 'OUTSTATION' && outstationTripType === 'ONE_WAY' ? distanceMeters / 1000 : undefined,
      startTime: params.scheduledTime ?? new Date(),
    });

    let promo: { promotionId: string; discountAmount: number; finalAmount: number } | null = null;
    if (promoCode) {
      const user = await promoUserPromise;
      if (!user) {
        throw new AppError('User not found', 404);
      }
      const validated = await PromotionService.validatePromotion({
        userId: params.customerId,
        code: promoCode,
        amount: fare.total,
        userType: user.userType,
      });
      promo = {
        promotionId: validated.promotionId,
        discountAmount: validated.discountAmount,
        finalAmount: validated.finalAmount,
      };
    }

    const commissionPct = Number(process.env.COMMISSION_PERCENTAGE || 0);
    const commissionPercentage = clamp(commissionPct, 0, 100);

    // ── Apply membership + streak discounts ──
    const memberDiscounts = await DiscountService.applyDiscounts(params.customerId, fare.total);

    const EXPERIENCED_DRIVER_FEE = 75;
    // Premium members get experienced driver automatically
    const requireExperienced = Boolean(params.requireExperienced) || memberDiscounts.requireExperienced;
    const experiencedDriverFee = requireExperienced ? EXPERIENCED_DRIVER_FEE : 0;

    const promoDiscountAmount = promo ? promo.discountAmount : 0;
    const discountAmount = promoDiscountAmount + memberDiscounts.totalDiscount;

    // customerPays = discounted amount
    const payableTotal = Math.max(0, Math.round((fare.total - discountAmount + experiencedDriverFee) * 100) / 100);

    // driverBase = full meter fare (platform absorbs ALL discounts — membership, streak, promo)
    // Driver is never penalised for platform-created incentives.
    const driverBase = Math.max(payableTotal, Math.max(0, Math.round((fare.total + experiencedDriverFee) * 100) / 100));
    const platformCommission = Math.round((driverBase * commissionPercentage) / 100);
    const driverEarnings = Math.max(0, driverBase - platformCommission);

    // platformSubsidy = gap between what customer pays and what driver earns
    // (= total discount absorbed by platform)
    const platformSubsidy = Math.max(0, Math.round((driverEarnings - (payableTotal - platformCommission)) * 100) / 100);

    const discountBreakdown = {
      promoDiscount: promoDiscountAmount,
      membershipDiscount: memberDiscounts.membershipDiscount,
      streakDiscount: memberDiscounts.streakDiscount,
      membershipType: memberDiscounts.breakdown.membershipType,
      streakRides: memberDiscounts.breakdown.streakRides,
      streakPct: memberDiscounts.breakdown.streakPct,
      platformSubsidy,
    };

    const booking = await prisma.$transaction(async (tx) => {
      const created = await tx.booking.create({
        data: {
          customerId: params.customerId,
          bookingType: tripType === 'OUTSTATION' ? 'OUTSTATION' : 'CITY',
          tripType,
          status: BookingStatus.REQUESTED,
          pickupLocationLat: pickupLat,
          pickupLocationLng: pickupLng,
          pickupAddress: params.pickup.address,
          dropLocationLat: dropLat,
          dropLocationLng: dropLng,
          dropAddress,
          scheduledTime: params.scheduledTime,
          vehicleType: params.vehicleType,
          transmissionType: params.transmissionType,
          specialRequests: params.specialRequests,
          estimatedDistance: distanceMeters ? distanceMeters / 1000 : null,
          estimatedDuration: durationSeconds ? Math.round(durationSeconds / 60) : null,
          routePolyline: polyline,
          pricingBreakdown: { ...(fare.breakdown as any), discounts: discountBreakdown, platformSubsidy } as any,
          totalAmount: payableTotal,
          promoCodeId: promo ? promo.promotionId : null,
          discountAmount,
          platformCommission,
          driverEarnings,
          commissionPercentage,
          paymentMethod: params.paymentMethod || PaymentMethod.CASH,
          paymentStatus: PaymentStatus.PENDING,
          matchAttempts: 0,
          rejectedDriverIds: [],
          requireExperienced,
          experiencedDriverFee,
        } as any,
        include: {
          customer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phoneNumber: true,
            },
          },
        },
      });

      if (promo) {
        await tx.promotion.update({
          where: { id: promo.promotionId },
          data: { currentUsageCount: { increment: 1 } },
        });

        await tx.promotionRedemption.create({
          data: {
            promotionId: promo.promotionId,
            userId: params.customerId,
            bookingId: created.id,
            discountAmount: new Prisma.Decimal(discountAmount),
          } as any,
        });
      }

      return created;
    });

    const io = getSocketServer();
    io.to(`user:${params.customerId}`).emit('booking:created', { bookingId: booking.id });

    const scheduledAt = booking.scheduledTime ? new Date(booking.scheduledTime as any) : null;
    const now = Date.now();
    const shouldStartNow = !scheduledAt || scheduledAt.getTime() <= now;

    if (shouldStartNow) {
      setImmediate(() => {
        MatchingService.startMatchingForBooking(booking.id).catch((error) => {
          logger.error('Matching service failed', { error, bookingId: booking.id });
        });
      });
    } else {
      try {
        io.to('online-drivers').emit('booking:offer', {
          bookingId: booking.id,
          tripType: (booking as any).tripType ?? undefined,
          requestedHours:
            typeof (booking as any).pricingBreakdown === 'object' && (booking as any).pricingBreakdown
              ? (() => {
                const raw = ((booking as any).pricingBreakdown as any).packageHours ?? ((booking as any).pricingBreakdown as any).durationHours;
                const hours = Number(raw);
                return Number.isFinite(hours) && hours > 0 ? hours : undefined;
              })()
              : undefined,
          outstationTripType:
            typeof (booking as any).pricingBreakdown === 'object' && (booking as any).pricingBreakdown
              ? ((booking as any).pricingBreakdown as any).outstationTripType
              : undefined,
          pickup: {
            latitude: Number((booking as any).pickupLocationLat),
            longitude: Number((booking as any).pickupLocationLng),
            address: (booking as any).pickupAddress,
          },
          drop:
            (booking as any).dropLocationLat && (booking as any).dropLocationLng
              ? {
                latitude: Number((booking as any).dropLocationLat),
                longitude: Number((booking as any).dropLocationLng),
                address: (booking as any).dropAddress,
              }
              : null,
          // Driver sees their FULL earnings (platform absorbs discounts)
          fare: Number((booking as any).driverEarnings),
          customerFare: Number((booking as any).totalAmount), // what customer actually pays
          platformSubsidy: Number(((booking as any).pricingBreakdown as any)?.platformSubsidy ?? 0),
          vehicleType: (booking as any).vehicleType ?? undefined,
          transmissionType: (booking as any).transmissionType ?? undefined,
          scheduledTime: scheduledAt ? scheduledAt.toISOString() : undefined,
          createdAt: (booking as any).createdAt,
        });
      } catch {
      }

      enqueueScheduledBooking(booking.id, scheduledAt).catch((error) => {
        logger.warn('Failed to enqueue scheduled booking; cron fallback may still pick it up', {
          error,
          bookingId: booking.id,
        });
      });
    }

    return booking;
  };

  static acceptBooking = async (params: { bookingId: string; driverId: string }) => {
    const activeForDriver = await prisma.booking.findFirst({
      where: {
        driverId: params.driverId,
        status: {
          in: [
            BookingStatus.ACCEPTED,
            BookingStatus.DRIVER_ARRIVING,
            BookingStatus.ARRIVED,
            BookingStatus.STARTED,
            BookingStatus.IN_PROGRESS,
          ],
        },
      },
      select: { id: true, status: true } as any,
    });

    if (activeForDriver && String((activeForDriver as any).id) !== String(params.bookingId)) {
      throw new AppError('Driver already has an active booking', 409);
    }

    const booking = await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: {
        id: true,
        customerId: true,
        driverId: true,
        status: true,
        scheduledTime: true,
        requireExperienced: true,
        experiencedDriverFee: true,
        totalAmount: true,
        driverEarnings: true,
        discountAmount: true,
        platformCommission: true,
        pricingBreakdown: true,
      } as any,
    });

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    if ((booking as any).driverId && (booking as any).driverId === params.driverId) {
      return { bookingId: params.bookingId };
    }

    if ((booking as any).driverId) {
      throw new AppError('Booking already assigned', 409);
    }

    if ((booking as any).status !== BookingStatus.SEARCHING && (booking as any).status !== BookingStatus.REQUESTED) {
      throw new AppError('Booking is not available for acceptance', 409);
    }

    const updated = await prisma.booking.updateMany({
      where: {
        id: params.bookingId,
        driverId: null,
        status: { in: [BookingStatus.SEARCHING, BookingStatus.REQUESTED] },
      },
      data: {
        driverId: params.driverId,
        status: BookingStatus.ACCEPTED,
        acceptedAt: new Date(),
        otp: null,
      } as any,
    });

    if (updated.count === 0) {
      const existing = await prisma.booking.findUnique({
        where: { id: params.bookingId },
        select: { driverId: true, status: true },
      });

      if (existing?.driverId && existing.driverId === params.driverId) {
        return { bookingId: params.bookingId };
      }

      throw new AppError('Booking already accepted by another driver', 409);
    }

    // Fetch driver profile (isExperienced) + user info + update availability in parallel
    const [driverUser, driverProfile] = await Promise.all([
      prisma.user.findUnique({
        where: { id: params.driverId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phoneNumber: true,
          profileImage: true,
          rating: true,
          totalRatings: true,
          userType: true,
        },
      }),
      prisma.driverProfile.findUnique({
        where: { userId: params.driverId },
        select: { isExperienced: true } as any,
      }),
      prisma.driverProfile.update({
        where: { userId: params.driverId },
        data: { isAvailable: false } as any,
      }),
    ]);

    // ── Experienced driver fee adjustment ────────────────────────────────────
    // If customer requested an experienced driver but a NORMAL driver accepted,
    // strip the ₹75 fee immediately and notify the customer with the new fare.
    const bookingRequiredExperienced = Boolean((booking as any).requireExperienced);
    const driverIsExperienced = Boolean((driverProfile as any)?.isExperienced);
    const existingExpFee = Math.max(0, Number((booking as any).experiencedDriverFee || 0));
    let fareWasAdjusted = false;
    let newTotalAmount = Number((booking as any).totalAmount || 0);
    let newDriverEarnings = Number((booking as any).driverEarnings || 0);

    if (bookingRequiredExperienced && !driverIsExperienced && existingExpFee > 0) {
      // Strip the experienced driver fee — customer gets a refund-of-expectation
      newTotalAmount = Math.max(0, Math.round((Number((booking as any).totalAmount || 0) - existingExpFee) * 100) / 100);
      newDriverEarnings = Math.max(0, Math.round((Number((booking as any).driverEarnings || 0) - existingExpFee) * 100) / 100);

      // Recompute platformSubsidy after fee removal
      const pb = typeof (booking as any).pricingBreakdown === 'object' && (booking as any).pricingBreakdown
        ? (booking as any).pricingBreakdown as any : {};

      await prisma.booking.update({
        where: { id: params.bookingId },
        data: {
          totalAmount: newTotalAmount,
          driverEarnings: newDriverEarnings,
          requireExperienced: false,    // booking is now fulfilled by a normal driver
          experiencedDriverFee: 0,      // fee removed
          pricingBreakdown: {
            ...pb,
            experiencedDriverFee: 0,
            experiencedDriverFeeRemoved: existingExpFee,
            fareAdjustedAt: new Date().toISOString(),
            fareAdjustedReason: 'Normal driver accepted — experienced driver fee removed',
          } as any,
        } as any,
      });

      fareWasAdjusted = true;
      logger.info('[acceptBooking] Experienced driver fee stripped — normal driver accepted', {
        bookingId: params.bookingId,
        driverId: params.driverId,
        strippedFee: existingExpFee,
        newTotalAmount,
        newDriverEarnings,
      });
    }

    // Single re-read with driver+customer included — used for socket AND return
    const acceptedBooking = await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: {
        id: true,
        bookingNumber: true,
        status: true,
        customerId: true,
        driverId: true,
        pickupAddress: true,
        dropAddress: true,
        pickupLocationLat: true,
        pickupLocationLng: true,
        dropLocationLat: true,
        dropLocationLng: true,
        vehicleType: true,
        transmissionType: true,
        tripType: true,
        totalAmount: true,
        paymentMethod: true,
        paymentStatus: true,
        scheduledTime: true,
        acceptedAt: true,
        createdAt: true,
        updatedAt: true,
        estimatedDistance: true,
        estimatedDuration: true,
        pricingBreakdown: true,
        discountAmount: true,
        platformCommission: true,
        driverEarnings: true,
        commissionPercentage: true,
        requireExperienced: true,
        experiencedDriverFee: true,
        otp: true,
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            profileImage: true,
            rating: true,
            totalRatings: true,
          },
        },
      } as any,
    });

    const io = getSocketServer();

    // If fare was adjusted (normal driver took experienced booking), notify customer FIRST
    // so they see the new lower price before the driver details appear.
    if (fareWasAdjusted) {
      io.to(`user:${booking.customerId}`).emit('booking:fare-updated', {
        bookingId: params.bookingId,
        totalAmount: newTotalAmount,
        discountAmount: Number((booking as any).discountAmount || 0),
        reason: 'experienced_driver_unavailable',
        message: `An experienced driver was not available. The ₹${existingExpFee} experienced driver fee has been removed. New fare: ₹${newTotalAmount}.`,
        fareReduced: existingExpFee,
      });

      try {
        await sendExpoPushNotification({
          userIds: [String(booking.customerId)],
          title: '💰 Fare Updated',
          body: `Experienced driver unavailable. ₹${existingExpFee} removed. New fare: ₹${newTotalAmount}.`,
          data: { kind: 'fare_updated', bookingId: String(params.bookingId) },
        });
      } catch { }
    }

    // Emit to customer with FULL driver + booking data (eliminates REST re-fetch)
    io.to(`user:${booking.customerId}`).emit('booking:accepted', {
      bookingId: params.bookingId,
      driverId: params.driverId,
      driver: driverUser,
      booking: acceptedBooking,
      fareAdjusted: fareWasAdjusted
        ? { reason: 'experienced_driver_unavailable', fareReduced: existingExpFee, newTotal: newTotalAmount }
        : undefined,
    });
    // Emit to driver (lightweight)
    io.to(`user:${params.driverId}`).emit('booking:accepted', {
      bookingId: params.bookingId,
      booking: acceptedBooking,
    });
    // Emit to booking room (lightweight)
    io.to(`booking:${params.bookingId}`).emit('booking:accepted', {
      bookingId: params.bookingId,
      driverId: params.driverId,
    });
    io.to('online-drivers').emit('booking:offer-removed', {
      bookingId: params.bookingId,
      reason: 'ACCEPTED',
    });

    try {
      await sendExpoPushNotification({
        userIds: [String(booking.customerId)],
        title: '🚗 Driver accepted your ride!',
        body: `${driverUser?.firstName || 'Your driver'} is heading to your pickup location.`,
        data: {
          kind: 'booking_accepted',
          bookingId: String(params.bookingId),
        },
      });
    } catch { }

    invalidateBookingCaches([String((booking as any).customerId), params.driverId]);
    return { booking: acceptedBooking, fareAdjusted: fareWasAdjusted };
  };

  static getActiveBookingForUser = async (userId: string) => {
    // ── 3-second Redis cache for active booking ────────────────────────────
    // Customer + driver both poll this on every screen mount/refresh.
    // Real-time updates come via Socket.IO — the 3s REST cache window is safe.
    const { redisClient } = await import('../config/redis');
    const activeCacheKey = `active_booking:${userId}`;
    if (redisClient.status === 'ready') {
      try {
        const cached = await redisClient.get(activeCacheKey);
        if (cached !== null) return JSON.parse(cached);
      } catch {
        // Fall through to DB
      }
    }

    const activeStatuses: BookingStatus[] = [
      BookingStatus.REQUESTED,
      BookingStatus.SEARCHING,
      BookingStatus.ACCEPTED,
      BookingStatus.DRIVER_ARRIVING,
      BookingStatus.ARRIVED,
      BookingStatus.STARTED,
      BookingStatus.IN_PROGRESS,
    ];

    const pendingStatuses: BookingStatus[] = [BookingStatus.REQUESTED, BookingStatus.SEARCHING];
    const engagedStatuses: BookingStatus[] = [
      BookingStatus.ACCEPTED,
      BookingStatus.DRIVER_ARRIVING,
      BookingStatus.ARRIVED,
      BookingStatus.STARTED,
      BookingStatus.IN_PROGRESS,
    ];

    const nowMs = Date.now();
    const booking = await prisma.booking.findFirst({
      where: {
        AND: [
          { OR: [{ customerId: userId }, { driverId: userId }] },
          {
            OR: [
              { status: { in: engagedStatuses } },
              { status: { in: pendingStatuses } },
            ],
          },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        status: true,
        updatedAt: true,
        customerId: true,
        driverId: true,
      },
    });

    if (!booking) {
      // Cache null result briefly too — no active booking
      if (redisClient.status === 'ready') {
        try { await redisClient.setex(activeCacheKey, 3, 'null'); } catch {}
      }
      return null;
    }

    const ageMs = nowMs - new Date(booking.updatedAt).getTime();
    const isStale = (() => {
      const searchingMaxMs = Number.POSITIVE_INFINITY;
      const preTripMaxMs = 2 * 60 * 60 * 1000;
      const inTripMaxMs = 24 * 60 * 60 * 1000;

      if (booking.status === BookingStatus.REQUESTED || booking.status === BookingStatus.SEARCHING) {
        return ageMs > searchingMaxMs;
      }

      if (
        booking.status === BookingStatus.ACCEPTED ||
        booking.status === BookingStatus.DRIVER_ARRIVING ||
        booking.status === BookingStatus.ARRIVED
      ) {
        return ageMs > preTripMaxMs;
      }

      if (booking.status === BookingStatus.STARTED || booking.status === BookingStatus.IN_PROGRESS) {
        return ageMs > inTripMaxMs;
      }

      return false;
    })();

    if (isStale) {
      const cancelledAt = new Date();
      const result = await prisma.booking.updateMany({
        where: {
          id: booking.id,
          status: { in: activeStatuses },
        },
        data: {
          status: BookingStatus.CANCELLED,
          cancelledAt,
          cancelledBy: CancelledBy.SYSTEM,
          cancellationReason: 'Expired',
        } as any,
      });

      if (result.count > 0) {
        if (booking.driverId) {
          await prisma.driverProfile.update({
            where: { userId: booking.driverId },
            data: { isAvailable: true } as any,
          });
        }

        const io = getSocketServer();
        io.to(`booking:${booking.id}`).emit('booking:cancelled', {
          bookingId: booking.id,
          cancelledBy: CancelledBy.SYSTEM,
          reason: 'Expired',
        });

        io.to(`user:${booking.customerId}`).emit('booking:cancelled', {
          bookingId: booking.id,
          cancelledBy: CancelledBy.SYSTEM,
        });

        if (booking.driverId) {
          io.to(`user:${booking.driverId}`).emit('booking:cancelled', {
            bookingId: booking.id,
            cancelledBy: CancelledBy.SYSTEM,
          });
        }

        io.to('online-drivers').emit('booking:offer-removed', {
          bookingId: booking.id,
          reason: 'CANCELLED',
        });
      }

      // Invalidate cache on stale cancel
      if (redisClient.status === 'ready') {
        try { await redisClient.del(activeCacheKey); } catch {}
      }
      return null;
    }

    const fullBooking = await BookingService.getBookingById(booking.id, userId);

    // Cache the result for 3 seconds
    if (redisClient.status === 'ready') {
      try {
        await redisClient.setex(activeCacheKey, 3, JSON.stringify(fullBooking));
      } catch {}
    }

    return fullBooking;
  };

  static verifyBookingOtp = async (_params: { bookingId: string; driverId: string; otp: string }) => {
    // OTP verification has been replaced with photo verification.
    // This endpoint is kept for backward compatibility with old app versions.
    throw new AppError(
      'OTP verification has been removed. Please update your app to the latest version. The new flow requires photo verification before starting the trip.',
      410  // HTTP 410 Gone
    );
  };

  static rejectBooking = async (params: { bookingId: string; driverId: string }) => {
    const booking = (await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: {
        id: true,
        customerId: true,
        driverId: true,
        status: true,
        rejectedDriverIds: true,
      } as any,
    })) as {
      id: string;
      customerId: string;
      driverId: string | null;
      status: BookingStatus;
      rejectedDriverIds?: string[];
    } | null;

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    if (booking.driverId) {
      throw new AppError('Booking already assigned', 409);
    }

    if (booking.status !== BookingStatus.SEARCHING) {
      throw new AppError('Booking is not in matching state', 409);
    }

    const rejected = new Set<string>(((booking as any).rejectedDriverIds || []) as string[]);
    rejected.add(params.driverId);

    const updatedBooking = await prisma.booking.update({
      where: { id: params.bookingId },
      data: {
        rejectedDriverIds: Array.from(rejected),
      } as any,
      select: {
        id: true,
        bookingNumber: true,
        status: true,
        customerId: true,
        driverId: true,
        pickupAddress: true,
        dropAddress: true,
        pickupLocationLat: true,
        pickupLocationLng: true,
        dropLocationLat: true,
        dropLocationLng: true,
        vehicleType: true,
        transmissionType: true,
        tripType: true,
        totalAmount: true,
        paymentMethod: true,
        paymentStatus: true,
        scheduledTime: true,
        createdAt: true,
        updatedAt: true,
        estimatedDistance: true,
        estimatedDuration: true,
        pricingBreakdown: true,
        discountAmount: true,
        platformCommission: true,
        driverEarnings: true,
        commissionPercentage: true,
        rejectedDriverIds: true,
      },
    });

    const io = getSocketServer();
    io.to(`user:${booking.customerId}`).emit('booking:driver-rejected', {
      bookingId: params.bookingId,
      driverId: params.driverId,
    });

    setImmediate(() => {
      MatchingService.startMatchingForBooking(params.bookingId).catch((error) => {
        logger.error('Matching service failed after rejection', { error, bookingId: params.bookingId });
      });
    });

    return { booking: updatedBooking };
  };

  static updateBookingStatus = async (params: {
    bookingId: string;
    userId: string;
    status: BookingStatus;
  }) => {
    const booking = await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: {
        id: true,
        customerId: true,
        driverId: true,
        status: true,
        otp: true,
        paymentMethod: true,
        paymentStatus: true,
        totalAmount: true,
        driverEarnings: true,
        commissionPercentage: true,
        tripType: true,
        pricingBreakdown: true,
        promoCodeId: true,
        discountAmount: true,
        acceptedAt: true,
        startedAt: true,
        estimatedDistance: true,
        actualDistance: true,
        createdAt: true,
        requireExperienced: true,
        experiencedDriverFee: true,
        pickupLocationLat: true,
        pickupLocationLng: true,
      } as any,
    }) as any;

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    const isCustomer = booking.customerId === params.userId;
    const isDriver = booking.driverId === params.userId;

    if (!isCustomer && !isDriver) {
      throw new AppError('Not authorized for this booking', 403);
    }

    if (params.status === BookingStatus.ARRIVED) {
      if (!isDriver) {
        throw new AppError('Only the driver can mark as arrived', 403);
      }

      // Proximity check: driver must be within 300m of the pickup pin.
      // (Mobile enforces 200m; the extra 100m here absorbs GPS drift and
      //  the ~30-second lag between the phone updating driverProfile in DB)
      const pickupLat = Number(booking.pickupLocationLat);
      const pickupLng = Number(booking.pickupLocationLng);

      if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng)) {
        const driverProfile = await prisma.driverProfile.findUnique({
          where: { userId: params.userId },
          select: { currentLocationLat: true, currentLocationLng: true } as any,
        }) as any;

        const driverLat = Number(driverProfile?.currentLocationLat);
        const driverLng = Number(driverProfile?.currentLocationLng);

        if (Number.isFinite(driverLat) && Number.isFinite(driverLng)) {
          const distKm = calculateDistance(driverLat, driverLng, pickupLat, pickupLng);
          const distMeters = distKm * 1000;

          if (distMeters > 300) {
            throw new AppError(
              `You are ${Math.round(distMeters)}m away from the pickup location. Please get within 200 meters to mark as arrived.`,
              400
            );
          }
        }
        // If driver location is not in DB yet (e.g. just accepted), allow through.
        // The mobile-side 200m guard is the primary UX protection.
      }
    }

    if (params.status === BookingStatus.STARTED) {
      if (!isDriver) {
        throw new AppError('Only driver can start the trip', 403);
      }

      if (booking.status !== BookingStatus.ARRIVED) {
        throw new AppError('Trip can be started only after arriving at pickup', 409);
      }

      // Photo verification required: 4 car photos + 1 selfie
      const photoStatus = await TripPhotoService.isPickupVerificationComplete(params.bookingId);
      if (!photoStatus.complete) {
        throw new AppError(
          `Photo verification incomplete. Missing: ${photoStatus.remaining.join(', ')}. Upload all 5 photos before starting the trip.`,
          409
        );
      }
    }

    if (booking.status === BookingStatus.CANCELLED || booking.status === BookingStatus.COMPLETED) {
      throw new AppError('Booking cannot be updated', 409);
    }

    if (params.status === BookingStatus.COMPLETED) {
      if (!booking.startedAt) {
        throw new AppError('Trip must be started before completing', 409);
      }
    }

    if (params.status !== BookingStatus.COMPLETED) {
      const updateData: any = {
        status: params.status,
        arrivedAt: params.status === BookingStatus.ARRIVED ? new Date() : undefined,
        completedAt: undefined,
      };

      if (params.status === BookingStatus.STARTED && !booking.startedAt) {
        updateData.startedAt = new Date();
      }

      await prisma.booking.update({
        where: { id: params.bookingId },
        data: updateData as any,
      });
    }

    // ── Push notifications with retry ──
    const sendPushWithRetry = async (payload: Parameters<typeof sendExpoPushNotification>[0], retries = 2) => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          await sendExpoPushNotification(payload);
          return; // success
        } catch (err) {
          logger.warn(`Push notification attempt ${attempt + 1} failed`, { error: err, bookingId: params.bookingId });
          if (attempt < retries) await new Promise(r => setTimeout(r, 1000)); // wait 1s before retry
        }
      }
    };

    try {
      const next = params.status;
      if (next === BookingStatus.DRIVER_ARRIVING) {
        await sendPushWithRetry({
          userIds: [String(booking.customerId)],
          title: '🚗 Driver is on the way!',
          body: 'Your driver is heading to your pickup location. Get ready!',
          data: { kind: 'booking_status', bookingId: String(params.bookingId), status: 'DRIVER_ARRIVING' },
        });
      }

      if (next === BookingStatus.ARRIVED) {
        await sendPushWithRetry({
          userIds: [String(booking.customerId)],
          title: '📍 Driver has arrived!',
          body: 'Your driver is at the pickup point and verifying the vehicle. Trip will start shortly!',
          data: {
            kind: 'booking_status',
            bookingId: String(params.bookingId),
            status: 'ARRIVED',
          },
        });
      }

      if (next === BookingStatus.STARTED) {
        await sendPushWithRetry({
          userIds: [String(booking.customerId)],
          title: '🚀 Trip started!',
          body: 'Your trip has begun. Enjoy your ride!',
          data: { kind: 'booking_status', bookingId: String(params.bookingId), status: 'STARTED' },
        });
      }

    } catch (notifErr) {
      logger.warn('Failed to send status push notification after retries', { error: notifErr, bookingId: params.bookingId, status: params.status });
    }

    let completedBooking:
      | (typeof booking & {
        platformCommission?: any;
        pricingBreakdown?: any;
      })
      | null = null;

    if (params.status === BookingStatus.COMPLETED) {
      completedBooking = await prisma.$transaction(async (tx) => {
        const completedAt = new Date();

        const updatedStatus = await tx.booking.update({
          where: { id: booking.id },
          data: {
            status: BookingStatus.COMPLETED,
            completedAt,
          } as any,
          select: {
            id: true,
            customerId: true,
            driverId: true,
            paymentMethod: true,
            paymentStatus: true,
            commissionPercentage: true,
            tripType: true,
            pickupLocationLat: true,
            pickupLocationLng: true,
            dropLocationLat: true,
            dropLocationLng: true,
            promoCodeId: true,
            discountAmount: true,
            totalAmount: true,
            startedAt: true,
            acceptedAt: true,
            createdAt: true,
          },
        });

        if (!updatedStatus.startedAt) {
          throw new AppError('Trip must be started before completing', 409);
        }

        const startTime = updatedStatus.startedAt;
        const durationMs = Math.max(60_000, completedAt.getTime() - startTime.getTime());
        const actualDurationMinutes = Math.max(1, Math.ceil(durationMs / 60_000));

        const locations = await tx.location.findMany({
          where: {
            bookingId: booking.id,
            timestamp: {
              gte: startTime,
              lte: completedAt,
            },
          },
          orderBy: { timestamp: 'asc' },
          select: {
            locationLat: true,
            locationLng: true,
          },
          take: 5000,
        });

        const points = locations.map((p) => ({ lat: Number(p.locationLat), lng: Number(p.locationLng) }));
        const computedDistanceKm = computeDistanceKmFromLocations(points);
        const storedLiveDistanceKm = (booking as any).actualDistance ? Number((booking as any).actualDistance) : 0;
        const estimatedDistanceKm = (booking as any).estimatedDistance ? Number((booking as any).estimatedDistance) : 0;
        const pickupLatFallback = (updatedStatus as any).pickupLocationLat ? Number((updatedStatus as any).pickupLocationLat) : NaN;
        const pickupLngFallback = (updatedStatus as any).pickupLocationLng ? Number((updatedStatus as any).pickupLocationLng) : NaN;
        const lastPointFallback = points.length ? points[points.length - 1] : null;
        const dropLatFallback = (updatedStatus as any).dropLocationLat ? Number((updatedStatus as any).dropLocationLat) : NaN;
        const dropLngFallback = (updatedStatus as any).dropLocationLng ? Number((updatedStatus as any).dropLocationLng) : NaN;

        const endPointFallback =
          lastPointFallback || (Number.isFinite(dropLatFallback) && Number.isFinite(dropLngFallback) ? { lat: dropLatFallback, lng: dropLngFallback } : null);

        const straightLineKm =
          endPointFallback && Number.isFinite(pickupLatFallback) && Number.isFinite(pickupLngFallback)
            ? calculateDistance(pickupLatFallback, pickupLngFallback, endPointFallback.lat, endPointFallback.lng)
            : 0;

        const actualDistanceKm =
          computedDistanceKm > 0.05
            ? computedDistanceKm
            : storedLiveDistanceKm > 0.05
              ? storedLiveDistanceKm
              : estimatedDistanceKm > 0.05
                ? estimatedDistanceKm
                : straightLineKm;

        const outstationTripTypeForDistanceRaw =
          typeof (booking as any).pricingBreakdown === 'object' && (booking as any).pricingBreakdown
            ? ((booking as any).pricingBreakdown as any).outstationTripType
            : undefined;
        const outstationTripTypeForDistance =
          typeof outstationTripTypeForDistanceRaw === 'string' && outstationTripTypeForDistanceRaw.trim().toUpperCase() === 'ONE_WAY'
            ? 'ONE_WAY'
            : typeof outstationTripTypeForDistanceRaw === 'string' && outstationTripTypeForDistanceRaw.trim().toUpperCase() === 'ROUND_TRIP'
              ? 'ROUND_TRIP'
              : undefined;

        const pickupLat = pickupLatFallback;
        const pickupLng = pickupLngFallback;
        const lastPoint = lastPointFallback;
        const distanceFromPickupKm =
          (updatedStatus.tripType === 'ROUND_TRIP' ||
            (updatedStatus.tripType === 'OUTSTATION' && outstationTripTypeForDistance === 'ONE_WAY')) &&
            lastPoint &&
            Number.isFinite(pickupLat) &&
            Number.isFinite(pickupLng)
            ? calculateDistance(pickupLat, pickupLng, lastPoint.lat, lastPoint.lng)
            : undefined;

        const selectedPackageHoursRaw =
          typeof (booking as any).pricingBreakdown === 'object' && (booking as any).pricingBreakdown
            ? ((booking as any).pricingBreakdown as any).packageHours ?? ((booking as any).pricingBreakdown as any).durationHours
            : undefined;
        const selectedPackageHours = Number.isFinite(Number(selectedPackageHoursRaw)) ? Number(selectedPackageHoursRaw) : undefined;

        const outstationTripTypeRaw =
          typeof (booking as any).pricingBreakdown === 'object' && (booking as any).pricingBreakdown
            ? ((booking as any).pricingBreakdown as any).outstationTripType
            : undefined;
        const outstationTripType =
          typeof outstationTripTypeRaw === 'string' && outstationTripTypeRaw.trim().toUpperCase() === 'ROUND_TRIP'
            ? 'ROUND_TRIP'
            : typeof outstationTripTypeRaw === 'string' && outstationTripTypeRaw.trim().toUpperCase() === 'ONE_WAY'
              ? 'ONE_WAY'
              : undefined;

        const plannedDropDistanceKmRaw =
          typeof (booking as any).pricingBreakdown === 'object' && (booking as any).pricingBreakdown
            ? ((booking as any).pricingBreakdown as any).plannedDropDistanceKm
            : undefined;
        const plannedDropDistanceKm = Number.isFinite(Number(plannedDropDistanceKmRaw)) ? Number(plannedDropDistanceKmRaw) : undefined;

        const includedKmLimitRaw =
          typeof (booking as any).pricingBreakdown === 'object' && (booking as any).pricingBreakdown
            ? ((booking as any).pricingBreakdown as any).includedKmLimit
            : undefined;
        const includedKmLimit = Number.isFinite(Number(includedKmLimitRaw)) ? Number(includedKmLimitRaw) : undefined;

        const fare = computeFare({
          tripType: updatedStatus.tripType as any,
          distanceMeters: Math.round(actualDistanceKm * 1000),
          durationSeconds: Math.round(actualDurationMinutes * 60),
          requestedHours: selectedPackageHours,
          includedKmLimit,
          roundTripDistanceFromPickupKm: distanceFromPickupKm,
          outstationTripType: updatedStatus.tripType === 'OUTSTATION' ? (outstationTripType as any) : undefined,
          outstationPlannedDistanceKm:
            updatedStatus.tripType === 'OUTSTATION' && outstationTripType === 'ONE_WAY' ? plannedDropDistanceKm : undefined,
          outstationDistanceFromPickupKm:
            updatedStatus.tripType === 'OUTSTATION' && outstationTripType === 'ONE_WAY' ? distanceFromPickupKm : undefined,
          startTime,
        });

        // ── Re-apply ALL discounts at completion (promo + membership + streak) ──
        let promoDiscountAmount = 0;
        if (updatedStatus.promoCodeId) {
          const promo = await tx.promotion.findUnique({
            where: { id: updatedStatus.promoCodeId },
            select: { type: true, value: true, maxDiscount: true },
          });
          if (promo) {
            promoDiscountAmount = PromotionService.computeDiscount({
              type: promo.type,
              value: Number(promo.value),
              maxDiscount: promo.maxDiscount ? Number(promo.maxDiscount) : null,
              amount: fare.total,
            });
          }
        }

        // Retrieve original membership & streak discounts from the booking's pricingBreakdown
        const originalBreakdown = typeof (booking as any).pricingBreakdown === 'object' && (booking as any).pricingBreakdown
          ? (booking as any).pricingBreakdown
          : {};
        const originalDiscounts = originalBreakdown?.discounts || {};
        const membershipDiscount = Math.max(0, Number(originalDiscounts?.membershipDiscount || 0));
        const streakDiscount = Math.max(0, Number(originalDiscounts?.streakDiscount || 0));

        // Total discount = promo + membership + streak
        const discountAmount = promoDiscountAmount + membershipDiscount + streakDiscount;

        // Re-apply experienced driver fee from original booking
        const experiencedDriverFee = Math.max(0, Number((booking as any).experiencedDriverFee || 0));

        // customerPays = discounted amount (unchanged)
        const payableTotal = Math.max(0, Math.round((fare.total - discountAmount + experiencedDriverFee) * 100) / 100);
        const commissionPct = clamp(Number(process.env.COMMISSION_PERCENTAGE || 0), 0, 100);

        // driverBase = full fare — platform absorbs ALL discounts
        const driverBase = Math.max(payableTotal, Math.max(0, Math.round((fare.total + experiencedDriverFee) * 100) / 100));
        const platformCommission = Math.round((driverBase * commissionPct) / 100);
        const driverEarnings = Math.max(0, driverBase - platformCommission);

        // platformSubsidy = gap absorbed by platform
        const platformSubsidy = Math.max(0, Math.round((driverEarnings - (payableTotal - platformCommission)) * 100) / 100);

        // Build the full discount breakdown for receipt display
        const discountBreakdown = {
          promoDiscount: promoDiscountAmount,
          membershipDiscount,
          streakDiscount,
          membershipType: originalDiscounts?.membershipType || null,
          streakRides: originalDiscounts?.streakRides || 0,
          streakPct: originalDiscounts?.streakPct || 0,
          platformSubsidy,
        };

        const updatedFare = await tx.booking.update({
          where: { id: booking.id },
          data: {
            actualDuration: actualDurationMinutes,
            actualDistance: actualDistanceKm,
            pricingBreakdown: {
              ...(typeof fare.breakdown === 'object' && fare.breakdown ? (fare.breakdown as any) : {}),
              actualDurationMinutes,
              actualDistanceKm: Math.round(actualDistanceKm * 100) / 100,
              experiencedDriverFee,
              discounts: discountBreakdown,
              platformSubsidy,
            } as any,
            totalAmount: payableTotal,
            discountAmount,
            platformCommission,
            driverEarnings,
          } as any,
          select: {
            id: true,
            customerId: true,
            driverId: true,
            paymentMethod: true,
            paymentStatus: true,
            tripType: true,       // ←← CRITICAL: needed for correct platform fee (ONE_WAY=₹10, ROUND_TRIP=₹20, OUTSTATION=₹30)
            totalAmount: true,
            discountAmount: true,
            platformCommission: true,
            driverEarnings: true,
            pricingBreakdown: true,
          },
        });

        if (updatedStatus.promoCodeId) {
          await tx.promotionRedemption.updateMany({
            where: { bookingId: booking.id, promotionId: updatedStatus.promoCodeId },
            data: { discountAmount: new Prisma.Decimal(promoDiscountAmount) } as any,
          });
        }

        // CASH trips: do NOT auto-mark as PAID at completion.\n        // Cash payment should be confirmed via \"Collect Cash\" or QR scan.\n        // This was previously auto-marking CASH as PAID which broke the QR flow.

        return updatedFare as any;
      });
    }

    if (params.status === BookingStatus.COMPLETED) {
      const finalBooking = completedBooking || booking;

      if (finalBooking.driverId) {
        // Only mark driver available and increment trip count.
        // Do NOT credit wallet here — that happens when payment is actually confirmed:
        //   • verifyPayment() / webhook → creditDriverForBooking() (online payment)
        //   • collectCash() → no wallet credit (driver has physical cash)
        //   • payBookingWithWallet() → inline credit (wallet payment)
        await prisma.driverProfile.update({
          where: { userId: finalBooking.driverId },
          data: {
            isAvailable: true,
            totalTrips: { increment: 1 },
          } as any,
        });

        // Deduct platform fee from driver wallet at trip completion
        // ONE_WAY=₹10, ROUND_TRIP=₹20, OUTSTATION=₹30 (regardless of sub-type)
        const tripTypeForFee = String((finalBooking as any).tripType || 'ONE_WAY').toUpperCase();
        DriverWalletService.deductPlatformFee(
          String(finalBooking.driverId),
          params.bookingId,
          tripTypeForFee,
        ).catch((err: any) => {
          logger.warn('[Booking] Platform fee deduction failed (non-critical)', { bookingId: params.bookingId, error: err?.message });
        });
      }

      try {
        const io = getSocketServer();
        io.to(`booking:${params.bookingId}`).emit('booking:fare-updated', {
          bookingId: params.bookingId,
          totalAmount: Number((finalBooking as any).totalAmount || 0),
          discountAmount: Number((finalBooking as any).discountAmount || 0),
          pricingBreakdown: (finalBooking as any).pricingBreakdown ?? null,
        });
        io.to(`user:${finalBooking.customerId}`).emit('booking:fare-updated', {
          bookingId: params.bookingId,
          totalAmount: Number((finalBooking as any).totalAmount || 0),
        });
        if (finalBooking.driverId) {
          io.to(`user:${finalBooking.driverId}`).emit('booking:fare-updated', {
            bookingId: params.bookingId,
            totalAmount: Number((finalBooking as any).totalAmount || 0),
          });
        }
      } catch (error) {
        logger.warn('Failed to emit booking:fare-updated', { error, bookingId: params.bookingId });
      }
    }

    if (params.status === BookingStatus.COMPLETED) {
      InvoiceService.ensureInvoiceForBooking({ bookingId: params.bookingId }).catch((error) => {
        logger.warn('Invoice generation failed', { error, bookingId: params.bookingId });
      });

      // Award reward coins to the customer for completing a ride
      const finalBookingForRewards = completedBooking || booking;
      const fareForRewards = Number((finalBookingForRewards as any).totalAmount || 0);
      if (finalBookingForRewards.customerId && fareForRewards > 0) {
        RewardsService.awardRideCoins(
          finalBookingForRewards.customerId,
          params.bookingId,
          fareForRewards,
        ).then((coins) => {
          if (coins > 0) {
            logger.info('Reward coins awarded', {
              customerId: finalBookingForRewards.customerId,
              bookingId: params.bookingId,
              coins,
            });
          }
        }).catch((error) => {
          logger.warn('Failed to award reward coins', { error, bookingId: params.bookingId });
        });
      }

      // Process referral reward if this is a referred user's first trip
      const finalBookingForReferral = completedBooking || booking;
      // Check customer referral
      ReferralService.processFirstTripReward(finalBookingForReferral.customerId, params.bookingId).catch((error) => {
        logger.warn('Failed to process customer referral reward', { error, bookingId: params.bookingId });
      });
      // Check driver referral
      if (finalBookingForReferral.driverId) {
        ReferralService.processFirstTripReward(finalBookingForReferral.driverId, params.bookingId).catch((error) => {
          logger.warn('Failed to process driver referral reward', { error, bookingId: params.bookingId });
        });
      }
    }

    // ── Socket events ──
    const io = getSocketServer();

    // Build status payload
    const statusPayload: any = {
      bookingId: params.bookingId,
      status: params.status,
    };

    io.to(`booking:${params.bookingId}`).emit('booking:status', statusPayload);

    io.to(`user:${booking.customerId}`).emit('booking:status', statusPayload);
    if (booking.driverId) {
      io.to(`user:${booking.driverId}`).emit('booking:status', {
        bookingId: params.bookingId,
        status: params.status,
      });
    }

    // Push notification for trip completion (placed here so completedBooking is available)
    if (params.status === BookingStatus.COMPLETED) {
      try {
        const finalBookingPush = completedBooking || booking;
        const fare = Number((finalBookingPush as any).totalAmount || 0);
        const fareText = fare > 0 ? ` Total fare: ₹${fare.toFixed(0)}` : '';
        // Notify customer
        await sendPushWithRetry({
          userIds: [String(booking.customerId)],
          title: '✅ Trip completed!',
          body: `Your trip has been completed.${fareText} Thank you for riding with DriveGaadi!`,
          data: { kind: 'booking_status', bookingId: String(params.bookingId), status: 'COMPLETED' },
        });
        // Notify driver
        if (booking.driverId) {
          const driverEarnings = Number((finalBookingPush as any).driverEarnings || 0);
          const earningsText = driverEarnings > 0 ? ` Earnings: ₹${driverEarnings.toFixed(0)}` : '';
          await sendPushWithRetry({
            userIds: [String(booking.driverId)],
            title: '✅ Trip completed!',
            body: `Trip completed successfully.${earningsText}`,
            data: { kind: 'booking_status', bookingId: String(params.bookingId), status: 'COMPLETED' },
          });
        }
      } catch (completePushErr) {
        logger.warn('Failed to send completion push notification', { error: completePushErr, bookingId: params.bookingId });
      }
    }

    invalidateBookingCaches([booking.customerId, booking.driverId]);
    return { bookingId: params.bookingId, status: params.status };
  };

  static cancelBooking = async (params: {
    bookingId: string;
    userId: string;
    cancelledBy: CancelledBy;
    reason?: string;
  }) => {
    const booking = (await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: {
        id: true,
        customerId: true,
        driverId: true,
        status: true,
        bookingNumber: true,
        driverTravelDistanceKm: true,
        pickupLocationLat: true,
        pickupLocationLng: true,
        pickupAddress: true,
        dropLocationLat: true,
        dropLocationLng: true,
        dropAddress: true,
        tripType: true,
        vehicleType: true,
        totalAmount: true,
        estimatedDistance: true,
        estimatedDuration: true,
        pricingBreakdown: true,
        rejectedDriverIds: true,
      },
    } as any)) as any;

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    const isCustomer = booking.customerId === params.userId;
    const isDriver = booking.driverId === params.userId;

    if (!isCustomer && !isDriver) {
      throw new AppError('Not authorized for this booking', 403);
    }

    if (booking.status === BookingStatus.CANCELLED || booking.status === BookingStatus.COMPLETED) {
      throw new AppError('Booking cannot be cancelled', 409);
    }

    const preStartDriverStatuses: BookingStatus[] = [
      BookingStatus.ACCEPTED,
      BookingStatus.DRIVER_ARRIVING,
      BookingStatus.ARRIVED,
    ];

    const isDriverPreStartCancel =
      params.cancelledBy === CancelledBy.DRIVER && isDriver && preStartDriverStatuses.includes(booking.status as BookingStatus);

    if (isDriverPreStartCancel) {
      const cancelledDriverId = booking.driverId as string;
      const nextRejected = Array.isArray((booking as any).rejectedDriverIds) ? ([...(booking as any).rejectedDriverIds] as string[]) : [];
      if (!nextRejected.includes(cancelledDriverId)) {
        nextRejected.push(cancelledDriverId);
      }

      await prisma.booking.update({
        where: { id: params.bookingId },
        data: {
          status: BookingStatus.SEARCHING,
          matchAttempts: 0,
          driverId: null,
          acceptedAt: null,
          arrivedAt: null,
          startedAt: null,
          completedAt: null,
          driverTravelDistanceKm: 0 as any,
          otp: null,
          cancelledAt: null,
          cancelledBy: null,
          cancellationReason: null,
          rejectedDriverIds: nextRejected,
        } as any,
      });

      await prisma.driverProfile.update({
        where: { userId: cancelledDriverId },
        data: { isAvailable: true } as any,
      });

      const io = getSocketServer();

      io.to(`booking:${params.bookingId}`).emit('booking:status', {
        bookingId: params.bookingId,
        status: BookingStatus.SEARCHING,
      });

      io.to(`user:${booking.customerId}`).emit('booking:status', {
        bookingId: params.bookingId,
        status: BookingStatus.SEARCHING,
      });

      io.to(`user:${cancelledDriverId}`).emit('booking:cancelled', {
        bookingId: params.bookingId,
        cancelledBy: CancelledBy.DRIVER,
        reason: params.reason,
      });

      // Push notification to customer: driver cancelled, searching for new driver
      try {
        await sendExpoPushNotification({
          userIds: [String(booking.customerId)],
          title: '🔄 Finding a new driver',
          body: 'Your previous driver cancelled. We are searching for another driver for you.',
          data: { kind: 'booking_driver_cancelled', bookingId: String(params.bookingId) },
        });
      } catch { }

      io.to('online-drivers').emit('booking:offer', {
        bookingId: params.bookingId,
        tripType: (booking as any).tripType ?? undefined,
        requestedHours:
          typeof (booking as any).pricingBreakdown === 'object' && (booking as any).pricingBreakdown
            ? (() => {
              const raw =
                ((booking as any).pricingBreakdown as any).packageHours ?? ((booking as any).pricingBreakdown as any).durationHours;
              const hours = Number(raw);
              return Number.isFinite(hours) && hours > 0 ? hours : undefined;
            })()
            : undefined,
        outstationTripType:
          typeof (booking as any).pricingBreakdown === 'object' && (booking as any).pricingBreakdown
            ? ((booking as any).pricingBreakdown as any).outstationTripType
            : undefined,
        pickup: {
          latitude: Number((booking as any).pickupLocationLat),
          longitude: Number((booking as any).pickupLocationLng),
          address: (booking as any).pickupAddress,
        },
        drop:
          (booking as any).dropLocationLat && (booking as any).dropLocationLng
            ? {
              latitude: Number((booking as any).dropLocationLat),
              longitude: Number((booking as any).dropLocationLng),
              address: (booking as any).dropAddress,
            }
            : null,
        // Driver sees their FULL earnings (platform absorbs discounts)
        fare: Number((booking as any).driverEarnings),
        customerFare: Number((booking as any).totalAmount), // what customer pays
        platformSubsidy: Number(((booking as any).pricingBreakdown as any)?.platformSubsidy ?? 0),
        vehicleType: (booking as any).vehicleType ?? undefined,
        transmissionType: (booking as any).transmissionType ?? undefined,
        distanceKm: typeof (booking as any).estimatedDistance === 'number' ? Number((booking as any).estimatedDistance) : undefined,
        etaMin: typeof (booking as any).estimatedDuration === 'number' ? Number((booking as any).estimatedDuration) : undefined,
        createdAt: new Date().toISOString(),
      });

      invalidateBookingCaches([booking.customerId, booking.driverId]);
      return { bookingId: params.bookingId, reopened: true };
    }

    await prisma.booking.update({
      where: { id: params.bookingId },
      data: {
        status: BookingStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledBy: params.cancelledBy,
        cancellationReason: params.reason,
      } as any,
    });

    // Driver compensation rule: if customer cancels after driver has traveled >= 5km
    // auto-credit ₹30 to driver's wallet
    try {
      const shouldConsiderRefund =
        params.cancelledBy === CancelledBy.CUSTOMER &&
        Boolean(booking.driverId) &&
        ([
          BookingStatus.ACCEPTED,
          BookingStatus.DRIVER_ARRIVING,
          BookingStatus.ARRIVED,
          BookingStatus.STARTED,
          BookingStatus.IN_PROGRESS,
        ] as any[]).includes(booking.status as any);

      if (shouldConsiderRefund) {
        const travelKm = booking.driverTravelDistanceKm ? Number(booking.driverTravelDistanceKm) : 0;
        if (Number.isFinite(travelKm) && travelKm >= 5) {
          const driverId = String(booking.driverId);
          const compensationAmount = 30;

          // Credit driver wallet directly
          await prisma.driverProfile.update({
            where: { userId: driverId },
            data: {
              pendingEarnings: { increment: compensationAmount },
              totalEarnings: { increment: compensationAmount },
            } as any,
          });

          const io = getSocketServer();

          // Store notification for driver
          await prisma.notification.create({
            data: {
              userId: driverId,
              type: 'SYSTEM' as any,
              title: 'Cancellation Compensation',
              body: `₹${compensationAmount} credited to your wallet — customer cancelled after you traveled ${travelKm.toFixed(1)} km`,
              data: {
                kind: 'driver_cancellation_credit',
                bookingId: booking.id,
                amount: compensationAmount,
                travelKm,
              } as any,
            },
          });

          // Real-time socket notification
          io.to(`user:${driverId}`).emit('wallet:updated', {
            bookingId: booking.id,
            amount: compensationAmount,
            reason: 'cancellation_compensation',
            message: `₹${compensationAmount} credited — customer cancelled after ${travelKm.toFixed(1)} km travel`,
          });

          // Push notification to driver
          await sendExpoPushNotification({
            userIds: [driverId],
            title: '💰 ₹30 Credited to Wallet',
            body: `Customer cancelled after you traveled ${travelKm.toFixed(1)} km. ₹${compensationAmount} has been added to your wallet.`,
            data: { kind: 'driver_cancellation_credit', bookingId: String(booking.id), amount: String(compensationAmount) },
          });

          logger.info('Driver cancellation compensation credited', {
            driverId,
            bookingId: booking.id,
            amount: compensationAmount,
            travelKm,
          });
        }
      }
    } catch {
    }

    if (booking.driverId) {
      await prisma.driverProfile.update({
        where: { userId: booking.driverId },
        data: { isAvailable: true } as any,
      });
    }

    // Refund customer wallet if booking was paid via wallet
    WalletService.refundBookingWallet({ bookingId: params.bookingId }).catch((err: any) => {
      logger.warn('[Booking] Wallet refund failed on cancellation', { bookingId: params.bookingId, error: err?.message });
    });

    const io = getSocketServer();
    io.to(`booking:${params.bookingId}`).emit('booking:cancelled', {
      bookingId: params.bookingId,
      cancelledBy: params.cancelledBy,
      reason: params.reason,
    });

    io.to(`user:${booking.customerId}`).emit('booking:cancelled', {
      bookingId: params.bookingId,
      cancelledBy: params.cancelledBy,
    });

    if (booking.driverId) {
      io.to(`user:${booking.driverId}`).emit('booking:cancelled', {
        bookingId: params.bookingId,
        cancelledBy: params.cancelledBy,
      });
    }

    // Push notification to the other party about cancellation
    try {
      if (params.cancelledBy === CancelledBy.CUSTOMER && booking.driverId) {
        await sendExpoPushNotification({
          userIds: [String(booking.driverId)],
          title: '❌ Booking cancelled',
          body: 'The customer has cancelled the booking.',
          data: { kind: 'booking_cancelled', bookingId: String(params.bookingId), cancelledBy: 'CUSTOMER' },
        });
      } else if (params.cancelledBy === CancelledBy.DRIVER && booking.customerId) {
        await sendExpoPushNotification({
          userIds: [String(booking.customerId)],
          title: '❌ Booking cancelled',
          body: 'Your driver has cancelled the booking. Please try booking again.',
          data: { kind: 'booking_cancelled', bookingId: String(params.bookingId), cancelledBy: 'DRIVER' },
        });
      }
    } catch { }

    io.to('online-drivers').emit('booking:offer-removed', {
      bookingId: params.bookingId,
      reason: 'CANCELLED',
    });

    invalidateBookingCaches([booking.customerId, booking.driverId]);
    return { bookingId: params.bookingId };
  };

  static getBookingById = async (bookingId: string, userId: string) => {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        rating: {
          select: {
            id: true,
            rating: true,
            review: true,
            ratedById: true,
            ratedUserId: true,
            createdAt: true,
          },
        },
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            rating: true,
            profileImage: true,
          },
        },
        driver: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            rating: true,
            profileImage: true,
            createdAt: true,
            totalRatings: true,
            driverProfile: {
              select: {
                totalTrips: true,
              },
            },
          },
        },
      },
    });

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    if (booking.customerId !== userId && booking.driverId !== userId) {
      throw new AppError('Not authorized for this booking', 403);
    }

    if (booking.driverId === userId) {
      (booking as any).otp = null;
    }

    // Fetch driver's earned quiz badges separately (DriverBadge.driverId has no Prisma relation to User)
    // Also fetch totalTrips by counting completed bookings (driverProfile may not exist for all drivers)
    if ((booking as any).driver?.id) {
      const driverId = (booking as any).driver.id;
      // Always fetch the actual trip count — stored counter may be 0 for older drivers
      // who completed trips before the increment logic was added.
      try {
        const completedTripsCount = await prisma.booking.count({
          where: { driverId, status: BookingStatus.COMPLETED },
        });
        if (!(booking as any).driver.driverProfile) {
          (booking as any).driver.driverProfile = { totalTrips: completedTripsCount };
        } else {
          (booking as any).driver.driverProfile.totalTrips = completedTripsCount;
        }
      } catch (countErr) {
        logger.warn('Failed to count completed trips for driver profile', { driverId, error: countErr });
      }
      // Fetch earned quiz badges — separate try/catch so a badge error doesn't lose the trip count
      try {
        const driverBadges = await prisma.driverBadge.findMany({
          where: {
            driverId,
            badge: { isActive: true },
          },
          orderBy: { earnedAt: 'desc' },
          take: 3,
          select: {
            earnedAt: true,
            quizScore: true,
            badge: {
              select: {
                id: true,
                title: true,
                icon: true,
                color: true,
                category: true,
              },
            },
          },
        });
        (booking as any).driver.driverBadges = driverBadges;
      } catch (badgeErr) {
        logger.warn('Failed to fetch driver badges', { driverId, error: badgeErr });
        (booking as any).driver.driverBadges = [];
      }
    }


    (booking as any).customerRating = (booking as any).customerRating ?? null;
    (booking as any).customerReview = (booking as any).customerReview ?? null;
    (booking as any).driverRating = (booking as any).driverRating ?? null;
    (booking as any).driverReview = (booking as any).driverReview ?? null;

    return booking;
  };
}


export default BookingService;
