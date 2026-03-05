import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';
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

      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      socket.userId = decoded.id;
      socket.userType = decoded.userType;
      
      next();
    } catch (error) {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    logger.info(`User connected: ${socket.userId}`);

    if (socket.userId) {
      socket.join(`user:${socket.userId}`);
    }

    registerLocationHandlers(io, socket);
    registerBookingHandlers(io, socket);
    registerSupportHandlers(io, socket);

    socket.on('disconnect', () => {
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
