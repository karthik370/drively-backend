import { v2 as cloudinary } from 'cloudinary';
import prisma from '../config/database';
import { logger } from '../utils/logger';
import { BookingStatus } from '@prisma/client';

// Cloudinary is already configured in driver.controller.ts
// but ensure config is set here too in case this service loads first
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const PICKUP_VERIFICATION_LABELS = ['front', 'back', 'left', 'right', 'selfie'] as const;
const MAX_PICKUP_PHOTOS = 5; // 4 car sides + 1 selfie

export class TripPhotoService {
  /**
   * Upload a base64 image to Cloudinary and save metadata to DB.
   */
  static async uploadPhoto(params: {
    bookingId: string;
    userId: string;
    phase: 'PICKUP_VERIFICATION' | 'BEFORE' | 'AFTER';
    base64: string;
    mimeType: string;
    label: string;        // front, back, left, right, selfie
    latitude?: number;
    longitude?: number;
  }) {
    const { bookingId, userId, phase, base64, mimeType, label, latitude, longitude } = params;

    // Verify booking exists and driver is assigned
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true, driverId: true },
    });
    if (!booking) throw new Error('Booking not found');

    if (phase === 'PICKUP_VERIFICATION') {
      // Only the assigned driver can upload pickup verification photos
      if (booking.driverId !== userId) {
        throw new Error('Only the assigned driver can upload verification photos');
      }

      // Must be in ARRIVED status
      if (booking.status !== BookingStatus.ARRIVED) {
        throw new Error('Verification photos can only be uploaded after arriving at pickup');
      }

      // Validate label
      if (!PICKUP_VERIFICATION_LABELS.includes(label as any)) {
        throw new Error(`Invalid label "${label}". Must be one of: ${PICKUP_VERIFICATION_LABELS.join(', ')}`);
      }

      // Check max photos
      const existing = await prisma.tripPhoto.count({
        where: { bookingId, phase: 'PICKUP_VERIFICATION' },
      });
      if (existing >= MAX_PICKUP_PHOTOS) {
        throw new Error('All verification photos already uploaded');
      }

      // Check no duplicate label
      const dupLabel = await prisma.tripPhoto.findFirst({
        where: { bookingId, phase: 'PICKUP_VERIFICATION', label },
      });
      if (dupLabel) {
        throw new Error(`Photo with label "${label}" already uploaded`);
      }
    } else {
      // Legacy BEFORE/AFTER phase — max 4 per phase
      const existing = await prisma.tripPhoto.count({
        where: { bookingId, phase },
      });
      if (existing >= 4) throw new Error(`Maximum 4 ${phase} photos already uploaded`);

      if (label) {
        const dupLabel = await prisma.tripPhoto.findFirst({
          where: { bookingId, phase, label },
        });
        if (dupLabel) throw new Error(`Photo with label "${label}" already uploaded for ${phase} phase`);
      }
    }

    // Upload to Cloudinary — compressed to save bandwidth
    const folder = `drivemate/trip-photos/${bookingId}/${phase.toLowerCase()}`;
    const publicId = `${label || Date.now()}`;

    logger.info('Uploading trip photo to Cloudinary', { bookingId, phase, label, folder });

    const result = await cloudinary.uploader.upload(
      `data:${mimeType};base64,${base64}`,
      {
        folder,
        public_id: publicId,
        resource_type: 'image',
        overwrite: true,
        transformation: [
          { width: 800, height: 600, crop: 'limit', quality: 70, format: 'jpg' },
        ],
      }
    );

    // Save to DB with cloudinaryPublicId for later cleanup
    const photo = await prisma.tripPhoto.create({
      data: {
        bookingId,
        uploadedBy: userId,
        phase,
        imageUrl: result.secure_url,
        cloudinaryPublicId: result.public_id,
        label,
        latitude: latitude != null && Number.isFinite(latitude) ? latitude : undefined,
        longitude: longitude != null && Number.isFinite(longitude) ? longitude : undefined,
        capturedAt: new Date(),
      },
    });

    logger.info('Trip photo saved', { id: photo.id, url: result.secure_url, cloudinaryPublicId: result.public_id });
    return photo;
  }

  /**
   * Check if all 5 pickup verification photos are uploaded (4 car + 1 selfie).
   */
  static async isPickupVerificationComplete(bookingId: string): Promise<{
    complete: boolean;
    uploaded: string[];
    remaining: string[];
    count: number;
  }> {
    const photos = await prisma.tripPhoto.findMany({
      where: { bookingId, phase: 'PICKUP_VERIFICATION' },
      select: { label: true },
    });

    const uploaded = photos.map(p => p.label).filter(Boolean) as string[];
    const remaining = PICKUP_VERIFICATION_LABELS.filter(l => !uploaded.includes(l));

    return {
      complete: remaining.length === 0,
      uploaded,
      remaining: remaining as unknown as string[],
      count: uploaded.length,
    };
  }

  /**
   * Get all photos for a booking, grouped by phase.
   */
  static async getPhotos(bookingId: string) {
    const photos = await prisma.tripPhoto.findMany({
      where: { bookingId },
      orderBy: [{ phase: 'asc' }, { label: 'asc' }],
    });

    const pickupVerification = photos.filter(p => p.phase === 'PICKUP_VERIFICATION');
    const before = photos.filter(p => p.phase === 'BEFORE');
    const after = photos.filter(p => p.phase === 'AFTER');

    return { pickupVerification, before, after, total: photos.length };
  }

  /**
   * Get photo count for a booking + phase.
   */
  static async getPhotoCount(bookingId: string, phase: 'PICKUP_VERIFICATION' | 'BEFORE' | 'AFTER') {
    return prisma.tripPhoto.count({ where: { bookingId, phase } });
  }

  /**
   * Delete Cloudinary images for completed trips older than 24 hours.
   * Keeps DB records (clears imageUrl) so admin can still see metadata.
   */
  static async cleanupExpiredPhotos(): Promise<{ deleted: number; errors: number }> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago

    // Find photos from completed bookings where completedAt is older than 24hrs
    // and the photo still has a cloudinaryPublicId (not yet cleaned)
    const photos = await prisma.$queryRawUnsafe<Array<{ id: string; cloudinaryPublicId: string }>>(
      `SELECT tp.id, tp."cloudinaryPublicId"
       FROM trip_photos tp
       JOIN bookings b ON b.id = tp."bookingId"
       WHERE b.status = 'COMPLETED'
         AND b."completedAt" < $1
         AND tp."cloudinaryPublicId" IS NOT NULL
       LIMIT 100`,
      cutoff
    );

    if (photos.length === 0) {
      return { deleted: 0, errors: 0 };
    }

    let deleted = 0;
    let errors = 0;

    for (const photo of photos) {
      try {
        await cloudinary.uploader.destroy(photo.cloudinaryPublicId, { resource_type: 'image' });
        await prisma.tripPhoto.update({
          where: { id: photo.id },
          data: {
            cloudinaryPublicId: null,
            imageUrl: '[deleted after 24hrs]',
          },
        });
        deleted++;
      } catch (err) {
        logger.warn('Failed to delete Cloudinary photo', { photoId: photo.id, error: err });
        errors++;
      }
    }

    logger.info(`Cleaned up ${deleted} expired trip photos (${errors} errors)`);
    return { deleted, errors };
  }
}
