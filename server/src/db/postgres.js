import pg from 'pg';
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';

// BIGINT (OID 20) arrives as a string by default. Order ids comfortably fit in
// a JS number for this system, so parse them to keep the API contract clean.
pg.types.setTypeParser(20, (value) => Number(value));
// NUMERIC (OID 1700) -> float, so money totals serialise as numbers not strings.
pg.types.setTypeParser(1700, (value) => parseFloat(value));

export const pool = new pg.Pool({
  connectionString: config.postgres.url,
  max: config.postgres.poolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  // An idle client blew up. Log it; the pool replaces the client itself.
  logger.error('postgres.pool_error', { error: err.message });
});

export const query = (text, params) => pool.query(text, params);

/**
 * Runs `fn` inside a single transaction on a dedicated client and guarantees the
 * client is released exactly once, whatever happens.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('postgres.rollback_failed', { error: rollbackErr.message });
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function pingPostgres() {
  await pool.query('SELECT 1');
}
