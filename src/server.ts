import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { Server } from 'socket.io';
import { createServer } from 'http';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import * as Sentry from '@sentry/node';
import rateLimit from 'express-rate-limit';

import { errorHandler } from './middleware/errorHandler';
import { logger } from './utils/logger';
import { connectRedis } from './config/redis';
import { initializeSocket } from './socket/socketHandler';
import { setSocketServer } from './socket/io';
import swaggerDocs from './config/swagger';
import { initScheduledBookingProcessor } from './services/scheduledBooking.service';
import { MembershipService } from './services/membership.service';

import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import bookingRoutes from './routes/booking.routes';
import driverRoutes from './routes/driver.routes';
import locationRoutes from './routes/locationRoutes';
import paymentRoutes from './routes/payment.routes';
import promotionRoutes from './routes/promotion.routes';
import walletRoutes from './routes/wallet.routes';
import membershipRoutes from './routes/membership.routes';
import tipRoutes from './routes/tip.routes';
import invoiceRoutes from './routes/invoice.routes';
import ratingRoutes from './routes/rating.routes';
import supportRoutes from './routes/support.routes';
import notificationRoutes from './routes/notification.routes';
import adminRoutes from './routes/admin.routes';
import featuresRoutes from './routes/features.routes';
import driverWalletRoutes from './routes/driverWallet.routes';
import subscriptionRoutes from './routes/subscription.routes';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const app: Application = express();
app.set('trust proxy', 1);
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

setSocketServer(io);

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

let socketRedisPubClient: ReturnType<typeof createClient> | null = null;
let socketRedisSubClient: ReturnType<typeof createClient> | null = null;

if (process.env.NODE_ENV === 'production' && process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 1.0,
  });
}

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(compression());
app.use(
  express.json({
    limit: '50mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', { stream: { write: (message) => logger.info(message.trim()) } }));
}

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const bookingsAvailableLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const routeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const nearbyDriversLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const bookingStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', (req, res, next) => {
  const apiVersion = process.env.API_VERSION || 'v1';
  const url = String(req.originalUrl || req.url || '');

  if (url.startsWith(`/api/${apiVersion}/bookings/available`)) {
    return bookingsAvailableLimiter(req, res, next);
  }

  if (url.startsWith(`/api/${apiVersion}/bookings/`) && url.includes('/status')) {
    return bookingStatusLimiter(req, res, next);
  }

  if (url.startsWith(`/api/${apiVersion}/location/route`)) {
    return routeLimiter(req, res, next);
  }

  if (url.startsWith(`/api/${apiVersion}/location/nearby-drivers`)) {
    return nearbyDriversLimiter(req, res, next);
  }

  return limiter(req, res, next);
});

app.get('/', (_req, res) => {
  res.status(200).json({
    service: 'drivemate-api',
    status: 'OK',
    health: '/health',
    docs: '/api-docs',
    apiBase: `/api/${API_VERSION}`,
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV,
  });
});

const API_VERSION = process.env.API_VERSION || 'v1';

app.use(`/api/${API_VERSION}/auth`, authRoutes);
app.use(`/api/${API_VERSION}/users`, userRoutes);
app.use(`/api/${API_VERSION}/bookings`, bookingRoutes);
app.use(`/api/${API_VERSION}/drivers`, driverRoutes);
app.use(`/api/${API_VERSION}/location`, locationRoutes);
app.use(`/api/${API_VERSION}/payments`, paymentRoutes);
app.use(`/api/${API_VERSION}/promotions`, promotionRoutes);
app.use(`/api/${API_VERSION}/wallet`, walletRoutes);
app.use(`/api/${API_VERSION}/membership`, membershipRoutes);
app.use(`/api/${API_VERSION}/tips`, tipRoutes);
app.use(`/api/${API_VERSION}/invoices`, invoiceRoutes);
app.use(`/api/${API_VERSION}/ratings`, ratingRoutes);
app.use(`/api/${API_VERSION}/support`, supportRoutes);
app.use(`/api/${API_VERSION}/notifications`, notificationRoutes);
app.use(`/api/${API_VERSION}/admin`, adminRoutes);
app.use(`/api/${API_VERSION}/features`, featuresRoutes);
app.use(`/api/${API_VERSION}/driver-wallet`, driverWalletRoutes);
app.use(`/api/${API_VERSION}/driver/subscription`, subscriptionRoutes);

swaggerDocs(app, Number(PORT));

app.use(errorHandler);

const startServer = async () => {
  try {
    await connectRedis();

    httpServer.listen(Number(PORT), HOST as any, () => {
      logger.info(`🚀 Server running on port ${PORT}`);
      logger.info(`📚 API Documentation available at http://localhost:${PORT}/api-docs`);
      logger.info(`🌍 Environment: ${process.env.NODE_ENV}`);
      logger.info('🧩 Runtime identity', { hostname: os.hostname() });
    });
    // Increase timeouts for slow mobile uploads
    httpServer.headersTimeout = 120000;
    httpServer.requestTimeout = 300000;

    const enableSocketRedisAdapter =
      String(process.env.SOCKET_REDIS_ADAPTER_ENABLED || '').trim() === 'true' ||
      (process.env.NODE_ENV === 'production' && String(process.env.SOCKET_REDIS_ADAPTER_ENABLED || '').trim() !== 'false');

    if (enableSocketRedisAdapter) {
      void (async () => {
        const host = String(process.env.REDIS_HOST || 'localhost').trim();
        const port = Number(process.env.REDIS_PORT || 6379);
        const password = process.env.REDIS_PASSWORD || undefined;
        const rawSocketUrl = process.env.SOCKET_REDIS_URL?.trim();
        const url =
          (rawSocketUrl && rawSocketUrl !== '${REDIS_URL}' ? rawSocketUrl : undefined) ||
          (typeof process.env.REDIS_URL === 'string' && process.env.REDIS_URL.trim()) ||
          `redis://${host}:${port}`;

        const tlsEnabled =
          String(process.env.REDIS_TLS || '').trim() === 'true' ||
          String(process.env.SOCKET_REDIS_TLS || '').trim() === 'true' ||
          url.toLowerCase().startsWith('rediss://');

        const rejectUnauthorized =
          String(process.env.REDIS_TLS_REJECT_UNAUTHORIZED || 'true').trim() !== 'false' &&
          String(process.env.SOCKET_REDIS_TLS_REJECT_UNAUTHORIZED || 'true').trim() !== 'false';

        let servername: string | undefined;
        try {
          const parsed = new URL(url);
          servername = parsed.hostname || undefined;
        } catch {
        }

        socketRedisPubClient = createClient({
          url,
          password,
          ...(tlsEnabled
            ? {
              socket: {
                tls: true,
                servername,
                rejectUnauthorized,
              },
            }
            : null),
        });

        socketRedisPubClient.on('error', (error) => {
          logger.error('Socket.IO Redis pub client error', { error, hostname: os.hostname() });
        });

        socketRedisSubClient = socketRedisPubClient.duplicate();
        socketRedisSubClient.on('error', (error) => {
          logger.error('Socket.IO Redis sub client error', { error, hostname: os.hostname() });
        });

        await Promise.all([socketRedisPubClient.connect(), socketRedisSubClient.connect()]);
        io.adapter(createAdapter(socketRedisPubClient, socketRedisSubClient));
        logger.info('✅ Socket.IO Redis adapter enabled', { hostname: os.hostname(), url: servername ? `redis(s)://${servername}:${port}` : url });
      })().catch((error) => {
        logger.error('Failed to enable Socket.IO Redis adapter:', error);
      });
    } else {
      logger.info('ℹ️ Socket.IO Redis adapter disabled');
    }

    initializeSocket(io);

    void MembershipService.ensureDefaultPlans().catch((error) => {
      logger.error('Failed to ensure default plans:', error);
    });

    void initScheduledBookingProcessor().catch((error) => {
      logger.error('Failed to start scheduled booking processor:', error);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  httpServer.close(() => {
    logger.info('HTTP server closed');
    try {
      if (socketRedisSubClient) {
        void socketRedisSubClient.quit();
      }
      if (socketRedisPubClient) {
        void socketRedisPubClient.quit();
      }
    } catch {
    }
    process.exit(0);
  });
});

startServer();

export { io };
