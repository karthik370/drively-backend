import { Server, Socket } from 'socket.io';
import prisma from '../config/database';
import { logger } from '../utils/logger';
import { sendExpoPushNotification } from '../services/expoPush.service';
import { isAdminPhone, getAdminUserIds } from '../utils/adminConfig';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userType?: string;
}

const supportRoom = (bookingId: string, threadUserId: string) =>
  `support:${bookingId}:${threadUserId}`;

/** True if the socket belongs to the admin */
const isAdminSocket = async (socket: AuthenticatedSocket): Promise<boolean> => {
  if (!socket.userId) return false;
  try {
    const user = await prisma.user.findUnique({
      where: { id: socket.userId },
      select: { phoneNumber: true },
    });
    return Boolean(user?.phoneNumber && isAdminPhone(user.phoneNumber));
  } catch {
    return false;
  }
};

/**
 * Resolve threadUserId for a support event.
 * - Admin WITH threadUserId in payload → use that (they're replying to a user's thread)
 * - Everyone else (including admin WITHOUT threadUserId) → use socket.userId
 *   This ensures regular users are NEVER misidentified and messages never get dropped.
 */
const resolveThreadUserId = (socket: AuthenticatedSocket, isAdminSender: boolean, payloadThreadUserId?: string): string => {
  if (isAdminSender && payloadThreadUserId) return String(payloadThreadUserId);
  return String(socket.userId ?? '');
};

export const registerSupportHandlers = (io: Server, socket: AuthenticatedSocket) => {
  // ── support:join ──────────────────────────────────────────────────────────
  socket.on('support:join', async (data: { bookingId: string; threadUserId?: string }) => {
    try {
      const bookingId = String(data?.bookingId ?? '');
      if (!socket.userId || !bookingId) return;

      const admin = await isAdminSocket(socket);
      const threadUserId = resolveThreadUserId(socket, admin, data?.threadUserId);
      if (!threadUserId) return;

      socket.join(supportRoom(bookingId, threadUserId));
      logger.info(`[SupportChat] ${socket.userId} joined room ${bookingId}:${threadUserId}`);
    } catch (e) {
      logger.error('[SupportChat] support:join error', { error: e });
    }
  });

  // ── support:leave ─────────────────────────────────────────────────────────
  socket.on('support:leave', async (data: { bookingId: string; threadUserId?: string }) => {
    try {
      const bookingId = String(data?.bookingId ?? '');
      if (!socket.userId || !bookingId) return;

      const admin = await isAdminSocket(socket);
      const threadUserId = resolveThreadUserId(socket, admin, data?.threadUserId);
      if (!threadUserId) return;

      socket.leave(supportRoom(bookingId, threadUserId));
      logger.info(`[SupportChat] ${socket.userId} left room ${bookingId}:${threadUserId}`);
    } catch (e) {
      logger.error('[SupportChat] support:leave error', { error: e });
    }
  });

  // ── support:message ───────────────────────────────────────────────────────
  socket.on(
    'support:message',
    async (data: { bookingId: string; threadUserId?: string; message: string; clientMessageId?: string }) => {
      try {
        const bookingId = String(data?.bookingId ?? '');
        const message = String(data?.message ?? '').trim();
        // Use null not undefined — Prisma Json fields silently drop undefined keys
        const clientMessageId = (typeof data?.clientMessageId === 'string' && data.clientMessageId)
          ? data.clientMessageId
          : null;

        if (!socket.userId || !bookingId || !message) {
          logger.warn('[SupportChat] support:message missing required field', {
            hasUserId: !!socket.userId, bookingId: !!bookingId, hasMessage: !!message,
          });
          return;
        }

        const isAdminSender = await isAdminSocket(socket);
        const threadUserId = resolveThreadUserId(socket, isAdminSender, data?.threadUserId);

        if (!threadUserId) {
          logger.error('[SupportChat] Could not resolve threadUserId', { senderId: socket.userId, bookingId });
          return;
        }

        logger.info(`[SupportChat] Message from ${socket.userId} isAdmin=${isAdminSender} threadUserId=${threadUserId} bookingId=${bookingId}`);

        // ── STEP 1: Persist to DB ──────────────────────────────────────────
        let adminIds: string[] = [];
        try {
          adminIds = await getAdminUserIds(prisma);
        } catch (e) {
          logger.warn('[SupportChat] getAdminUserIds failed', { error: e });
        }

        // Recipients: threadUser (customer/driver) + admin
        const recipients = Array.from(new Set([threadUserId, ...adminIds])).filter(Boolean);
        logger.info(`[SupportChat] Persisting to ${recipients.length} recipient(s): ${recipients.join(', ')}`);

        try {
          const result = await prisma.notification.createMany({
            data: recipients.map((recipientId) => ({
              userId: recipientId,
              type: 'SYSTEM' as any,
              title: 'Need Help',
              body: message,
              data: {
                kind: 'support_chat',
                bookingId,
                threadUserId,
                senderId: String(socket.userId),
                clientMessageId,
              },
            })),
          });
          logger.info(`[SupportChat] ✓ Stored ${result.count} notification(s)`);
        } catch (dbError) {
          logger.error('[SupportChat] ✗ DB write FAILED', { error: dbError, bookingId, threadUserId });
        }

        // ── STEP 2: Sender name (optional, non-blocking) ───────────────────
        let senderName = '';
        let senderRole = '';
        try {
          const sender = await prisma.user.findUnique({
            where: { id: String(socket.userId) },
            select: { firstName: true, lastName: true, userType: true },
          });
          if (sender) {
            senderName = `${String(sender.firstName ?? '')} ${String(sender.lastName ?? '')}`.trim();
            senderRole = String((sender as any).userType ?? '');
          }
        } catch { /* non-fatal */ }

        const payload = {
          bookingId,
          threadUserId,
          senderId: String(socket.userId),
          senderName,
          senderRole,
          message,
          clientMessageId,
          timestamp: new Date(),
        };

        // ── STEP 3: Real-time emit ─────────────────────────────────────────
        // Emit to the support room AND each recipient's personal channel
        io.to(supportRoom(bookingId, threadUserId)).emit('support:message', payload);
        for (const recipientId of recipients) {
          io.to(`user:${recipientId}`).emit('support:message', payload);
        }

        // ── STEP 4: Push notification (non-blocking) ───────────────────────
        try {
          const pushTo = recipients.filter((u) => u !== String(socket.userId));
          if (pushTo.length) {
            await sendExpoPushNotification({
              userIds: pushTo,
              title: 'Need Help',
              body: `${senderName ? `${senderName}: ` : ''}${message}`,
              data: { kind: 'support_chat', bookingId, threadUserId },
            });
          }
        } catch { /* push failure is non-fatal */ }

      } catch (outerError) {
        logger.error('[SupportChat] Unhandled error in support:message', { error: outerError });
      }
    }
  );
};

export default registerSupportHandlers;
