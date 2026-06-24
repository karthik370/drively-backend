import { Response } from 'express';
import Joi from 'joi';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { UserType } from '@prisma/client';
import { TripPhotoService } from '../services/tripPhoto.service';

const uploadPhotoSchema = Joi.object({
  base64: Joi.string().required(),
  mimeType: Joi.string().valid('image/jpeg', 'image/png', 'image/webp', 'image/jpg').default('image/jpeg'),
  label: Joi.string().valid('front', 'back', 'left', 'right', 'selfie').required(),
  phase: Joi.string().valid('PICKUP_VERIFICATION', 'BEFORE', 'AFTER').default('PICKUP_VERIFICATION'),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
});

export class TripPhotoController {
  /**
   * Upload a trip verification photo (base64).
   * POST /bookings/:bookingId/trip-photos
   */
  static uploadPhoto = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    if (req.user.userType !== UserType.DRIVER && req.user.userType !== UserType.BOTH) {
      throw new AppError('Only drivers can upload verification photos', 403);
    }

    const bookingId = req.params.bookingId;
    if (!bookingId) {
      throw new AppError('bookingId is required', 400);
    }

    const { error, value } = uploadPhotoSchema.validate(req.body);
    if (error) {
      throw new AppError(error.details[0].message, 400);
    }

    const photo = await TripPhotoService.uploadPhoto({
      bookingId,
      userId: req.user.id,
      phase: value.phase,
      base64: value.base64,
      mimeType: value.mimeType,
      label: value.label,
      latitude: value.latitude,
      longitude: value.longitude,
    });

    res.status(201).json({
      success: true,
      message: `Photo "${value.label}" uploaded successfully`,
      data: {
        id: photo.id,
        label: photo.label,
        imageUrl: photo.imageUrl,
        phase: photo.phase,
      },
    });
  });

  /**
   * Get all photos for a booking.
   * GET /bookings/:bookingId/trip-photos
   */
  static getPhotos = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const bookingId = req.params.bookingId;
    if (!bookingId) {
      throw new AppError('bookingId is required', 400);
    }

    const photos = await TripPhotoService.getPhotos(bookingId);

    res.status(200).json({
      success: true,
      data: photos,
    });
  });

  /**
   * Get pickup verification photo status (how many uploaded, which are missing).
   * GET /bookings/:bookingId/trip-photos/status
   */
  static getPhotoStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    const bookingId = req.params.bookingId;
    if (!bookingId) {
      throw new AppError('bookingId is required', 400);
    }

    const status = await TripPhotoService.isPickupVerificationComplete(bookingId);

    res.status(200).json({
      success: true,
      data: status,
    });
  });
}

export default TripPhotoController;
