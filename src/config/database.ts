import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

// ── Connection URL resolution ─────────────────────────────────────────────────
// When PGBOUNCER_URL is set (Railway PgBouncer service), we connect through it.
// PgBouncer manages the real PostgreSQL pool, so:
//   - connection_limit=50      → app opens 50 connections TO PgBouncer (cheap)
//   - pgbouncer=true           → disables Prisma prepared statements (required for
//                                PgBouncer transaction mode — without this, you get
//                                "prepared statement already exists" errors)
//   - statement_cache_size=0   → double-ensures no prepared statements leak through
//
// When only DATABASE_URL is set (direct to PostgreSQL):
//   - connection_limit=25      → safe for 1 Railway replica (leaves room for admin tools)
//   - pool_timeout=30          → queued requests error after 30s instead of hanging forever
//
// Multi-replica tip: with PgBouncer, keep connection_limit=50 per replica (PgBouncer absorbs it).
//                    Without PgBouncer, reduce per replica (2 replicas = 12 each, etc.)

const PGBOUNCER_URL = typeof process.env.PGBOUNCER_URL === 'string' ? process.env.PGBOUNCER_URL.trim() : '';
const DATABASE_URL  = typeof process.env.DATABASE_URL  === 'string' ? process.env.DATABASE_URL.trim()  : '';

const buildDatabaseUrl = (): string | undefined => {
  if (PGBOUNCER_URL) {
    // Through PgBouncer — disable prepared statements, generous app-side pool
    const sep = PGBOUNCER_URL.includes('?') ? '&' : '?';
    return `${PGBOUNCER_URL}${sep}pgbouncer=true&statement_cache_size=0&connection_limit=50&pool_timeout=30`;
  }
  if (DATABASE_URL) {
    // Direct to PostgreSQL — conservative pool to protect the DB
    const sep = DATABASE_URL.includes('?') ? '&' : '?';
    return `${DATABASE_URL}${sep}connection_limit=25&pool_timeout=30`;
  }
  return undefined;
};

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? ['query', 'error', 'warn']
    : ['error'],
  datasources: {
    db: {
      url: buildDatabaseUrl(),
    },
  },
});

prisma.$connect()
  .then(() => {
    const mode = PGBOUNCER_URL ? 'PgBouncer (pool=50)' : 'Direct PostgreSQL (pool=25)';
    logger.info(`Database connected successfully [${mode}]`);
  })
  .catch((error) => {
    logger.error('Database connection failed:', error);
    process.exit(1);
  });

process.on('beforeExit', async () => {
  await prisma.$disconnect();
  logger.info('Database disconnected');
});

export default prisma;

