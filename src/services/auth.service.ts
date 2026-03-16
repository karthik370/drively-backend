import prisma from '../config/database';
import { hashPassword, comparePassword } from '../utils/encryption';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { AppError } from '../middleware/errorHandler';
import { User, UserType } from '@prisma/client';
// Unused imports commented out
// import { OtpService } from './otp.service';
// import { redisClient } from '../config/redis';

interface SignupData {
  phoneNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  password?: string;
  userType: UserType;
  upiId?: string;
  dateOfBirth?: Date;
  gender?: string;
  phoneVerified?: boolean;
}

interface LoginData {
  phoneNumber: string;
  password?: string;
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  user: Partial<User>;
}

export class AuthService {
  static async signup(data: SignupData): Promise<TokenResponse> {
    if (data.userType === UserType.BOTH) {
      throw new AppError('User type BOTH is not supported. Please choose CUSTOMER or DRIVER.', 400);
    }

    // Email is compulsory for all signups — needed for Cashfree payment receipts
    if (!data.email || !data.email.trim()) {
      throw new AppError('Email address is required', 400);
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.email.trim())) {
      throw new AppError('Please provide a valid email address', 400);
    }

    data.email = data.email.trim().toLowerCase();

    const existingUser = await prisma.user.findUnique({
      where: { phoneNumber: data.phoneNumber },
    });

    if (existingUser) {
      throw new AppError('User already exists with this phone number', 409);
    }

    if (data.email) {
      const existingEmail = await prisma.user.findUnique({
        where: { email: data.email },
      });

      if (existingEmail) {
        throw new AppError('Email already in use', 409);
      }
    }

    let hashedPassword: string | undefined;
    if (data.password) {
      hashedPassword = await hashPassword(data.password);
    }

    return prisma.$transaction(async (tx) => {
      const phoneVerified = Boolean(data.phoneVerified);
      const user = await tx.user.create({
        data: {
          phoneNumber: data.phoneNumber,
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          password: hashedPassword,
          userType: data.userType,
          dateOfBirth: data.dateOfBirth,
          gender: data.gender as any,
          phoneVerified,
          isVerified: phoneVerified,
        },
      });

      if (data.userType === UserType.CUSTOMER) {
        await tx.customerProfile.create({
          data: {
            userId: user.id,
          },
        });
      }

      if (data.userType === UserType.DRIVER) {
        const upiId = typeof (data as any).upiId === 'string' ? (data as any).upiId.trim() : '';

        const compactId = user.id.replace(/-/g, '');
        const licenseNumber = `PEND-${compactId}`;
        const aadhaarNumber = `PEND-AAD-${compactId}`;
        const panNumber = `PEND${compactId.slice(0, 16)}`;

        await tx.driverProfile.create({
          data: {
            userId: user.id,
            licenseNumber,
            licenseExpiryDate: new Date(),
            licenseImageUrl: '',
            aadhaarNumber,
            aadhaarImageUrl: '',
            panNumber,
            panImageUrl: '',
            bankAccountNumber: '',
            bankIfscCode: '',
            bankAccountHolderName: '',
            upiId,
          },
        });
      }

      const referralCode = await this.generateReferralCode(user.id, data.userType);
      await tx.referralCode.create({
        data: {
          code: referralCode,
          ownerId: user.id,
          ownerType: data.userType,
          rewardAmount: 100,
          referrerReward: 50,
          refereeReward: 50,
        },
      });

      const accessToken = generateAccessToken({
        id: user.id,
        phoneNumber: user.phoneNumber,
        email: user.email || undefined,
        userType: user.userType,
        isVerified: user.isVerified,
      });

      const refreshToken = generateRefreshToken({
        id: user.id,
        phoneNumber: user.phoneNumber,
        email: user.email || undefined,
        userType: user.userType,
        isVerified: user.isVerified,
      });

      await tx.session.create({
        data: {
          userId: user.id,
          refreshToken,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      const { password: _, ...userWithoutPassword } = user;

      return {
        accessToken,
        refreshToken,
        user: userWithoutPassword,
      };
    });
  }

  static async login(data: LoginData): Promise<TokenResponse> {
    const user = await prisma.user.findUnique({
      where: { phoneNumber: data.phoneNumber },
      include: {
        customerProfile: true,
        driverProfile: true,
      },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    if (!user.isActive) {
      throw new AppError('Account is deactivated', 403);
    }

    if (user.isBlocked) {
      throw new AppError('Account is blocked', 403);
    }

    if (data.password && user.password) {
      const isPasswordValid = await comparePassword(data.password, user.password);
      if (!isPasswordValid) {
        throw new AppError('Invalid credentials', 401);
      }
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const accessToken = generateAccessToken({
      id: user.id,
      phoneNumber: user.phoneNumber,
      email: user.email || undefined,
      userType: user.userType,
      isVerified: user.isVerified,
    });

    const refreshToken = generateRefreshToken({
      id: user.id,
      phoneNumber: user.phoneNumber,
      email: user.email || undefined,
      userType: user.userType,
      isVerified: user.isVerified,
    });

    await prisma.session.create({
      data: {
        userId: user.id,
        refreshToken,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const { password: _, ...userWithoutPassword } = user;

    return {
      accessToken,
      refreshToken,
      user: userWithoutPassword,
    };
  }

  static async refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    try {
      verifyRefreshToken(refreshToken);

      const session = await prisma.session.findFirst({
        where: {
          refreshToken,
          isValid: true,
          expiresAt: {
            gt: new Date(),
          },
        },
        include: {
          user: true,
        },
      });

      if (!session) {
        throw new AppError('Invalid or expired refresh token', 401);
      }

      const user = session.user;

      const newAccessToken = generateAccessToken({
        id: user.id,
        phoneNumber: user.phoneNumber,
        email: user.email || undefined,
        userType: user.userType,
        isVerified: user.isVerified,
      });

      const newRefreshToken = generateRefreshToken({
        id: user.id,
        phoneNumber: user.phoneNumber,
        email: user.email || undefined,
        userType: user.userType,
        isVerified: user.isVerified,
      });

      await prisma.session.update({
        where: { id: session.id },
        data: {
          refreshToken: newRefreshToken,
          lastUsedAt: new Date(),
        },
      });

      const { password: _, ...userWithoutPassword } = user;

      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        user: userWithoutPassword,
      };
    } catch (error) {
      throw new AppError('Invalid or expired refresh token', 401);
    }
  }

  static async logout(userId: string, refreshToken: string): Promise<void> {
    await prisma.session.updateMany({
      where: {
        userId,
        refreshToken,
      },
      data: {
        isValid: false,
      },
    });
  }

  static async logoutAllDevices(userId: string): Promise<void> {
    await prisma.session.updateMany({
      where: { userId },
      data: { isValid: false },
    });
  }

  static async socialLogin(
    _provider: string,
    _providerId: string,
    email: string,
    firstName: string,
    lastName: string,
    profileImage?: string
  ): Promise<TokenResponse> {
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          { phoneNumber: email },
        ],
      },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          phoneNumber: email,
          email,
          firstName,
          lastName,
          profileImage,
          userType: UserType.CUSTOMER,
          emailVerified: true,
          isVerified: true,
        },
      });

      await prisma.customerProfile.create({
        data: {
          userId: user.id,
        },
      });

      const referralCode = await this.generateReferralCode(user.id, UserType.CUSTOMER);
      await prisma.referralCode.create({
        data: {
          code: referralCode,
          ownerId: user.id,
          ownerType: UserType.CUSTOMER,
          rewardAmount: 100,
          referrerReward: 50,
          refereeReward: 50,
        },
      });
    }

    const accessToken = generateAccessToken({
      id: user.id,
      phoneNumber: user.phoneNumber,
      email: user.email || undefined,
      userType: user.userType,
      isVerified: user.isVerified,
    });

    const refreshToken = generateRefreshToken({
      id: user.id,
      phoneNumber: user.phoneNumber,
      email: user.email || undefined,
      userType: user.userType,
      isVerified: user.isVerified,
    });

    await prisma.session.create({
      data: {
        userId: user.id,
        refreshToken,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const { password: _, ...userWithoutPassword } = user;

    return {
      accessToken,
      refreshToken,
      user: userWithoutPassword,
    };
  }

  private static async generateReferralCode(_userId: string, userType: UserType): Promise<string> {
    const prefix = userType === UserType.DRIVER ? 'DRV' : 'CUS';
    const randomStr = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `${prefix}${randomStr}`;
  }
}
