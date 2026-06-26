const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // Check the ROUND_TRIP booking
  const b = await p.booking.findFirst({
    where: { bookingNumber: { contains: 'cmqtow14' } },
    select: { id: true, tripType: true, bookingNumber: true },
  });
  console.log('Booking:', JSON.stringify(b));

  // Check platform fee payment records for that booking
  if (b) {
    const fees = await p.payment.findMany({
      where: {
        bookingId: b.id,
        gatewayResponse: { path: ['purpose'], equals: 'DRIVER_PLATFORM_FEE' },
      },
      select: { id: true, amount: true, gatewayResponse: true },
    });
    console.log('Fee records:', JSON.stringify(fees));

    // Check driverProfile platformFeesTotal
    const booking2 = await p.booking.findUnique({
      where: { id: b.id },
      select: { driverId: true },
    });
    if (booking2?.driverId) {
      const prof = await p.driverProfile.findUnique({
        where: { userId: booking2.driverId },
        select: { platformFeesTotal: true, walletTopupTotal: true, totalEarnings: true },
      });
      console.log('DriverProfile:', JSON.stringify(prof));
    }
  }
}

main().then(() => p.$disconnect()).catch(e => { console.error(e); p.$disconnect(); });
