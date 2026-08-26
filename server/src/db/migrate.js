import { pool } from './postgres.js';
import { logger } from '../lib/logger.js';

/**
 * Idempotent schema migration. Run with `npm run migrate`.
 *
 * Design notes:
 *  - status is a TEXT + CHECK rather than a native ENUM. A CHECK is trivial to
 *    evolve with a plain ALTER; changing an ENUM's members is far more awkward.
 *    Either way the invalid-status case is rejected by the database itself.
 *  - `version` powers optimistic concurrency control (see orderService.js).
 *  - The UNIQUE(order_id, to_status) on the transitions table is the strongest
 *    guarantee in the system: an order can physically only ever enter a given
 *    stage once, so a duplicate transition is impossible even if every layer
 *    above the database were to fail simultaneously.
 */
const SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('staff', 'manager')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id            BIGSERIAL PRIMARY KEY,
  table_number  INTEGER CHECK (table_number > 0),
  customer_name TEXT,
  status        TEXT NOT NULL DEFAULT 'PREPARING'
                CHECK (status IN ('PREPARING', 'READY', 'COMPLETED')),
  version       INTEGER NOT NULL DEFAULT 1,
  total_amount  NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The orders board filters by status and sorts by recency: one composite index
-- serves both, so the hot list query never sequential-scans.
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_created        ON orders (created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id         BIGSERIAL PRIMARY KEY,
  order_id   BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(10, 2) NOT NULL CHECK (unit_price >= 0)
);

-- Avoids the N+1 when hydrating items for a page of orders.
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);

CREATE TABLE IF NOT EXISTS order_status_transitions (
  id          BIGSERIAL PRIMARY KEY,
  order_id    BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  actor_id    BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_order_stage UNIQUE (order_id, to_status)
);

CREATE INDEX IF NOT EXISTS idx_transitions_order ON order_status_transitions (order_id, created_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        TEXT PRIMARY KEY,
  order_id   BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function migrate() {
  await pool.query(SQL);
  logger.info('migrate.complete');
}

// Only run standalone when invoked directly, not when imported.
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('migrate.failed', { error: err.message });
      process.exit(1);
    });
}
