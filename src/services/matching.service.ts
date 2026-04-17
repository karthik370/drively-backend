import { BookingStatus } from '@prisma/client';
import prisma from '../config/database';
import { logger } from '../utils/logger';
import { getSocketServer } from '../socket/io';
import { sendExpoPushNotification } from './expoPush.service';


let lastKickoffRecentBookingsTs = 0;

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
    if (now - lastKickoffRecentBookingsTs < 5000) {
      return;
    }
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

    if (!booking) {
      return;
    }

    if (booking.driverId) {
      return;
    }

    if (booking.scheduledTime) {
      const st = new Date(booking.scheduledTime as any);
      if (Number.isFinite(st.getTime()) && st.getTime() > Date.now()) {
        return;
      }
    }

    if (booking.status !== BookingStatus.REQUESTED && booking.status !== BookingStatus.SEARCHING) {
      return;
    }

    const alreadyBroadcast = booking.status === BookingStatus.SEARCHING && Number((booking as any).matchAttempts || 0) > 0;
    if (alreadyBroadcast) {
      return;
    }

    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.SEARCHING,
        matchAttempts: ((booking as any).matchAttempts || 0) + 1,
      } as any,
    });

    const pickupLat = Number(booking.pickupLocationLat);
    const pickupLng = Number(booking.pickupLocationLng);

    const io = getSocketServer();

    const latest = (await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { driverId: true, status: true, rejectedDriverIds: true } as any,
    })) as BookingMatchingState | null;

    if (!latest || latest.driverId || latest.status !== BookingStatus.SEARCHING) {
      return;
    }

    const requireExperienced = Boolean((booking as any).requireExperienced);
    const roomName = requireExperienced ? 'experienced-drivers' : 'online-drivers';

    logger.info(`Broadcasting booking offer to ${roomName}`, {
      bookingId,
      room: roomName,
    });

    io.to(roomName).emit('booking:offer', {
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
    });

    // ── Favorite driver priority: notify favorites first ──
    // Track notified IDs so they don't receive a second push below
    const alreadyNotifiedIds = new Set<string>();
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
          await sendExpoPushNotification({
            userIds: favDriverIds,
            title: '⭐ Favorite customer booking!',
            body: booking.pickupAddress ? `Pickup: ${String(booking.pickupAddress)}` : 'A customer who favorited you needs a ride!',
            data: { kind: 'favorite_booking_offer', bookingId: String(bookingId) },
          });
          // Mark these drivers as already notified — prevent duplicate push below
          favDriverIds.forEach((id: string) => alreadyNotifiedIds.add(id));
        }
      }
    } catch {
    }

    try {
      const online = await prisma.driverProfile.findMany({
        where: {
          isOnline: true,
          isAvailable: true,
          ...(requireExperienced ? { isExperienced: true } : {}),
        },
        select: { userId: true },
        take: 500,
      });
      // Exclude favourite drivers — they already received the priority notification above
      const driverIds = online
        .map((d: any) => String(d.userId))
        .filter(Boolean)
        .filter((id: string) => !alreadyNotifiedIds.has(id));
      if (driverIds.length) {
        await sendExpoPushNotification({
          userIds: driverIds,
          title: 'New booking request',
          body: booking.pickupAddress ? `Pickup: ${String(booking.pickupAddress)}` : 'Open the app to view booking details',
          data: { kind: 'booking_offer', bookingId: String(bookingId) },
        });
      }
    } catch {
    }
  };
}

export default MatchingService;
