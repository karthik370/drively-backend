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
import { initPaymentReconciliation } from './services/paymentReconciliation.service';

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
import tripPhotoRoutes from './routes/tripPhoto.routes';
import badgeRoutes from './routes/badge.routes';
import emergencyRoutes from './routes/emergency.routes';
import tripShareWebRoutes from './routes/tripShareWeb';
import kycRoutes from './routes/kyc.routes';
import diditSessionRoutes from './routes/diditSession.routes';
import webhookRoutes from './routes/webhook.routes';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const app: Application = express();
app.set('trust proxy', 1);
// Disable ETags globally — dynamic endpoints like support chat history must never return 304
// (an empty message list has the same ETag as a list with messages if the body hash coincidentally matches)
app.set('etag', false);
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

// Global security headers — CSP is disabled for /track share pages
// (the tripShareWeb route sets its own permissive CSP header directly)
app.use((req, res, next) => {
  if (req.path.startsWith('/track/') || req.path === '/track') {
    // Skip CSP for share pages — tripShareWeb.ts sets its own header
    return helmet({ contentSecurityPolicy: false })(req, res, next);
  }
  return helmet()(req, res, next);
});
// SECURITY: CORS origin allowlist — no wildcard fallback
const corsOrigins = (() => {
  const origins: (string | RegExp)[] = [];
  // Production frontend(s)
  if (process.env.FRONTEND_URL) {
    process.env.FRONTEND_URL.split(',').forEach(u => {
      const trimmed = u.trim();
      if (trimmed) origins.push(trimmed);
    });
  }
  // Admin dashboard
  if (process.env.ADMIN_DASHBOARD_URL) {
    origins.push(process.env.ADMIN_DASHBOARD_URL.trim());
  }
  // Always allow localhost in development
  if (process.env.NODE_ENV !== 'production') {
    origins.push(/^https?:\/\/localhost(:\d+)?$/);
    origins.push(/^https?:\/\/127\.0\.0\.1(:\d+)?$/);
  }
  // If nothing configured, allow the known production domain
  if (origins.length === 0) {
    origins.push('https://v3.kurnm.click');
    origins.push(/^https?:\/\/localhost(:\d+)?$/);
  }
  return origins;
})();

app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));
app.use(compression());
// Large body limit for KYC selfie and trip photo routes (base64 images ~2-4MB each)
app.post(
  /\/(kyc\/selfie|bookings\/.*\/trip-photos)/,
  express.json({
    limit: '50mb',
    verify: (req: any, _res, buf) => { req.rawBody = buf; },
  })
);
app.use(
  express.json({
    limit: '5mb',
    verify: (req: any, _res, buf) => { req.rawBody = buf; },
  })
);
app.use(express.urlencoded({ extended: true, limit: '5mb' }));


if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', { stream: { write: (message) => logger.info(message.trim()) } }));
}

// ─── SECURITY: PHP webshell probe blocker ────────────────────────────────────
// Immediately drop requests for *.php paths — this server runs Node.js and
// will NEVER serve PHP files. These are automated scanners (CVE probers,
// webshell droppers, WordPress backdoor scanners).
// Returns 404 with no body and logs a single warn per unique IP per session.
const phpProbeIpsSeen = new Set<string>();
app.use((req, res, next) => {
  if (req.path.toLowerCase().endsWith('.php')) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!phpProbeIpsSeen.has(ip)) {
      phpProbeIpsSeen.add(ip);
      logger.warn('PHP probe blocked', { ip, path: req.path, ua: req.headers['user-agent'] });
    }
    res.status(404).end();
    return;
  }
  next();
});

// ─── SECURITY: Non-API path rate limiter ─────────────────────────────────────
// Catches scanner bots probing arbitrary paths outside /api/, /track/, /health.
// 20 requests per minute per IP — well above any legitimate browser/app but
// stops automated path scanners cold.
const unknownPathLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many requests.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const p = req.path;
    return (
      p.startsWith('/api/') ||
      p.startsWith('/track/') ||
      p === '/track' ||
      p === '/health' ||
      p === '/'
    );
  },
});
app.use(unknownPathLimiter);

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

// SECURITY: Strict rate limit for auth/OTP endpoints to prevent SMS bombing,
// OTP brute-force, and credential stuffing attacks
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many authentication attempts. Please try again in a minute.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', (req, res, next) => {
  const apiVersion = process.env.API_VERSION || 'v1';
  const url = String(req.originalUrl || req.url || '');

  // Auth endpoints get strict per-IP limiting
  if (url.startsWith(`/api/${apiVersion}/auth/`)) {
    return authLimiter(req, res, next);
  }

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

// Trip share tracking web page (must be before API routes)
app.use(tripShareWebRoutes);

app.get('/', (_req, res) => {
  res.status(200).json({
    service: 'drivemate-api',
    status: 'OK',
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
app.use(`/api/${API_VERSION}/trip-photos`, tripPhotoRoutes);
app.use(`/api/${API_VERSION}/badges`, badgeRoutes);
app.use(`/api/${API_VERSION}/emergency`, emergencyRoutes);
app.use(`/api/${API_VERSION}/kyc`, kycRoutes);
app.use(`/api/${API_VERSION}/kyc/session`, diditSessionRoutes);
app.use(`/api/${API_VERSION}/webhooks`, webhookRoutes);

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

    // ── Payment reconciliation: catches webhook-missed subscription payments ──────
    initPaymentReconciliation();

    // Seed default driver badges — runs once per server process only
    void (async () => {
      try {
        const { BadgeService } = await import('./services/badge.service');
        await BadgeService.seedDefaultBadges();
        logger.info('✅ Default badges seeded');
      } catch (error) {
        logger.error('Failed to seed default badges:', error);
      }
    })();

    // ── Hourly cleanup: delete expired Cloudinary trip photos (24hrs after trip ends) ──
    const PHOTO_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
    setInterval(async () => {
      try {
        const { TripPhotoService } = await import('./services/tripPhoto.service');
        const result = await TripPhotoService.cleanupExpiredPhotos();
        if (result.deleted > 0 || result.errors > 0) {
          logger.info('Trip photo cleanup completed', result);
        }
      } catch (error) {
        logger.error('Trip photo cleanup failed:', error);
      }
    }, PHOTO_CLEANUP_INTERVAL);
    logger.info('📸 Trip photo cleanup scheduled (every 1 hour)');
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
