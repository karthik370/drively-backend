import { PrismaClient, UserType, Gender, VehicleType, BookingStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { hashPassword } from '../src/utils/encryption';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seeding...');

  // Create sample customers
  console.log('Creating customers...');
  const customer1 = await prisma.user.create({
    data: {
      phoneNumber: '+919876543210',
      phoneVerified: true,
      email: 'customer1@drivemate.com',
      emailVerified: true,
      firstName: 'Rajesh',
      lastName: 'Kumar',
      dateOfBirth: new Date('1990-05-15'),
      gender: Gender.MALE,
      userType: UserType.CUSTOMER,
      isVerified: true,
      rating: 4.5,
      totalRatings: 20,
      customerProfile: {
        create: {
          savedAddresses: [
            {
              label: 'Home',
              street: '123 MG Road',
              city: 'Bangalore',
              state: 'Karnataka',
              postalCode: '560001',
              country: 'India',
              lat: 12.9716,
              lng: 77.5946,
              isDefault: true,
            },
          ],
        },
      },
    },
  });

  const customer2 = await prisma.user.create({
    data: {
      phoneNumber: '+919876543211',
      phoneVerified: true,
      email: 'priya.sharma@drivemate.com',
      emailVerified: true,
      firstName: 'Priya',
      lastName: 'Sharma',
      dateOfBirth: new Date('1995-08-20'),
      gender: Gender.FEMALE,
      userType: UserType.CUSTOMER,
      isVerified: true,
      rating: 4.8,
      totalRatings: 15,
      customerProfile: {
        create: {
          savedAddresses: [
            {
              label: 'Office',
              street: '456 Brigade Road',
              city: 'Bangalore',
              state: 'Karnataka',
              postalCode: '560025',
              country: 'India',
              lat: 12.9698,
              lng: 77.6016,
              isDefault: true,
            },
          ],
        },
      },
    },
  });

  // Create sample drivers
  console.log('Creating drivers...');
  const driver1 = await prisma.user.create({
    data: {
      phoneNumber: '+919876543212',
      phoneVerified: true,
      email: 'driver1@drivemate.com',
      emailVerified: true,
      firstName: 'Amit',
      lastName: 'Singh',
      dateOfBirth: new Date('1988-03-10'),
      gender: Gender.MALE,
      userType: UserType.DRIVER,
      isVerified: true,
      rating: 4.7,
      totalRatings: 150,
      driverProfile: {
        create: {
          licenseNumber: 'KA0120230001234',
          licenseExpiryDate: new Date('2028-03-10'),
          licenseImageUrl: 'https://example.com/licenses/driver1-license.jpg',
          aadhaarNumber: '1234-5678-9012',
          aadhaarImageUrl: 'https://example.com/aadhaar/driver1-aadhaar.jpg',
          panNumber: 'ABCDE1234F',
          panImageUrl: 'https://example.com/pan/driver1-pan.jpg',
          bankAccountNumber: '1234567890',
          bankIfscCode: 'SBIN0001234',
          bankAccountHolderName: 'Amit Singh',
          upiId: 'amit@paytm',
          isOnline: true,
          isAvailable: true,
          currentLocationLat: 12.9716,
          currentLocationLng: 77.5946,
          totalTrips: 500,
          totalEarnings: 125000.50,
          pendingEarnings: 5000.00,
          acceptanceRate: 92.5,
          cancellationRate: 2.5,
          documentsVerified: true,
        },
      },
    },
  });

  const driver2 = await prisma.user.create({
    data: {
      phoneNumber: '+919876543213',
      phoneVerified: true,
      email: 'driver2@drivemate.com',
      emailVerified: true,
      firstName: 'Mohammed',
      lastName: 'Khan',
      dateOfBirth: new Date('1985-11-25'),
      gender: Gender.MALE,
      userType: UserType.DRIVER,
      isVerified: true,
      rating: 4.9,
      totalRatings: 280,
      driverProfile: {
        create: {
          licenseNumber: 'KA0120230005678',
          licenseExpiryDate: new Date('2027-11-25'),
          licenseImageUrl: 'https://example.com/licenses/driver2-license.jpg',
          aadhaarNumber: '9876-5432-1098',
          aadhaarImageUrl: 'https://example.com/aadhaar/driver2-aadhaar.jpg',
          panNumber: 'XYZAB5678C',
          panImageUrl: 'https://example.com/pan/driver2-pan.jpg',
          bankAccountNumber: '0987654321',
          bankIfscCode: 'HDFC0004567',
          bankAccountHolderName: 'Mohammed Khan',
          upiId: 'khan@phonepe',
          isOnline: false,
          isAvailable: false,
          currentLocationLat: 12.9698,
          currentLocationLng: 77.6016,
          totalTrips: 850,
          totalEarnings: 215000.75,
          pendingEarnings: 8500.00,
          acceptanceRate: 95.8,
          cancellationRate: 1.2,
          documentsVerified: true,
        },
      },
    },
  });

  // Create vehicles
  console.log('Creating vehicles...');
  const vehicle1 = await prisma.vehicle.create({
    data: {
      registrationNumber: 'KA01AB1234',
      make: 'Maruti Suzuki',
      model: 'Swift Dzire',
      year: 2022,
      vehicleType: VehicleType.SEDAN,
      color: 'White',
      insurancePolicyNumber: 'INS123456789',
      insuranceExpiryDate: new Date('2025-12-31'),
      currentDriverId: driver1.id,
    },
  });

  const vehicle2 = await prisma.vehicle.create({
    data: {
      registrationNumber: 'KA01CD5678',
      make: 'Toyota',
      model: 'Innova Crysta',
      year: 2023,
      vehicleType: VehicleType.SUV,
      color: 'Silver',
      insurancePolicyNumber: 'INS987654321',
      insuranceExpiryDate: new Date('2026-06-30'),
      currentDriverId: driver2.id,
    },
  });

  // Update driver profiles with vehicle IDs
  await prisma.driverProfile.update({
    where: { userId: driver1.id },
    data: { currentVehicleId: vehicle1.id },
  });

  await prisma.driverProfile.update({
    where: { userId: driver2.id },
    data: { currentVehicleId: vehicle2.id },
  });

  // Create sample bookings
  console.log('Creating bookings...');
  const booking1 = await prisma.booking.create({
    data: {
      customerId: customer1.id,
      driverId: driver1.id,
      vehicleType: VehicleType.SEDAN,
      pickupAddress: '123 MG Road, Bangalore',
      pickupLocationLat: 12.9716,
      pickupLocationLng: 77.5946,
      dropAddress: '456 Whitefield, Bangalore',
      dropLocationLat: 12.9698,
      dropLocationLng: 77.7499,
      status: BookingStatus.COMPLETED,
      estimatedDistance: 15.5,
      estimatedDuration: 35,
      actualDistance: 16.2,
      actualDuration: 38,
      pricingBreakdown: {
        baseFare: 50.00,
        distanceFare: 162.00,
        timeFare: 38.00,
        platformFee: 30.00,
        gst: 15.00,
      },
      totalAmount: 295.00,
      driverEarnings: 259.60,
      platformCommission: 35.40,
      acceptedAt: new Date('2024-12-10T09:02:00Z'),
      startedAt: new Date('2024-12-10T09:15:00Z'),
      completedAt: new Date('2024-12-10T09:53:00Z'),
    },
  });

  const booking2 = await prisma.booking.create({
    data: {
      customerId: customer2.id,
      driverId: driver2.id,
      vehicleType: VehicleType.SUV,
      pickupAddress: '456 Brigade Road, Bangalore',
      pickupLocationLat: 12.9698,
      pickupLocationLng: 77.6016,
      dropAddress: '789 Koramangala, Bangalore',
      dropLocationLat: 12.9352,
      dropLocationLng: 77.6245,
      status: BookingStatus.COMPLETED,
      estimatedDistance: 8.5,
      estimatedDuration: 22,
      actualDistance: 9.1,
      actualDuration: 25,
      pricingBreakdown: {
        baseFare: 60.00,
        distanceFare: 136.50,
        timeFare: 25.00,
        platformFee: 26.58,
        gst: 13.29,
      },
      totalAmount: 261.37,
      driverEarnings: 229.60,
      platformCommission: 31.77,
      acceptedAt: new Date('2024-12-11T14:32:00Z'),
      startedAt: new Date('2024-12-11T14:45:00Z'),
      completedAt: new Date('2024-12-11T15:10:00Z'),
    },
  });

  // Create payments
  console.log('Creating payments...');
  await prisma.payment.create({
    data: {
      bookingId: booking1.id,
      userId: customer1.id,
      amount: 295.00,
      paymentMethod: PaymentMethod.UPI,
      status: PaymentStatus.PAID,
      gatewayTransactionId: 'TXN1234567890',
      processedAt: new Date('2024-12-10T09:55:00Z'),
    },
  });

  await prisma.payment.create({
    data: {
      bookingId: booking2.id,
      userId: customer2.id,
      amount: 261.37,
      paymentMethod: PaymentMethod.CARD,
      status: PaymentStatus.PAID,
      gatewayTransactionId: 'TXN0987654321',
      processedAt: new Date('2024-12-11T15:12:00Z'),
    },
  });

  // Create ratings
  console.log('Creating ratings...');
  await prisma.rating.create({
    data: {
      bookingId: booking1.id,
      ratedById: customer1.id,
      ratedUserId: driver1.id,
      rating: 5,
      review: 'Excellent service! Very professional and punctual.',
      categories: {
        behaviorRating: 5,
        drivingRating: 5,
        punctualityRating: 5,
      },
    },
  });

  await prisma.rating.create({
    data: {
      bookingId: booking2.id,
      ratedById: customer2.id,
      ratedUserId: driver2.id,
      rating: 5,
      review: 'Great driver, smooth ride. Highly recommended!',
      categories: {
        behaviorRating: 5,
        drivingRating: 5,
        punctualityRating: 5,
      },
    },
  });

  // Create promotion codes
  console.log('Creating promotions...');
  await prisma.promotion.create({
    data: {
      code: 'FIRST50',
      description: 'Get 50% off on your first ride',
      type: 'PERCENTAGE',
      value: 50.00,
      minOrderValue: 100.00,
      maxDiscount: 100.00,
      validFrom: new Date('2024-01-01'),
      validUntil: new Date('2025-12-31'),
      totalUsageLimit: 1000,
      currentUsageCount: 150,
      usageLimitPerUser: 1,
      applicableFor: UserType.CUSTOMER,
      isActive: true,
    },
  });

  await prisma.promotion.create({
    data: {
      code: 'WELCOME100',
      description: 'Welcome bonus - ₹100 off',
      type: 'FIXED_AMOUNT',
      value: 100.00,
      minOrderValue: 200.00,
      validFrom: new Date('2024-01-01'),
      validUntil: new Date('2025-12-31'),
      totalUsageLimit: 5000,
      currentUsageCount: 823,
      usageLimitPerUser: 3,
      applicableFor: UserType.CUSTOMER,
      isActive: true,
    },
  });

  // Create referral codes
  console.log('Creating referral codes...');
  await prisma.referralCode.create({
    data: {
      ownerId: customer1.id,
      code: 'RAJESH2024',
      ownerType: UserType.CUSTOMER,
      rewardAmount: 100.00,
      referrerReward: 100.00,
      refereeReward: 150.00,
      usageCount: 5,
      totalRewardsEarned: 500.00,
    },
  });

  await prisma.referralCode.create({
    data: {
      ownerId: driver1.id,
      code: 'AMIT2024',
      ownerType: UserType.DRIVER,
      rewardAmount: 200.00,
      referrerReward: 200.00,
      refereeReward: 100.00,
      usageCount: 8,
      totalRewardsEarned: 1600.00,
    },
  });

  // Create admin user
  console.log('Creating admin user...');
  await prisma.adminUser.create({
    data: {
      email: 'admin@drivemate.com',
      password: await hashPassword('Admin@123'),
      firstName: 'System',
      lastName: 'Admin',
      role: 'SUPER_ADMIN',
      isActive: true,
      permissions: ['ALL'],
    },
  });

  // Create app config
  console.log('Creating app configuration...');
  await prisma.appConfig.create({
    data: {
      key: 'pricing',
      value: {
        baseFare: 50,
        perKmRate: 12,
        perMinuteRate: 1,
        platformCommission: 12,
        gstRate: 5,
        surgePricing: {
          enabled: true,
          peakHours: ['08:00-10:00', '18:00-20:00'],
          multiplier: 1.5,
        },
      },
      description: 'Dynamic pricing configuration',
      isActive: true,
    },
  });

  console.log('✅ Database seeding completed successfully!');
  console.log('\n📊 Summary:');
  console.log('- 2 Customers created');
  console.log('- 2 Drivers created');
  console.log('- 2 Vehicles created');
  console.log('- 2 Bookings created');
  console.log('- 2 Payments created');
  console.log('- 2 Ratings created');
  console.log('- 2 Promotions created');
  console.log('- 2 Referral codes created');
  console.log('- 1 Admin user created (admin@drivemate.com / Admin@123)');
  console.log('- App configuration created');
  console.log('\n🔐 Test Accounts:');
  console.log('Customer: +919876543210');
  console.log('Driver: +919876543212');
  console.log('Admin: admin@drivemate.com / Admin@123');
}

main()
  .catch((e) => {
    console.error('❌ Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
