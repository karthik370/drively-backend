// check-push-tokens.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

p.$queryRawUnsafe(`
  SELECT t.token, t.platform, t."isActive", t."createdAt", u."firstName", u."phoneNumber"
  FROM expo_push_tokens t
  JOIN users u ON u.id = t."userId"
  ORDER BY t."createdAt" DESC
  LIMIT 20
`)
  .then(r => {
    console.log(`\n📊 Registered push tokens: ${r.length}`);
    if (r.length === 0) {
      console.log('⚠️  NO push tokens found in DB!');
      console.log('   This is why notifications are not being delivered.');
      console.log('   Open the dev build app — it will now auto-register the token.');
    } else {
      r.forEach((t, i) => {
        console.log(`  ${i+1}. ${t.firstName} (${t.phoneNumber}) | active=${t.isActive} | platform=${t.platform}`);
        console.log(`       token: ${String(t.token).substring(0,50)}...`);
      });
    }
    p.$disconnect();
  })
  .catch(e => {
    console.error('Error:', e.message);
    p.$disconnect();
  });
