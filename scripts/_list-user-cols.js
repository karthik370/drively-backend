const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

p.$queryRawUnsafe(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'users' ORDER BY ordinal_position
`)
.then(r => {
  console.log('Users table columns:');
  r.forEach(c => console.log(' -', c.column_name));
  p.$disconnect();
})
.catch(e => { console.error(e.message); p.$disconnect(); });
