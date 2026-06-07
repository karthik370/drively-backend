// ensure-push-token-table.js
// Run with: node scripts/ensure-push-token-table.js
// Creates ExpoPushToken table if it doesn't exist in the DB

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('🔌 Connecting to database...');

  // Check if table exists
  const tableCheck = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ExpoPushToken'`
  );
  
  const tableExists = Number(tableCheck[0] && tableCheck[0].count) > 0;
  console.log(`📋 ExpoPushToken table exists: ${tableExists}`);

  if (!tableExists) {
    console.log('⚠️  Creating ExpoPushToken table...');
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ExpoPushToken" (
        "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
        "userId"    TEXT NOT NULL,
        "token"     TEXT NOT NULL,
        "platform"  TEXT,
        "isActive"  BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ExpoPushToken_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "ExpoPushToken_token_key" UNIQUE ("token"),
        CONSTRAINT "ExpoPushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "ExpoPushToken_userId_idx" ON "ExpoPushToken"("userId")`
    );
    console.log('✅ ExpoPushToken table created!');
  }

  // Show current token count
  const countResult = await prisma.$queryRawUnsafe(`SELECT COUNT(*) as count FROM "ExpoPushToken"`);
  const tokenCount = countResult[0] ? countResult[0].count : 0;
  console.log(`\n📊 Current push tokens in DB: ${tokenCount}`);
  
  if (Number(tokenCount) > 0) {
    // List tokens
    const tokens = await prisma.$queryRawUnsafe(`
      SELECT t.token, t.platform, t."isActive", t."createdAt", u."firstName", u."phoneNumber"
      FROM "ExpoPushToken" t
      JOIN "User" u ON u.id = t."userId"
      ORDER BY t."createdAt" DESC
      LIMIT 20
    `);
    
    if (tokens.length > 0) {
      console.log('\nRegistered push tokens:');
      tokens.forEach((t, i) => {
        console.log(`  ${i + 1}. ${t.firstName} (${t.phoneNumber}) | ${String(t.token).substring(0, 40)}... | platform=${t.platform} | active=${t.isActive}`);
      });
    }
  } else {
    console.log('\n⚠️  No push tokens registered yet!');
    console.log('   → Open the app (dev build) to register tokens, then check logs for [PushToken] messages.');
  }
}

main()
  .catch((err) => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log('\n🔌 Done.');
  });
