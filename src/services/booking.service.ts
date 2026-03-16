import { BookingStatus, CancelledBy, PaymentMethod, PaymentStatus, Prisma, TransmissionType, VehicleType } from '@prisma/client';
import prisma from '../config/database';
import { randomInt } from 'crypto';
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
        vehicleType: true,
        transmissionType: true,
        tripType: true,
        pricingBreakdown: true,
        estimatedDuration: true,
        rejectedDriverIds: true,
        requireExperienced: true,
      } as any,
    });

    const driverVehicleTypes = Array.isArray((driver as any)?.vehicleTypes) ? ((driver as any).vehicleTypes as VehicleType[]) : [];

    const items = bookings
      .map((b: any) => {
        const rejected = Array.isArray((b as any)?.rejectedDriverIds) ? ((b as any).rejectedDriverIds as string[]) : [];
        if (rejected.includes(params.driverId)) {
          return null;
        }

        const requireExperienced = Boolean((b as any).requireExperienced);
        const isExperienced = Boolean((driver as any).isExperienced);
        if (requireExperienced && !isExperienced) {
          const bookingTime = new Date((b as any).createdAt).getTime();
          const minutesElapsed = (Date.now() - bookingTime) / (1000 * 60);
          if (minutesElapsed < 15) {
            return null;
          }
        }

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
          fare: typeof b.totalAmount === 'number' ? Number(b.totalAmount) : Number(b.totalAmount || 0),
          vehicleType: b.vehicleType ?? undefined,
          transmissionType: (b as any).transmissionType ?? undefined,
          createdAt,
        };
      })
      .filter(Boolean) as any[];

    items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return items.slice(0, limit);
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
        paymentMethod: true,
        paymentStatus: true,
        createdAt: true,
        completedAt: true,
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
    const promoCode = (params.promoCode || '').trim();
    if (promoCode) {
      const user = await prisma.user.findUnique({ where: { id: params.customerId }, select: { userType: true } });
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
    const payableTotal = Math.max(0, Math.round((fare.total - discountAmount + experiencedDriverFee) * 100) / 100);

    const platformCommission = Math.round((payableTotal * commissionPercentage) / 100);
    const driverEarnings = Math.max(0, payableTotal - platformCommission);

    const discountBreakdown = {
      promoDiscount: promoDiscountAmount,
      membershipDiscount: memberDiscounts.membershipDiscount,
      streakDiscount: memberDiscounts.streakDiscount,
      membershipType: memberDiscounts.breakdown.membershipType,
      streakRides: memberDiscounts.breakdown.streakRides,
      streakPct: memberDiscounts.breakdown.streakPct,
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
          pricingBreakdown: { ...(fare.breakdown as any), discounts: discountBreakdown },
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
          fare: Number((booking as any).totalAmount),
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
      },
    });

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    if (booking.driverId && booking.driverId === params.driverId) {
      return { bookingId: params.bookingId };
    }

    if (booking.driverId) {
      throw new AppError('Booking already assigned', 409);
    }

    if (booking.status !== BookingStatus.SEARCHING && booking.status !== BookingStatus.REQUESTED) {
      throw new AppError('Booking is not available for acceptance', 409);
    }

    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');

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
        otp,
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

    await prisma.driverProfile.update({
      where: { userId: params.driverId },
      data: {
        isAvailable: false,
      } as any,
    });

    const io = getSocketServer();
    io.to(`booking:${params.bookingId}`).emit('booking:accepted', {
      bookingId: params.bookingId,
      driverId: params.driverId,
    });
    io.to(`user:${booking.customerId}`).emit('booking:accepted', {
      bookingId: params.bookingId,
      driverId: params.driverId,
      otp,
    });
    io.to(`user:${params.driverId}`).emit('booking:accepted', {
      bookingId: params.bookingId,
    });

    io.to('online-drivers').emit('booking:offer-removed', {
      bookingId: params.bookingId,
      reason: 'ACCEPTED',
    });

    try {
      const otpText = typeof otp === 'string' && otp.trim() ? ` OTP: ${otp.trim()}` : '';
      await sendExpoPushNotification({
        userIds: [String(booking.customerId)],
        title: 'Driver accepted',
        body: `A driver has accepted your booking.${otpText}`,
        data: {
          kind: 'booking_accepted',
          bookingId: String(params.bookingId),
          otp: typeof otp === 'string' ? otp : '',
        },
      });
    } catch {
    }

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
        otp: true,
      },
    });

    return { booking: acceptedBooking };
  };

  static getActiveBookingForUser = async (userId: string) => {
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
    const nowDate = new Date(nowMs);
    const booking = await prisma.booking.findFirst({
      where: {
        AND: [
          { OR: [{ customerId: userId }, { driverId: userId }] },
          {
            OR: [
              { status: { in: engagedStatuses } },
              {
                AND: [
                  { status: { in: pendingStatuses } },
                  { OR: [{ scheduledTime: null }, { scheduledTime: { lte: nowDate } }] },
                ],
              },
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

    if (!booking) return null;

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

      return null;
    }

    return BookingService.getBookingById(booking.id, userId);
  };

  static verifyBookingOtp = async (params: { bookingId: string; driverId: string; otp: string }) => {
    const booking = await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: {
        id: true,
        customerId: true,
        driverId: true,
        status: true,
        otp: true,
      },
    });

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    if (!booking.driverId || booking.driverId !== params.driverId) {
      throw new AppError('Not authorized for this booking', 403);
    }

    if (booking.status !== BookingStatus.ARRIVED) {
      throw new AppError('OTP can be verified only after arriving at pickup', 409);
    }

    const expectedOtp = typeof booking.otp === 'string' ? booking.otp : null;
    const providedOtp = String(params.otp || '').trim();

    if (!expectedOtp) {
      throw new AppError('OTP not available', 409);
    }

    if (expectedOtp !== providedOtp) {
      throw new AppError('Invalid OTP', 400);
    }

    await prisma.booking.update({
      where: { id: params.bookingId },
      data: {
        otp: null,
      },
    });

    const started = await BookingService.updateBookingStatus({
      bookingId: params.bookingId,
      userId: params.driverId,
      status: BookingStatus.STARTED,
    });

    const io = getSocketServer();
    io.to(`booking:${params.bookingId}`).emit('booking:otp-verified', {
      bookingId: params.bookingId,
    });
    io.to(`user:${booking.customerId}`).emit('booking:otp-verified', {
      bookingId: params.bookingId,
    });
    io.to(`user:${params.driverId}`).emit('booking:otp-verified', {
      bookingId: params.bookingId,
    });

    try {
      await sendExpoPushNotification({
        userIds: [String(booking.customerId)],
        title: 'OTP verified',
        body: 'OTP verified successfully. Your trip will start now.',
        data: { kind: 'booking_otp_verified', bookingId: String(params.bookingId) },
      });
    } catch {
    }

    return { bookingId: params.bookingId, verified: true, status: started.status };
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
      },
    });

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    const isCustomer = booking.customerId === params.userId;
    const isDriver = booking.driverId === params.userId;

    if (!isCustomer && !isDriver) {
      throw new AppError('Not authorized for this booking', 403);
    }

    if (params.status === BookingStatus.STARTED) {
      if (!isDriver) {
        throw new AppError('Only driver can start the trip', 403);
      }

      if (booking.status !== BookingStatus.ARRIVED) {
        throw new AppError('Trip can be started only after arriving at pickup', 409);
      }

      if (typeof booking.otp === 'string' && booking.otp.trim().length > 0) {
        throw new AppError('OTP verification required before starting the trip', 409);
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

    try {
      const next = params.status;
      if (next === BookingStatus.DRIVER_ARRIVING) {
        await sendExpoPushNotification({
          userIds: [String(booking.customerId)],
          title: 'Driver is on the way',
          body: 'Your driver is heading to your pickup location.',
          data: { kind: 'booking_status', bookingId: String(params.bookingId), status: 'DRIVER_ARRIVING' },
        });
      }

      if (next === BookingStatus.ARRIVED) {
        const otpText =
          typeof booking.otp === 'string' && booking.otp.trim() ? ` OTP: ${booking.otp.trim()}` : '';
        await sendExpoPushNotification({
          userIds: [String(booking.customerId)],
          title: 'Driver arrived',
          body: `Your driver has reached the pickup point. Please share OTP to start the trip.${otpText}`,
          data: {
            kind: 'booking_status',
            bookingId: String(params.bookingId),
            status: 'ARRIVED',
            otp: typeof booking.otp === 'string' ? booking.otp : '',
          },
        });
      }
    } catch {
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

        let discountAmount = 0;
        if (updatedStatus.promoCodeId) {
          const promo = await tx.promotion.findUnique({
            where: { id: updatedStatus.promoCodeId },
            select: { type: true, value: true, maxDiscount: true },
          });
          if (promo) {
            discountAmount = PromotionService.computeDiscount({
              type: promo.type,
              value: Number(promo.value),
              maxDiscount: promo.maxDiscount ? Number(promo.maxDiscount) : null,
              amount: fare.total,
            });
          }
        }

        const payableTotal = Math.max(0, Math.round((fare.total - discountAmount) * 100) / 100);
        const commissionPct = clamp(Number(process.env.COMMISSION_PERCENTAGE || 0), 0, 100);
        const platformCommission = Math.round((payableTotal * commissionPct) / 100);
        const driverEarnings = Math.max(0, payableTotal - platformCommission);

        const updatedFare = await tx.booking.update({
          where: { id: booking.id },
          data: {
            actualDuration: actualDurationMinutes,
            actualDistance: actualDistanceKm,
            pricingBreakdown: {
              ...(typeof fare.breakdown === 'object' && fare.breakdown ? (fare.breakdown as any) : {}),
              actualDurationMinutes,
              actualDistanceKm: Math.round(actualDistanceKm * 100) / 100,
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
            data: { discountAmount: new Prisma.Decimal(discountAmount) } as any,
          });
        }

        if (updatedFare.paymentMethod === PaymentMethod.CASH && updatedFare.paymentStatus !== PaymentStatus.PAID) {
          const payment = await tx.payment.create({
            data: {
              bookingId: updatedFare.id,
              userId: updatedFare.customerId,
              amount: updatedFare.totalAmount,
              paymentMethod: PaymentMethod.CASH,
              status: PaymentStatus.PAID,
              processedAt: new Date(),
              gatewayResponse: { purpose: 'BOOKING_CASH' } as any,
            },
            select: { id: true },
          });

          await tx.booking.update({
            where: { id: updatedFare.id },
            data: {
              paymentStatus: PaymentStatus.PAID,
              paymentId: payment.id,
            },
          });

          return { ...updatedFare, paymentStatus: PaymentStatus.PAID } as any;
        }

        return updatedFare as any;
      });
    }

    if (params.status === BookingStatus.COMPLETED) {
      const finalBooking = completedBooking || booking;

      if (finalBooking.driverId) {
        const earnings = Number((finalBooking as any).driverEarnings || 0);
        const isCash = (finalBooking as any).paymentMethod === PaymentMethod.CASH;

        await prisma.driverProfile.update({
          where: { userId: finalBooking.driverId },
          data: {
            isAvailable: true,
            totalTrips: { increment: 1 },
            // Only credit wallet for online payments — CASH is collected directly
            ...(isCash
              ? {}
              : {
                  totalEarnings: { increment: earnings },
                  pendingEarnings: { increment: earnings },
                }),
          } as any,
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


    const io = getSocketServer();
    io.to(`booking:${params.bookingId}`).emit('booking:status', {
      bookingId: params.bookingId,
      status: params.status,
    });

    io.to(`user:${booking.customerId}`).emit('booking:status', {
      bookingId: params.bookingId,
      status: params.status,
    });
    if (booking.driverId) {
      io.to(`user:${booking.driverId}`).emit('booking:status', {
        bookingId: params.bookingId,
        status: params.status,
      });
    }

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
        fare: Number((booking as any).totalAmount),
        vehicleType: (booking as any).vehicleType ?? undefined,
        transmissionType: (booking as any).transmissionType ?? undefined,
        distanceKm: typeof (booking as any).estimatedDistance === 'number' ? Number((booking as any).estimatedDistance) : undefined,
        etaMin: typeof (booking as any).estimatedDuration === 'number' ? Number((booking as any).estimatedDuration) : undefined,
        createdAt: new Date().toISOString(),
      });

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

    // Driver refund rule: if customer cancels after driver has traveled >= 5km (from ACCEPTED onward)
    // create a refund instruction for admin to pay driver ₹30.
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
          const driverProfile = await prisma.driverProfile.findUnique({
            where: { userId: driverId },
            include: {
              user: { select: { firstName: true, lastName: true, phoneNumber: true } },
            },
          });

          const upiId = typeof driverProfile?.upiId === 'string' ? driverProfile.upiId.trim() : '';
          if (upiId) {
            const refund = await (prisma as any).driverRefund.upsert({
              where: { bookingId: booking.id },
              create: {
                bookingId: booking.id,
                driverId,
                upiId,
                amount: 30 as any,
                status: 'PENDING' as any,
              } as any,
              update: {} as any,
              select: { id: true, amount: true },
            });

            const io = getSocketServer();

            // Notify driver
            await prisma.notification.create({
              data: {
                userId: driverId,
                type: 'SYSTEM' as any,
                title: 'Refund',
                body: 'You will be refunded with ₹30',
                data: {
                  kind: 'driver_refund_created',
                  bookingId: booking.id,
                  refundId: refund.id,
                  amount: Number(refund.amount),
                } as any,
              },
            });
            io.to(`user:${driverId}`).emit('driver:refund-created', {
              bookingId: booking.id,
              refundId: refund.id,
              amount: Number(refund.amount),
              message: 'You will be refunded with ₹30',
            });

            // Notify admins
            const raw = String(
              process.env.ADMIN_PHONE_NUMBERS ||
              process.env.ADMIN_PHONES ||
              process.env.ADMIN_PHONE ||
              process.env.ADMIN_ALLOWLIST ||
              ''
            ).trim();
            const allowedDigits = raw
              .split(/[\s,;]+/g)
              .map((v) => v.trim())
              .filter(Boolean)
              .map((v) => v.replace(/\D/g, ''))
              .map((d) => (d.length > 10 ? d.slice(-10) : d))
              .filter(Boolean);

            if (allowedDigits.length) {
              const adminUsers = await prisma.user.findMany({
                where: {
                  OR: allowedDigits.map((digits) => ({
                    phoneNumber: {
                      endsWith: digits,
                    },
                  })),
                },
                select: { id: true },
              });

              const adminIds = adminUsers.map((u) => String(u.id)).filter(Boolean);
              if (adminIds.length) {
                await prisma.notification.createMany({
                  data: adminIds.map((adminId) => ({
                    userId: adminId,
                    type: 'SYSTEM' as any,
                    title: 'Driver refund required',
                    body: `Pay ₹30 to driver (${driverProfile?.user?.firstName ?? ''} ${driverProfile?.user?.lastName ?? ''}) UPI: ${upiId}`.trim(),
                    data: {
                      kind: 'driver_refund_admin',
                      bookingId: booking.id,
                      bookingNumber: booking.bookingNumber,
                      refundId: refund.id,
                      driverId,
                      driverPhoneNumber: driverProfile?.user?.phoneNumber,
                      upiId,
                      amount: Number(refund.amount),
                    } as any,
                  })),
                });

                for (const adminId of adminIds) {
                  io.to(`user:${adminId}`).emit('admin:refund-created', {
                    bookingId: booking.id,
                    refundId: refund.id,
                    driverId,
                    upiId,
                    amount: Number(refund.amount),
                  });
                }
              }
            }
          }
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

    io.to('online-drivers').emit('booking:offer-removed', {
      bookingId: params.bookingId,
      reason: 'CANCELLED',
    });

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

    (booking as any).customerRating = (booking as any).customerRating ?? null;
    (booking as any).customerReview = (booking as any).customerReview ?? null;
    (booking as any).driverRating = (booking as any).driverRating ?? null;
    (booking as any).driverReview = (booking as any).driverReview ?? null;

    return booking;
  };
}

export default BookingService;
