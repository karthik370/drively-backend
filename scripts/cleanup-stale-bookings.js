// cleanup-stale-bookings.js
// Run with: node scripts/cleanup-stale-bookings.js
// Cancels all REQUESTED/SEARCHING bookings with no driver and no scheduled time

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('🔌 Connecting to database...');

  // First, show what will be affected
  const staleBookings = await prisma.booking.findMany({
    where: {
      status: { in: ['REQUESTED', 'SEARCHING'] },
      driverId: null,
      scheduledTime: null,
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      pickupAddress: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`\n📋 Found ${staleBookings.length} stale booking(s) to cancel`);

  if (staleBookings.length === 0) {
    console.log('✅ Nothing to clean up. Done!');
    return;
  }

  console.log('\nBookings to be cancelled:');
  staleBookings.forEach((b, i) => {
    console.log(`  ${i + 1}. [${b.status}] id=${b.id} | created=${b.createdAt.toISOString()} | pickup=${b.pickupAddress}`);
  });

  // Cancel them all
  const result = await prisma.booking.updateMany({
    where: {
      status: { in: ['REQUESTED', 'SEARCHING'] },
      driverId: null,
      scheduledTime: null,
    },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelledBy: 'CUSTOMER',
      cancellationReason: 'Manual cleanup: stale booking',
    },
  });

  console.log(`\n✅ Successfully cancelled ${result.count} stale booking(s)`);
}

main()
  .catch((err) => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log('🔌 Disconnected from database');
  });
