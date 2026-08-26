import { randomUUID } from 'node:crypto';
import { redis, safeRedis } from '../db/redis.js';
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Redis distributed lock (SET key value NX PX ttl).
 *
 * IMPORTANT — this lock is an optimisation, not the correctness guarantee.
 * Correctness comes from `SELECT ... FOR UPDATE` inside a Postgres transaction.
 * The Redis lock exists so that competing requests are rejected cheaply, before
 * they queue on a database row and hold a connection from the pool. If Redis is
 * down, acquire() returns a null token and the request proceeds straight to
 * Postgres, which is still fully safe.
 */

// Compare-and-delete: only the owner may release the lock. Without this, a slow
// request whose lock had already expired could delete a lock another request owns.
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

export async function acquireLock(resource, ttlMs = config.orderLockTtlMs) {
  const key = `lock:${resource}`;
  const token = randomUUID();
  const acquired = await safeRedis(
    () => redis.set(key, token, 'PX', ttlMs, 'NX'),
    'DEGRADED', // Redis unavailable: treat as "no lock held", fall through to Postgres
  );
  if (acquired === 'DEGRADED') {
    logger.warn('lock.degraded', { resource });
    return { key, token: null, held: false, degraded: true };
  }
  if (acquired === 'OK') return { key, token, held: true, degraded: false };
  return null; // someone else holds the lock right now
}

export async function releaseLock(lock) {
  if (!lock || !lock.token) return;
  await safeRedis(() => redis.eval(RELEASE_SCRIPT, 1, lock.key, lock.token));
}

/** Acquire, run, release — with the release guaranteed by `finally`. */
export async function withLock(resource, fn, { ttlMs } = {}) {
  const lock = await acquireLock(resource, ttlMs);
  if (!lock) return { acquired: false, result: undefined };
  try {
    return { acquired: true, result: await fn() };
  } finally {
    await releaseLock(lock);
  }
}
