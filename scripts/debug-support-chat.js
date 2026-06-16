const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // Check if ANY support chat notifications exist at all
  const total = await p.notification.count({ where: { title: 'Need Help' } });
  console.log('Total "Need Help" notifications in DB:', total);

  // Check with the specific bookingId and userId from the logs
  const bookingId = '1fd4eba5-52f9-4d6f-8a23-c804081a5635';
  const userId = 'c740d09d-5d3e-41a2-ab5f-78f52212e7fe';

  const forUser = await p.notification.findMany({
    where: { userId, title: 'Need Help' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, body: true, data: true, createdAt: true },
  });

  console.log('\nNotifications for user', userId, ':');
  console.log(JSON.stringify(forUser, null, 2));

  // Also check ALL recent Need Help notifs regardless of userId
  const allRecent = await p.notification.findMany({
    where: { title: 'Need Help' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, userId: true, body: true, data: true, createdAt: true },
  });
  console.log('\nAll recent "Need Help" notifications:');
  console.log(JSON.stringify(allRecent, null, 2));
}

main().catch(console.error).finally(() => p.$disconnect());
