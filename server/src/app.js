import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config/env.js';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler, asyncHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import orderRoutes from './routes/orders.js';
import statsRoutes from './routes/stats.js';
import { pingPostgres } from './db/postgres.js';
import { pingMongo } from './db/mongo.js';
import { isRedisHealthy } from './db/redis.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // correct req.ip behind a load balancer
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '100kb' })); // bounded body size
  app.use(requestContext);

  /**
   * Health check that reports each dependency separately. Postgres is the only
   * hard requirement — the API is degraded but usable without Redis or Mongo,
   * and the payload says so rather than reporting a flat pass/fail.
   */
  app.get('/health', asyncHandler(async (_req, res) => {
    const checks = { postgres: 'down', mongo: 'down', redis: isRedisHealthy() ? 'up' : 'down' };
    try { await pingPostgres(); checks.postgres = 'up'; } catch { /* stays down */ }
    try { await pingMongo(); checks.mongo = 'up'; } catch { /* stays down */ }

    const healthy = checks.postgres === 'up';
    const degraded = healthy && (checks.mongo === 'down' || checks.redis === 'down');
    res.status(healthy ? 200 : 503).json({
      status: !healthy ? 'unhealthy' : degraded ? 'degraded' : 'healthy',
      checks,
      uptimeSeconds: Math.round(process.uptime()),
    });
  }));

  app.use('/api/auth', authRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api', statsRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
