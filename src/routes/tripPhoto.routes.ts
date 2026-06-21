import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { TripPhotoService } from '../services/tripPhoto.service';
import prisma from '../config/database';

const router = Router();

// ── Helper: verify user is a participant in the booking ──
const verifyBookingParticipant = async (bookingId: string, userId: string) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { customerId: true, driverId: true },
  });
  if (!booking) throw new AppError('Booking not found', 404);
  if (booking.customerId !== userId && booking.driverId !== userId) {
    throw new AppError('Not authorized for this booking', 403);
  }
};

// Upload a trip photo
router.post('/:bookingId/upload', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { bookingId } = req.params;
  const { base64, mimeType, phase, label, latitude, longitude } = req.body || {};

  if (!req.user) throw new AppError('Not authenticated', 401);

  // SECURITY: Verify user is a participant in this booking
  await verifyBookingParticipant(bookingId, req.user.id);

  if (!base64 || typeof base64 !== 'string') {
    throw new AppError('base64 image data is required', 400);
  }
  if (!phase || !['BEFORE', 'AFTER'].includes(phase)) {
    throw new AppError('phase must be BEFORE or AFTER', 400);
  }
  if (!label || !['front', 'back', 'left', 'right'].includes(label)) {
    throw new AppError('label must be front, back, left, or right', 400);
  }

  const photo = await TripPhotoService.uploadPhoto({
    bookingId,
    userId: req.user.id,
    phase,
    base64,
    mimeType: mimeType || 'image/jpeg',
    label,
    latitude: latitude != null ? Number(latitude) : undefined,
    longitude: longitude != null ? Number(longitude) : undefined,
  });

  res.status(201).json({ success: true, data: photo });
}));

// Get all photos for a booking
router.get('/:bookingId', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw new AppError('Not authenticated', 401);
  const { bookingId } = req.params;

  // SECURITY: Verify user is a participant in this booking
  await verifyBookingParticipant(bookingId, req.user.id);

  const data = await TripPhotoService.getPhotos(bookingId);
  res.status(200).json({ success: true, data });
}));

// Get photo count for a booking + phase
router.get('/:bookingId/count/:phase', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw new AppError('Not authenticated', 401);
  const { bookingId, phase } = req.params;

  // SECURITY: Verify user is a participant in this booking
  await verifyBookingParticipant(bookingId, req.user.id);

  const count = await TripPhotoService.getPhotoCount(bookingId, phase as 'BEFORE' | 'AFTER');
  res.status(200).json({ success: true, data: { count } });
}));

export default router;
