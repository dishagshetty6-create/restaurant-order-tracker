import { redis, safeRedis } from '../db/redis.js';
import { config } from '../config/env.js';

/**
 * Read-through cache for the orders board — the single hottest endpoint, since
 * every screen in the restaurant polls it.
 *
 * Invalidation uses a monotonically increasing generation counter baked into
 * every cache key. Any write bumps the counter, which orphans the whole previous
 * generation in one O(1) INCR; the orphans then expire on their own TTL. This
 * avoids `KEYS`/`SCAN` pattern deletes, which are O(n) and block the Redis
 * event loop on large keyspaces.
 */
const GENERATION_KEY = 'orders:generation';

async function currentGeneration() {
  const value = await safeRedis(() => redis.get(GENERATION_KEY), null);
  return value ?? '0';
}

export async function bumpGeneration() {
  await safeRedis(() => redis.incr(GENERATION_KEY));
}

export function ordersListKey({ status, page, limit, generation }) {
  return `orders:list:v${generation}:${status || 'ALL'}:p${page}:l${limit}`;
}

/**
 * Returns the cached value if present, otherwise runs `producer`, caches the
 * result and returns it. A Redis outage silently becomes a permanent cache miss.
 */
export async function readThrough(buildKey, producer, ttlSeconds = config.cacheTtlSeconds) {
  const generation = await currentGeneration();
  const key = buildKey(generation);

  const cached = await safeRedis(() => redis.get(key), null);
  if (cached) {
    try {
      return { value: JSON.parse(cached), hit: true };
    } catch {
      // Corrupt entry — drop it and fall through to a fresh read.
      await safeRedis(() => redis.del(key));
    }
  }

  const value = await producer();
  await safeRedis(() => redis.set(key, JSON.stringify(value), 'EX', ttlSeconds));
  return { value, hit: false };
}
