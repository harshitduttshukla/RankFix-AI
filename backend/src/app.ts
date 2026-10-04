import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { prisma } from './config/database.js';
import { csrfProtection } from './middleware/csrf.middleware.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { globalLimiter } from './middleware/rate-limit.middleware.js';
import { authRoutes } from './routes/auth.routes.js';
import { gscOAuthRoutes, projectGscRoutes } from './routes/gsc.routes.js';
import { projectRoutes } from './routes/projects.routes.js';
import { websiteRoutes } from './routes/websites.routes.js';
import { logger } from './utils/logger.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: env.FRONTEND_ORIGIN, credentials: true }));
  app.use(pinoHttp({ logger, autoLogging: env.NODE_ENV !== 'test' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok' });
  });

  app.use('/api', globalLimiter, csrfProtection);
  app.use('/api/auth', authRoutes);
  app.use('/api/projects/:projectId/gsc', projectGscRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api/gsc', gscOAuthRoutes);
  app.use('/api/websites', websiteRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
