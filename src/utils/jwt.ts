import jwt from 'jsonwebtoken';
import { UserType } from '@prisma/client';

export interface TokenPayload {
  id: string;
  phoneNumber: string;
  email?: string;
  userType: UserType;
  isVerified: boolean;
}

const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('FATAL: JWT_SECRET environment variable is not set. Server cannot start safely.');
  return secret;
};

const getRefreshSecret = (): string => {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) throw new Error('FATAL: JWT_REFRESH_SECRET environment variable is not set. Server cannot start safely.');
  return secret;
};

export const generateAccessToken = (payload: TokenPayload): string => {
  // @ts-ignore - expiresIn accepts string values
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

export const generateRefreshToken = (payload: TokenPayload): string => {
  // @ts-ignore - expiresIn accepts string values
  return jwt.sign(payload, getRefreshSecret(), {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  });
};

export const verifyRefreshToken = (token: string): TokenPayload => {
  return jwt.verify(token, getRefreshSecret()) as TokenPayload;
};

export const decodeToken = (token: string): TokenPayload | null => {
  try {
    return jwt.decode(token) as TokenPayload;
  } catch (error) {
    return null;
  }
};
