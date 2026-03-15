import { Response } from 'express';
import Joi from 'joi';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { BookingStatus, CancelledBy, PaymentMethod, TransmissionType, UserType, VehicleType } from '@prisma/client';
import BookingService from '../services/booking.service';
import prisma from '../config/database';

const createBookingSchema = Joi.object({
  pickup: Joi.object({
    latitude: Joi.number().min(-90).max(90).required(),
    longitude: Joi.number().min(-180).max(180).required(),
    address: Joi.string().min(3).required(),
  }).required(),
  drop: Joi.object({
    latitude: Joi.number().min(-90).max(90).required(),
    longitude: Joi.number().min(-180).max(180).required(),
    address: Joi.string().min(3).required(),
  }).optional(),
  vehicleType: Joi.string().valid(...Object.values(VehicleType)).required(),
  transmissionType: Joi.string().valid(...Object.values(TransmissionType)).optional(),
  paymentMethod: Joi.string().valid(...Object.values(PaymentMethod)).optional(),
  tripType: Joi.string().valid('ONE_WAY', 'ROUND_TRIP', 'OUTSTATION').optional(),
  outstationTripType: Joi.string().valid('ROUND_TRIP', 'ONE_WAY').optional(),
  requestedHours: Joi.number().integer().min(1).max(120).optional(),
  scheduledTime: Joi.date().iso().optional(),
  specialRequests: Joi.string().max(500).optional().allow(''),
  promoCode: Joi.string().max(50).optional().allow(''),
  requireExperienced: Joi.boolean().optional().default(false),
});

const updateStatusSchema = Joi.object({
  status: Joi.string().valid(...Object.values(BookingStatus)).required(),
});

const verifyOtpSchema = Joi.object({
  otp: Joi.string().trim().min(4).max(6).required(),
});

const cancelSchema = Joi.object({
  reason: Joi.string().max(500).optional().allow(''),
});

const rateBookingSchema = Joi.object({
  rating: Joi.number().integer().min(1).max(5).required(),
  review: Joi.string().max(2000).optional().allow(''),
  categories: Joi.object({
    punctuality: Joi.number().integer().min(1).max(5).optional(),
    driving: Joi.number().integer().min(1).max(5).optional(),
    behavior: Joi.number().integer().min(1).max(5).optional(),
  })
    .optional()
    .allow(null),
});

export class BookingController {
  static getUserBookingHistory = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;

    const data = await BookingService.getBookingHistoryForUser({
      userId: req.user.id,
      page,
      limit,
    });

    res.status(200).json({
      success: true,
      data,
    });
  });

  static getAvailableBookings = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    if (req.user.userType !== UserType.DRIVER && req.user.userType !== UserType.BOTH) {
      throw new AppError('Only drivers can view available bookings', 403);
    }

    const radiusKm = req.query.radiusKm ? Number(req.query.radiusKm) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const maxAgeMinutes = req.query.maxAgeMinutes ? Number(req.query.maxAgeMinutes) : undefined;

    const items = await BookingService.listAvailableBookingsForDriver({
      driverId: req.user.id,
      radiusKm,
      limit,
      maxAgeMinutes,
    });

    res.status(200).json({
      success: true,
      data: items,
    });
  });

  static createBooking = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    if (
      req.user.userType !== UserType.CUSTOMER &&
      req.user.userType !== UserType.BOTH &&
      req.user.userType !== UserType.DRIVER
    ) {
      throw new AppError('Only customers can create bookings', 403);
    }

    const { error, value } = createBookingSchema.validate(req.body);
    if (error) {
      throw new AppError(error.details[0].message, 400);
    }

    const booking = await BookingService.createBooking({
      customerId: req.user.id,
      pickup: value.pickup,
      drop: value.drop,
      vehicleType: value.vehicleType,
      transmissionType: value.transmissionType,
      paymentMethod: value.paymentMethod || PaymentMethod.CASH,
      tripType: value.tripType,
      outstationTripType: value.outstationTripType,
      requestedHours: value.requestedHours,
      scheduledTime: value.scheduledTime ? new Date(value.scheduledTime) : undefined,
      specialRequests: value.specialRequests || undefined,
      promoCode: value.promoCode || undefined,
      requireExperienced: value.requireExperienced || false,
    } as any);

    res.status(201).json({
      success: true,
      message: 'Booking created',
      data: {
        id: booking.id,
        bookingNumber: booking.bookingNumber,
        status: booking.status,
        customerId: booking.customerId,
        pickupAddress: booking.pickupAddress,
        dropAddress: booking.dropAddress,
        pickupLocationLat: booking.pickupLocationLat,
        pickupLocationLng: booking.pickupLocationLng,
        dropLocationLat: booking.dropLocationLat,
        dropLocationLng: booking.dropLocationLng,
        vehicleType: booking.vehicleType,
        transmissionType: booking.transmissionType,
        tripType: booking.tripType,
        totalAmount: booking.totalAmount,
        paymentMethod: booking.paymentMethod,
        paymentStatus: booking.paymentStatus,
        scheduledTime: booking.scheduledTime,
        createdAt: booking.createdAt,
        updatedAt: booking.updatedAt,
        estimatedDistance: booking.estimatedDistance,
        estimatedDuration: booking.estimatedDuration,
        pricingBreakdown: booking.pricingBreakdown,
        discountAmount: booking.discountAmount,
        platformCommission: booking.platformCommission,
        driverEarnings: booking.driverEarnings,
        commissionPercentage: booking.commissionPercentage,
        requireExperienced: (booking as any).requireExperienced,
        experiencedDriverFee: Number((booking as any).experiencedDriverFee || 0),
      },
    });
  });

  static getBooking = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const bookingId = req.params.bookingId;
    if (!bookingId) {
      throw new AppError('bookingId is required', 400);
    }

    const booking = await BookingService.getBookingById(bookingId, req.user.id);

    res.status(200).json({
      success: true,
      data: booking,
    });
  });

  static getActiveBooking = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const booking = await BookingService.getActiveBookingForUser(req.user.id);

    res.status(200).json({
      success: true,
      data: booking,
    });
  });

  static acceptBooking = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    if (req.user.userType !== UserType.DRIVER && req.user.userType !== UserType.BOTH) {
      throw new AppError('Only drivers can accept bookings', 403);
    }

    const bookingId = req.params.bookingId;
    if (!bookingId) {
      throw new AppError('bookingId is required', 400);
    }

    const result = await BookingService.acceptBooking({
      bookingId,
      driverId: req.user.id,
    });

    if (!result.booking) {
      throw new AppError('Failed to accept booking', 500);
    }

    res.status(200).json({
      success: true,
      message: 'Booking accepted',
      data: {
        id: result.booking.id,
        bookingNumber: result.booking.bookingNumber,
        status: result.booking.status,
        customerId: result.booking.customerId,
        driverId: result.booking.driverId,
        pickupAddress: result.booking.pickupAddress,
        dropAddress: result.booking.dropAddress,
        pickupLocationLat: result.booking.pickupLocationLat,
        pickupLocationLng: result.booking.pickupLocationLng,
        dropLocationLat: result.booking.dropLocationLat,
        dropLocationLng: result.booking.dropLocationLng,
        vehicleType: result.booking.vehicleType,
        transmissionType: result.booking.transmissionType,
        tripType: result.booking.tripType,
        totalAmount: result.booking.totalAmount,
        paymentMethod: result.booking.paymentMethod,
        paymentStatus: result.booking.paymentStatus,
        scheduledTime: result.booking.scheduledTime,
        acceptedAt: result.booking.acceptedAt,
        createdAt: result.booking.createdAt,
        updatedAt: result.booking.updatedAt,
        estimatedDistance: result.booking.estimatedDistance,
        estimatedDuration: result.booking.estimatedDuration,
        pricingBreakdown: result.booking.pricingBreakdown,
        discountAmount: result.booking.discountAmount,
        platformCommission: result.booking.platformCommission,
        driverEarnings: result.booking.driverEarnings,
        commissionPercentage: result.booking.commissionPercentage,
        otp: result.booking.otp,
      },
    });
  });

  static rejectBooking = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    if (req.user.userType !== UserType.DRIVER && req.user.userType !== UserType.BOTH) {
      throw new AppError('Only drivers can reject bookings', 403);
    }

    const bookingId = req.params.bookingId;
    if (!bookingId) {
      throw new AppError('bookingId is required', 400);
    }

    const result = await BookingService.rejectBooking({
      bookingId,
      driverId: req.user.id,
    });

    if (!result.booking) {
      throw new AppError('Failed to reject booking', 500);
    }

    res.status(200).json({
      success: true,
      message: 'Booking rejected',
      data: {
        id: result.booking.id,
        bookingNumber: result.booking.bookingNumber,
        status: result.booking.status,
        customerId: result.booking.customerId,
        driverId: result.booking.driverId,
        pickupAddress: result.booking.pickupAddress,
        dropAddress: result.booking.dropAddress,
        pickupLocationLat: result.booking.pickupLocationLat,
        pickupLocationLng: result.booking.pickupLocationLng,
        dropLocationLat: result.booking.dropLocationLat,
        dropLocationLng: result.booking.dropLocationLng,
        vehicleType: result.booking.vehicleType,
        transmissionType: result.booking.transmissionType,
        tripType: result.booking.tripType,
        totalAmount: result.booking.totalAmount,
        paymentMethod: result.booking.paymentMethod,
        paymentStatus: result.booking.paymentStatus,
        scheduledTime: result.booking.scheduledTime,
        createdAt: result.booking.createdAt,
        updatedAt: result.booking.updatedAt,
        estimatedDistance: result.booking.estimatedDistance,
        estimatedDuration: result.booking.estimatedDuration,
        pricingBreakdown: result.booking.pricingBreakdown,
        discountAmount: result.booking.discountAmount,
        platformCommission: result.booking.platformCommission,
        driverEarnings: result.booking.driverEarnings,
        commissionPercentage: result.booking.commissionPercentage,
        rejectedDriverIds: result.booking.rejectedDriverIds,
      },
    });
  });

  static updateBookingStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const bookingId = req.params.bookingId;
    if (!bookingId) {
      throw new AppError('bookingId is required', 400);
    }

    const { error, value } = updateStatusSchema.validate(req.body);
    if (error) {
      throw new AppError(error.details[0].message, 400);
    }

    const result = await BookingService.updateBookingStatus({
      bookingId,
      userId: req.user.id,
      status: value.status,
    });

    res.status(200).json({
      success: true,
      message: 'Booking status updated',
      data: result,
    });
  });

  static cancelBooking = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const bookingId = req.params.bookingId;
    if (!bookingId) {
      throw new AppError('bookingId is required', 400);
    }

    const { error, value } = cancelSchema.validate(req.body);
    if (error) {
      throw new AppError(error.details[0].message, 400);
    }

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { customerId: true, driverId: true },
    });

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    const cancelledBy: CancelledBy = booking.driverId === req.user.id ? CancelledBy.DRIVER : CancelledBy.CUSTOMER;

    const result = await BookingService.cancelBooking({
      bookingId,
      userId: req.user.id,
      cancelledBy,
      reason: value.reason || undefined,
    });

    res.status(200).json({
      success: true,
      message: 'Booking cancelled',
      data: result,
    });
  });

  static verifyBookingOtp = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    if (req.user.userType !== UserType.DRIVER && req.user.userType !== UserType.BOTH) {
      throw new AppError('Only drivers can verify OTP', 403);
    }

    const bookingId = req.params.bookingId;
    if (!bookingId) {
      throw new AppError('bookingId is required', 400);
    }

    const { error, value } = verifyOtpSchema.validate(req.body);
    if (error) {
      throw new AppError(error.details[0].message, 400);
    }

    const result = await BookingService.verifyBookingOtp({
      bookingId,
      driverId: req.user.id,
      otp: value.otp,
    });

    res.status(200).json({
      success: true,
      message: 'OTP verified',
      data: result,
    });
  });

  static rateBooking = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const bookingId = req.params.bookingId;
    if (!bookingId) {
      throw new AppError('bookingId is required', 400);
    }

    const { error, value } = rateBookingSchema.validate(req.body);
    if (error) {
      throw new AppError(error.details[0].message, 400);
    }

    const result = await BookingService.rateBooking({
      bookingId,
      customerId: req.user.id,
      rating: value.rating,
      review: value.review || undefined,
      categories: value.categories || undefined,
    });

    res.status(200).json({
      success: true,
      message: 'Rating submitted',
      data: result,
    });
  });
}

export default BookingController;
