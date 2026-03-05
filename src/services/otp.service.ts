import twilio from 'twilio';
import AWS from 'aws-sdk';
import prisma from '../config/database';
import { cacheSet, cacheGet, cacheDel } from '../config/redis';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';

// Initialize Twilio client only if credentials are provided
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_ACCOUNT_SID.startsWith('AC')
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

const OTP_EXPIRY = 5 * 60;
const MAX_ATTEMPTS = 3;
const RESEND_COOLDOWN = 30;

const shouldSendViaTwilio = (): boolean => {
  if (!twilioClient) return false;
  if (process.env.NODE_ENV === 'production') return true;
  return process.env.TWILIO_SEND_IN_DEV === 'true';
};

const shouldSendViaSNS = (): boolean => {
  const enabled = String(process.env.AWS_SNS_ENABLED || '').trim() === 'true';
  if (!enabled) return false;
  if (process.env.NODE_ENV === 'production') return true;
  return String(process.env.AWS_SNS_SEND_IN_DEV || '').trim() === 'true';
};

export class OtpService {
  static generateOTP(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  static async sendOTP(phoneNumber: string): Promise<void> {
    const cooldownKey = `otp:cooldown:${phoneNumber}`;

    // Check cooldown — gracefully skip if Redis is unavailable
    try {
      const cooldown = await cacheGet(cooldownKey);
      if (cooldown) {
        throw new AppError(`Please wait ${RESEND_COOLDOWN} seconds before requesting another OTP`, 429);
      }
    } catch (err) {
      if (err instanceof AppError) throw err; // re-throw cooldown error
      logger.warn('Redis unavailable for OTP cooldown check, skipping', { phoneNumber });
    }

    const otp = this.generateOTP();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY * 1000);

    await prisma.otpVerification.create({
      data: {
        phoneNumber,
        otp,
        expiresAt,
        attempts: 0,
      },
    });

    const snsPreferred = shouldSendViaSNS();
    const twilioPreferred = shouldSendViaTwilio() && Boolean(twilioClient);

    if (snsPreferred) {
      try {
        const region = String(process.env.AWS_REGION || 'ap-south-1').trim();
        const sns = new AWS.SNS({ region });
        await sns
          .publish({
            PhoneNumber: phoneNumber,
            Message: `Your DriveMate OTP is: ${otp}`,
            MessageAttributes: {
              'AWS.SNS.SMS.SMSType': {
                DataType: 'String',
                StringValue: 'Transactional',
              },
            },
          })
          .promise();
        logger.info(`OTP sent via SNS to ${phoneNumber}`);
      } catch (error) {
        logger.error('SNS error:', error);
        throw new AppError('Failed to send OTP', 500);
      }
    } else if (twilioPreferred && twilioClient) {
      try {
        await twilioClient.messages.create({
          body: `Your DriveMate OTP is: ${otp}`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phoneNumber,
        });
        logger.info(`OTP sent via Twilio to ${phoneNumber}`);
      } catch (error) {
        logger.error('Twilio error:', error);
        throw new AppError('Failed to send OTP', 500);
      }
    } else {
      logger.info(`[DEV MODE] OTP for ${phoneNumber}: ${otp}`);
      console.log(`\n🔐 OTP for ${phoneNumber}: ${otp}\n`);
    }

    // Set cooldown — gracefully skip if Redis is unavailable
    try {
      await cacheSet(cooldownKey, 'true', RESEND_COOLDOWN);
    } catch (err) {
      logger.warn('Redis unavailable for OTP cooldown set, skipping', { phoneNumber });
    }
  }

  static async verifyOTP(phoneNumber: string, otp: string): Promise<boolean> {
    const otpRecord = await prisma.otpVerification.findFirst({
      where: {
        phoneNumber,
        isVerified: false,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!otpRecord) {
      throw new AppError('No OTP found for this phone number', 404);
    }

    if (otpRecord.attempts >= MAX_ATTEMPTS) {
      throw new AppError('Maximum OTP attempts exceeded. Please request a new OTP', 429);
    }

    if (new Date() > otpRecord.expiresAt) {
      throw new AppError('OTP has expired. Please request a new OTP', 400);
    }

    await prisma.otpVerification.update({
      where: { id: otpRecord.id },
      data: {
        attempts: otpRecord.attempts + 1,
      },
    });

    if (otpRecord.otp !== otp) {
      const remainingAttempts = MAX_ATTEMPTS - (otpRecord.attempts + 1);
      throw new AppError(
        `Invalid OTP. ${remainingAttempts} attempts remaining`,
        400
      );
    }

    await prisma.otpVerification.update({
      where: { id: otpRecord.id },
      data: {
        isVerified: true,
        verifiedAt: new Date(),
      },
    });

    // Clear cooldown — gracefully skip if Redis is unavailable
    try {
      await cacheDel(`otp:cooldown:${phoneNumber}`);
    } catch (err) {
      logger.warn('Redis unavailable for OTP cooldown clear, skipping', { phoneNumber });
    }

    return true;
  }

  static async cleanupExpiredOTPs(): Promise<void> {
    await prisma.otpVerification.deleteMany({
      where: {
        expiresAt: {
          lt: new Date(),
        },
      },
    });
  }
}
