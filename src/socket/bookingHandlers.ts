import { Server, Socket } from 'socket.io';
import prisma from '../config/database';
import { logger } from '../utils/logger';
import BookingService from '../services/booking.service';
import { calculateDistance } from '../utils/mapUtils';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userType?: string;
}

import { sendExpoPushNotification } from '../services/expoPush.service';

export const registerBookingHandlers = (io: Server, socket: AuthenticatedSocket) => {
  socket.on('booking:join', async (bookingId: string) => {
    socket.join(`booking:${bookingId}`);
    logger.info(`User ${socket.userId} joined booking room: ${bookingId}`);

    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: {
          status: true,
          currentETA: true,
          pickupLocationLat: true,
          pickupLocationLng: true,
          dropLocationLat: true,
          dropLocationLng: true,
          totalAmount: true,
          discountAmount: true,
          pricingBreakdown: true,
        } as any,
      });

      if (booking?.status) {
        socket.emit('booking:status', {
          bookingId,
          status: booking.status,
        });
      }

      if (booking && typeof (booking as any).totalAmount !== 'undefined') {
        socket.emit('booking:fare-updated', {
          bookingId,
          totalAmount: Number((booking as any).totalAmount || 0),
          discountAmount: Number((booking as any).discountAmount || 0),
          pricingBreakdown: (booking as any).pricingBreakdown,
        });
      }

      const latest = await prisma.location.findFirst({
        where: { bookingId },
        orderBy: { timestamp: 'desc' },
        select: { locationLat: true, locationLng: true, speed: true, heading: true },
      });

      if (latest && booking) {
        let distanceKm: number | undefined = undefined;

        const status = String((booking as any).status ?? '');
        const pickupLat = Number((booking as any).pickupLocationLat);
        const pickupLng = Number((booking as any).pickupLocationLng);
        const dropLatRaw = (booking as any).dropLocationLat;
        const dropLngRaw = (booking as any).dropLocationLng;
        const dropLat = dropLatRaw !== null && dropLatRaw !== undefined ? Number(dropLatRaw) : NaN;
        const dropLng = dropLngRaw !== null && dropLngRaw !== undefined ? Number(dropLngRaw) : NaN;

        const shouldGoToDrop = status === 'STARTED' || status === 'IN_PROGRESS' || status === 'COMPLETED';
        const target =
          shouldGoToDrop && Number.isFinite(dropLat) && Number.isFinite(dropLng)
            ? { latitude: dropLat, longitude: dropLng }
            : { latitude: pickupLat, longitude: pickupLng };

        const currentLat = Number(latest.locationLat);
        const currentLng = Number(latest.locationLng);
        if (
          Number.isFinite(currentLat) &&
          Number.isFinite(currentLng) &&
          Number.isFinite(target.latitude) &&
          Number.isFinite(target.longitude)
        ) {
          distanceKm = calculateDistance(currentLat, currentLng, target.latitude, target.longitude);
        }

        const storedEta = typeof (booking as any)?.currentETA === 'number' ? Number((booking as any).currentETA) : NaN;
        const fallbackEta =
          typeof distanceKm === 'number' && Number.isFinite(distanceKm)
            ? Math.max(1, Math.round((distanceKm / 30) * 60))
            : undefined;
        const eta = Number.isFinite(storedEta) ? storedEta : fallbackEta;

        if (typeof eta === 'number') {
          socket.emit('eta:update', {
            bookingId,
            eta,
            distanceKm,
          });
        }
      }

      if (latest) {
        socket.emit('location:update', {
          bookingId,
          latitude: Number(latest.locationLat),
          longitude: Number(latest.locationLng),
          speed: typeof latest.speed === 'number' ? latest.speed : undefined,
          heading: typeof latest.heading === 'number' ? latest.heading : undefined,
        });

        socket.emit('driver:location-update', {
          bookingId,
          latitude: Number(latest.locationLat),
          longitude: Number(latest.locationLng),
          speed: typeof latest.speed === 'number' ? latest.speed : undefined,
          heading: typeof latest.heading === 'number' ? latest.heading : undefined,
        });
      }
    } catch (error) {
      logger.warn('Failed to emit latest location on booking:join', { error, bookingId, userId: socket.userId });
    }
  });

  socket.on('booking:leave', (bookingId: string) => {
    socket.leave(`booking:${bookingId}`);
    logger.info(`User ${socket.userId} left booking room: ${bookingId}`);
  });

  socket.on('booking:accept', async (data: { bookingId: string }) => {
    if (!socket.userId) {
      return;
    }

    try {
      await BookingService.acceptBooking({ bookingId: data.bookingId, driverId: socket.userId });
    } catch (error) {
      logger.warn('booking:accept failed', { error, bookingId: data.bookingId, userId: socket.userId });
      socket.emit('booking:error', { bookingId: data.bookingId, message: 'Failed to accept booking' });
    }
  });

  socket.on('booking:reject', async (data: { bookingId: string }) => {
    if (!socket.userId) {
      return;
    }

    try {
      await BookingService.rejectBooking({ bookingId: data.bookingId, driverId: socket.userId });
    } catch (error) {
      logger.warn('booking:reject failed', { error, bookingId: data.bookingId, userId: socket.userId });
      socket.emit('booking:error', { bookingId: data.bookingId, message: 'Failed to reject booking' });
    }
  });

  socket.on('booking:cancel', async (data: { bookingId: string; reason?: string }) => {
    if (!socket.userId) {
      return;
    }

    try {
      const booking = await prisma.booking.findUnique({
        where: { id: data.bookingId },
        select: { customerId: true, driverId: true },
      });

      if (!booking) {
        socket.emit('booking:error', { bookingId: data.bookingId, message: 'Booking not found' });
        return;
      }

      const cancelledBy = booking.driverId === socket.userId ? 'DRIVER' : 'CUSTOMER';

      await BookingService.cancelBooking({
        bookingId: data.bookingId,
        userId: socket.userId,
        cancelledBy: cancelledBy as any,
        reason: data.reason,
      });
    } catch (error) {
      logger.warn('booking:cancel failed', { error, bookingId: data.bookingId, userId: socket.userId });
      socket.emit('booking:error', { bookingId: data.bookingId, message: 'Failed to cancel booking' });
    }
  });

  socket.on('chat:message', async (data: { bookingId: string; message: string; clientMessageId?: string }) => {
    const timestamp = new Date();
    io.to(`booking:${data.bookingId}`).emit('chat:message', {
      bookingId: data.bookingId,
      senderId: socket.userId,
      message: data.message,
      clientMessageId: data.clientMessageId,
      timestamp,
    });

    // Send push notification to the other party
    try {
      const booking = await prisma.booking.findUnique({
        where: { id: data.bookingId },
        select: { customerId: true, driverId: true },
      });
      if (booking) {
        const recipientId =
          socket.userId === booking.customerId
            ? booking.driverId
            : booking.customerId;
        if (recipientId) {
          await sendExpoPushNotification({
            userIds: [recipientId],
            title: 'New message',
            body: data.message.length > 80 ? data.message.slice(0, 80) + '…' : data.message,
            data: { kind: 'chat', bookingId: data.bookingId },
          });
        }
      }
    } catch (err) {
      logger.warn('Failed to send chat push notification', { error: err, bookingId: data.bookingId });
    }
  });
};

export default registerBookingHandlers;
