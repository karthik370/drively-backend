import { v2 as cloudinary } from 'cloudinary';
import prisma from '../config/database';
import { logger } from '../utils/logger';

// Cloudinary is already configured in driver.controller.ts
// but ensure config is set here too in case this service loads first
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export class TripPhotoService {
  /**
   * Upload a base64 image to Cloudinary and save metadata to DB.
   */
  static async uploadPhoto(params: {
    bookingId: string;
    userId: string;
    phase: 'BEFORE' | 'AFTER';
    base64: string;
    mimeType: string;
    label: string;        // front, back, left, right
    latitude?: number;
    longitude?: number;
  }) {
    const { bookingId, userId, phase, base64, mimeType, label, latitude, longitude } = params;

    // Verify booking exists
    const booking = await prisma.booking.findUnique({ where: { id: bookingId }, select: { id: true, status: true } });
    if (!booking) throw new Error('Booking not found');

    // Check max 4 photos per phase
    const existing = await prisma.tripPhoto.count({
      where: { bookingId, phase },
    });
    if (existing >= 4) throw new Error(`Maximum 4 ${phase} photos already uploaded`);

    // Check no duplicate label for this phase
    if (label) {
      const dupLabel = await prisma.tripPhoto.findFirst({
        where: { bookingId, phase, label },
      });
      if (dupLabel) throw new Error(`Photo with label "${label}" already uploaded for ${phase} phase`);
    }

    // Upload to Cloudinary
    const folder = `drivemate/trip-photos/${bookingId}/${phase.toLowerCase()}`;
    const publicId = `${label || Date.now()}`;

    logger.info('Uploading trip photo to Cloudinary', { bookingId, phase, label, folder });

    const result = await cloudinary.uploader.upload(
      `data:${mimeType};base64,${base64}`,
      { folder, public_id: publicId, resource_type: 'image', overwrite: true }
    );

    // Save to DB
    const photo = await prisma.tripPhoto.create({
      data: {
        bookingId,
        uploadedBy: userId,
        phase,
        imageUrl: result.secure_url,
        label,
        latitude: latitude != null && Number.isFinite(latitude) ? latitude : undefined,
        longitude: longitude != null && Number.isFinite(longitude) ? longitude : undefined,
        capturedAt: new Date(),
      },
    });

    logger.info('Trip photo saved', { id: photo.id, url: result.secure_url });
    return photo;
  }

  /**
   * Get all photos for a booking, grouped by phase.
   */
  static async getPhotos(bookingId: string) {
    const photos = await prisma.tripPhoto.findMany({
      where: { bookingId },
      orderBy: [{ phase: 'asc' }, { label: 'asc' }],
    });

    const before = photos.filter(p => p.phase === 'BEFORE');
    const after = photos.filter(p => p.phase === 'AFTER');

    return { before, after, total: photos.length };
  }

  /**
   * Get photo count for a booking + phase.
   */
  static async getPhotoCount(bookingId: string, phase: 'BEFORE' | 'AFTER') {
    return prisma.tripPhoto.count({ where: { bookingId, phase } });
  }
}
