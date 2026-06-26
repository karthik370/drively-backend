import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import { logger } from '../utils/logger';
import { cacheGet } from '../config/redis';
import { registerLocationHandlers } from './locationHandlers';
import { registerBookingHandlers } from './bookingHandlers';
import { registerSupportHandlers } from './supportHandlers';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userType?: string;
}

export const initializeSocket = (io: Server) => {
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
      
      if (!token) {
        return next(new Error('Authentication error'));
      }

      // SECURITY: Check token blacklist (matches REST authenticate middleware)
      try {
        const blacklisted = await cacheGet(`blacklist:${token}`);
        if (blacklisted) {
          return next(new Error('Token has been revoked'));
        }
      } catch {
        // Redis unavailable — allow connection (graceful degradation)
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      socket.userId = decoded.id;
      socket.userType = decoded.userType;
      
      next();
    } catch (error) {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', async (socket: AuthenticatedSocket) => {
    logger.info(`User connected: ${socket.userId}`);

    if (socket.userId) {
      socket.join(`user:${socket.userId}`);
    }

    // ── Auto-restore online-drivers room membership after reconnect ──────────
    // When a driver's app goes to background, the socket may disconnect.
    // The backend DB still has isOnline=true (we never wipe it on disconnect).
    // On the next connection (reconnect by background task or app resume), we
    // check the DB and immediately re-add the driver to online-drivers so they
    // receive booking:offer socket events without needing to re-emit driver:online.
    if (socket.userId && (socket.userType === 'DRIVER' || socket.userType === 'BOTH')) {
      try {
        const profile = await prisma.driverProfile.findUnique({
          where: { userId: socket.userId },
          select: { isOnline: true, isExperienced: true } as any,
        });
        if ((profile as any)?.isOnline) {
          socket.join('online-drivers');
          if ((profile as any)?.isExperienced) {
            socket.join('experienced-drivers');
          }
          logger.info(`Driver ${socket.userId} auto-rejoined online-drivers room on reconnect`);
        }
      } catch (err) {
        logger.warn('Failed to auto-restore driver room membership', { err, userId: socket.userId });
      }
    }

    registerLocationHandlers(io, socket);
    registerBookingHandlers(io, socket);
    registerSupportHandlers(io, socket);

    socket.on('disconnect', () => {
      // NOTE: We intentionally do NOT mark the driver offline here.
      // The driver stays online in DB (isOnline=true) until they explicitly
      // press the Offline button in the app (which emits driver:offline).
      // The background location task will reconnect the socket and the
      // auto-rejoin logic above will restore their online-drivers room membership.
      logger.info(`User disconnected: ${socket.userId}`);
    });
  });

  return io;
};

export const emitToUser = (io: Server, userId: string, event: string, data: any) => {
  io.to(`user:${userId}`).emit(event, data);
};

export const emitToBooking = (io: Server, bookingId: string, event: string, data: any) => {
  io.to(`booking:${bookingId}`).emit(event, data);
};
