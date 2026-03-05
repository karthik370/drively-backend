import { Response } from 'express';
import prisma from '../config/database';
import { redisClient } from '../config/redis';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import {
  calculateDistance,
  calculateETA,
  geocodeAddress as geocodeAddressUtil,
  getRoute,
  reverseGeocode as reverseGeocodeUtil,
} from '../utils/mapUtils';
import { computeFare } from '../utils/pricing';
import { getSocketServer } from '../socket/io';
import { BookingStatus } from '@prisma/client';

const DRIVER_GEO_KEY = 'driver_locations';
const DRIVER_META_PREFIX = 'driver_location_meta:';

const toNumber = (value: unknown): number => {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return n;
};

const isFiniteNumber = (n: number) => Number.isFinite(n);

const validateLatLng = (latitude: number, longitude: number) => {
  if (!isFiniteNumber(latitude) || latitude < -90 || latitude > 90) {
    throw new AppError('Invalid latitude', 400);
  }
  if (!isFiniteNumber(longitude) || longitude < -180 || longitude > 180) {
    throw new AppError('Invalid longitude', 400);
  }
};

const setDriverGeo = async (driverId: string, latitude: number, longitude: number) => {
  if (redisClient.status !== 'ready') {
    throw new AppError('Redis unavailable', 503);
  }
  await redisClient.geoadd(DRIVER_GEO_KEY, longitude, latitude, driverId);
  await redisClient.setex(
    `${DRIVER_META_PREFIX}${driverId}`,
    180,
    JSON.stringify({ latitude, longitude, ts: Date.now() })
  );
};

// POST /api/v1/location/update
export const updateDriverLocation = asyncHandler(async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const driverId = req.user.id;

    const latitude = toNumber((req.body as any).latitude);
    const longitude = toNumber((req.body as any).longitude);
    const speed = toNumber((req.body as any).speed);
    const heading = toNumber((req.body as any).heading);
    const accuracy = toNumber((req.body as any).accuracy);
    const altitude = toNumber((req.body as any).altitude);
    const batteryLevel = (req.body as any).batteryLevel;
    const bookingId = (req.body as any).bookingId as string | undefined;

    validateLatLng(latitude, longitude);

    const driverProfile = await prisma.driverProfile.findUnique({
      where: { userId: driverId },
      select: { userId: true, isOnline: true },
    });

    if (!driverProfile) {
      throw new AppError('Driver profile not found', 404);
    }

    if (!driverProfile.isOnline) {
      throw new AppError('Driver is offline', 403);
    }

    await prisma.driverProfile.update({
      where: { userId: driverId },
      data: {
        currentLocationLat: latitude,
        currentLocationLng: longitude,
        currentSpeed: isFiniteNumber(speed) ? speed : undefined,
        currentHeading: isFiniteNumber(heading) ? heading : undefined,
        batteryLevel: typeof batteryLevel === 'number' ? batteryLevel : undefined,
      } as any,
    });

    await prisma.user.update({
      where: { id: driverId },
      data: { lastLocationUpdate: new Date() },
    });

    await setDriverGeo(driverId, latitude, longitude);

    if (bookingId) {
      await prisma.location.create({
        data: {
          bookingId,
          driverId,
          locationLat: latitude,
          locationLng: longitude,
          speed: isFiniteNumber(speed) ? speed : undefined,
          heading: isFiniteNumber(heading) ? heading : undefined,
          accuracy: isFiniteNumber(accuracy) ? accuracy : undefined,
          altitude: isFiniteNumber(altitude) ? altitude : undefined,
          batteryLevel: typeof batteryLevel === 'number' ? batteryLevel : undefined,
        },
      });

      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: {
          id: true,
          pickupLocationLat: true,
          pickupLocationLng: true,
          dropLocationLat: true,
          dropLocationLng: true,
          status: true,
          customerId: true,
          driverId: true,
          tripType: true,
          acceptedAt: true,
          startedAt: true,
          createdAt: true,
          pricingBreakdown: true,
          actualDistance: true,
        },
      });

      const io = getSocketServer();

      const payload = {
        bookingId,
        latitude,
        longitude,
        speed: isFiniteNumber(speed) ? speed : undefined,
        heading: isFiniteNumber(heading) ? heading : undefined,
      };

      io.to(`booking:${bookingId}`).emit('driver:location-update', payload);

      io.to(`booking:${bookingId}`).emit('location:update', payload);

      if (booking) {
        const pickupLat = Number(booking.pickupLocationLat);
        const pickupLng = Number(booking.pickupLocationLng);

        const dropLat = booking.dropLocationLat ? Number(booking.dropLocationLat) : null;
        const dropLng = booking.dropLocationLng ? Number(booking.dropLocationLng) : null;

        const target =
          (booking.status === BookingStatus.STARTED || booking.status === BookingStatus.IN_PROGRESS) &&
          dropLat !== null &&
          dropLng !== null
            ? { latitude: dropLat, longitude: dropLng }
            : { latitude: pickupLat, longitude: pickupLng };

        const eta = await calculateETA(
          { latitude, longitude },
          target
        );

        await prisma.booking.update({
          where: { id: bookingId },
          data: { currentETA: eta },
        });

        io.to(`booking:${bookingId}`).emit('eta:update', {
          bookingId,
          eta,
          distanceKm: calculateDistance(latitude, longitude, target.latitude, target.longitude),
        });

        io.to(`user:${booking.customerId}`).emit('eta:update', {
          bookingId,
          eta,
          distanceKm: calculateDistance(latitude, longitude, target.latitude, target.longitude),
        });

        if (booking.status === BookingStatus.STARTED || booking.status === BookingStatus.IN_PROGRESS) {
          const lastTwo = await prisma.location.findMany({
            where: { bookingId },
            orderBy: { timestamp: 'desc' },
            select: { locationLat: true, locationLng: true },
            take: 2,
          });

          let segmentKm = 0;
          if (lastTwo.length === 2) {
            const a = lastTwo[0];
            const b = lastTwo[1];
            segmentKm = calculateDistance(Number(a.locationLat), Number(a.locationLng), Number(b.locationLat), Number(b.locationLng));
          }

          const prevDistanceKm = booking.actualDistance ? Number(booking.actualDistance) : 0;
          const liveDistanceKm = Math.max(0, prevDistanceKm + (Number.isFinite(segmentKm) ? segmentKm : 0));

          await prisma.booking.update({
            where: { id: bookingId },
            data: { actualDistance: liveDistanceKm } as any,
          });
        }
      }
    }

    res.status(200).json({
      success: true,
      message: 'Location updated',
      data: {
        driverId,
        latitude,
        longitude,
      },
    });
  } catch (error) {
    logger.error('Failed to update driver location', { error });
    throw error;
  }
});

// GET /api/v1/location/nearby-drivers
export const getNearbyDrivers = asyncHandler(async (req: AuthRequest, res: Response) => {
  const latitude = toNumber(req.query.latitude);
  const longitude = toNumber(req.query.longitude);
  const radius = toNumber(req.query.radius);

  try {
    validateLatLng(latitude, longitude);
    const radiusKm = isFiniteNumber(radius) && radius > 0 ? radius : 5;

    type Nearby = { driverId: string; distance: number };

    let nearby: Nearby[] = [];

    if (redisClient.status !== 'ready') {
      throw new AppError('Redis unavailable', 503);
    }

    const results = (await redisClient.georadius(
      DRIVER_GEO_KEY,
      longitude,
      latitude,
      radiusKm,
      'km',
      'WITHDIST'
    )) as Array<[string, string]>;

    const candidates = results.map(([id, dist]) => ({ driverId: id, distance: Number(dist) }));

    const metaKeys = candidates.map((c) => `${DRIVER_META_PREFIX}${c.driverId}`);
    const metas = metaKeys.length ? await redisClient.mget(...metaKeys) : [];

    const usable: Nearby[] = [];

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const meta = metas[i];
      if (meta) {
        usable.push(candidate);
      } else {
        await redisClient.zrem(DRIVER_GEO_KEY, candidate.driverId);
      }
    }

    nearby = usable;

    let driverIds = nearby.map((n) => n.driverId);

    if (driverIds.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const requireVerifiedDocs =
      String(process.env.REQUIRE_VERIFIED_DRIVER_DOCS_FOR_NEARBY || '').trim() !== ''
        ? String(process.env.REQUIRE_VERIFIED_DRIVER_DOCS_FOR_NEARBY || '').trim().toLowerCase() === 'true'
        : process.env.NODE_ENV === 'production';

    const profiles = await prisma.driverProfile.findMany({
      where: {
        userId: { in: driverIds },
        isOnline: true,
        isAvailable: true,
        ...(requireVerifiedDocs ? { documentsVerified: true } : {}),
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            profileImage: true,
            rating: true,
          },
        },
      },
    });

    const distanceById = new Map<string, number>();
    nearby.forEach((n) => distanceById.set(n.driverId, n.distance));

    const response = profiles
      .map((p) => {
        const dist = distanceById.get(p.userId);
        const lat = p.currentLocationLat ? Number(p.currentLocationLat) : null;
        const lng = p.currentLocationLng ? Number(p.currentLocationLng) : null;

        if (dist === undefined || lat === null || lng === null) {
          return null;
        }

        return {
          id: p.userId,
          name: `${p.user.firstName} ${p.user.lastName}`,
          photo: p.user.profileImage,
          rating: Number(p.user.rating),
          distance: dist,
          location: { latitude: lat, longitude: lng },
        };
      })
      .filter(Boolean) as any[];

    response.sort((a, b) => a.distance - b.distance);

    return res.status(200).json({ success: true, data: response });
  } catch (error) {
    logger.error('Failed to get nearby drivers', { error });
    return res.status(200).json({ success: true, data: [] });
  }
});

// GET /api/v1/location/driver/:driverId
export const getDriverLocation = asyncHandler(async (req: AuthRequest, res: Response) => {
  const driverId = req.params.driverId;

  const profile = await prisma.driverProfile.findUnique({
    where: { userId: driverId },
    select: {
      userId: true,
      currentLocationLat: true,
      currentLocationLng: true,
      user: {
        select: {
          lastLocationUpdate: true,
        },
      },
    },
  });

  if (!profile) {
    throw new AppError('Driver not found', 404);
  }

  const latitude = profile.currentLocationLat ? Number(profile.currentLocationLat) : null;
  const longitude = profile.currentLocationLng ? Number(profile.currentLocationLng) : null;

  res.status(200).json({
    success: true,
    data: {
      driverId: profile.userId,
      currentLatitude: latitude,
      currentLongitude: longitude,
      lastLocationUpdate: profile.user.lastLocationUpdate,
    },
  });
});

// POST /api/v1/location/geocode
export const geocodeAddress = asyncHandler(async (req: AuthRequest, res: Response) => {
  const address = (req.body as any).address as string | undefined;
  if (!address || !address.trim()) {
    throw new AppError('Address is required', 400);
  }

  const result = await geocodeAddressUtil(address);

  res.status(200).json({
    success: true,
    data: {
      latitude: result.latitude,
      longitude: result.longitude,
      formatted_address: result.formattedAddress,
    },
  });
});

// POST /api/v1/location/reverse-geocode
export const reverseGeocodeLocation = asyncHandler(async (req: AuthRequest, res: Response) => {
  const latitude = toNumber((req.body as any).latitude);
  const longitude = toNumber((req.body as any).longitude);
  validateLatLng(latitude, longitude);

  const formatted = await reverseGeocodeUtil(latitude, longitude);

  res.status(200).json({
    success: true,
    data: { formatted_address: formatted },
  });
});

// POST /api/v1/location/route
export const calculateRoute = asyncHandler(async (req: AuthRequest, res: Response) => {
  const origin = (req.body as any).origin as { latitude: number; longitude: number } | undefined;
  const destination = (req.body as any).destination as { latitude: number; longitude: number } | undefined;

  if (!origin || !destination) {
    throw new AppError('Origin and destination are required', 400);
  }

  validateLatLng(origin.latitude, origin.longitude);
  validateLatLng(destination.latitude, destination.longitude);

  const route = await getRoute(origin, destination);

  const fare = computeFare({
    tripType: 'ONE_WAY',
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    requestedHours: 1,
    startTime: new Date(),
  });

  const breakdownOneWayCharge =
    typeof (fare.breakdown as any)?.oneWayCharge === 'number' ? Number((fare.breakdown as any).oneWayCharge) : null;

  res.status(200).json({
    success: true,
    data: {
      distance: route.distance,
      duration: route.duration,
      polyline: route.polyline,
      routeSource: route.routeSource,
      fallbackReason: route.fallbackReason,
      estimatedFare: fare.total,
      oneWayCharge: breakdownOneWayCharge,
    },
  });
});

// GET /api/v1/location/trip-history/:bookingId
export const getTripHistory = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    throw new AppError('Not authenticated', 401);
  }

  const bookingId = req.params.bookingId;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, customerId: true, driverId: true },
  });

  if (!booking) {
    throw new AppError('Booking not found', 404);
  }

  if (booking.customerId !== req.user.id && booking.driverId !== req.user.id) {
    throw new AppError('Not authorized to access this trip history', 403);
  }

  const points = await prisma.location.findMany({
    where: { bookingId },
    orderBy: { timestamp: 'asc' },
    select: {
      locationLat: true,
      locationLng: true,
      timestamp: true,
      speed: true,
      heading: true,
    },
  });

  res.status(200).json({
    success: true,
    data: points.map((p) => ({
      latitude: Number(p.locationLat),
      longitude: Number(p.locationLng),
      timestamp: p.timestamp,
      speed: p.speed ? Number(p.speed) : null,
      heading: p.heading ? Number(p.heading) : null,
    })),
  });
});

export default {
  updateDriverLocation,
  getNearbyDrivers,
  getDriverLocation,
  geocodeAddress,
  reverseGeocodeLocation,
  calculateRoute,
  getTripHistory,
};
