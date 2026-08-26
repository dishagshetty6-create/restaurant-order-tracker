import Redis from 'ioredis';
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';

export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false, // fail fast instead of queueing when Redis is down
  retryStrategy: (times) => Math.min(times * 200, 3000),
});

let healthy = false;
redis.on('ready', () => {
  healthy = true;
  logger.info('redis.ready');
});
redis.on('end', () => {
  healthy = false;
});
redis.on('error', (err) => {
  healthy = false;
  // Redis is a performance layer, never the source of truth, so an outage is a
  // warning rather than a fatal error. Callers degrade gracefully.
  logger.warn('redis.error', { error: err.message });
});

export const isRedisHealthy = () => healthy;

/**
 * Wraps a Redis call so an outage degrades instead of 500-ing: cache miss,
 * no lock, no rate limit. Correctness never depends on this layer.
 */
export async function safeRedis(operation, fallback = null) {
  if (!healthy) return fallback;
  try {
    return await operation();
  } catch (err) {
    logger.warn('redis.operation_failed', { error: err.message });
    return fallback;
  }
}
