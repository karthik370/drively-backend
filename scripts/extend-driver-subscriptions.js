/**
 * extend-driver-subscriptions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Extends subscription by 1 month for all VERIFIED drivers whose subscription
 * has EXPIRED or is about to expire.
 *
 * Logic:
 *   - Finds all verified drivers (documentsVerified = true)
 *   - Whose subscription status = EXPIRED  OR  validUntil < now
 *   - Sets status = ACTIVE, validUntil = now + 30 days
 *
 * Usage:
 *   node scripts/extend-driver-subscriptions.js           ← dry run (preview)
 *   node scripts/extend-driver-subscriptions.js --apply   ← actually update DB
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes('--apply');

async function main() {
  console.log('\n🔄 Driver Subscription Extension Script');
  console.log('=========================================');

  if (DRY_RUN) {
    console.log('⚠️  DRY RUN MODE — no changes will be made');
    console.log('    Run with --apply to actually update subscriptions\n');
  } else {
    console.log('✅ APPLY MODE — changes WILL be written to DB\n');
  }

  const now = new Date();
  const newValidUntil = new Date(now);
  newValidUntil.setDate(newValidUntil.getDate() + 30); // +30 days from today

  // ── Find all verified drivers with expired/inactive subscriptions ──────────
  const expiredSubscriptions = await prisma.driverSubscription.findMany({
    where: {
      // Subscription is expired or past validUntil
      OR: [
        { status: 'EXPIRED' },
        { status: 'INACTIVE' },
        {
          status: 'ACTIVE',
          validUntil: { lt: now }, // still marked ACTIVE but actually expired
        },
      ],
      // Only for verified drivers
      driver: {
        documentsVerified: true,
      },
    },
    include: {
      driver: {
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phoneNumber: true,
            },
          },
        },
      },
    },
    orderBy: { updatedAt: 'asc' },
  });

  if (expiredSubscriptions.length === 0) {
    console.log('✅ No expired subscriptions found for verified drivers.');
    console.log('   All verified drivers are currently active!\n');
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${expiredSubscriptions.length} expired subscription(s) to extend:\n`);
  console.log('─'.repeat(80));

  let extended = 0;
  let failed = 0;

  for (const sub of expiredSubscriptions) {
    const driver = sub.driver;
    const user = driver?.user;
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Unknown';
    const phone = user?.phoneNumber || 'N/A';
    const oldStatus = sub.status;
    const oldValidUntil = sub.validUntil
      ? sub.validUntil.toLocaleDateString('en-IN')
      : 'Not set';

    console.log(`  Driver : ${name} (${phone})`);
    console.log(`  Status : ${oldStatus} → ACTIVE`);
    console.log(`  Until  : ${oldValidUntil} → ${newValidUntil.toLocaleDateString('en-IN')}`);

    if (!DRY_RUN) {
      try {
        await prisma.driverSubscription.update({
          where: { id: sub.id },
          data: {
            status: 'ACTIVE',
            validUntil: newValidUntil,
          },
        });
        console.log(`  ✅ Extended successfully`);
        extended++;
      } catch (err) {
        console.log(`  ❌ Failed: ${err.message}`);
        failed++;
      }
    } else {
      console.log(`  ⏭️  (dry run — skipped)`);
      extended++;
    }

    console.log('─'.repeat(80));
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n📊 Summary');
  console.log('===========');
  console.log(`  Total found   : ${expiredSubscriptions.length}`);

  if (DRY_RUN) {
    console.log(`  Would extend  : ${extended}`);
    console.log('\n  Run with --apply to apply changes:');
    console.log('  node scripts/extend-driver-subscriptions.js --apply\n');
  } else {
    console.log(`  Extended      : ${extended}`);
    console.log(`  Failed        : ${failed}`);
    console.log(`  New validUntil: ${newValidUntil.toLocaleDateString('en-IN')}\n`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('\n❌ Script failed:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
