import { Response } from 'express';
import prisma from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';

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

const isAdminUser = (phoneNumber: string): boolean => {
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
  const current = normalizePhoneDigits(phoneNumber);
  return Boolean(current && allowed.includes(current));
};

const isSupportNotification = (n: any, bookingId?: string, threadUserId?: string) => {
  if (!n) return false;
  if (String(n?.title ?? '') !== 'Need Help') return false;
  const data = n?.data;
  if (!data || typeof data !== 'object') return false;
  const kind = (data as any)?.kind;
  if (kind !== 'support_chat') return false;

  if (bookingId && String((data as any)?.bookingId ?? '') !== String(bookingId)) return false;
  if (threadUserId && String((data as any)?.threadUserId ?? '') !== String(threadUserId)) return false;

  return true;
};

class SupportController {
  static listThreads = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const admin = isAdminUser(req.user.phoneNumber);

    const rows = await prisma.notification.findMany({
      where: {
        userId: req.user.id,
        type: 'SYSTEM' as any,
        title: 'Need Help',
      },
      orderBy: { createdAt: 'desc' },
      take: 800,
    });

    const threadsMap = new Map<
      string,
      {
        bookingId: string;
        threadUserId: string;
        lastMessage: string;
        lastAt: string;
        lastSenderId: string | null;
      }
    >();

    for (const n of rows) {
      if (!isSupportNotification(n)) continue;
      const data = n.data as any;
      const bookingId = String(data?.bookingId ?? '');
      const threadUserId = String(data?.threadUserId ?? '');
      if (!bookingId || !threadUserId) continue;

      if (!admin && threadUserId !== String(req.user.id)) {
        continue;
      }

      const key = `${bookingId}:${threadUserId}`;
      if (!threadsMap.has(key)) {
        threadsMap.set(key, {
          bookingId,
          threadUserId,
          lastMessage: String(n.body ?? ''),
          lastAt: n.createdAt instanceof Date ? n.createdAt.toISOString() : new Date(n.createdAt as any).toISOString(),
          lastSenderId: typeof data?.senderId === 'string' ? data.senderId : null,
        });
      }
    }

    const threads = Array.from(threadsMap.values());
    const bookingIds = Array.from(new Set(threads.map((t) => t.bookingId)));

    const bookings = await prisma.booking.findMany({
      where: { id: { in: bookingIds } },
      select: {
        id: true,
        bookingNumber: true,
        status: true,
        customer: { select: { id: true, firstName: true, lastName: true, phoneNumber: true } },
        driver: { select: { id: true, firstName: true, lastName: true, phoneNumber: true } },
        pickupAddress: true,
        dropAddress: true,
        createdAt: true,
      } as any,
    });

    const bookingById = new Map(bookings.map((b: any) => [String(b.id), b]));

    res.json({
      success: true,
      message: 'Support threads',
      data: threads
        .map((t) => {
          const b: any = bookingById.get(String(t.bookingId)) ?? null;
          return {
            bookingId: t.bookingId,
            threadUserId: t.threadUserId,
            lastMessage: t.lastMessage,
            lastAt: t.lastAt,
            booking: b
              ? {
                  id: String(b.id),
                  bookingNumber: String(b.bookingNumber ?? ''),
                  status: String(b.status ?? ''),
                  pickupAddress: b.pickupAddress ?? null,
                  dropAddress: b.dropAddress ?? null,
                  createdAt: b.createdAt instanceof Date ? b.createdAt.toISOString() : String(b.createdAt ?? ''),
                  customer: b.customer
                    ? {
                        id: String(b.customer.id),
                        name: `${String(b.customer.firstName ?? '')} ${String(b.customer.lastName ?? '')}`.trim(),
                        phoneNumber: String(b.customer.phoneNumber ?? ''),
                      }
                    : null,
                  driver: b.driver
                    ? {
                        id: String(b.driver.id),
                        name: `${String(b.driver.firstName ?? '')} ${String(b.driver.lastName ?? '')}`.trim(),
                        phoneNumber: String(b.driver.phoneNumber ?? ''),
                      }
                    : null,
                }
              : null,
          };
        })
        .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)),
    });
  });

  static listMessages = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const bookingId = String(req.params.bookingId ?? '');
    if (!bookingId) throw new AppError('bookingId is required', 400);

    const admin = isAdminUser(req.user.phoneNumber);
    const threadUserIdRaw = typeof req.query.threadUserId === 'string' ? req.query.threadUserId : '';
    const threadUserId = admin ? String(threadUserIdRaw || '') : String(req.user.id);
    if (!threadUserId) throw new AppError('threadUserId is required', 400);

    const rows = await prisma.notification.findMany({
      where: {
        userId: req.user.id,
        type: 'SYSTEM' as any,
        title: 'Need Help',
      },
      orderBy: { createdAt: 'asc' },
      take: 2000,
    });

    const messages = rows
      .filter((n) => isSupportNotification(n, bookingId, threadUserId))
      .map((n) => {
        const data = n.data as any;
        return {
          id: String((data?.clientMessageId as any) ?? n.id),
          bookingId,
          threadUserId,
          senderId: typeof data?.senderId === 'string' ? data.senderId : null,
          message: String(n.body ?? ''),
          timestamp: n.createdAt instanceof Date ? n.createdAt.toISOString() : new Date(n.createdAt as any).toISOString(),
        };
      });

    res.json({
      success: true,
      message: 'Support messages',
      data: messages,
    });
  });
}

export default SupportController;
