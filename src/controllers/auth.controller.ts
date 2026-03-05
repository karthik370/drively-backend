import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthService } from '../services/auth.service';
import { OtpService } from '../services/otp.service';
import { AppError } from '../middleware/errorHandler';
import Joi from 'joi';
import prisma from '../config/database';
import axios from 'axios';
import { logger } from '../utils/logger';
import jwt from 'jsonwebtoken';

const normalizePhoneE164 = (raw: string): string => {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('+')) return trimmed;

  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';

  return `+${digits}`;
};

const normalizeLast10 = (raw: string): string => {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length <= 10 ? digits : digits.slice(-10);
};

const extractIdentifierFromMsg91 = (payload: any): string => {
  const candidates = [
    payload?.data?.identifier,
    payload?.identifier,
    payload?.data?.mobile,
    payload?.mobile,
    payload?.data?.phone,
    payload?.phone,
    payload?.data?.email,
    payload?.email,
    payload?.data?.message,
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }

  const topType = String(payload?.type || '').toLowerCase();
  const topMessage = payload?.message;
  if (topType === 'success' && typeof topMessage === 'string' && topMessage.trim()) {
    return topMessage.trim();
  }

  if (payload?.data && typeof payload.data === 'object') {
    for (const k of Object.keys(payload.data)) {
      const v = (payload.data as any)[k];
      if (
        typeof v === 'string' &&
        v.trim() &&
        (k.toLowerCase().includes('identifier') ||
          k.toLowerCase().includes('mobile') ||
          k.toLowerCase().includes('phone') ||
          k.toLowerCase().includes('email'))
      ) {
        return v.trim();
      }
    }
  }

  return '';
};

const MSG91_MAX_RETRIES = 3;
const MSG91_RETRY_DELAYS = [0, 500, 1000]; // ms delay before each attempt

const verifyMsg91AccessTokenAndExtract = async (accessToken: string): Promise<{ identifierRaw: string }> => {
  const authkey = String(process.env.MSG91_AUTHKEY || process.env.MSG91_AUTH_KEY || '').trim();
  if (!authkey) {
    logger.error('MSG91 AuthKey is not configured. Set MSG91_AUTHKEY in .env');
    throw new AppError('MSG91 AuthKey is not configured on server', 500);
  }

  let verifyResponse: any;
  let lastError: any = null;

  for (let attempt = 0; attempt < MSG91_MAX_RETRIES; attempt++) {
    const delay = MSG91_RETRY_DELAYS[attempt] || 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const r = await axios.post(
        'https://control.msg91.com/api/v5/widget/verifyAccessToken',
        {
          authkey,
          'access-token': accessToken,
        },
        {
          timeout: 15000,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
      verifyResponse = r?.data;
      lastError = null;
      break; // success — exit retry loop
    } catch (err: any) {
      lastError = err;
      logger.warn(`MSG91 verifyAccessToken attempt ${attempt + 1}/${MSG91_MAX_RETRIES} failed`, {
        message: err?.message,
        status: err?.response?.status,
        payload: err?.response?.data,
      });
    }
  }

  if (lastError) {
    logger.error('MSG91 verifyAccessToken failed after all retries', {
      message: lastError?.message,
      status: lastError?.response?.status,
      payload: lastError?.response?.data,
    });
    throw new AppError('Failed to verify OTP token', 502);
  }

  const identifierRaw = extractIdentifierFromMsg91(verifyResponse);
  if (!identifierRaw) {
    logger.warn('MSG91 verifyAccessToken: identifier missing', { verifyResponse });
    throw new AppError('Invalid or expired OTP token', 401);
  }

  return { identifierRaw };
};

const generateOtpSignupToken = (payload: { identifierRaw: string; phoneNumber?: string | null; email?: string | null }): string => {
  const secret = String(process.env.JWT_SECRET || 'fallback-secret');
  return jwt.sign(
    {
      typ: 'otp_signup',
      identifierRaw: payload.identifierRaw,
      phoneNumber: payload.phoneNumber || null,
      email: payload.email || null,
    },
    secret,
    { expiresIn: '15m' }
  );
};

const verifyOtpSignupToken = (token: string): { identifierRaw: string; phoneNumber: string | null; email: string | null } => {
  const secret = String(process.env.JWT_SECRET || 'fallback-secret');
  const decoded = jwt.verify(token, secret) as any;
  if (!decoded || String(decoded.typ || '') !== 'otp_signup') {
    throw new AppError('Invalid or expired OTP token', 401);
  }
  const identifierRaw = typeof decoded.identifierRaw === 'string' ? decoded.identifierRaw.trim() : '';
  if (!identifierRaw) {
    throw new AppError('Invalid or expired OTP token', 401);
  }
  const phoneNumber = typeof decoded.phoneNumber === 'string' ? decoded.phoneNumber.trim() : null;
  const email = typeof decoded.email === 'string' ? decoded.email.trim() : null;
  return { identifierRaw, phoneNumber, email };
};

const sendOtpSchema = Joi.object({
  phoneNumber: Joi.string().pattern(/^\+?[1-9]\d{1,14}$/).required(),
});

const verifyOtpSchema = Joi.object({
  phoneNumber: Joi.string().pattern(/^\+?[1-9]\d{1,14}$/).required(),
  otp: Joi.string().length(6).required(),
});

const signupSchema = Joi.object({
  phoneNumber: Joi.string().pattern(/^\+?[1-9]\d{1,14}$/).required(),
  firstName: Joi.string().min(2).max(50).required(),
  lastName: Joi.string().min(2).max(50).required(),
  email: Joi.string().trim().email().optional().allow(''),
  password: Joi.string().min(8).optional(),
  userType: Joi.string().valid('CUSTOMER', 'DRIVER').required(),
  upiId: Joi.string().trim().max(100).when('userType', { is: 'DRIVER', then: Joi.required(), otherwise: Joi.optional().allow('', null) }),
  dateOfBirth: Joi.date().optional(),
  gender: Joi.string().valid('MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY').optional(),
  msg91AccessToken: Joi.string().min(10).optional(),
  otpSignupToken: Joi.string().min(10).optional(),
});

const loginSchema = Joi.object({
  phoneNumber: Joi.string().pattern(/^\+?[1-9]\d{1,14}$/).required(),
  password: Joi.string().min(1).required(),
});

const refreshTokenSchema = Joi.object({
  refreshToken: Joi.string().required(),
});

const msg91VerifyAccessTokenSchema = Joi.object({
  accessToken: Joi.string().min(10).required(),
  phoneNumber: Joi.string().pattern(/^\+?[1-9]\d{1,14}$/).optional(),
});

export class AuthController {
  static verifyMsg91AccessToken = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { error, value } = msg91VerifyAccessTokenSchema.validate(req.body);
    if (error) {
      throw new AppError(error.details[0].message, 400);
    }

    const accessToken = String(value.accessToken).trim();
    const claimedPhone = typeof value.phoneNumber === 'string' ? value.phoneNumber.trim() : '';

    const { identifierRaw } = await verifyMsg91AccessTokenAndExtract(accessToken);

    const isEmail = identifierRaw.includes('@');

    if (!isEmail && claimedPhone) {
      const tokenLast10 = normalizeLast10(identifierRaw);
      const claimedLast10 = normalizeLast10(claimedPhone);
      if (tokenLast10 && claimedLast10 && tokenLast10 !== claimedLast10) {
        throw new AppError('OTP token does not match phone number', 401);
      }
    }

    let user = null as any;
    let verifiedPhoneNumber: string | null = null;

    if (isEmail) {
      const email = identifierRaw.toLowerCase();
      user = await prisma.user.findUnique({
        where: { email },
        include: { customerProfile: true, driverProfile: true },
      });
    } else {
      verifiedPhoneNumber = normalizePhoneE164(identifierRaw);
      const last10 = normalizeLast10(verifiedPhoneNumber);

      if (!verifiedPhoneNumber || !last10) {
        throw new AppError('Invalid phone number returned by OTP provider', 400);
      }

      user = await prisma.user.findFirst({
        where: {
          OR: [
            { phoneNumber: verifiedPhoneNumber },
            { phoneNumber: { endsWith: last10 } as any },
          ],
        },
        include: { customerProfile: true, driverProfile: true },
      });
    }

    if (!user) {
      const otpSignupToken = generateOtpSignupToken({
        identifierRaw,
        phoneNumber: verifiedPhoneNumber || claimedPhone || null,
        email: isEmail ? identifierRaw : null,
      });
      res.status(200).json({
        success: true,
        message: 'OTP verified. User not found; please signup.',
        data: {
          verified: true,
          userExists: false,
          phoneNumber: verifiedPhoneNumber || claimedPhone || null,
          email: isEmail ? identifierRaw : null,
          otpSignupToken,
        },
      });
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        phoneVerified: true,
        isVerified: true,
      },
    });

    const result = await AuthService.login({ phoneNumber: user.phoneNumber });

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: result,
    });
  });

  static sendOtp = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { error, value } = sendOtpSchema.validate(req.body);
    if (error) {
      throw new AppError(error.details[0].message, 400);
    }

    const { phoneNumber } = value;
    await OtpService.sendOTP(phoneNumber);

    res.status(200).json({
      success: true,
      message: 'OTP sent successfully',
      data: {
        phoneNumber,
        expiresIn: 300,
      },
    });
  });

  static verifyOtp = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { error, value } = verifyOtpSchema.validate(req.body);
    if (error) {
      throw new AppError(error.details[0].message, 400);
    }

    const { phoneNumber, otp } = value;
    const isValid = await OtpService.verifyOTP(phoneNumber, otp);

    res.status(200).json({
      success: true,
      message: 'OTP verified successfully',
      data: { verified: isValid },
    });
  });

  static signup = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { error, value } = signupSchema.validate(req.body);
    if (error) {
      throw new AppError(error.details[0].message, 400);
    }

    const msg91AccessToken = String((value as any).msg91AccessToken || '').trim();
    const otpSignupToken = String((value as any).otpSignupToken || '').trim();
    if (!msg91AccessToken && !otpSignupToken) {
      throw new AppError('OTP token is required', 400);
    }

    let identifierRaw = '';
    if (otpSignupToken) {
      const decoded = verifyOtpSignupToken(otpSignupToken);
      identifierRaw = decoded.identifierRaw;
    } else {
      const r = await verifyMsg91AccessTokenAndExtract(msg91AccessToken);
      identifierRaw = r.identifierRaw;
    }

    const tokenPhoneE164 = identifierRaw.includes('@') ? '' : normalizePhoneE164(identifierRaw);
    const claimedPhoneE164 = normalizePhoneE164(value.phoneNumber);

    if (!tokenPhoneE164) {
      throw new AppError('OTP verification did not return a phone number', 401);
    }

    const tokenLast10 = normalizeLast10(tokenPhoneE164);
    const claimedLast10 = normalizeLast10(claimedPhoneE164);

    if (!tokenLast10 || !claimedLast10 || tokenLast10 !== claimedLast10) {
      throw new AppError('OTP token does not match phone number', 401);
    }

    if (typeof value.email === 'string' && value.email.trim() === '') {
      delete value.email;
    }

    delete (value as any).msg91AccessToken;
    delete (value as any).otpSignupToken;

    const payload = {
      ...(value as any),
      phoneVerified: true,
      phoneNumber: claimedPhoneE164,
    };

    const result = await AuthService.signup(payload);

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: result,
    });
  });

  static login = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { error, value } = loginSchema.validate(req.body);
    if (error) {
      throw new AppError(error.details[0].message, 400);
    }

    const result = await AuthService.login(value);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: result,
    });
  });

  static refreshToken = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { error, value } = refreshTokenSchema.validate(req.body);
    if (error) {
      throw new AppError(error.details[0].message, 400);
    }

    const { refreshToken } = value;
    const result = await AuthService.refreshAccessToken(refreshToken);

    res.status(200).json({
      success: true,
      message: 'Token refreshed successfully',
      data: result,
    });
  });

  static logout = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { refreshToken } = req.body;
    
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    await AuthService.logout(req.user.id, refreshToken);

    res.status(200).json({
      success: true,
      message: 'Logged out successfully',
    });
  });

  static logoutAllDevices = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    await AuthService.logoutAllDevices(req.user.id);

    res.status(200).json({
      success: true,
      message: 'Logged out from all devices successfully',
    });
  });

  static getMe = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        phoneNumber: true,
        email: true,
        firstName: true,
        lastName: true,
        profileImage: true,
        dateOfBirth: true,
        gender: true,
        userType: true,
        isVerified: true,
        rating: true,
        totalRatings: true,
        createdAt: true,
        customerProfile: true,
        driverProfile: true,
      },
    });

    res.status(200).json({
      success: true,
      data: user,
    });
  });

  static socialLogin = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { provider, providerId, email, firstName, lastName, profileImage } = req.body;

    if (!provider || !email || !firstName || !lastName) {
      throw new AppError('Missing required fields', 400);
    }

    const result = await AuthService.socialLogin(
      provider,
      providerId,
      email,
      firstName,
      lastName,
      profileImage
    );

    res.status(200).json({
      success: true,
      message: 'Social login successful',
      data: result,
    });
  });
}
