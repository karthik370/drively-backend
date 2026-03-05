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
            const baseUrl = process.env.APP_URL || process.env.API_URL || 'https://app.drivemateservice.com';
            return { shareToken: booking.shareToken, shareUrl: `${baseUrl}/track/${booking.shareToken}` };
        }

        const shareToken = crypto.randomBytes(16).toString('hex');
        await prisma.booking.update({ where: { id: bookingId }, data: { shareToken } as any });

        const baseUrl = process.env.APP_URL || process.env.API_URL || 'https://app.drivemateservice.com';
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
                                vehicleMake: true, vehicleModel: true, vehicleColor: true, licensePlate: true,
                            } as any,
                        },
                    },
                },
                customer: { select: { firstName: true } },
            },
        }) as any;

        if (!booking) throw new AppError('Tracking link not found or expired', 404);

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
            customerName: booking.customer?.firstName || 'Customer',
            driver: booking.driver ? {
                firstName: booking.driver.firstName,
                lastName: booking.driver.lastName,
                profileImage: booking.driver.profileImage,
                vehicle: booking.driver.driverProfile ? {
                    make: booking.driver.driverProfile.vehicleMake,
                    model: booking.driver.driverProfile.vehicleModel,
                    color: booking.driver.driverProfile.vehicleColor,
                    licensePlate: booking.driver.driverProfile.licensePlate,
                } : null,
                currentLocation: booking.driver.driverProfile ? {
                    latitude: booking.driver.driverProfile.currentLatitude ? Number(booking.driver.driverProfile.currentLatitude) : null,
                    longitude: booking.driver.driverProfile.currentLongitude ? Number(booking.driver.driverProfile.currentLongitude) : null,
                } : null,
            } : null,
            vehicleType: booking.vehicleType,
            tripType: booking.tripType,
            totalAmount: booking.totalAmount ? Number(booking.totalAmount) : null,
            scheduledTime: booking.scheduledTime,
            createdAt: booking.createdAt,
        };
    }
}
