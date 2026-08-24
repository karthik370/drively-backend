import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

// ── Connection URL resolution ─────────────────────────────────────────────────
// Priority: PGBOUNCER_URL > DATABASE_URL
// If PgBouncer is unreachable at startup, server falls back to direct PostgreSQL
// instead of crashing.  A Proxy is used so all imports always see the live
// PrismaClient even after the instance is replaced during fallback.

const PGBOUNCER_URL = (process.env.PGBOUNCER_URL ?? '').trim();
const DATABASE_URL  = (process.env.DATABASE_URL  ?? '').trim();

const appendParams = (base: string, params: string): string =>
  `${base}${base.includes('?') ? '&' : '?'}${params}`;

const makePgBouncerClient = () =>
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    datasources: {
      db: {
        url: appendParams(
          PGBOUNCER_URL,
          'pgbouncer=true&statement_cache_size=0&connection_limit=50&pool_timeout=30'
        ),
      },
    },
  });

const makeDirectClient = () =>
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    datasources: {
      db: {
        url: appendParams(DATABASE_URL, 'connection_limit=25&pool_timeout=30'),
      },
    },
  });

// _current is the live PrismaClient.  We swap it on fallback.
let _current: PrismaClient = PGBOUNCER_URL ? makePgBouncerClient() : makeDirectClient();

// Stable Proxy export — all imports always delegate to _current.
// This means reassigning _current is immediately visible to every service.
const prisma = new Proxy(
  {} as PrismaClient,
  { get: (_t, prop) => (_current as any)[prop] }
) as PrismaClient;

// ── Connection bootstrap ──────────────────────────────────────────────────────
const bootstrap = async () => {
  if (PGBOUNCER_URL) {
    try {
      await _current.$connect();
      logger.info('Database connected successfully [PgBouncer (pool=50)]');
      return;
    } catch (pgErr: any) {
      logger.warn('PgBouncer unreachable — falling back to direct PostgreSQL', {
        error: pgErr?.message ?? pgErr,
      });
      await _current.$disconnect().catch(() => {});
    }

    // Swap to direct PostgreSQL
    if (!DATABASE_URL) {
      logger.error('No DATABASE_URL fallback — shutting down');
      process.exit(1);
    }
    _current = makeDirectClient();
  }

  // Direct PostgreSQL (primary or fallback)
  try {
    await _current.$connect();
    const mode = PGBOUNCER_URL
      ? 'Direct PostgreSQL fallback (pool=25)'
      : 'Direct PostgreSQL (pool=25)';
    logger.info(`Database connected successfully [${mode}]`);
  } catch (err: any) {
    logger.error('Database connection failed', { error: err?.message ?? err });
    process.exit(1);
  }
};

bootstrap();

process.on('beforeExit', async () => {
  await _current.$disconnect();
  logger.info('Database disconnected');
});

export default prisma;
