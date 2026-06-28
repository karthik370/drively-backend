import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? ['query', 'error', 'warn']
    : ['error'],
  datasources: {
    db: {
      // IMPORTANT: Never remove this limit. PostgreSQL can handle max ~100 connections total.
      // Without a limit, Prisma opens unlimited connections → PostgreSQL crashes with
      // "FATAL: too many clients already" and the ENTIRE app goes down for everyone.
      // 25 = safe limit for 1 backend instance on Railway (leaves room for DB admin tools).
      // If you add more backend instances later, reduce this per instance (e.g., 2 instances = 12 each).
      url: process.env.DATABASE_URL
        ? `${process.env.DATABASE_URL}${process.env.DATABASE_URL.includes('?') ? '&' : '?'}connection_limit=25&pool_timeout=30`
        : undefined,
    },
  },
});

prisma.$connect()
  .then(() => {
    logger.info('Database connected successfully');
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
