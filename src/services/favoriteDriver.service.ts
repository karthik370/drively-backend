import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';

export class FavoriteDriverService {
  /**
   * Add a driver to customerʼs favorites list.
   */
  static async addFavoriteDriver(customerId: string, driverId: string) {
    // Verify driver exists
    const driver = await prisma.user.findUnique({
      where: { id: driverId },
      select: { id: true, firstName: true, lastName: true, userType: true },
    });
    if (!driver || (driver.userType !== 'DRIVER' && driver.userType !== 'BOTH')) {
      throw new AppError('Driver not found', 404);
    }

    // Don't allow self-favoriting
    if (customerId === driverId) {
      throw new AppError('Cannot favorite yourself', 400);
    }

    const profile = await prisma.customerProfile.findUnique({
      where: { userId: customerId },
      select: { favoriteDriverIds: true },
    });

    if (!profile) {
      throw new AppError('Customer profile not found', 404);
    }

    const existing = Array.isArray(profile.favoriteDriverIds) ? profile.favoriteDriverIds : [];
    if (existing.includes(driverId)) {
      return { added: false, message: 'Driver already in favorites' };
    }

    await prisma.customerProfile.update({
      where: { userId: customerId },
      data: { favoriteDriverIds: [...existing, driverId] },
    });

    return { added: true, message: 'Driver added to favorites' };
  }

  /**
   * Remove a driver from customerʼs favorites.
   */
  static async removeFavoriteDriver(customerId: string, driverId: string) {
    const profile = await prisma.customerProfile.findUnique({
      where: { userId: customerId },
      select: { favoriteDriverIds: true },
    });

    if (!profile) {
      throw new AppError('Customer profile not found', 404);
    }

    const existing = Array.isArray(profile.favoriteDriverIds) ? profile.favoriteDriverIds : [];
    const filtered = existing.filter((id) => id !== driverId);

    if (filtered.length === existing.length) {
      return { removed: false, message: 'Driver was not in favorites' };
    }

    await prisma.customerProfile.update({
      where: { userId: customerId },
      data: { favoriteDriverIds: filtered },
    });

    return { removed: true, message: 'Driver removed from favorites' };
  }

  /**
   * Get all favorite drivers with their profile details.
   */
  static async getFavoriteDrivers(customerId: string) {
    const profile = await prisma.customerProfile.findUnique({
      where: { userId: customerId },
      select: { favoriteDriverIds: true },
    });

    if (!profile) {
      throw new AppError('Customer profile not found', 404);
    }

    const ids = Array.isArray(profile.favoriteDriverIds) ? profile.favoriteDriverIds : [];
    if (ids.length === 0) return [];

    const drivers = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phoneNumber: true,
        profileImage: true,
        rating: true,
        driverProfile: {
          select: {
            totalTrips: true,
            isExperienced: true,
            vehicleTypes: true,
          },
        },
      },
    });

    return drivers.map((d) => ({
      id: d.id,
      name: [d.firstName, d.lastName].filter(Boolean).join(' ') || 'Driver',
      phone: d.phoneNumber,
      photo: (d as any).profileImage || null,
      rating: typeof d.rating === 'number' ? d.rating : Number(d.rating || 0),
      totalTrips: d.driverProfile?.totalTrips ?? 0,
      isExperienced: d.driverProfile?.isExperienced ?? false,
      vehicleTypes: d.driverProfile?.vehicleTypes ?? [],
    }));
  }

  /**
   * Check if a specific driver is in favorites.
   */
  static async isFavorite(customerId: string, driverId: string): Promise<boolean> {
    const profile = await prisma.customerProfile.findUnique({
      where: { userId: customerId },
      select: { favoriteDriverIds: true },
    });
    const ids = Array.isArray(profile?.favoriteDriverIds) ? profile.favoriteDriverIds : [];
    return ids.includes(driverId);
  }
}
