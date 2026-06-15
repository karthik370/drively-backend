#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 *  broadcast-notification.js
 *  Send a push notification to ALL registered users (or a specific
 *  audience) who have an active Expo push token in the database.
 *
 *  USAGE:
 *    node scripts/broadcast-notification.js
 *
 *  CUSTOMIZE the message below in the ── CONFIG ── section.
 * ═══════════════════════════════════════════════════════════════════
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────
// ✏️  CONFIG — EDIT THIS SECTION BEFORE RUNNING
// ─────────────────────────────────────────────────────────────────

const NOTIFICATION = {
  title: '🎉 MG',        // ← notification title
  body: 'EP', // ← notification body / message
  data: {                                           // ← optional extra data (opens a screen)
    screen: 'Home',                                 //    e.g. 'Home', 'Wallet', 'Offers'
    type: 'broadcast',
  },
};

// WHO to send to:
//   'all'       → every user with an active push token (customers + drivers)
//   'customers' → only customers (role = CUSTOMER)
//   'drivers'   → only drivers   (role = DRIVER)
const AUDIENCE = 'all'; // ← change to 'customers' or 'drivers' if needed

// ─────────────────────────────────────────────────────────────────
// END OF CONFIG — no need to touch anything below this line
// ─────────────────────────────────────────────────────────────────

const isExpoToken = (t) => {
  const s = String(t || '').trim();
  return s.startsWith('ExponentPushToken[') || s.startsWith('ExpoPushToken[');
};

const chunk = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
};

async function main() {
  console.log('\n══════════════════════════════════════════════');
  console.log('  📣  Drively Broadcast Notification Script');
  console.log('══════════════════════════════════════════════');
  console.log(`  Audience : ${AUDIENCE}`);
  console.log(`  Title    : ${NOTIFICATION.title}`);
  console.log(`  Message  : ${NOTIFICATION.body}`);
  console.log('──────────────────────────────────────────────\n');

  // 1. Fetch all active push tokens (with user role filter if needed)
  const whereClause = { isActive: true };

  let roleFilter = null;
  if (AUDIENCE === 'customers') roleFilter = 'CUSTOMER';
  if (AUDIENCE === 'drivers') roleFilter = 'DRIVER';

  let tokens = [];
  if (roleFilter) {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT t.token, u."firstName", u."phoneNumber", u."userType"
      FROM expo_push_tokens t
      JOIN users u ON u.id = t."userId"
      WHERE t."isActive" = true
        AND u."userType" = $1
    `, roleFilter);
    tokens = rows.map(r => ({ token: r.token, name: r.firstName, phone: r.phoneNumber }));
  } else {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT t.token, u."firstName", u."phoneNumber", u."userType"
      FROM expo_push_tokens t
      JOIN users u ON u.id = t."userId"
      WHERE t."isActive" = true
    `);
    tokens = rows.map(r => ({ token: r.token, name: r.firstName, phone: r.phoneNumber }));
  }

  // Filter to valid Expo tokens only
  const validTokens = tokens.filter(t => isExpoToken(t.token));

  console.log(`📊  Total active tokens found : ${tokens.length}`);
  console.log(`✅  Valid Expo tokens         : ${validTokens.length}`);

  if (validTokens.length === 0) {
    console.log('\n⚠️  No valid push tokens found. Nobody to notify.');
    console.log('   Make sure users have opened the app at least once after install.');
    return;
  }

  // Preview first 5 recipients
  console.log('\n👥  Sample recipients:');
  validTokens.slice(0, 5).forEach((t, i) => {
    console.log(`   ${i + 1}. ${t.name || 'Unknown'} (${t.phone || '—'}) → ${String(t.token).substring(0, 45)}...`);
  });
  if (validTokens.length > 5) console.log(`   ... and ${validTokens.length - 5} more`);

  // 2. Build message payloads
  const messages = validTokens.map(({ token }) => ({
    to: token,
    sound: 'default',
    title: NOTIFICATION.title,
    body: NOTIFICATION.body,
    data: NOTIFICATION.data || {},
    priority: 'high',
    channelId: 'default',
  }));

  // 3. Send in chunks of 90 (Expo's recommended max per request)
  const chunks = chunk(messages, 90);
  let totalSent = 0;
  let totalFailed = 0;

  console.log(`\n🚀  Sending in ${chunks.length} batch(es) of up to 90...`);

  for (let ci = 0; ci < chunks.length; ci++) {
    const batch = chunks[ci];
    process.stdout.write(`   Batch ${ci + 1}/${chunks.length} (${batch.length} tokens)... `);

    try {
      const res = await axios.post('https://exp.host/--/api/v2/push/send', batch, {
        timeout: 20000,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
      });

      const results = res?.data?.data || [];
      const ok = results.filter(r => r?.status === 'ok').length;
      const errors = results.filter(r => r?.status === 'error');

      totalSent += ok;
      totalFailed += errors.length;

      console.log(`✓  ${ok} delivered${errors.length ? `, ${errors.length} failed` : ''}`);

      if (errors.length) {
        errors.slice(0, 3).forEach(e => {
          console.log(`     ⚠  ${e?.details?.error || e?.message || JSON.stringify(e)}`);
        });
      }

    } catch (err) {
      totalFailed += batch.length;
      console.log(`✗  ERROR: ${err?.message}`);
    }

    // Small delay between batches to be polite to Expo servers
    if (ci < chunks.length - 1) await new Promise(r => setTimeout(r, 200));
  }

  // 4. Summary
  console.log('\n══════════════════════════════════════════════');
  console.log(`  ✅  Delivered : ${totalSent}`);
  console.log(`  ❌  Failed    : ${totalFailed}`);
  console.log(`  📩  Total     : ${validTokens.length}`);
  console.log('══════════════════════════════════════════════\n');
}

main()
  .catch(err => {
    console.error('\n❌  Fatal error:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
