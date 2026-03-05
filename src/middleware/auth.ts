import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError, asyncHandler } from './errorHandler';
import prisma from '../config/database';
import { cacheGet } from '../config/redis';
import { BookingStatus, UserType } from '@prisma/client';

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

export interface AuthRequest extends Request {
  user?: {
    id: string;
    phoneNumber: string;
    email?: string;
    userType: UserType;
    isVerified: boolean;
  };
}

export const authenticate = asyncHandler(
  async (req: AuthRequest, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('No token provided', 401);
    }

    const token = authHeader.split(' ')[1];

    const blacklisted = await cacheGet(`blacklist:${token}`);
    if (blacklisted) {
      throw new AppError('Token has been revoked', 401);
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
        id: string;
        phoneNumber: string;
        email?: string;
        userType: UserType;
        isVerified: boolean;
      };

      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: {
          id: true,
          phoneNumber: true,
          email: true,
          userType: true,
          isVerified: true,
          isActive: true,
          isBlocked: true,
        },
      });

      if (!user) {
        throw new AppError('User not found', 404);
      }

      if (!user.isActive) {
        throw new AppError('Account has been deactivated', 403);
      }

      if (user.isBlocked) {
        throw new AppError('Account has been blocked', 403);
      }

      req.user = {
        id: user.id,
        phoneNumber: user.phoneNumber,
        email: user.email || undefined,
        userType: user.userType,
        isVerified: user.isVerified,
      };

      next();
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new AppError('Token has expired', 401);
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new AppError('Invalid token', 401);
      }
      throw error;
    }
  }
);

export const authorize = (...allowedRoles: UserType[]) => {
  return (req: AuthRequest, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    if (!allowedRoles.includes(req.user.userType)) {
      throw new AppError('Not authorized to access this resource', 403);
    }

    next();
  };
};

export const requireCustomer = authorize(UserType.CUSTOMER, UserType.BOTH);

export const requireDriver = authorize(UserType.DRIVER, UserType.BOTH);

export const requireAdminAllowlist = asyncHandler(async (req: AuthRequest, _res: Response, next: NextFunction) => {
  if (!req.user) {
    throw new AppError('Not authenticated', 401);
  }

  const raw = String(
    process.env.ADMIN_PHONE_NUMBERS ||
      process.env.ADMIN_PHONES ||
      process.env.ADMIN_PHONE ||
      process.env.ADMIN_ALLOWLIST ||
      ''
  ).trim();
  if (!raw) {
    throw new AppError(
      'Admin access is not configured. Set ADMIN_PHONE_NUMBERS in backend .env (comma-separated, last 10 digits ok).',
      403
    );
  }

  const allowed = parseAdminAllowlist(raw);
  if (!allowed.length) {
    throw new AppError(
      'Admin access is not configured. Set ADMIN_PHONE_NUMBERS in backend .env (comma-separated, last 10 digits ok).',
      403
    );
  }

  const current = normalizePhoneDigits(req.user.phoneNumber);
  if (!current || !allowed.includes(current)) {
    throw new AppError('Not authorized to access this resource', 403);
  }

  return next();
});

export const requireCustomerOrOfflineDriver = asyncHandler(async (req: AuthRequest, _res: Response, next: NextFunction) => {
  if (!req.user) {
    throw new AppError('Not authenticated', 401);
  }

  if (req.user.userType === UserType.CUSTOMER || req.user.userType === UserType.BOTH) {
    return next();
  }

  if (req.user.userType !== UserType.DRIVER) {
    throw new AppError('Not authorized to access this resource', 403);
  }

  const profile = await prisma.driverProfile.findUnique({
    where: { userId: req.user.id },
    select: { isOnline: true },
  });

  if (!profile) {
    throw new AppError('Driver profile not found', 404);
  }

  if (profile.isOnline) {
    throw new AppError('Go offline to use customer features', 409);
  }

  const activeStatuses: BookingStatus[] = [
    BookingStatus.REQUESTED,
    BookingStatus.SEARCHING,
    BookingStatus.ACCEPTED,
    BookingStatus.DRIVER_ARRIVING,
    BookingStatus.ARRIVED,
    BookingStatus.STARTED,
    BookingStatus.IN_PROGRESS,
  ];

  const active = await prisma.booking.findFirst({
    where: {
      OR: [{ customerId: req.user.id }, { driverId: req.user.id }],
      status: { in: activeStatuses },
    },
    select: { id: true },
  });

  if (active?.id) {
    throw new AppError('Complete or cancel the active booking to use customer features', 409);
  }

  return next();
});

export const requireVerification = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    throw new AppError('Not authenticated', 401);
  }

  if (!req.user.isVerified) {
    throw new AppError('Phone number not verified', 403);
  }

  next();
};

export const optionalAuth = asyncHandler(
  async (req: AuthRequest, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.split(' ')[1];

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
        id: string;
        phoneNumber: string;
        email?: string;
        userType: UserType;
        isVerified: boolean;
      };

      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: {
          id: true,
          phoneNumber: true,
          email: true,
          userType: true,
          isVerified: true,
          isActive: true,
        },
      });

      if (user && user.isActive) {
        req.user = {
          id: user.id,
          phoneNumber: user.phoneNumber,
          email: user.email || undefined,
          userType: user.userType,
          isVerified: user.isVerified,
        };
      }
    } catch (error) {
    }

    next();
  }
);
