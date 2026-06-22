import { Response } from 'express';
import prisma from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { isAdminPhone, getAdminUserIds } from '../utils/adminConfig';
import { sendExpoPushNotification } from '../services/expoPush.service';

const isAdminUser = (phoneNumber: string): boolean => isAdminPhone(phoneNumber);

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

/** True if bookingId is an onboarding synthetic ID e.g. 'onboarding:userId' */
const isOnboardingThread = (bookingId: string) => bookingId.startsWith('onboarding:');

/** Fetch driver details for an onboarding thread to show admin */
const fetchOnboardingDriverDetails = async (threadUserId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: threadUserId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phoneNumber: true,
      createdAt: true,
      kycVerification: {
        select: {
          status: true,
          aadhaarVerified: true,
          panVerified: true,
          dlVerified: true,
          faceMatchPassed: true,
          faceMatchScore: true,
          failureReason: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!user) return null;

  // Also fetch driverProfile if it exists (documents submitted)
  const driverProfile = await prisma.driverProfile.findUnique({
    where: { userId: threadUserId },
    select: {
      documentsVerified: true,
      backgroundCheckStatus: true,
      rejectionReason: true,
      updatedAt: true,
    },
  }).catch(() => null);

  return {
    id: user.id,
    name: `${String(user.firstName ?? '')} ${String(user.lastName ?? '')}`.trim(),
    phoneNumber: user.phoneNumber,
    joinedAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : String(user.createdAt ?? ''),
    kyc: user.kycVerification
      ? {
          status: String(user.kycVerification.status ?? ''),
          aadhaarVerified: Boolean(user.kycVerification.aadhaarVerified),
          panVerified: Boolean(user.kycVerification.panVerified),
          dlVerified: Boolean(user.kycVerification.dlVerified),
          faceMatchPassed: Boolean(user.kycVerification.faceMatchPassed),
          faceMatchScore: user.kycVerification.faceMatchScore ?? null,
          failureReason: user.kycVerification.failureReason ?? null,
        }
      : null,
    documents: driverProfile
      ? {
          documentsVerified: Boolean(driverProfile.documentsVerified),
          backgroundCheckStatus: String(driverProfile.backgroundCheckStatus ?? ''),
          rejectionReason: driverProfile.rejectionReason ?? null,
        }
      : null,
  };
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

    // Separate onboarding threads from booking threads
    const onboardingThreads = threads.filter((t) => isOnboardingThread(t.bookingId));
    const bookingThreads = threads.filter((t) => !isOnboardingThread(t.bookingId));

    // Resolve booking data for regular threads
    const bookingIds = Array.from(new Set(bookingThreads.map((t) => t.bookingId)));
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

    // Resolve driver details for onboarding threads
    const onboardingDriverMap = new Map<string, any>();
    for (const t of onboardingThreads) {
      if (!onboardingDriverMap.has(t.threadUserId)) {
        const details = await fetchOnboardingDriverDetails(t.threadUserId);
        onboardingDriverMap.set(t.threadUserId, details);
      }
    }

    const mapThread = (t: typeof threads[0]) => {
      if (isOnboardingThread(t.bookingId)) {
        const driver = onboardingDriverMap.get(t.threadUserId) ?? null;
        return {
          bookingId: t.bookingId,
          threadUserId: t.threadUserId,
          lastMessage: t.lastMessage,
          lastAt: t.lastAt,
          isOnboarding: true,
          booking: null,
          driverDetails: driver,
        };
      }

      const b: any = bookingById.get(String(t.bookingId)) ?? null;
      return {
        bookingId: t.bookingId,
        threadUserId: t.threadUserId,
        lastMessage: t.lastMessage,
        lastAt: t.lastAt,
        isOnboarding: false,
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
        driverDetails: null,
      };
    };

    res.json({
      success: true,
      message: 'Support threads',
      data: threads
        .map(mapThread)
        .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)),
    });
  });

  static listMessages = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const bookingId = String(req.params.bookingId ?? '');
    if (!bookingId) throw new AppError('bookingId is required', 400);

    const admin = isAdminUser(req.user.phoneNumber);
    const threadUserIdRaw = typeof req.query.threadUserId === 'string' ? req.query.threadUserId : '';
    const threadUserId = admin
      ? (String(threadUserIdRaw || '') || '')
      : String(req.user.id);

    if (!threadUserId) {
      res.json({ success: true, message: 'Support messages', data: [] });
      return;
    }

    const whereClause = admin
      ? { userId: threadUserId, type: 'SYSTEM' as any, title: 'Need Help' }
      : { userId: req.user.id, type: 'SYSTEM' as any, title: 'Need Help' };

    const rows = await prisma.notification.findMany({
      where: whereClause,
      orderBy: { createdAt: 'asc' },
      take: 2000,
    });

    const seen = new Set<string>();
    const messages = rows
      .filter((n) => isSupportNotification(n, bookingId, threadUserId))
      .filter((n) => {
        const data = n.data as any;
        const dedupeKey = typeof data?.clientMessageId === 'string' && data.clientMessageId
          ? data.clientMessageId
          : String(n.id);
        if (seen.has(dedupeKey)) return false;
        seen.add(dedupeKey);
        return true;
      })
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

  /**
   * POST /support/onboarding-ticket
   * Creates the initial support message when a driver taps "Need Help?" during onboarding.
   * Auto-populates the message with their KYC status and failure reason.
   */
  static createOnboardingTicket = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const userId = req.user.id;
    const bookingId = `onboarding:${userId}`;
    const { message: customMessage } = req.body;

    // Fetch driver's current KYC + documents status for context
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        firstName: true,
        lastName: true,
        phoneNumber: true,
        kycVerification: {
          select: {
            status: true,
            aadhaarVerified: true,
            panVerified: true,
            dlVerified: true,
            faceMatchPassed: true,
            failureReason: true,
          },
        },
      },
    });

    if (!user) throw new AppError('User not found', 404);

    const driverName = `${String(user.firstName ?? '')} ${String(user.lastName ?? '')}`.trim();
    const kyc = user.kycVerification;

    // Build an informative auto-message for admin context
    const kycSummary = kyc
      ? [
          `KYC Status: ${kyc.status}`,
          `Aadhaar: ${kyc.aadhaarVerified ? '✅' : '❌'}`,
          `PAN: ${kyc.panVerified ? '✅' : '❌'}`,
          `Driving License: ${kyc.dlVerified ? '✅' : '❌'}`,
          `Face Match: ${kyc.faceMatchPassed ? '✅' : '❌'}`,
          kyc.failureReason ? `Failure Reason: ${kyc.failureReason}` : null,
        ].filter(Boolean).join(' | ')
      : 'KYC not started';

    const autoMessage = customMessage
      ? `${customMessage}\n\n[Auto-info] Driver: ${driverName} (${user.phoneNumber}) | ${kycSummary}`
      : `Driver needs help with verification.\n\n[Auto-info] Driver: ${driverName} (${user.phoneNumber}) | ${kycSummary}`;

    const clientMessageId = `onboarding-${userId}-${Date.now()}`;

    // Get admin user IDs to notify
    let adminIds: string[] = [];
    try {
      adminIds = await getAdminUserIds(prisma);
    } catch { /* non-fatal */ }

    // Recipients: the driver + all admins
    const recipients = Array.from(new Set([userId, ...adminIds])).filter(Boolean);

    // Persist to Notification table (same pattern as support socket handler)
    await prisma.notification.createMany({
      data: recipients.map((recipientId) => ({
        userId: recipientId,
        type: 'SYSTEM' as any,
        title: 'Need Help',
        body: autoMessage,
        data: {
          kind: 'support_chat',
          bookingId,
          threadUserId: userId,
          senderId: userId,
          clientMessageId,
          isOnboarding: true,
        },
      })),
    });

    // Push notification to admin
    if (adminIds.length) {
      try {
        await sendExpoPushNotification({
          userIds: adminIds,
          title: '🆘 Driver Needs Help',
          body: `${driverName} needs help with onboarding verification`,
          data: { kind: 'support_chat', bookingId, threadUserId: userId, isOnboarding: 'true' },
        });
      } catch { /* push failure is non-fatal */ }
    }

    res.status(201).json({
      success: true,
      message: 'Support ticket created',
      data: {
        bookingId,
        threadUserId: userId,
        clientMessageId,
      },
    });
  });
}

export default SupportController;
