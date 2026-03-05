import Redis from 'ioredis';
import { logger } from '../utils/logger';

const redisUrl = typeof process.env.REDIS_URL === 'string' ? process.env.REDIS_URL.trim() : '';
const redisTlsEnabled =
  String(process.env.REDIS_TLS || '').trim() === 'true' ||
  redisUrl.toLowerCase().startsWith('rediss://');
const redisTlsRejectUnauthorized = String(process.env.REDIS_TLS_REJECT_UNAUTHORIZED || 'true').trim() !== 'false';
const redisTlsOptions = redisTlsEnabled ? { tls: { rejectUnauthorized: redisTlsRejectUnauthorized } } : {};
const redisAuthOptions = {
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
};

const baseRedisOptions = {
  retryStrategy: () => null, // Don't retry - fail fast
  maxRetriesPerRequest: 1,
  lazyConnect: true, // Don't connect immediately
  enableOfflineQueue: false, // Don't queue commands when offline
} as const;

export const redisClient = redisUrl
  ? new Redis(redisUrl, {
      ...baseRedisOptions,
      ...redisAuthOptions,
      ...redisTlsOptions,
    })
  : new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      ...baseRedisOptions,
      ...redisAuthOptions,
      ...redisTlsOptions,
    });

let redisAvailable = false;

const isRedisUsable = (): boolean => {
  return redisAvailable && redisClient.status === 'ready';
};

redisClient.on('error', (error) => {
  redisAvailable = false;
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  logger.error('Redis client error', { error: message, stack });
});

redisClient.on('connect', () => {
  logger.info('Redis Client Connected');
  redisAvailable = true;
});

redisClient.on('ready', () => {
  logger.info('Redis Client Ready');
  redisAvailable = true;
});

redisClient.on('end', () => {
  redisAvailable = false;
});

redisClient.on('close', () => {
  redisAvailable = false;
});

export const connectRedis = async (): Promise<void> => {
  try {
    const timeoutMs = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 8000);
    const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      );
      return (await Promise.race([promise, timeout])) as T;
    };

    logger.info('Connecting to Redis...');
    await withTimeout(redisClient.connect(), 'Redis connect');
    logger.info('Redis connected. Pinging...');

    try {
      await withTimeout(redisClient.ping(), 'Redis ping');
      logger.info('✅ Redis connection established');
    } catch (error) {
      logger.error('⚠️ Redis ping failed (continuing anyway)', { error });
    }
  } catch (error) {
    redisAvailable = false;
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const redisRequired = String(process.env.REDIS_REQUIRED || 'true').trim() !== 'false';

    if (redisRequired) {
      logger.error('❌ Redis unavailable - refusing to start without Redis', { error: message, stack });
      throw error;
    }

    logger.error('⚠️ Redis unavailable - continuing without Redis', { error: message, stack });
  }
};

export const cacheGet = async (key: string): Promise<string | null> => {
  if (!isRedisUsable()) {
    throw new Error('Redis unavailable');
  }
  return await redisClient.get(key);
};

export const cacheSet = async (
  key: string,
  value: string,
  expiryInSeconds?: number
): Promise<void> => {
  if (!isRedisUsable()) {
    throw new Error('Redis unavailable');
  }
  if (expiryInSeconds) {
    await redisClient.setex(key, expiryInSeconds, value);
  } else {
    await redisClient.set(key, value);
  }
};

export const cacheDel = async (key: string): Promise<void> => {
  if (!isRedisUsable()) {
    throw new Error('Redis unavailable');
  }
  await redisClient.del(key);
};

export const cacheDelPattern = async (pattern: string): Promise<void> => {
  if (!isRedisUsable()) {
    throw new Error('Redis unavailable');
  }
  const keys = await redisClient.keys(pattern);
  if (keys.length > 0) {
    await redisClient.del(...keys);
  }
};

export default redisClient;
