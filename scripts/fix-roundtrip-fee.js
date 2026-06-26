/**
 * One-time fix: correct the platform fee for booking cmqtow14 (ROUND_TRIP).
 * The deduction was stored as ONE_WAY=₹10 instead of ROUND_TRIP=₹20.
 * 
 * Fix:
 * 1. Update the Payment record amount to ₹20 and fix the gatewayResponse
 * 2. Increment platformFeesTotal by ₹10 more (from 20 → 30)
 */
const { PrismaClient, Prisma } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // Find the booking
  const booking = await p.booking.findFirst({
    where: { bookingNumber: { contains: 'cmqtow14' } },
    select: { id: true, tripType: true, bookingNumber: true, driverId: true },
  });

  if (!booking) { console.log('Booking not found'); return; }
  console.log('Found booking:', booking.tripType, booking.id);

  if (booking.tripType !== 'ROUND_TRIP') {
    console.log('Not a ROUND_TRIP booking, skipping');
    return;
  }

  // Find the wrong payment record
  const feePayment = await p.payment.findFirst({
    where: {
      bookingId: booking.id,
      gatewayResponse: { path: ['purpose'], equals: 'DRIVER_PLATFORM_FEE' },
    },
    select: { id: true, amount: true, gatewayResponse: true },
  });

  if (!feePayment) { console.log('No fee payment found'); return; }
  console.log('Current fee:', feePayment.amount, 'gateway:', feePayment.gatewayResponse);

  if (Number(feePayment.amount) >= 20) {
    console.log('Fee already correct, skipping');
    return;
  }

  // Fix in a transaction
  await p.$transaction(async (tx) => {
    // Update the payment record
    await tx.payment.update({
      where: { id: feePayment.id },
      data: {
        amount: new Prisma.Decimal(20),
        gatewayResponse: {
          purpose: 'DRIVER_PLATFORM_FEE',
          tripType: 'ROUND_TRIP',
          feeAmount: 20,
          driverId: booking.driverId,
          correctedAt: new Date().toISOString(),
        },
      },
    });

    // Increment platformFeesTotal by 10 more (10 was already added, need 20 total)
    await tx.driverProfile.update({
      where: { userId: booking.driverId },
      data: {
        platformFeesTotal: { increment: 10 },
      },
    });
  });

  console.log('✅ Fixed! ROUND_TRIP booking now correctly shows ₹20 platform fee');

  // Verify
  const after = await p.driverProfile.findUnique({
    where: { userId: booking.driverId },
    select: { platformFeesTotal: true },
  });
  console.log('New platformFeesTotal:', after?.platformFeesTotal);
}

main().then(() => p.$disconnect()).catch(e => { console.error(e); p.$disconnect(); });
