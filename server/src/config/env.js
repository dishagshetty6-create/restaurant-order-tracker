import dotenv from 'dotenv';
dotenv.config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  postgres: {
    url: required('DATABASE_URL'),
    poolMax: Number(process.env.PG_POOL_MAX || 10),
  },
  mongo: {
    url: required('MONGO_URL'),
    db: process.env.MONGO_DB || 'rot_logs',
  },
  redis: {
    url: required('REDIS_URL'),
  },
  jwt: {
    // Never hard-code this. In production it comes from a secret manager.
    secret: required('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  },
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 10),
  orderLockTtlMs: Number(process.env.ORDER_LOCK_TTL_MS || 3000),
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS || 30),
  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
    maxWrites: Number(process.env.RATE_LIMIT_MAX_WRITES || 60),
  },
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
};
