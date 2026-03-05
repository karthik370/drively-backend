import { Server, Socket } from 'socket.io';
import prisma from '../config/database';
import { redisClient } from '../config/redis';
import { logger } from '../utils/logger';
import { calculateDistance, calculateETA } from '../utils/mapUtils';
import { BookingStatus } from '@prisma/client';
import { MatchingService } from '../services/matching.service';

const BOOKING_CACHE_MS = 5000;
const ETA_THROTTLE_MS = 8000;
const LIVE_DISTANCE_THROTTLE_MS = 4000;
const USER_LAST_LOCATION_THROTTLE_MS = 15000;

const bookingCache = new Map<string, { ts: number; value: any }>();
const lastEtaTsByBooking = new Map<string, number>();
const lastDistanceTsByBooking = new Map<string, number>();
const lastUserLocationTsByDriver = new Map<string, number>();

const getCachedBooking = async (bookingId: string) => {
  const now = Date.now();
  const cached = bookingCache.get(bookingId);
  if (cached && now - cached.ts < BOOKING_CACHE_MS) return cached.value;

  const booking = (await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      customerId: true,
      tripType: true,
      pickupLocationLat: true,
      pickupLocationLng: true,
      dropLocationLat: true,
      dropLocationLng: true,
      status: true,
      actualDistance: true,
      driverTravelDistanceKm: true,
      pricingBreakdown: true,
    } as any,
  })) as any;

  if (booking) {
    bookingCache.set(bookingId, { ts: now, value: booking });
  }
  return booking;
};

const DRIVER_GEO_KEY = 'driver_locations';
const DRIVER_META_PREFIX = 'driver_location_meta:';

const setDriverGeo = async (driverId: string, latitude: number, longitude: number) => {
  try {
    if (redisClient.status !== 'ready') {
      return;
    }
    await redisClient.geoadd(DRIVER_GEO_KEY, longitude, latitude, driverId);
    await redisClient.setex(
      `${DRIVER_META_PREFIX}${driverId}`,
      180,
      JSON.stringify({ latitude, longitude, ts: Date.now() })
    );
  } catch (error) {
    logger.warn('Failed to update driver geo in Redis', { error, driverId });
  }
};

const removeDriverGeo = async (driverId: string) => {
  try {
    if (redisClient.status !== 'ready') {
      return;
    }
    await redisClient.zrem(DRIVER_GEO_KEY, driverId);
    await redisClient.del(`${DRIVER_META_PREFIX}${driverId}`);
  } catch (error) {
    logger.warn('Failed to remove driver geo in Redis', { error, driverId });
  }
};

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userType?: string;
}

const buildPendingDriverProfileCreate = (userId: string) => {
  const compactId = userId.replace(/-/g, '');
  const licenseNumber = `PEND-${compactId}`;
  const aadhaarNumber = `PEND-AAD-${compactId}`;
  const panNumber = `PEND${compactId.slice(0, 16)}`;

  return {
    userId,
    licenseNumber,
    licenseExpiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    licenseImageUrl: '',
    aadhaarNumber,
    aadhaarImageUrl: '',
    panNumber,
    panImageUrl: '',
    bankAccountNumber: '',
    bankIfscCode: '',
    bankAccountHolderName: '',
  };
};

export const registerLocationHandlers = (io: Server, socket: AuthenticatedSocket) => {
  socket.on('driver:online', async (data) => {
    if (socket.userType === 'DRIVER' || socket.userType === 'BOTH') {
      if (!socket.userId) return;
      try {
        const active = await prisma.booking.findFirst({
          where: {
            driverId: socket.userId,
            status: {
              in: [BookingStatus.ACCEPTED, BookingStatus.DRIVER_ARRIVING, BookingStatus.ARRIVED, BookingStatus.STARTED, BookingStatus.IN_PROGRESS],
            },
          },
          select: { id: true } as any,
        });
        const canAcceptNew = !active;

        const driverProfile = await prisma.driverProfile.upsert({
          where: { userId: socket.userId },
          create: {
            ...buildPendingDriverProfileCreate(socket.userId),
            isOnline: true,
            isAvailable: canAcceptNew,
            currentLatitude: data.latitude,
            currentLongitude: data.longitude,
            currentLocationLat: data.latitude,
            currentLocationLng: data.longitude,
          } as any,
          update: {
            isOnline: true,
            isAvailable: canAcceptNew,
            currentLatitude: data.latitude,
            currentLongitude: data.longitude,
            currentLocationLat: data.latitude,
            currentLocationLng: data.longitude,
          } as any,
          select: { isExperienced: true } as any,
        });

        socket.join('online-drivers');
        if ((driverProfile as any).isExperienced) {
          socket.join('experienced-drivers');
        }
        await setDriverGeo(socket.userId, Number(data.latitude), Number(data.longitude));
        logger.info(`Driver ${socket.userId} is now online`);

        if (canAcceptNew) {
          try {
            await MatchingService.kickoffMatchingForRecentPendingBookings();
          } catch {
          }
        }
      } catch (error) {
        logger.error('Failed to set driver online', { error, userId: socket.userId });
      }
    }
  });

  socket.on('driver:offline', async () => {
    if (socket.userType === 'DRIVER' || socket.userType === 'BOTH') {
      if (!socket.userId) return;
      try {
        await prisma.driverProfile.updateMany({
          where: { userId: socket.userId },
          data: { isOnline: false, isAvailable: false } as any,
        });

        socket.leave('online-drivers');
        socket.leave('experienced-drivers');
        await removeDriverGeo(socket.userId);
        logger.info(`Driver ${socket.userId} is now offline`);
      } catch (error) {
        logger.error('Failed to set driver offline', { error, userId: socket.userId });
      }
    }
  });

  socket.on('driver:location-update', async (data) => {
    if (socket.userType === 'DRIVER' || socket.userType === 'BOTH') {
      if (!socket.userId) return;
      try {
        const isAvailable = !data?.bookingId;
        await prisma.driverProfile.upsert({
          where: { userId: socket.userId },
          create: {
            ...buildPendingDriverProfileCreate(socket.userId),
            isOnline: true,
            isAvailable,
            currentLatitude: data.latitude,
            currentLongitude: data.longitude,
            currentLocationLat: data.latitude,
            currentLocationLng: data.longitude,
          } as any,
          update: {
            isOnline: true,
            isAvailable,
            currentLatitude: data.latitude,
            currentLongitude: data.longitude,
            currentLocationLat: data.latitude,
            currentLocationLng: data.longitude,
          } as any,
        });

        const nowUser = Date.now();
        const lastUserTs = lastUserLocationTsByDriver.get(String(socket.userId)) ?? 0;
        if (nowUser - lastUserTs >= USER_LAST_LOCATION_THROTTLE_MS) {
          lastUserLocationTsByDriver.set(String(socket.userId), nowUser);
          await prisma.user.update({
            where: { id: socket.userId },
            data: {
              lastLocationUpdate: new Date(),
            },
          });
        }

        await setDriverGeo(socket.userId, Number(data.latitude), Number(data.longitude));

        if (data.bookingId) {
          await prisma.location.create({
            data: {
              bookingId: data.bookingId,
              driverId: socket.userId,
              locationLat: data.latitude,
              locationLng: data.longitude,
              speed: data.speed,
              heading: data.heading,
              accuracy: data.accuracy,
              batteryLevel: data.batteryLevel,
            },
          });

          const payload = {
            bookingId: data.bookingId,
            latitude: data.latitude,
            longitude: data.longitude,
            speed: data.speed,
            heading: data.heading,
          };

          io.to(`booking:${data.bookingId}`).emit('driver:location-update', payload);

          // Keep backward compatibility for clients still listening to this event.
          io.to(`booking:${data.bookingId}`).emit('location:update', payload);

          // Throttle booking lookups and expensive ETA calls.
          const now = Date.now();
          const lastEta = lastEtaTsByBooking.get(String(data.bookingId)) ?? 0;
          const lastDist = lastDistanceTsByBooking.get(String(data.bookingId)) ?? 0;
          const shouldComputeEta = now - lastEta >= ETA_THROTTLE_MS;
          const shouldUpdateDistance = now - lastDist >= LIVE_DISTANCE_THROTTLE_MS;

          if (!shouldComputeEta && !shouldUpdateDistance) {
            return;
          }

          // Run heavier work async so location emits stay fast.
          void (async () => {
            try {
              const booking = await getCachedBooking(String(data.bookingId));
              if (!booking) return;

              if (booking.customerId) {
                io.to(`user:${booking.customerId}`).emit('location:update', payload);
                io.to(`user:${booking.customerId}`).emit('driver:location-update', payload);
              }

              const pickupLat = Number(booking.pickupLocationLat);
              const pickupLng = Number(booking.pickupLocationLng);
              const dropLat = booking.dropLocationLat ? Number(booking.dropLocationLat) : null;
              const dropLng = booking.dropLocationLng ? Number(booking.dropLocationLng) : null;
              const status = booking.status as BookingStatus;
              const target =
                (status === BookingStatus.STARTED || status === BookingStatus.IN_PROGRESS) && dropLat !== null && dropLng !== null
                  ? { latitude: dropLat, longitude: dropLng }
                  : { latitude: pickupLat, longitude: pickupLng };

              if (shouldComputeEta) {
                lastEtaTsByBooking.set(String(data.bookingId), Date.now());
                try {
                  const eta = await calculateETA({ latitude: data.latitude, longitude: data.longitude }, target);
                  const distanceKm = calculateDistance(data.latitude, data.longitude, target.latitude, target.longitude);

                  await prisma.booking.update({
                    where: { id: data.bookingId },
                    data: { currentETA: eta } as any,
                  });

                  io.to(`booking:${data.bookingId}`).emit('eta:update', { bookingId: data.bookingId, eta, distanceKm });
                  if (booking.customerId) {
                    io.to(`user:${booking.customerId}`).emit('eta:update', { bookingId: data.bookingId, eta, distanceKm });
                  }
                } catch (error) {
                  logger.warn('Failed to compute ETA for booking on socket location update', {
                    error,
                    bookingId: data.bookingId,
                    userId: socket.userId,
                  });
                }
              }

              const shouldTrackDriverTravel =
                status === BookingStatus.ACCEPTED ||
                status === BookingStatus.DRIVER_ARRIVING ||
                status === BookingStatus.ARRIVED ||
                status === BookingStatus.STARTED ||
                status === BookingStatus.IN_PROGRESS;

              if (shouldUpdateDistance && shouldTrackDriverTravel) {
                lastDistanceTsByBooking.set(String(data.bookingId), Date.now());
                try {
                  const lastTwo = await prisma.location.findMany({
                    where: { bookingId: data.bookingId },
                    orderBy: { timestamp: 'desc' },
                    select: { locationLat: true, locationLng: true },
                    take: 2,
                  });

                  let segmentKm = 0;
                  if (lastTwo.length === 2) {
                    const a = lastTwo[0];
                    const b = lastTwo[1];
                    segmentKm = calculateDistance(
                      Number(a.locationLat),
                      Number(a.locationLng),
                      Number(b.locationLat),
                      Number(b.locationLng)
                    );
                  }

                  const safeSegment = Number.isFinite(segmentKm) ? segmentKm : 0;
                  const prevTravelKm = booking.driverTravelDistanceKm ? Number(booking.driverTravelDistanceKm) : 0;
                  const nextTravelKm = Math.max(0, prevTravelKm + safeSegment);

                  const shouldUpdateActualTripDistance = status === BookingStatus.STARTED || status === BookingStatus.IN_PROGRESS;
                  const prevDistanceKm = booking.actualDistance ? Number(booking.actualDistance) : 0;
                  const liveTripDistanceKm = Math.max(0, prevDistanceKm + safeSegment);

                  await prisma.booking.update({
                    where: { id: data.bookingId },
                    data: {
                      driverTravelDistanceKm: nextTravelKm,
                      ...(shouldUpdateActualTripDistance ? { actualDistance: liveTripDistanceKm } : {}),
                    } as any,
                  });
                } catch (error) {
                  logger.warn('Failed to update live distance on socket location update', {
                    error,
                    bookingId: data.bookingId,
                    userId: socket.userId,
                  });
                }
              }
            } catch {
            }
          })();
        }
      } catch (error) {
        logger.error('Failed to process driver location update', { error, userId: socket.userId });
      }
    }
  });
};

export default registerLocationHandlers;
