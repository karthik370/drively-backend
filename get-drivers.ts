import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const drivers = await prisma.user.findMany({
    where: { userType: 'DRIVER' },
    select: {
      phoneNumber: true,
      firstName: true,
      lastName: true,
      driverProfile: {
        select: {
          documentsVerified: true,
          subscription: {
            select: { status: true, validUntil: true }
          }
        }
      }
    }
  });

  console.log('\n=== ALL DRIVERS ===\n');
  for (const d of drivers) {
    const sub = d.driverProfile?.subscription;
    const subStatus = sub ? `${sub.status} (until ${sub.validUntil?.toISOString().split('T')[0] || 'N/A'})` : 'NO SUBSCRIPTION';
    const docsVerified = d.driverProfile?.documentsVerified ? '✅' : '❌';
    console.log(`📱 ${d.phoneNumber}  |  ${d.firstName} ${d.lastName}  |  Docs: ${docsVerified}  |  Sub: ${subStatus}`);
  }
  console.log(`\nTotal drivers: ${drivers.length}\n`);
}

main().finally(() => prisma.$disconnect());
