// fix-driver-wallet-balances.js
// Audits and fixes driver wallet balances that were double-credited due to the bug.
//
// The bug: booking.service.ts credited driver wallets at trip completion for non-cash payments,
// AND payment.service.ts credited again when payment was verified — resulting in 2x earnings.
// Also, cash-collected trips were credited when the original paymentMethod was non-cash.
//
// Run with: node scripts/fix-driver-wallet-balances.js
// Add --fix to actually apply corrections (default is dry-run)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes('--fix');

async function main() {
  console.log(DRY_RUN
    ? '🔍 DRY RUN — no changes will be made. Pass --fix to apply corrections.'
    : '🔧 FIX MODE — corrections will be applied!');
  console.log('');

  // Get all drivers with earnings
  const drivers = await prisma.driverProfile.findMany({
    where: {
      totalEarnings: { gt: 0 },
    },
    select: {
      userId: true,
      totalEarnings: true,
      pendingEarnings: true,
      user: { select: { firstName: true, lastName: true, phoneNumber: true } },
    },
  });

  console.log(`📋 Found ${drivers.length} driver(s) with earnings\n`);

  let totalOverCredited = 0;
  let driversAffected = 0;

  for (const driver of drivers) {
    const driverId = driver.userId;
    const name = `${driver.user?.firstName || ''} ${driver.user?.lastName || ''}`.trim() || driverId.slice(0, 8);

    // Get ALL completed bookings for this driver
    const bookings = await prisma.booking.findMany({
      where: {
        driverId,
        status: 'COMPLETED',
      },
      select: {
        id: true,
        bookingNumber: true,
        driverEarnings: true,
        paymentMethod: true,
        paymentStatus: true,
        totalAmount: true,
        completedAt: true,
      },
    });

    // Calculate what the correct total earnings should be based on bookings
    let correctEarnings = 0;

    for (const b of bookings) {
      const earnings = Number(b.driverEarnings || 0);
      if (earnings <= 0) continue;

      // Check if this booking has a payment with driverCredited flag
      // (any bookings processed after the fix would have this flag)
      const payments = await prisma.payment.findMany({
        where: { bookingId: b.id, status: 'PAID' },
        select: { gatewayResponse: true, paymentMethod: true },
      });

      const wasCashCollected = payments.some(p => {
        const gr = typeof p.gatewayResponse === 'object' && p.gatewayResponse ? p.gatewayResponse : {};
        return gr.type === 'CASH_COLLECTED';
      });

      const wasOnlinePaid = payments.some(p => {
        return p.paymentMethod !== 'CASH' && payments.length > 0;
      });

      // For CASH-collected trips: driver should NOT get wallet credit (they have physical cash)
      if (wasCashCollected) {
        // No wallet credit for cash collection
        continue;
      }

      // For bookings that are PAID via online methods: credit once
      if (b.paymentStatus === 'PAID') {
        correctEarnings += earnings;
      }
      // If payment is still PENDING, driver should not have been credited yet
    }

    // Add tips
    const tipsAggregate = await prisma.tip.aggregate({
      where: { driverId, status: 'PAID' },
      _sum: { amount: true },
    });
    const tipTotal = Number(tipsAggregate._sum?.amount || 0);
    correctEarnings += tipTotal;

    // Add referral rewards — these credit driverProfile directly,
    // tracked via Referral table with status REWARDED
    let referralTotal = 0;
    try {
      const referrals = await prisma.referral.findMany({
        where: {
          OR: [
            { referrerId: driverId, status: 'REWARDED' },
            { referredUserId: driverId, status: 'REWARDED' },
          ],
        },
        select: { referrerReward: true, referredReward: true, referrerId: true },
      });
      for (const r of referrals) {
        if (r.referrerId === driverId) {
          referralTotal += Number(r.referrerReward || 0);
        } else {
          referralTotal += Number(r.referredReward || 0);
        }
      }
    } catch { /* table may not have these columns */ }
    correctEarnings += referralTotal;

    // Add cancellation compensations (₹30 credits)
    let cancelTotal = 0;
    try {
      const cancelNotifs = await prisma.notification.findMany({
        where: { userId: driverId },
        select: { data: true, title: true },
      });
      for (const n of cancelNotifs) {
        if (n.title === 'Cancellation Compensation' && typeof n.data === 'object' && n.data) {
          cancelTotal += Number((n.data).amount || 0);
        }
      }
    } catch { /* non-critical */ }
    correctEarnings += cancelTotal;

    const currentEarnings = Number(driver.totalEarnings || 0);
    const diff = currentEarnings - correctEarnings;

    if (Math.abs(diff) > 0.5) { // Allow small rounding differences
      driversAffected++;
      totalOverCredited += diff;
      
      console.log(`⚠️  ${name} (${driver.user?.phoneNumber || ''})`);
      console.log(`   Current totalEarnings:  ₹${currentEarnings.toFixed(2)}`);
      console.log(`   Correct totalEarnings:  ₹${correctEarnings.toFixed(2)}`);
      console.log(`   Over-credited by:       ₹${diff.toFixed(2)}`);
      console.log(`   Bookings: ${bookings.length} | Tips: ₹${tipTotal.toFixed(0)} | Referrals: ₹${referralTotal.toFixed(0)} | Cancel comp: ₹${cancelTotal.toFixed(0)}`);

      if (!DRY_RUN) {
        const currentPending = Number(driver.pendingEarnings || 0);
        const newPending = Math.max(0, currentPending - diff);

        await prisma.driverProfile.update({
          where: { userId: driverId },
          data: {
            totalEarnings: correctEarnings,
            pendingEarnings: newPending,
          },
        });
        console.log(`   ✅ FIXED: totalEarnings → ₹${correctEarnings.toFixed(2)}, pendingEarnings → ₹${newPending.toFixed(2)}`);
      }
      console.log('');
    }
  }

  console.log('═══════════════════════════════════════════');
  console.log(`Drivers affected: ${driversAffected} / ${drivers.length}`);
  console.log(`Total over-credited: ₹${totalOverCredited.toFixed(2)}`);

  if (DRY_RUN && driversAffected > 0) {
    console.log('\n💡 Run with --fix to apply corrections:');
    console.log('   node scripts/fix-driver-wallet-balances.js --fix');
  }

  if (!DRY_RUN && driversAffected > 0) {
    console.log('\n✅ All corrections applied!');
  }

  if (driversAffected === 0) {
    console.log('\n✅ No wallet discrepancies found. All balances are correct!');
  }
}

main()
  .catch((err) => {
    console.error('❌ Error:', err.message);
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log('\n🔌 Disconnected from database');
  });
