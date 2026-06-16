import { Server, Socket } from 'socket.io';
import prisma from '../config/database';
import { logger } from '../utils/logger';
import { sendExpoPushNotification } from '../services/expoPush.service';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userType?: string;
}

const normalizePhoneDigits = (phone: string): string => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length <= 10) return digits;
  return digits.slice(-10);
};

const parseAdminAllowlist = (raw: string): string[] => {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((v) => String(v).trim())
          .filter(Boolean)
          .map(normalizePhoneDigits)
          .filter(Boolean);
      }
    } catch {
    }
  }

  return trimmed
    .split(/[\s,;]+/g)
    .map((v) => v.trim())
    .filter(Boolean)
    .map(normalizePhoneDigits)
    .filter(Boolean);
};

const getAdminUserIds = async (): Promise<string[]> => {
  const raw = String(
    process.env.ADMIN_PHONE_NUMBERS ||
      process.env.ADMIN_PHONES ||
      process.env.ADMIN_PHONE ||
      process.env.ADMIN_ALLOWLIST ||
      ''
  ).trim();

  const allowed = parseAdminAllowlist(raw);
  if (!allowed.length) return [];

  try {
    const users = await prisma.user.findMany({
      where: {
        OR: allowed.map((digits) => ({
          phoneNumber: {
            endsWith: digits,
          },
        })),
      },
      select: { id: true },
    });

    return users.map((u) => String(u.id));
  } catch (error) {
    logger.warn('Failed to load admin users for support chat', { error });
    return [];
  }
};

const isAdminSocket = async (socket: AuthenticatedSocket): Promise<boolean> => {
  if (!socket.userId) return false;
  try {
    const user = await prisma.user.findUnique({
      where: { id: socket.userId },
      select: { phoneNumber: true },
    });
    if (!user?.phoneNumber) return false;

    const raw = String(
      process.env.ADMIN_PHONE_NUMBERS ||
        process.env.ADMIN_PHONES ||
        process.env.ADMIN_PHONE ||
        process.env.ADMIN_ALLOWLIST ||
        ''
    ).trim();
    if (!raw) return false;

    const allowed = parseAdminAllowlist(raw);
    if (!allowed.length) return false;

    const current = normalizePhoneDigits(user.phoneNumber);
    return Boolean(current && allowed.includes(current));
  } catch {
    return false;
  }
};

const supportRoom = (bookingId: string, threadUserId: string) => {
  return `support:${bookingId}:${threadUserId}`;
};

export const registerSupportHandlers = (io: Server, socket: AuthenticatedSocket) => {
  socket.on('support:join', async (data: { bookingId: string; threadUserId?: string }) => {
    const bookingId = String(data?.bookingId ?? '');
    if (!socket.userId || !bookingId) return;

    const admin = await isAdminSocket(socket);
    const threadUserId = admin ? String(data?.threadUserId ?? '') : String(socket.userId);
    if (!threadUserId) return;

    socket.join(supportRoom(bookingId, threadUserId));
    logger.info(`User ${socket.userId} joined support room: ${bookingId}:${threadUserId}`);
  });

  socket.on('support:leave', async (data: { bookingId: string; threadUserId?: string }) => {
    const bookingId = String(data?.bookingId ?? '');
    if (!socket.userId || !bookingId) return;

    const admin = await isAdminSocket(socket);
    const threadUserId = admin ? String(data?.threadUserId ?? '') : String(socket.userId);
    if (!threadUserId) return;

    socket.leave(supportRoom(bookingId, threadUserId));
    logger.info(`User ${socket.userId} left support room: ${bookingId}:${threadUserId}`);
  });

  socket.on(
    'support:message',
    async (data: { bookingId: string; threadUserId?: string; message: string; clientMessageId?: string }) => {
      // Wrap the entire handler in try-catch — async socket handlers that throw cause silent failures
      try {
        const bookingId = String(data?.bookingId ?? '');
        const message = String(data?.message ?? '').trim();
        const clientMessageId = typeof data?.clientMessageId === 'string' && data.clientMessageId
          ? data.clientMessageId
          : null; // null, NOT undefined — Prisma Json fields silently fail on undefined

        if (!socket.userId || !bookingId || !message) {
          logger.warn('[SupportChat] support:message ignored — missing required field', {
            hasUserId: !!socket.userId, bookingId: !!bookingId, hasMessage: !!message,
          });
          return;
        }

        // For non-admin: threadUserId = socket.userId (deterministic, no DB call needed)
        // For admin: threadUserId comes from the payload
        // Do NOT await isAdminSocket here before determining threadUserId —
        // we can persist immediately for the non-admin case and handle admin separately
        const isAdminSender = await isAdminSocket(socket);
        const threadUserId = isAdminSender
          ? String(data?.threadUserId ?? '')
          : String(socket.userId);

        if (!threadUserId) {
          logger.warn('[SupportChat] support:message ignored — empty threadUserId (admin without param?)', {
            senderId: socket.userId, bookingId,
          });
          return;
        }

        // ── STEP 1: Persist to DB immediately ──────────────────────────────────
        // Do this BEFORE any optional lookups so history is always saved
        let adminUserIds: string[] = [];
        try {
          adminUserIds = await getAdminUserIds();
        } catch (e) {
          logger.warn('[SupportChat] getAdminUserIds failed, falling back to empty', { error: e });
        }

        const recipients = Array.from(new Set([threadUserId, ...adminUserIds])).filter(Boolean);
        logger.info(`[SupportChat] Persisting message: bookingId=${bookingId} threadUserId=${threadUserId} recipients=${recipients.length}`);

        try {
          const created = await prisma.notification.createMany({
            data: recipients.map((recipientUserId) => ({
              userId: recipientUserId,
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
          logger.info(`[SupportChat] ✓ Stored ${created.count} notification(s)`);
        } catch (dbError) {
          logger.error('[SupportChat] ✗ DB write FAILED — messages will NOT appear in history', {
            error: dbError, bookingId, threadUserId, recipients,
          });
        }

        // ── STEP 2: Resolve sender name (best-effort, doesn't gate anything) ──
        let senderName = '';
        let senderRole = '';
        try {
          const sender = await prisma.user.findUnique({
            where: { id: String(socket.userId) },
            select: { firstName: true, lastName: true, userType: true },
          });
          if (sender) {
            senderName = `${String(sender.firstName ?? '')} ${String(sender.lastName ?? '')}`.trim();
            senderRole = typeof (sender as any).userType === 'string' ? String((sender as any).userType) : '';
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

        // ── STEP 3: Emit real-time events ───────────────────────────────────────
        io.to(supportRoom(bookingId, threadUserId)).emit('support:message', payload);
        for (const recipientUserId of recipients) {
          io.to(`user:${recipientUserId}`).emit('support:message', payload);
        }

        // ── STEP 4: Push notifications (best-effort) ────────────────────────────
        try {
          const pushRecipients = recipients.filter((u) => String(u) !== String(socket.userId));
          if (pushRecipients.length) {
            await sendExpoPushNotification({
              userIds: pushRecipients,
              title: 'Need Help',
              body: `${senderName ? `${senderName}${senderRole ? ` (${senderRole})` : ''}: ` : ''}${message}`,
              data: { kind: 'support_chat', bookingId: String(bookingId), threadUserId: String(threadUserId) },
            });
          }
        } catch { /* push failure is non-fatal */ }

      } catch (outerError) {
        // Catch-all — no async rejection should crash the socket handler silently
        logger.error('[SupportChat] Unhandled error in support:message handler', { error: outerError });
      }
    }
  );
};

export default registerSupportHandlers;
