import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { config, RETENTION_OPTIONS } from './config.js';
import { logger } from './logger.js';
import { buildLimiters } from './middleware/rateLimit.js';
import { attachUser, clientId } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler, notFoundHandler, wrap } from './middleware/errors.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { uploadsRouter } from './routes/uploads.js';
import { filesRouter } from './routes/files.js';
import { userRouter } from './routes/user.js';
import { adminRouter } from './routes/admin.js';
import { getSettings } from './services/settings.js';
import { typeRegistry } from './services/filePolicy.js';

export function createApp() {
  const c = config();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', c.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/health') },
      // never log query strings (download tokens) or cookies
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: (req.url ?? '').split('?')[0] }), res: (res) => ({ statusCode: res.statusCode }) },
    }),
  );
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  const origins = c.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || origins.includes(origin)),
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Manage-Token', 'Range'],
      exposedHeaders: ['Content-Disposition', 'Content-Range', 'Accept-Ranges', 'Content-Length'],
      maxAge: 600,
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '100kb' }));
  app.use(clientId);

  const limiters = buildLimiters(c);
  app.use('/health', healthRouter);
  app.use('/api', limiters.api, wrap(async (req, _res, next) => attachUser(req, _res, next)), csrfProtection);

  app.get('/api/config', wrap(async (_req, res) => {
    const s = await getSettings();
    res.json({
      maxFileBytes: s.maxFileBytes,
      partSize: c.PART_SIZE_BYTES,
      allowAnonymous: s.allowAnonymous,
      allowRegistration: s.allowRegistration,
      retentionOptions: RETENTION_OPTIONS.filter((o) => s.allowedRetentionKeys.includes(o.key)),
      blockedExtensions: s.blockedExtensions,
      knownExtensions: Object.keys(typeRegistry()),
    });
  }));
  app.use('/api/auth', authRouter(limiters));
  app.use('/api/uploads', uploadsRouter(limiters));
  app.use('/api/files', filesRouter(limiters));
  app.use('/api/user', userRouter);
  app.use('/api/admin', adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
