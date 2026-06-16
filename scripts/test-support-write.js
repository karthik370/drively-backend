// Test writing a support chat notification directly to DB
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const userId = 'c740d09d-5d3e-41a2-ab5f-78f52212e7fe';
  const bookingId = '1fd4eba5-52f9-4d6f-8a23-c804081a5635';

  // First check if user exists
  const user = await p.user.findUnique({ where: { id: userId }, select: { id: true, phoneNumber: true } });
  console.log('User exists?', user ? 'YES' : 'NO', user);

  if (!user) {
    console.log('Cannot write - user does not exist');
    return;
  }

  // Try writing a test notification with clientMessageId = null (our fix)
  console.log('\nTrying createMany with clientMessageId: null...');
  try {
    const result = await p.notification.createMany({
      data: [{
        userId,
        type: 'SYSTEM',
        title: 'Need Help',
        body: 'Test message from debug script',
        data: {
          kind: 'support_chat',
          bookingId,
          threadUserId: userId,
          senderId: userId,
          clientMessageId: null,
        },
      }],
    });
    console.log('SUCCESS - created:', result);
  } catch (err) {
    console.error('FAILED with null clientMessageId:', err.message);
  }

  // Try writing with clientMessageId as a string
  console.log('\nTrying createMany with clientMessageId: string...');
  try {
    const result = await p.notification.createMany({
      data: [{
        userId,
        type: 'SYSTEM',
        title: 'Need Help',
        body: 'Test message 2 from debug script',
        data: {
          kind: 'support_chat',
          bookingId,
          threadUserId: userId,
          senderId: userId,
          clientMessageId: `${userId}-${Date.now()}-test`,
        },
      }],
    });
    console.log('SUCCESS - created:', result);
  } catch (err) {
    console.error('FAILED with string clientMessageId:', err.message);
  }

  // Try writing with clientMessageId: undefined (the original broken way)
  console.log('\nTrying createMany with clientMessageId: undefined...');
  try {
    const result = await p.notification.createMany({
      data: [{
        userId,
        type: 'SYSTEM',
        title: 'Need Help',
        body: 'Test message 3 from debug script',
        data: {
          kind: 'support_chat',
          bookingId,
          threadUserId: userId,
          senderId: userId,
          clientMessageId: undefined,
        },
      }],
    });
    console.log('SUCCESS - created:', result);
  } catch (err) {
    console.error('FAILED with undefined clientMessageId:', err.message);
  }

  // Verify what was written
  const written = await p.notification.findMany({
    where: { userId, title: 'Need Help' },
    select: { id: true, body: true, data: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  console.log('\nFinal notifications in DB:', JSON.stringify(written, null, 2));
}

main().catch(console.error).finally(() => p.$disconnect());
