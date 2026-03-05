import Queue from 'bull';
import cron from 'node-cron';
import prisma from '../config/database';
import { logger } from '../utils/logger';
import { BookingStatus } from '@prisma/client';
import { MatchingService } from './matching.service';

type ScheduledBookingJobData = {
  bookingId: string;
};

const QUEUE_NAME = 'scheduled-bookings';
const JOB_NAME = 'start-matching';

let queue: Queue.Queue<ScheduledBookingJobData> | null = null;
let initialized = false;
let cronStarted = false;

const buildRedisUrl = (): string => {
  const explicitUrl = typeof process.env.REDIS_URL === 'string' ? process.env.REDIS_URL.trim() : '';
  if (explicitUrl) {
    return explicitUrl;
  }

  const tlsEnabled = String(process.env.REDIS_TLS || '').trim() === 'true';
  const protocol = tlsEnabled ? 'rediss' : 'redis';

  const host = process.env.REDIS_HOST || 'localhost';
  const port = process.env.REDIS_PORT || '6379';
  const username = process.env.REDIS_USERNAME;
  const password = process.env.REDIS_PASSWORD;

  if (password && username) {
    return `${protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  }

  if (password) {
    return `${protocol}://:${encodeURIComponent(password)}@${host}:${port}`;
  }

  return `${protocol}://${host}:${port}`;
};

const ensureQueue = async (): Promise<Queue.Queue<ScheduledBookingJobData> | null> => {
  if (queue) return queue;

  try {
    const redisUrl = buildRedisUrl();
    const q = new Queue(QUEUE_NAME, redisUrl, {
      settings: {
        lockDuration: 30000,
        stalledInterval: 30000,
        maxStalledCount: 1,
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });

    await (q as Queue.Queue<ScheduledBookingJobData>).isReady();
    queue = q as Queue.Queue<ScheduledBookingJobData>;
    logger.info('✅ Scheduled booking Bull queue ready');
    return queue;
  } catch (error) {
    queue = null;
    logger.error('❌ Bull queue unavailable - Redis is required for scheduled bookings', { error });
    throw error;
  }
};

const schedulePendingJobsAtStartup = async (q: Queue.Queue<ScheduledBookingJobData>) => {
  const now = new Date();

  const pending = await prisma.booking.findMany({
    where: {
      status: { in: [BookingStatus.REQUESTED, BookingStatus.SEARCHING] },
      driverId: null,
      scheduledTime: {
        gt: now,
      },
    },
    select: {
      id: true,
      scheduledTime: true,
    },
    take: 500,
  });

  for (const b of pending) {
    const st = b.scheduledTime ? new Date(b.scheduledTime) : null;
    if (!st) continue;
    const delayMs = Math.max(0, st.getTime() - Date.now());

    try {
      await q.add(
        JOB_NAME,
        { bookingId: b.id },
        {
          jobId: b.id,
          delay: delayMs,
        }
      );
    } catch (error) {
      logger.warn('Failed to schedule booking job at startup', { error, bookingId: b.id });
    }
  }

  if (pending.length > 0) {
    logger.info('Scheduled booking jobs ensured at startup', { count: pending.length });
  }
};

const startCronFallback = () => {
  if (cronStarted) return;
  cronStarted = true;

  cron.schedule('*/1 * * * *', async () => {
    try {
      const now = new Date();
      const due = await prisma.booking.findMany({
        where: {
          status: { in: [BookingStatus.REQUESTED, BookingStatus.SEARCHING] },
          driverId: null,
          scheduledTime: {
            lte: now,
          },
        },
        select: { id: true },
        take: 100,
      });

      for (const b of due) {
        try {
          await MatchingService.startMatchingForBooking(b.id);
        } catch (error) {
          logger.warn('Cron failed to start matching for scheduled booking', { error, bookingId: b.id });
        }
      }
    } catch (error) {
      logger.warn('Scheduled booking cron tick failed', { error });
    }
  });

  logger.info('✅ Scheduled booking cron fallback started (every 1 min)');
};

export const initScheduledBookingProcessor = async (): Promise<void> => {
  if (initialized) return;
  initialized = true;

  startCronFallback();

  const q = await ensureQueue();
  if (!q) {
    return;
  }

  q.process(JOB_NAME, async (job: Queue.Job<ScheduledBookingJobData>) => {
    const bookingId = String(job.data?.bookingId || '');
    if (!bookingId) {
      throw new Error('bookingId missing');
    }

    await MatchingService.startMatchingForBooking(bookingId);
  });

  q.on('error', (error: unknown) => {
    logger.warn('Scheduled booking queue error', { error });
  });

  await schedulePendingJobsAtStartup(q);
};

export const enqueueScheduledBooking = async (bookingId: string, scheduledTime: Date): Promise<void> => {
  const q = await ensureQueue();
  if (!q) {
    return;
  }

  const delayMs = Math.max(0, scheduledTime.getTime() - Date.now());

  await q.add(
    JOB_NAME,
    { bookingId },
    {
      jobId: bookingId,
      delay: delayMs,
    }
  );
};
