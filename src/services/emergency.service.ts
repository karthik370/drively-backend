import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { sendExpoPushNotification } from './expoPush.service';

export class EmergencyService {
    /**
     * Trigger an SOS emergency — logs to DB, notifies admin via push.
     */
    static async triggerSOS(params: {
        userId: string;
        bookingId: string;
        latitude: number;
        longitude: number;
    }) {
        const { userId, bookingId, latitude, longitude } = params;

        // Verify booking belongs to user
        const booking = await prisma.booking.findUnique({
            where: { id: bookingId },
            select: { id: true, customerId: true, driverId: true, status: true, bookingNumber: true },
        });

        if (!booking) throw new AppError('Booking not found', 404);
        if (booking.customerId !== userId && booking.driverId !== userId) {
            throw new AppError('Unauthorized', 403);
        }

        // Resolve active statuses that can have SOS
        const activeStatuses = ['ACCEPTED', 'DRIVER_ARRIVING', 'ARRIVED', 'STARTED', 'IN_PROGRESS'];
        if (!activeStatuses.includes(booking.status)) {
            throw new AppError('SOS can only be triggered on an active booking', 400);
        }

        // Create emergency record
        const emergency = await prisma.emergency.create({
            data: {
                bookingId,
                triggeredById: userId,
                locationLat: latitude,
                locationLng: longitude,
                status: 'ACTIVE',
                contactedAuthorities: false,
                policeNotified: false,
            } as any,
        });

        logger.warn('🚨 SOS TRIGGERED', {
            emergencyId: emergency.id,
            userId,
            bookingId,
            bookingNumber: booking.bookingNumber,
            lat: latitude,
            lng: longitude,
        });

        // Notify the other party in the booking via push
        try {
            const otherUserId = booking.customerId === userId ? booking.driverId : booking.customerId;
            if (otherUserId) {
                await sendExpoPushNotification({
                    userIds: [otherUserId],
                    title: '🚨 SOS Alert',
                    body: 'An emergency has been triggered on your current trip. Please check in.',
                    data: { kind: 'sos', bookingId, emergencyId: emergency.id },
                });
            }
        } catch (err) {
            logger.warn('Failed to send SOS push notification', { error: err });
        }

        return {
            emergencyId: emergency.id,
            bookingId,
            status: 'ACTIVE',
            timestamp: (emergency as any).timestamp,
        };
    }

    /**
     * Resolve an active emergency.
     */
    static async resolveEmergency(emergencyId: string, userId: string) {
        const emergency = await prisma.emergency.findUnique({
            where: { id: emergencyId },
            select: { id: true, triggeredById: true, status: true, bookingId: true },
        });

        if (!emergency) throw new AppError('Emergency not found', 404);
        if (emergency.triggeredById !== userId) throw new AppError('Unauthorized', 403);
        if ((emergency as any).status === 'RESOLVED') throw new AppError('Already resolved', 400);

        await prisma.emergency.update({
            where: { id: emergencyId },
            data: {
                status: 'RESOLVED',
                resolvedAt: new Date(),
                resolution: 'User marked safe',
            } as any,
        });

        logger.info('✅ Emergency resolved', { emergencyId, userId });
        return { emergencyId, status: 'RESOLVED' };
    }

    /**
     * Get active emergencies — for admin.
     */
    static async getActiveEmergencies() {
        const emergencies = await prisma.emergency.findMany({
            where: { status: 'ACTIVE' } as any,
            orderBy: { timestamp: 'desc' } as any,
            include: {
                triggeredBy: {
                    select: { firstName: true, lastName: true, phoneNumber: true },
                },
                booking: {
                    select: { bookingNumber: true, status: true, pickupAddress: true },
                },
            } as any,
        });

        return emergencies.map((e: any) => ({
            id: e.id,
            bookingId: e.bookingId,
            bookingNumber: e.booking?.bookingNumber,
            pickupAddress: e.booking?.pickupAddress,
            triggeredBy: {
                name: `${e.triggeredBy?.firstName} ${e.triggeredBy?.lastName || ''}`.trim(),
                phone: e.triggeredBy?.phoneNumber,
            },
            location: {
                latitude: e.locationLat ? Number(e.locationLat) : null,
                longitude: e.locationLng ? Number(e.locationLng) : null,
            },
            status: e.status,
            timestamp: e.timestamp,
        }));
    }

    /**
     * Get/set emergency contacts from the user's CustomerProfile.
     */
    static async getEmergencyContacts(userId: string) {
        const profile = await prisma.customerProfile.findUnique({
            where: { userId },
            select: { emergencyContacts: true },
        });

        if (!profile) return [];
        const contacts = profile.emergencyContacts as any[];
        return Array.isArray(contacts) ? contacts : [];
    }

    static async saveEmergencyContacts(userId: string, contacts: Array<{ id: string; name: string; phone: string }>) {
        if (contacts.length > 5) throw new AppError('Maximum 5 emergency contacts allowed', 400);

        // Validate each contact
        for (const c of contacts) {
            if (!c.name?.trim()) throw new AppError('Each contact must have a name', 400);
            const digits = c.phone?.replace(/\D/g, '') || '';
            if (digits.length < 10) throw new AppError(`Invalid phone number for ${c.name}`, 400);
        }

        await prisma.customerProfile.upsert({
            where: { userId },
            update: { emergencyContacts: contacts as any },
            create: {
                userId,
                emergencyContacts: contacts as any,
                preferences: {},
            } as any,
        });

        return contacts;
    }
}
