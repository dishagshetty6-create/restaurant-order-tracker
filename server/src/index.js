import { createApp } from './app.js';
import { config } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectMongo, closeMongo } from './db/mongo.js';
import { pool, pingPostgres } from './db/postgres.js';
import { redis } from './db/redis.js';
import { migrate } from './db/migrate.js';

async function start() {
  // Postgres is a hard dependency: if it is unreachable, fail loudly at boot
  // rather than serving requests that will all fall over.
  await pingPostgres();
  await migrate();

  // Mongo is not. Start without it and log the degradation.
  try {
    await connectMongo();
  } catch (err) {
    logger.warn('mongo.unavailable_at_boot', { error: err.message });
  }

  const server = createApp().listen(config.port, () => {
    logger.info('server.listening', { port: config.port, env: config.nodeEnv });
  });

  const shutdown = async (signal) => {
    logger.info('server.shutting_down', { signal });
    // Stop accepting new connections, then drain the pools so in-flight
    // transactions are not cut off mid-commit.
    server.close(async () => {
      await Promise.allSettled([pool.end(), closeMongo(), redis.quit()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref(); // hard cap on drain time
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error('server.failed_to_start', { error: err.message, stack: err.stack });
  process.exit(1);
});
