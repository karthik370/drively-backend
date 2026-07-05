import { BookingStatus } from '@prisma/client';
import prisma from '../config/database';
import { logger } from '../utils/logger';
import { getSocketServer } from '../socket/io';
import { sendExpoPushNotification } from './expoPush.service';
import { redisClient } from '../config/redis';

// ── Constants ────────────────────────────────────────────────────────────────
const DRIVER_GEO_KEY = 'driver_locations';

// Wave radii — nearest drivers get the offer first
const WAVE_1_RADIUS_KM = 5;    // Wave 1 fallback radius when no nearest-driver data available
const WAVE_2_RADIUS_KM = 12;   // Wave 2: expand to 12km (after dynamic Wave 1)
// Wave 3: ALL online drivers via room broadcast (last resort)
// Wave delays: 25s → Wave 2, 55s → Wave 3 (adaptive based on nearest driver distance)

// ── Dedup guard: prevent duplicate broadcast for the same booking ─────────────
let lastKickoffRecentBookingsTs = 0;

const recentlyBroadcastBookings = new Set<string>();
const BROADCAST_DEDUP_TTL_MS = 60_000; // 60 seconds

// ── Per-driver push dedup ─────────────────────────────────────────────────────
// Tracks which (driver, booking) pairs have already received a push notification.
const notifiedDriverByBooking = new Map<string, Set<string>>(); // bookingId → Set<driverId>

const hasDriverBeenNotified = (bookingId: string, driverId: string): boolean =>
  notifiedDriverByBooking.get(bookingId)?.has(driverId) ?? false;

const markDriverNotified = (bookingId: string, driverIds: string[]): void => {
  if (!notifiedDriverByBooking.has(bookingId)) {
    notifiedDriverByBooking.set(bookingId, new Set());
    setTimeout(() => notifiedDriverByBooking.delete(bookingId), BROADCAST_DEDUP_TTL_MS);
  }
  const set = notifiedDriverByBooking.get(bookingId)!;
  driverIds.forEach(id => set.add(id));
};

const markAsBroadcast = (bookingId: string) => {
  recentlyBroadcastBookings.add(bookingId);
  setTimeout(() => recentlyBroadcastBookings.delete(bookingId), BROADCAST_DEDUP_TTL_MS);
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns driver IDs sorted by distance (nearest first) within radiusKm.
 * Uses Redis GEORADIUS — the same geo index drivers write their location to.
 * Returns [] if Redis is unavailable (caller falls back to broadcast).
 */
const getNearbyDriverIds = async (lat: number, lng: number, radiusKm: number): Promise<string[]> => {
  if (redisClient.status !== 'ready') return [];
  try {
    // 'ASC' = sorted nearest-first. Returns plain string[] (driverId values).
    const results = await redisClient.georadius(DRIVER_GEO_KEY, lng, lat, radiusKm, 'km', 'ASC');
    return (results as string[]).filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * Returns the distance in km to the nearest driver in the Redis geo pool.
 * Uses GEORADIUS WITHDIST to get the actual distance without a second call.
 * Returns null if Redis unavailable or no drivers within 50km.
 */
const getNearestDriverDistanceKm = async (lat: number, lng: number): Promise<number | null> => {
  if (redisClient.status !== 'ready') return null;
  try {
    // WITHDIST returns [[memberId, distStr], ...]
    const results = await (redisClient as any).georadius(
      DRIVER_GEO_KEY, lng, lat, 50, 'km', 'WITHDIST', 'ASC', 'COUNT', 1
    );
    if (!Array.isArray(results) || results.length === 0) return null;
    const entry = results[0];
    const distStr = Array.isArray(entry) ? entry[1] : null;
    const dist = Number(distStr);
    return Number.isFinite(dist) ? dist : null;
  } catch {
    return null;
  }
};

/** Returns true only if the booking is still waiting for a driver. */
const isBookingStillPending = async (bookingId: string): Promise<boolean> => {
  try {
    const b = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { driverId: true, status: true } as any,
    });
    return !!b && !(b as any).driverId && (b as any).status === BookingStatus.SEARCHING;
  } catch {
    return false;
  }
};

type WaveOfferParams = {
  bookingId: string;
  offerPayload: Record<string, unknown>;
  nearbyDriverIds: string[];      // from Redis geo, nearest-first
  rejectedDriverIds: string[];    // drivers who already rejected this booking
  requireExperienced: boolean;
  notifiedInSession: Set<string>; // shared Set mutated across waves (de-dup)
  waveName: string;               // for logging
  sendPush: boolean;
  pickupAddress?: string | null;
};

/**
 * Core wave helper.
 * Filters candidates → validates online status in DB → sends socket + push.
 * Uses individual `user:{id}` rooms instead of broadcasting to a shared room,
 * which keeps each emit O(1) and spreads the work across small batches.
 */
const sendWaveOffer = async (params: WaveOfferParams): Promise<void> => {
  const {
    bookingId, offerPayload, nearbyDriverIds, rejectedDriverIds,
    requireExperienced, notifiedInSession, waveName, sendPush, pickupAddress,
  } = params;

  const io = getSocketServer();

  // 1. Filter out: rejected + already notified this session/booking
  const candidates = nearbyDriverIds
    .filter(id => !rejectedDriverIds.includes(id))
    .filter(id => !notifiedInSession.has(id))
    .filter(id => !hasDriverBeenNotified(bookingId, id));

  if (candidates.length === 0) {
    logger.info(`[Matching] ${waveName}: no new candidates`, { bookingId });
    return;
  }

  // 2. Cross-reference with DB — driver must still be online + available in DB
  const onlineInDB = await prisma.driverProfile.findMany({
    where: {
      userId: { in: candidates },
      isOnline: true,
      isAvailable: true,
      ...(requireExperienced ? { isExperienced: true } : {}),
    },
    select: { userId: true },
  });
  const validIds = onlineInDB.map((d: any) => String(d.userId)).filter(Boolean);

  if (validIds.length === 0) {
    logger.info(`[Matching] ${waveName}: all candidates offline in DB`, { bookingId });
    return;
  }

  logger.info(`[Matching] ${waveName}: notifying ${validIds.length} drivers`, { bookingId, count: validIds.length });

  // 3. Send via each driver's personal socket room.
  //    This is O(n) but n is small (5-20 drivers per wave) instead of 200+.
  //    Nearest drivers receive the offer first.
  validIds.forEach(driverId => {
    io.to(`user:${driverId}`).emit('booking:offer', offerPayload);
    notifiedInSession.add(driverId);
  });
  markDriverNotified(bookingId, validIds);

  // 4. Push notification for drivers who may have the app in background
  if (sendPush) {
    sendExpoPushNotification({
      userIds: validIds,
      title: 'New booking request',
      body: pickupAddress ? `Pickup: ${String(pickupAddress)}` : 'Open the app to view booking details',
      data: { kind: 'booking_offer', bookingId: String(bookingId) },
    }).catch(() => { /* non-fatal */ });
  }
};

type BookingMatchingState = {
  driverId: string | null;
  status: BookingStatus;
  rejectedDriverIds?: string[];
};

export class MatchingService {

  static kickoffMatchingForRecentPendingBookings = async (params?: { maxAgeMinutes?: number; limit?: number }) => {
    const maxAgeMinutes = Number.isFinite(Number(params?.maxAgeMinutes)) ? Number(params?.maxAgeMinutes) : 15;
    const limit = Number.isFinite(Number(params?.limit)) ? Number(params?.limit) : 15;

    const now = Date.now();
    if (now - lastKickoffRecentBookingsTs < 5000) return;
    lastKickoffRecentBookingsTs = now;

    const since = new Date(now - maxAgeMinutes * 60 * 1000);
    const nowDate = new Date(now);
    const recent = await prisma.booking.findMany({
      where: {
        driverId: null,
        status: { in: [BookingStatus.REQUESTED, BookingStatus.SEARCHING] },
        OR: [{ scheduledTime: null }, { scheduledTime: { lte: nowDate } }],
        createdAt: { gte: since },
      } as any,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true } as any,
    });

    for (const b of recent) {
      const bookingId = String((b as any)?.id ?? '');
      if (!bookingId) continue;
      try {
        await MatchingService.startMatchingForBooking(bookingId);
      } catch (error) {
        logger.error('Failed to kickoff matching for booking', { error, bookingId });
      }
    }
  };

  static startMatchingForBooking = async (bookingId: string): Promise<void> => {
    // ── 1. Load booking ───────────────────────────────────────────────────────
    const booking: any = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        status: true,
        customerId: true,
        driverId: true,
        tripType: true,
        scheduledTime: true,
        pickupLocationLat: true,
        pickupLocationLng: true,
        pickupAddress: true,
        dropLocationLat: true,
        dropLocationLng: true,
        dropAddress: true,
        vehicleType: true,
        transmissionType: true,
        totalAmount: true,
        estimatedDistance: true,
        estimatedDuration: true,
        pricingBreakdown: true,
        rejectedDriverIds: true,
        matchAttempts: true,
        requireExperienced: true,
      } as any,
    });

    if (!booking || booking.driverId) return;

    if (booking.scheduledTime) {
      const st = new Date(booking.scheduledTime as any);
      if (Number.isFinite(st.getTime()) && st.getTime() > Date.now()) return;
    }

    if (booking.status !== BookingStatus.REQUESTED && booking.status !== BookingStatus.SEARCHING) return;

    const alreadyBroadcast = booking.status === BookingStatus.SEARCHING && Number((booking as any).matchAttempts || 0) > 0;
    if (alreadyBroadcast) return;

    if (recentlyBroadcastBookings.has(bookingId)) {
      logger.info('[Matching] Skipping duplicate broadcast for booking', { bookingId });
      return;
    }
    markAsBroadcast(bookingId);

    // ── 2. Mark booking as SEARCHING ─────────────────────────────────────────
    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.SEARCHING,
        matchAttempts: ((booking as any).matchAttempts || 0) + 1,
      } as any,
    });

    const pickupLat = Number(booking.pickupLocationLat);
    const pickupLng = Number(booking.pickupLocationLng);
    const rejectedDriverIds: string[] = Array.isArray(booking.rejectedDriverIds) ? booking.rejectedDriverIds : [];
    const requireExperienced = Boolean((booking as any).requireExperienced);

    // ── 3. Build offer payload (shared across all waves) ──────────────────────
    const offerPayload: Record<string, unknown> = {
      bookingId,
      distanceKm: typeof (booking as any).estimatedDistance === 'number' ? Number((booking as any).estimatedDistance) : undefined,
      etaMin: typeof (booking as any).estimatedDuration === 'number' ? Number((booking as any).estimatedDuration) : undefined,
      tripType: (booking as any).tripType ?? undefined,
      scheduledTime: (booking as any).scheduledTime ? new Date((booking as any).scheduledTime).toISOString() : undefined,
      requestedHours:
        typeof (booking as any).pricingBreakdown === 'object' && (booking as any).pricingBreakdown
          ? (() => {
            const raw =
              ((booking as any).pricingBreakdown as any).packageHours ??
              ((booking as any).pricingBreakdown as any).durationHours;
            const hours = Number(raw);
            return Number.isFinite(hours) && hours > 0 ? hours : undefined;
          })()
          : undefined,
      outstationTripType:
        typeof (booking as any).pricingBreakdown === 'object' && (booking as any).pricingBreakdown
          ? ((booking as any).pricingBreakdown as any).outstationTripType
          : undefined,
      pickup: {
        latitude: pickupLat,
        longitude: pickupLng,
        address: booking.pickupAddress,
      },
      drop:
        booking.dropLocationLat && booking.dropLocationLng
          ? {
            latitude: Number(booking.dropLocationLat),
            longitude: Number(booking.dropLocationLng),
            address: booking.dropAddress,
          }
          : null,
      fare: Number(booking.totalAmount),
      vehicleType: booking.vehicleType ?? undefined,
      transmissionType: (booking as any).transmissionType ?? undefined,
    };

    // ── 4. Shared dedup Set across all waves for this booking session ─────────
    // Passed by reference into setTimeout closures, so all 3 waves share it.
    const notifiedInSession = new Set<string>();

    // ── 5. Verify booking is still pending before starting waves ──────────────
    const latest = (await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { driverId: true, status: true, rejectedDriverIds: true } as any,
    })) as BookingMatchingState | null;

    if (!latest || latest.driverId || latest.status !== BookingStatus.SEARCHING) return;

    // ── 6. Favorite driver priority: notify before proximity waves ────────────
    try {
      const customerProfile = await prisma.customerProfile.findUnique({
        where: { userId: booking.customerId },
        select: { favoriteDriverIds: true },
      });
      const favIds = Array.isArray(customerProfile?.favoriteDriverIds) ? customerProfile.favoriteDriverIds : [];
      if (favIds.length > 0) {
        const onlineFavs = await prisma.driverProfile.findMany({
          where: {
            userId: { in: favIds },
            isOnline: true,
            isAvailable: true,
            ...(requireExperienced ? { isExperienced: true } : {}),
          },
          select: { userId: true },
        });
        const favDriverIds = onlineFavs.map((d: any) => String(d.userId)).filter(Boolean);
        if (favDriverIds.length > 0) {
          const io = getSocketServer();
          favDriverIds.forEach(driverId => {
            io.to(`user:${driverId}`).emit('booking:offer', offerPayload);
            notifiedInSession.add(driverId);
          });
          markDriverNotified(bookingId, favDriverIds);
          sendExpoPushNotification({
            userIds: favDriverIds,
            title: '⭐ Favorite customer booking!',
            body: booking.pickupAddress ? `Pickup: ${String(booking.pickupAddress)}` : 'A customer who favorited you needs a ride!',
            data: { kind: 'favorite_booking_offer', bookingId: String(bookingId) },
          }).catch(() => { /* non-fatal */ });
        }
      }
    } catch { /* non-fatal — favorites are best-effort */ }

    // ── 7. Smart Adaptive Wave Matching ─────────────────────────────────────────────────
    //
    // Strategy: find the NEAREST available driver's distance first, then set
    // Wave 1 radius to always include that driver (nearest distance + 2km buffer).
    // This eliminates the "wait 40s for Wave 2" delay when the nearest driver
    // is just outside the old fixed 5km radius.
    //
    //   Nearest driver at 1km  →  Wave 1 = 3km  (tight, fast)
    //   Nearest driver at 4km  →  Wave 1 = 6km  (includes him + buffer)
    //   Nearest driver at 9km  →  Wave 1 = 10km (max cap)
    //   No driver within 50km  →  Wave 1 = 5km fallback + immediate escalation

    const redisGeoAvailable = redisClient.status === 'ready';

    if (!redisGeoAvailable) {
      // Redis geo unavailable — fall back to safe room broadcast
      logger.info('[Matching] Redis unavailable — falling back to room broadcast', { bookingId });
      const fallbackRoom = requireExperienced ? 'experienced-drivers' : 'online-drivers';
      const io = getSocketServer();
      io.to(fallbackRoom).emit('booking:offer', offerPayload);
      await _pushAllOnline(bookingId, requireExperienced, notifiedInSession, booking.pickupAddress);
      return;
    }

    // Find nearest driver's actual distance
    const nearestKm = await getNearestDriverDistanceKm(pickupLat, pickupLng);

    // Dynamic Wave 1 radius: nearest driver distance + 2km buffer, clamped [3km, 10km]
    const dynamicWave1Km = nearestKm !== null
      ? Math.min(Math.max(nearestKm + 2, 3), 10)
      : WAVE_1_RADIUS_KM;

    logger.info(
      `[Matching] Nearest driver: ${nearestKm?.toFixed(1) ?? 'none'}km → Wave 1 radius = ${dynamicWave1Km}km`,
      { bookingId }
    );

    const wave1Drivers = await getNearbyDriverIds(pickupLat, pickupLng, dynamicWave1Km);

    if (wave1Drivers.length === 0) {
      // No drivers in dynamic radius — escalate immediately (no 25s wait)
      logger.info('[Matching] Wave 1 empty — escalating to Wave 2 immediately', { bookingId });

      const wave2Drivers = await getNearbyDriverIds(pickupLat, pickupLng, WAVE_2_RADIUS_KM);

      if (wave2Drivers.length === 0) {
        // Absolutely no drivers nearby — broadcast all online immediately
        logger.info('[Matching] Wave 2 also empty — broadcasting all online drivers now', { bookingId });
        const fallbackRoom = requireExperienced ? 'experienced-drivers' : 'online-drivers';
        const io = getSocketServer();
        io.to(fallbackRoom).emit('booking:offer', offerPayload);
        await _pushAllOnline(bookingId, requireExperienced, notifiedInSession, booking.pickupAddress);
        return;
      }

      // Wave 2 immediate (0-WAVE_2_RADIUS_KM km)
      await sendWaveOffer({
        bookingId, offerPayload,
        nearbyDriverIds: wave2Drivers,
        rejectedDriverIds, requireExperienced,
        notifiedInSession, waveName: `Wave 2-immediate (0-${WAVE_2_RADIUS_KM}km)`,
        sendPush: true, pickupAddress: booking.pickupAddress,
      });

      // Wave 3 (all) after 30s
      setTimeout(async () => {
        try {
          if (!(await isBookingStillPending(bookingId))) return;
          logger.info('[Matching] Wave 3 fallback broadcast (after immediate Wave 2)', { bookingId });
          const fallbackRoom = requireExperienced ? 'experienced-drivers' : 'online-drivers';
          const io = getSocketServer();
          io.to(fallbackRoom).emit('booking:offer', offerPayload);
          await _pushAllOnline(bookingId, requireExperienced, notifiedInSession, booking.pickupAddress);
        } catch (err) {
          logger.error('[Matching] Wave 3 error', { bookingId, err });
        }
      }, 30_000);

      return;
    }

    // ── Normal path: Wave 1 has drivers ───────────────────────────────────────
    logger.info(`[Matching] Wave 1 (0-${dynamicWave1Km}km): ${wave1Drivers.length} drivers`, { bookingId });

    await sendWaveOffer({
      bookingId, offerPayload,
      nearbyDriverIds: wave1Drivers,
      rejectedDriverIds, requireExperienced,
      notifiedInSession, waveName: `Wave 1 (0-${dynamicWave1Km}km)`,
      sendPush: true, pickupAddress: booking.pickupAddress,
    });

    // Wave 2: expand to WAVE_2_RADIUS_KM after 25s (reduced from 40s)
    setTimeout(async () => {
      try {
        if (!(await isBookingStillPending(bookingId))) return;
        const wave2Drivers = await getNearbyDriverIds(pickupLat, pickupLng, WAVE_2_RADIUS_KM);
        logger.info(`[Matching] Wave 2 (0-${WAVE_2_RADIUS_KM}km): ${wave2Drivers.length} candidates`, { bookingId });
        await sendWaveOffer({
          bookingId, offerPayload,
          nearbyDriverIds: wave2Drivers,
          rejectedDriverIds, requireExperienced,
          notifiedInSession, waveName: `Wave 2 (0-${WAVE_2_RADIUS_KM}km)`,
          sendPush: true, pickupAddress: booking.pickupAddress,
        });
      } catch (err) {
        logger.error('[Matching] Wave 2 error', { bookingId, err });
      }
    }, 25_000); // 25s (was 40s)

    // Wave 3: broadcast ALL after 55s total (was 80s)
    setTimeout(async () => {
      try {
        if (!(await isBookingStillPending(bookingId))) return;
        const fallbackRoom = requireExperienced ? 'experienced-drivers' : 'online-drivers';
        logger.info(`[Matching] Wave 3 fallback broadcast to "${fallbackRoom}"`, { bookingId });
        const io = getSocketServer();
        io.to(fallbackRoom).emit('booking:offer', offerPayload);
        await _pushAllOnline(bookingId, requireExperienced, notifiedInSession, booking.pickupAddress);
      } catch (err) {
        logger.error('[Matching] Wave 3 error', { bookingId, err });
      }
    }, 55_000); // 55s total (25 + 30)
  };
}

// ── Module-level push helper (used in fallback + Wave 3) ─────────────────────
async function _pushAllOnline(
  bookingId: string,
  requireExperienced: boolean,
  notifiedInSession: Set<string>,
  pickupAddress?: string | null,
): Promise<void> {
  try {
    const allOnline = await prisma.driverProfile.findMany({
      where: {
        isOnline: true,
        isAvailable: true,
        ...(requireExperienced ? { isExperienced: true } : {}),
      },
      select: { userId: true },
      take: 500,
    });
    const remainingIds = allOnline
      .map((d: any) => String(d.userId))
      .filter(Boolean)
      .filter(id => !notifiedInSession.has(id))
      .filter(id => !hasDriverBeenNotified(bookingId, id));

    if (remainingIds.length === 0) return;

    markDriverNotified(bookingId, remainingIds);
    await sendExpoPushNotification({
      userIds: remainingIds,
      title: 'New booking request',
      body: pickupAddress ? `Pickup: ${String(pickupAddress)}` : 'Open the app to view booking details',
      data: { kind: 'booking_offer', bookingId: String(bookingId) },
    });
  } catch { /* non-fatal */ }
}

export default MatchingService;
