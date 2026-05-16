import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const phoneNumber = '+919133616534';
  const amount = 500;

  console.log(`Looking up user with phone number ${phoneNumber}...`);
  const user = await prisma.user.findUnique({
    where: { phoneNumber },
    include: { driverProfile: true },
  });

  if (!user) {
    console.error(`User with phone number ${phoneNumber} not found.`);
    return;
  }

  if (!user.driverProfile) {
    console.error(`User ${phoneNumber} exists but does not have a DriverProfile.`);
    return;
  }

  const driverId = user.id;

  // Create a manual payment record
  const payment = await prisma.payment.create({
    data: {
      userId: user.id,
      amount: amount,
      paymentMethod: 'CASH', // or MANUAL/UPI depending on schema, CASH is safe
      status: 'PAID',
      gatewayTransactionId: 'MANUAL_' + Date.now(),
      processedAt: new Date(),
    },
  });

  console.log(`Created payment record: ${payment.id}`);

  // Calculate validity (e.g., 30 days from now)
  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + 30);

  // Upsert the subscription
  const subscription = await prisma.driverSubscription.upsert({
    where: { driverId: driverId },
    update: {
      status: 'ACTIVE',
      planPrice: amount,
      validUntil: validUntil,
      lastPaymentId: payment.id,
    },
    create: {
      driverId: driverId,
      status: 'ACTIVE',
      planPrice: amount,
      validUntil: validUntil,
      lastPaymentId: payment.id,
    },
  });

  console.log(`Successfully activated subscription for driver ${user.firstName} ${user.lastName} (Phone: ${phoneNumber}).`);
  console.log(`Subscription ID: ${subscription.id}`);
  console.log(`Valid Until: ${validUntil.toISOString()}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
