import { Server, Socket } from 'socket.io';
import prisma from '../config/database';
import { redisClient } from '../config/redis';
import { logger } from '../utils/logger';
import { calculateDistance, calculateETA } from '../utils/mapUtils';
import { BookingStatus } from '@prisma/client';
import { MatchingService } from '../services/matching.service';
import { computeFare, normalizeTripType } from '../utils/pricing';

const BOOKING_CACHE_MS = 5000;
const ETA_THROTTLE_MS = 8000;
const LIVE_DISTANCE_THROTTLE_MS = 4000;
const USER_LAST_LOCATION_THROTTLE_MS = 15000;
const LIVE_FARE_THROTTLE_MS = 30000;

// ── Inactivity auto-offline ───────────────────────────────────────────────
const DRIVER_INACTIVITY_LIMIT_MS = 3 * 60 * 60 * 1000;  // 3 hours online with no booking
const INACTIVITY_CHECK_INTERVAL_MS = 5 * 60 * 1000;      // max one check per 5 min per driver
const DRIVER_ONLINE_SINCE_PREFIX = 'driver_online_since:';
// Per-driver throttle for the inactivity check (avoids a DB query every location update)
const lastInactivityCheckByDriver = new Map<string, number>();

const bookingCache = new Map<string, { ts: number; value: any }>();
const lastEtaTsByBooking = new Map<string, number>();
const lastDistanceTsByBooking = new Map<string, number>();
const lastUserLocationTsByDriver = new Map<string, number>();
const lastFareTsByBooking = new Map<string, number>();

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
      startedAt: true,
      totalAmount: true,
      driverEarnings: true,
      discountAmount: true,
      experiencedDriverFee: true,
      estimatedDistance: true,
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

/**
 * Auto-offline guard: forces a driver offline if they've been online for
 * DRIVER_INACTIVITY_LIMIT_MS (3h) with no active booking accepted.
 * Called from driver:location-update (throttled to once every 5 minutes).
 */
const checkAndAutoOffline = async (
  io: Server,
  socket: AuthenticatedSocket,
  driverId: string
): Promise<void> => {
  try {
    if (redisClient.status !== 'ready') return;

    const onlineSinceStr = await redisClient.get(`${DRIVER_ONLINE_SINCE_PREFIX}${driverId}`);
    if (!onlineSinceStr) return; // Key missing — can't determine — skip

    const onlineSince = Number(onlineSinceStr);
    if (!Number.isFinite(onlineSince)) return;

    const idleMs = Date.now() - onlineSince;
    if (idleMs < DRIVER_INACTIVITY_LIMIT_MS) return; // Still under 3 hours — fine

    // Has the driver accepted a booking recently? If so, reset the timer.
    const activeBooking = await prisma.booking.findFirst({
      where: {
        driverId,
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
      select: { id: true } as any,
    });

    if (activeBooking) {
      // Driver is actively on a trip — reset the online-since clock
      await redisClient.setex(`${DRIVER_ONLINE_SINCE_PREFIX}${driverId}`, 4 * 60 * 60, String(Date.now()));
      return;
    }

    const idleHours = (idleMs / 3_600_000).toFixed(1);
    logger.info(`[AutoOffline] Driver ${driverId} idle ${idleHours}h with no bookings — forcing offline`);

    // Force offline in DB
    await prisma.driverProfile.updateMany({
      where: { userId: driverId },
      data: { isOnline: false, isAvailable: false } as any,
    });

    // Remove from Redis geo pool
    socket.leave('online-drivers');
    socket.leave('experienced-drivers');
    await removeDriverGeo(driverId);
    await redisClient.del(`${DRIVER_ONLINE_SINCE_PREFIX}${driverId}`);

    // Notify the driver's app so the UI updates immediately
    io.to(`user:${driverId}`).emit('driver:force_offline', {
      reason: 'inactivity',
      message: `You were automatically taken offline after ${idleHours} hours of inactivity. Please go online again when you are ready to accept bookings.`,
    });

    logger.info(`[AutoOffline] Driver ${driverId} forced offline successfully`);
  } catch (err) {
    logger.warn('[AutoOffline] Error during inactivity check', { error: err, driverId });
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

        // Track when driver went online (for the 3-hour inactivity auto-offline check)
        if (redisClient.status === 'ready') {
          redisClient.setex(
            `${DRIVER_ONLINE_SINCE_PREFIX}${socket.userId}`,
            4 * 60 * 60,           // auto-expire after 4h (longer than the 3h limit)
            String(Date.now())
          ).catch(() => {});
        }

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

        // Clear inactivity tracking key
        if (redisClient.status === 'ready') {
          redisClient.del(`${DRIVER_ONLINE_SINCE_PREFIX}${socket.userId}`).catch(() => {});
        }

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

        // ── Throttled inactivity check ───────────────────────────────────────
        // Runs at most once every 5 minutes per driver to avoid DB queries on every GPS ping.
        const nowForCheck = Date.now();
        const lastCheck = lastInactivityCheckByDriver.get(socket.userId) ?? 0;
        if (nowForCheck - lastCheck > INACTIVITY_CHECK_INTERVAL_MS) {
          lastInactivityCheckByDriver.set(socket.userId, nowForCheck);
          void checkAndAutoOffline(io, socket, socket.userId);
        }

        // Ensure the socket is in online-drivers room.
        // This is the safety net for background reconnects: if the driver's socket
        // reconnected while the app was in background, the location update arrives
        // before driver:online is re-emitted. Re-joining here keeps them in the pool.
        if (isAvailable) {
          socket.join('online-drivers');
          const profileForRoom = await prisma.driverProfile.findUnique({
            where: { userId: socket.userId },
            select: { isExperienced: true } as any,
          });
          if ((profileForRoom as any)?.isExperienced) {
            socket.join('experienced-drivers');
          }
        }

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

                  // ── Live fare emit (throttled every 30s) ───────────────────
                  // Recompute fare from actual elapsed time + actual distance
                  // and push to both driver and customer in real time.
                  if (shouldUpdateActualTripDistance) {
                    const nowFare = Date.now();
                    const lastFareTs = lastFareTsByBooking.get(String(data.bookingId)) ?? 0;
                    if (nowFare - lastFareTs >= LIVE_FARE_THROTTLE_MS) {
                      lastFareTsByBooking.set(String(data.bookingId), nowFare);
                      try {
                        const startedAtRaw = (booking as any).startedAt;
                        const startedMs = startedAtRaw ? new Date(startedAtRaw).getTime() : 0;
                        const elapsedSeconds = startedMs > 0 ? Math.max(0, Math.round((nowFare - startedMs) / 1000)) : 0;
                        const actualKm = Math.max(0, liveTripDistanceKm);
                        const tripType = normalizeTripType((booking as any).tripType);
                        const pb = typeof (booking as any).pricingBreakdown === 'object' && (booking as any).pricingBreakdown
                          ? (booking as any).pricingBreakdown as any : {} as any;
                        const requestedHours = Number(pb?.packageHours ?? pb?.durationHours ?? 0) || undefined;

                        const liveFareResult = computeFare({
                          tripType,
                          distanceMeters: actualKm * 1000,
                          durationSeconds: elapsedSeconds,
                          requestedHours,
                          startTime: startedMs > 0 ? new Date(startedMs) : undefined,
                          isEstimate: false,
                          outstationTripType: pb?.outstationTripType ?? undefined,
                          outstationPlannedDistanceKm: Number(pb?.plannedDropDistanceKm ?? 0) || undefined,
                        });

                        // Apply discounts to get customer-facing total
                        const discountAmount = Number((booking as any).discountAmount ?? 0);
                        const experiencedDriverFee = Number((booking as any).experiencedDriverFee ?? 0);
                        const customerLiveFare = Math.max(0, Math.round((liveFareResult.total - discountAmount + experiencedDriverFee) * 100) / 100);
                        const driverLiveFare = Math.max(0, Math.round((liveFareResult.total + experiencedDriverFee) * 100) / 100);

                        const farePayload = {
                          bookingId: data.bookingId,
                          liveFare: customerLiveFare,
                          driverLiveFare,
                          baseFare: liveFareResult.total,
                          actualDistanceKm: Math.round(actualKm * 100) / 100,
                          elapsedSeconds,
                          breakdown: liveFareResult.breakdown,
                        };

                        io.to(`booking:${data.bookingId}`).emit('fare:live-update', farePayload);
                        if (booking.customerId) {
                          io.to(`user:${booking.customerId}`).emit('fare:live-update', farePayload);
                        }
                      } catch (fareErr) {
                        logger.warn('Failed to compute live fare', {
                          error: fareErr,
                          bookingId: data.bookingId,
                        });
                      }
                    }
                  }
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
