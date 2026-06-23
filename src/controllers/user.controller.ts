import { Response } from 'express';
import { randomUUID } from 'crypto';
import prisma from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { UserType } from '@prisma/client';
import { sendExpoPushNotification } from '../services/expoPush.service';
import { logger } from '../utils/logger';

type SavedAddress = {
  id: string;
  label?: string;
  address: string;
  location: { latitude: number; longitude: number };
  createdAt: string;
};

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

const normalizeSaved = (raw: any): SavedAddress | null => {
  if (!raw || typeof raw !== 'object') return null;

  const id = typeof raw.id === 'string' ? raw.id : '';
  const address = typeof raw.address === 'string' ? raw.address : '';
  const label = typeof raw.label === 'string' ? raw.label : undefined;

  const loc = raw.location;
  const latitude = loc && typeof loc === 'object' ? (loc as any).latitude : undefined;
  const longitude = loc && typeof loc === 'object' ? (loc as any).longitude : undefined;

  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString();

  if (!id || !address || !isFiniteNumber(latitude) || !isFiniteNumber(longitude)) return null;

  return {
    id,
    label,
    address,
    location: { latitude, longitude },
    createdAt,
  };
};

export class UserController {
  static updateProfile = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const firstName = typeof (req.body as any)?.firstName === 'string' ? (req.body as any).firstName.trim() : '';
    const lastName = typeof (req.body as any)?.lastName === 'string' ? (req.body as any).lastName.trim() : '';
    const profileImage = typeof (req.body as any)?.profileImage === 'string' ? (req.body as any).profileImage.trim() : undefined;
    const emailRaw = typeof (req.body as any)?.email === 'string' ? (req.body as any).email.trim().toLowerCase() : null;

    if (!firstName || !lastName) {
      throw new AppError('firstName and lastName are required', 400);
    }

    if (firstName.length < 2 || lastName.length < 1) {
      throw new AppError('Invalid name', 400);
    }

    if (profileImage && !(req.user.userType === UserType.DRIVER || req.user.userType === UserType.BOTH)) {
      throw new AppError('Only drivers can update profile photo', 403);
    }

    // Validate and deduplicate email if being changed
    let newEmail: string | undefined;
    if (emailRaw) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(emailRaw)) {
        throw new AppError('Please provide a valid email address', 400);
      }

      // Check if email is used by a different account
      const existingWithEmail = await prisma.user.findUnique({
        where: { email: emailRaw },
        select: { id: true },
      });

      if (existingWithEmail && existingWithEmail.id !== req.user.id) {
        throw new AppError('This email address is already in use by another account', 409);
      }

      newEmail = emailRaw;
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        firstName,
        lastName,
        profileImage: profileImage ? profileImage : undefined,
        ...(newEmail !== undefined ? { email: newEmail } : {}),
      } as any,
      select: {
        id: true,
        phoneNumber: true,
        email: true,
        firstName: true,
        lastName: true,
        profileImage: true,
        userType: true,
        rating: true,
        totalRatings: true,
        isVerified: true,
      },
    });

    res.status(200).json({
      success: true,
      message: 'Profile updated',
      data: updated,
    });
  });

  static getSavedAddresses = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const profile = await prisma.customerProfile.findUnique({
      where: { userId: req.user.id },
      select: { savedAddresses: true },
    });

    const raw = Array.isArray((profile as any)?.savedAddresses) ? (profile as any).savedAddresses : [];
    const items = raw.map(normalizeSaved).filter(Boolean) as SavedAddress[];

    res.status(200).json({
      success: true,
      data: items,
    });
  });

  static addSavedAddress = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const label = typeof (req.body as any)?.label === 'string' ? (req.body as any).label.trim() : undefined;
    const address = typeof (req.body as any)?.address === 'string' ? (req.body as any).address.trim() : '';
    const latitude = (req.body as any)?.latitude;
    const longitude = (req.body as any)?.longitude;

    const lat = typeof latitude === 'number' ? latitude : Number(latitude);
    const lng = typeof longitude === 'number' ? longitude : Number(longitude);

    if (!address || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new AppError('Invalid address payload', 400);
    }

    const createdAt = new Date().toISOString();
    const item: SavedAddress = {
      id: randomUUID(),
      label: label || undefined,
      address,
      location: { latitude: lat, longitude: lng },
      createdAt,
    };

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.customerProfile.findUnique({
        where: { userId: req.user!.id },
        select: { savedAddresses: true },
      });

      if (!existing) {
        await tx.customerProfile.create({
          data: { userId: req.user!.id, savedAddresses: [item] as any },
        });
        return [item];
      }

      const raw = Array.isArray((existing as any).savedAddresses) ? (existing as any).savedAddresses : [];
      const normalized = raw.map(normalizeSaved).filter(Boolean) as SavedAddress[];

      const next = [item, ...normalized].slice(0, 20);

      await tx.customerProfile.update({
        where: { userId: req.user!.id },
        data: { savedAddresses: next as any },
      });

      return next;
    });

    res.status(201).json({
      success: true,
      message: 'Saved address added',
      data: updated,
    });
  });

  static deleteSavedAddress = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const addressId = String(req.params.addressId || '').trim();
    if (!addressId) {
      throw new AppError('addressId is required', 400);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.customerProfile.findUnique({
        where: { userId: req.user!.id },
        select: { savedAddresses: true },
      });

      const raw = Array.isArray((existing as any)?.savedAddresses) ? (existing as any).savedAddresses : [];
      const normalized = raw.map(normalizeSaved).filter(Boolean) as SavedAddress[];
      const next = normalized.filter((a) => a.id !== addressId);

      if (existing) {
        await tx.customerProfile.update({
          where: { userId: req.user!.id },
          data: { savedAddresses: next as any },
        });
      }

      return next;
    });

    res.status(200).json({
      success: true,
      message: 'Saved address deleted',
      data: updated,
    });
  });

  static registerExpoPushToken = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const token = typeof (req.body as any)?.token === 'string' ? (req.body as any).token.trim() : '';
    const rawPlatform = typeof (req.body as any)?.platform === 'string' ? (req.body as any).platform.trim().toLowerCase() : undefined;

    // Normalize platform to known short values — Device.osName can return
    // long strings like "Android 14" that exceed the VARCHAR(20) column limit.
    const normalizePlatform = (p: string | undefined): string | undefined => {
      if (!p) return undefined;
      if (p.includes('android')) return 'android';
      if (p.includes('ios') || p.includes('iphone') || p.includes('ipad')) return 'ios';
      if (p.includes('web') || p.includes('chrome') || p.includes('firefox')) return 'web';
      return p.slice(0, 15); // hard truncate as safety net
    };
    const platform = normalizePlatform(rawPlatform);

    if (!token) {
      throw new AppError('token is required', 400);
    }

    if (!token.startsWith('ExponentPushToken[') && !token.startsWith('ExpoPushToken[')) {
      throw new AppError('Invalid Expo push token', 400);
    }

    // Track if this token is brand-new FOR THIS USER.
    // "new for this user" = token never existed, OR token existed for a different user
    // (e.g. user logs out of Account A, signs in as Account B on same device —
    //  the device token is the same physical token, but it's "new" for Account B)
    let isNewToken = false;
    let tokenSaved = false;
    try {
      const existing = await (prisma as any).expoPushToken.findUnique({ where: { token } });
      // New for this user if: no record at all, OR record belongs to a different userId
      isNewToken = !existing || existing.userId !== req.user.id;
      if (existing) {
        await (prisma as any).expoPushToken.update({
          where: { token },
          data: {
            userId: req.user.id,
            platform: platform || undefined,
            isActive: true,
          },
        });
        tokenSaved = true;
      } else {
        await (prisma as any).expoPushToken.create({
          data: {
            userId: req.user.id,
            token,
            platform: platform || undefined,
            isActive: true,
          },
        });
        tokenSaved = true;
        logger.info('[PushToken] New token saved successfully', { userId: req.user.id, platform });
      }
    } catch {
      // Fallback: best-effort upsert by token unique constraint
      try {
        await (prisma as any).expoPushToken.upsert({
          where: { token },
          create: {
            userId: req.user.id,
            token,
            platform: platform || undefined,
            isActive: true,
          },
          update: {
            userId: req.user.id,
            platform: platform || undefined,
            isActive: true,
          },
        });
        tokenSaved = true;
        logger.info('[PushToken] Token saved via upsert fallback', { userId: req.user.id, platform });
      } catch (upsertErr: any) {
        logger.error('[PushToken] Failed to save token — welcome notification will not fire', {
          userId: req.user.id,
          error: upsertErr?.message,
        });
      }
    }

    // ── One-time welcome notification ──
    // Fires ONLY when:
    //   1. This is a brand-new token (never seen before)
    //   2. Token was actually saved to DB (not a DB error)
    //   3. The account was created within the last 60 minutes (new signup, not returning user)
    if (isNewToken && tokenSaved) {
      void (async () => {
        try {
          // Count how many tokens the user now has (just inserted, so ≥ 1)
          const tokenCount = await (prisma as any).expoPushToken.count({
            where: { userId: req.user!.id, isActive: true },
          });
          // Only proceed if this is the very first token for this user (first device ever)
          if (tokenCount >= 1) {
            const user = await prisma.user.findUnique({
              where: { id: req.user!.id },
              select: { firstName: true, createdAt: true },
            });
            const ageMs = user?.createdAt ? Date.now() - new Date(user.createdAt).getTime() : Infinity;
            const isNewAccount = ageMs < 60 * 60 * 1000; // within last 60 minutes
            if (isNewAccount) {
              const firstName = String(user?.firstName || 'there').trim();
              // Send directly to this token (guaranteed to exist — just registered above)
              await sendExpoPushNotification({
                userIds: [req.user!.id],
                title: `Welcome to Drively, ${firstName}! 🎉`,
                body: `Thanks for choosing Drively! You're all set to book your first ride. Share the app with friends — quality rides, wherever you go.`,
                data: { kind: 'welcome' },
              });
              logger.info('Sent welcome notification to new user', { userId: req.user!.id });
            }
          }
        } catch (err: any) {
          logger.warn('Failed to send welcome notification', { userId: req.user!.id, error: err?.message });
        }
      })();
    }

    res.status(200).json({
      success: true,
      message: 'Push token registered',
      data: { ok: true },
    });
  });
}

export default UserController;
