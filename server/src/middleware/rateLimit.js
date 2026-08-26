import { redis, safeRedis } from '../db/redis.js';
import { config } from '../config/env.js';
import { AppError } from '../lib/errors.js';

/**
 * Fixed-window rate limiter backed by Redis.
 *
 * INCR and PEXPIRE run inside one Lua script so they are atomic: without this,
 * a crash between the two commands leaves a key with no TTL, which would lock
 * that user out permanently.
 *
 * Fixed-window is a deliberate trade-off — it allows a short burst at a window
 * boundary but costs one round trip and a few bytes per user. A sliding-window
 * log would be smoother and more expensive; at restaurant scale, this is plenty.
 */
const SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return current
`;

export const rateLimit = ({ name, max = config.rateLimit.maxWrites, windowMs = config.rateLimit.windowMs }) =>
  async (req, res, next) => {
    // Prefer the authenticated user; fall back to IP for unauthenticated routes.
    const identity = req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`;
    const window = Math.floor(Date.now() / windowMs);
    const key = `rl:${name}:${identity}:${window}`;

    // A Redis outage must not take the whole API down: fail open, and rely on
    // the fact that Postgres constraints still protect data integrity.
    const count = await safeRedis(() => redis.eval(SCRIPT, 1, key, windowMs), 0);

    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - count)));

    if (count > max) {
      const retryAfter = Math.ceil((windowMs - (Date.now() % windowMs)) / 1000);
      res.set('Retry-After', String(retryAfter));
      return next(
        new AppError(429, 'RATE_LIMITED', `Too many requests. Try again in ${retryAfter}s.`),
      );
    }
    return next();
  };
