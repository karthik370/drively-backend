const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.notification.deleteMany({ where: { title: 'Need Help', body: { contains: 'debug script' } } })
  .then(r => console.log('Deleted test records:', r))
  .finally(() => p.$disconnect());
