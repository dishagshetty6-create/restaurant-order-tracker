import { pool, query, withTransaction } from '../db/postgres.js';
import { acquireLock, releaseLock } from '../lib/lock.js';
import { bumpGeneration, readThrough, ordersListKey } from '../lib/cache.js';
import { notFound, conflict, unprocessable, badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import * as activity from './activityLog.js';

/**
 * The status machine. Single source of truth for what may follow what.
 * Expressed as data, not as if/else chains, so the rule is impossible to
 * contradict in one code path and not another.
 */
export const STATUS_FLOW = Object.freeze({
  PREPARING: 'READY',
  READY: 'COMPLETED',
  COMPLETED: null, // terminal
});

export const ALL_STATUSES = Object.keys(STATUS_FLOW);
export const nextStatus = (current) => STATUS_FLOW[current] ?? null;

const mapOrder = (row) => ({
  id: row.id,
  tableNumber: row.table_number,
  customerName: row.customer_name,
  status: row.status,
  version: row.version,
  totalAmount: row.total_amount,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  nextStatus: nextStatus(row.status),
  items: row.items || [],
});

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

export async function createOrder({ tableNumber, customerName, items, actor, idempotencyKey }) {
  // Double-tap protection: the same key always returns the original order
  // rather than creating a second one.
  if (idempotencyKey) {
    const existing = await query(
      'SELECT order_id FROM idempotency_keys WHERE key = $1',
      [idempotencyKey],
    );
    if (existing.rows[0]) {
      const order = await getOrderById(existing.rows[0].order_id);
      return { order, replayed: true };
    }
  }

  const total = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

  const order = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO orders (table_number, customer_name, status, total_amount, created_by)
       VALUES ($1, $2, 'PREPARING', $3, $4)
       RETURNING *`,
      [tableNumber ?? null, customerName ?? null, total.toFixed(2), actor.id],
    );
    const created = inserted.rows[0];

    // One multi-row INSERT rather than one per item — avoids N round trips.
    const values = [];
    const params = [];
    items.forEach((item, index) => {
      const base = index * 4;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      params.push(created.id, item.name, item.quantity, item.unitPrice);
    });
    const itemRows = await client.query(
      `INSERT INTO order_items (order_id, name, quantity, unit_price)
       VALUES ${values.join(', ')} RETURNING id, name, quantity, unit_price`,
      params,
    );

    // The very first stage is a transition too, so history is complete from birth.
    await client.query(
      `INSERT INTO order_status_transitions (order_id, from_status, to_status, actor_id)
       VALUES ($1, 'NEW', 'PREPARING', $2)`,
      [created.id, actor.id],
    );

    if (idempotencyKey) {
      await client.query(
        'INSERT INTO idempotency_keys (key, order_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [idempotencyKey, created.id],
      );
    }

    return mapOrder({
      ...created,
      items: itemRows.rows.map((row) => ({
        id: row.id,
        name: row.name,
        quantity: row.quantity,
        unitPrice: row.unit_price,
      })),
    });
  });

  await bumpGeneration();
  await activity.record({
    type: 'order.created',
    orderId: order.id,
    actorId: actor.id,
    actorName: actor.name,
    payload: { tableNumber: order.tableNumber, itemCount: items.length, total: order.totalAmount },
  });

  return { order, replayed: false };
}

/* ------------------------------------------------------------------ */
/* The concurrency-critical path                                       */
/* ------------------------------------------------------------------ */

/**
 * Advance one order to its next stage, safely, under concurrent access.
 *
 * The scenario from the brief: two staff open the board, both see Order #58 in
 * PREPARING. Staff A taps "Ready". A fraction of a second later Staff B taps
 * "Completed" — from a screen that is now stale.
 *
 * Four independent layers keep that correct. Each would mostly work alone; they
 * are stacked so that no single failure produces a wrong order state.
 *
 *  1. REDIS LOCK (fast rejection).
 *     `SET lock:order:58 <token> NX PX 3000`. The second request is turned away
 *     immediately with 409 ORDER_BUSY instead of blocking on a database row and
 *     holding a pooled connection. This is an optimisation only — if Redis is
 *     down we log and continue, and layers 2-4 still guarantee correctness.
 *
 *  2. POSTGRES ROW LOCK (serialisation — the real guarantee).
 *     `SELECT ... FOR UPDATE` inside a transaction takes an exclusive lock on
 *     that single row. Any concurrent transaction touching order 58 waits at
 *     that line until the first commits, then — under READ COMMITTED — re-reads
 *     the row it was waiting for and sees the *committed* new state. So the two
 *     updates can never interleave, and B never validates against a stale read.
 *     Note it locks one row, not the table: orders 57 and 59 are unaffected.
 *
 *  3. OPTIMISTIC VERSION CHECK (correct UX for a stale screen).
 *     Every order carries a `version`. The client must send the version it was
 *     looking at. Once A commits, the version moves 1 -> 2, so B's request
 *     (expectedVersion 1) is rejected with 409 VERSION_CONFLICT and a message
 *     naming what actually happened. Without this, B's "Completed" would look
 *     like a perfectly legal READY -> COMPLETED and would silently succeed —
 *     the order would jump two stages from B's point of view, and the kitchen
 *     would never register that it was ever Ready.
 *     The UPDATE itself is also guarded (`WHERE version = $n`), so even if a
 *     row lock were somehow not held, a lost update is still impossible.
 *
 *  4. DATABASE CONSTRAINTS (last line of defence).
 *     UNIQUE(order_id, to_status) on the transitions table means an order can
 *     physically enter each stage at most once, and the CHECK on `status`
 *     rejects any value outside the three legal stages. These hold even against
 *     a buggy client, a manual psql session, or a future second service.
 */
export async function updateOrderStatus({ orderId, toStatus, expectedVersion, actor, requestId }) {
  const startedAt = Date.now();

  // ---- Layer 1: Redis lock -----------------------------------------------
  const lock = await acquireLock(`order:${orderId}`);
  if (lock === null) {
    await activity.record({
      type: 'order.status_rejected',
      orderId,
      actorId: actor.id,
      actorName: actor.name,
      payload: { reason: 'ORDER_BUSY', attempted: toStatus, requestId },
    });
    throw conflict(
      'ORDER_BUSY',
      'Someone else is updating this order right now. Refresh and try again.',
    );
  }

  try {
    const result = await withTransaction(async (client) => {
      // ---- Layer 2: row-level lock ----------------------------------------
      const { rows } = await client.query(
        'SELECT id, status, version FROM orders WHERE id = $1 FOR UPDATE',
        [orderId],
      );
      const current = rows[0];
      if (!current) throw notFound(`Order #${orderId} does not exist`);

      // ---- Layer 3: optimistic version check ------------------------------
      if (current.version !== expectedVersion) {
        throw conflict(
          'VERSION_CONFLICT',
          `Order #${orderId} was already moved to ${current.status} by someone else. Refresh to see the latest state.`,
          { currentStatus: current.status, currentVersion: current.version, attempted: toStatus },
        );
      }

      const allowed = nextStatus(current.status);
      if (allowed === null) {
        throw unprocessable(
          'TERMINAL_STATE',
          `Order #${orderId} is already COMPLETED and cannot change again.`,
          { currentStatus: current.status },
        );
      }
      if (toStatus !== allowed) {
        // Covers both skipping ahead (PREPARING -> COMPLETED) and going
        // backwards (READY -> PREPARING).
        throw unprocessable(
          'INVALID_TRANSITION',
          `Order #${orderId} is ${current.status}. The only allowed next stage is ${allowed}.`,
          { currentStatus: current.status, allowedNext: allowed, attempted: toStatus },
        );
      }

      const updated = await client.query(
        `UPDATE orders
            SET status = $1, version = version + 1, updated_at = now()
          WHERE id = $2 AND version = $3
          RETURNING *`,
        [toStatus, orderId, expectedVersion],
      );
      if (updated.rowCount === 0) {
        // Belt and braces: unreachable while the row lock is held.
        throw conflict('VERSION_CONFLICT', 'Order changed while being updated. Please retry.');
      }

      // ---- Layer 4: unique constraint --------------------------------------
      try {
        await client.query(
          `INSERT INTO order_status_transitions (order_id, from_status, to_status, actor_id)
           VALUES ($1, $2, $3, $4)`,
          [orderId, current.status, toStatus, actor.id],
        );
      } catch (err) {
        if (err.code === '23505') {
          throw conflict(
            'DUPLICATE_TRANSITION',
            `Order #${orderId} has already been marked ${toStatus}.`,
          );
        }
        throw err;
      }

      return { order: mapOrder(updated.rows[0]), from: current.status };
    });

    await bumpGeneration(); // invalidate the cached board
    await activity.record({
      type: 'order.status_changed',
      orderId,
      actorId: actor.id,
      actorName: actor.name,
      payload: {
        from: result.from,
        to: toStatus,
        requestId,
        lockDegraded: lock.degraded,
        durationMs: Date.now() - startedAt,
      },
    });

    logger.info('order.status_changed', {
      orderId, from: result.from, to: toStatus, actorId: actor.id, durationMs: Date.now() - startedAt,
    });

    return result.order;
  } catch (err) {
    if (err.expected) {
      await activity.record({
        type: 'order.status_rejected',
        orderId,
        actorId: actor.id,
        actorName: actor.name,
        payload: { reason: err.code, attempted: toStatus, expectedVersion, requestId },
      });
    }
    throw err;
  } finally {
    // Always released, on every path, including the thrown ones.
    await releaseLock(lock);
  }
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function listOrders({ status, page = 1, limit = 20 }) {
  if (status && !ALL_STATUSES.includes(status)) {
    throw badRequest('INVALID_STATUS', `status must be one of: ${ALL_STATUSES.join(', ')}`);
  }
  const offset = (page - 1) * limit;

  // Read-through cache. This endpoint is polled by every screen in the
  // restaurant, so it is the one worth caching; a 30s TTL plus generation-based
  // invalidation on write means staff never see a stale board after an action.
  const { value, hit } = await readThrough(
    (generation) => ordersListKey({ status, page, limit, generation }),
    async () => {
      const params = [];
      let where = '';
      if (status) {
        params.push(status);
        where = 'WHERE o.status = $1';
      }
      params.push(limit, offset);

      // Items are aggregated in the same query — no N+1 round trip per order.
      const { rows } = await query(
        `SELECT o.*,
                COALESCE(
                  json_agg(
                    json_build_object('id', i.id, 'name', i.name,
                                      'quantity', i.quantity, 'unitPrice', i.unit_price)
                    ORDER BY i.id
                  ) FILTER (WHERE i.id IS NOT NULL), '[]'
                ) AS items
           FROM orders o
           LEFT JOIN order_items i ON i.order_id = o.id
           ${where}
          GROUP BY o.id
          ORDER BY o.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      const counted = await query(
        status ? 'SELECT COUNT(*)::int AS total FROM orders WHERE status = $1'
               : 'SELECT COUNT(*)::int AS total FROM orders',
        status ? [status] : [],
      );
      const total = counted.rows[0].total;

      return {
        orders: rows.map(mapOrder),
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      };
    },
  );

  return { ...value, cached: hit };
}

export async function getOrderById(orderId) {
  const { rows } = await query(
    `SELECT o.*,
            COALESCE(
              json_agg(
                json_build_object('id', i.id, 'name', i.name,
                                  'quantity', i.quantity, 'unitPrice', i.unit_price)
                ORDER BY i.id
              ) FILTER (WHERE i.id IS NOT NULL), '[]'
            ) AS items
       FROM orders o
       LEFT JOIN order_items i ON i.order_id = o.id
      WHERE o.id = $1
      GROUP BY o.id`,
    [orderId],
  );
  if (!rows[0]) throw notFound(`Order #${orderId} does not exist`);
  return mapOrder(rows[0]);
}

export async function getOrderHistory(orderId) {
  await getOrderById(orderId); // 404 early if the order is not real

  // Postgres holds the authoritative transition record; Mongo holds the richer
  // activity trail including rejected attempts.
  const { rows } = await query(
    `SELECT t.from_status, t.to_status, t.created_at, u.name AS actor_name
       FROM order_status_transitions t
       LEFT JOIN users u ON u.id = t.actor_id
      WHERE t.order_id = $1
      ORDER BY t.created_at ASC`,
    [orderId],
  );

  return {
    transitions: rows.map((row) => ({
      from: row.from_status,
      to: row.to_status,
      at: row.created_at,
      by: row.actor_name,
    })),
    activity: await activity.listForOrder(orderId),
  };
}

export async function getStats() {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS count FROM orders GROUP BY status`,
  );
  const counts = Object.fromEntries(ALL_STATUSES.map((status) => [status, 0]));
  rows.forEach((row) => { counts[row.status] = row.count; });
  return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

export const _internals = { mapOrder, pool };
