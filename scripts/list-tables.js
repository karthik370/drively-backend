// list-tables.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

p.$queryRawUnsafe("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name")
  .then(r => {
    console.log('Tables in DB:');
    r.forEach(x => console.log(' -', x.table_name));
    p.$disconnect();
  })
  .catch(e => {
    console.error('Error:', e.message);
    p.$disconnect();
  });
