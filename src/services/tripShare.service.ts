import crypto from 'crypto';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';

export class TripShareService {
    static async createShareLink(bookingId: string, userId: string): Promise<{ shareToken: string; shareUrl: string }> {
        const booking: any = await prisma.booking.findUnique({
            where: { id: bookingId },
            select: { id: true, customerId: true, driverId: true, shareToken: true } as any,
        });

        if (!booking) throw new AppError('Booking not found', 404);
        if (booking.customerId !== userId && booking.driverId !== userId) throw new AppError('Unauthorized', 403);

        if (booking.shareToken) {
            const baseUrl = process.env.APP_URL || process.env.API_URL || 'https://v3.kurnm.click';
            return { shareToken: booking.shareToken, shareUrl: `${baseUrl}/track/${booking.shareToken}` };
        }

        const shareToken = crypto.randomBytes(16).toString('hex');
        await prisma.booking.update({ where: { id: bookingId }, data: { shareToken } as any });

        const baseUrl = process.env.APP_URL || process.env.API_URL || 'https://v3.kurnm.click';
        return { shareToken, shareUrl: `${baseUrl}/track/${shareToken}` };
    }

    static async getPublicTracking(shareToken: string) {
        const booking: any = await prisma.booking.findFirst({
            where: { shareToken } as any,
            select: {
                id: true, bookingNumber: true, status: true,
                pickupAddress: true, dropAddress: true,
                pickupLocationLat: true, pickupLocationLng: true,
                dropLocationLat: true, dropLocationLng: true,
                vehicleType: true, tripType: true, totalAmount: true,
                driverETA: true, currentETA: true,
                scheduledTime: true, createdAt: true,
                driver: {
                    select: {
                        id: true, firstName: true, lastName: true, profileImage: true,
                        driverProfile: {
                            select: {
                                currentLatitude: true, currentLongitude: true,
                                // Vehicle info is on the Vehicle model via currentVehicle relation
                                currentVehicle: {
                                    select: {
                                        make: true, model: true, color: true,
                                        registrationNumber: true,
                                    },
                                },
                            },
                        },
                    },
                },
                customer: { select: { firstName: true } },
            },
        }) as any;

        if (!booking) throw new AppError('Tracking link not found or expired', 404);

        const dp = booking.driver?.driverProfile;
        const vehicle = dp?.currentVehicle;

        return {
            bookingNumber: booking.bookingNumber,
            status: booking.status,
            pickupAddress: booking.pickupAddress,
            dropAddress: booking.dropAddress,
            pickup: {
                latitude: booking.pickupLocationLat ? Number(booking.pickupLocationLat) : null,
                longitude: booking.pickupLocationLng ? Number(booking.pickupLocationLng) : null,
            },
            drop: {
                latitude: booking.dropLocationLat ? Number(booking.dropLocationLat) : null,
                longitude: booking.dropLocationLng ? Number(booking.dropLocationLng) : null,
            },
            driverETA: booking.driverETA ?? booking.currentETA ?? null,
            currentETA: booking.currentETA ?? null,  // Live Google Maps ETA updated every 8s
            customerName: booking.customer?.firstName || 'Customer',
            driver: booking.driver ? {
                firstName: booking.driver.firstName,
                lastName: booking.driver.lastName,
                profileImage: booking.driver.profileImage,
                vehicle: vehicle ? {
                    make: vehicle.make,
                    model: vehicle.model,
                    color: vehicle.color,
                    licensePlate: vehicle.registrationNumber,
                } : null,
                currentLocation: dp ? {
                    latitude: dp.currentLatitude ? Number(dp.currentLatitude) : null,
                    longitude: dp.currentLongitude ? Number(dp.currentLongitude) : null,
                } : null,
            } : null,
            vehicleType: booking.vehicleType,
            tripType: booking.tripType,
            // NOTE: totalAmount intentionally excluded from public tracking for privacy
            scheduledTime: booking.scheduledTime,
            createdAt: booking.createdAt,
        };
    }
}
