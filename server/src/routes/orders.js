import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import * as orders from '../services/orderService.js';

const router = Router();
router.use(requireAuth); // every order route requires a valid token

const itemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  quantity: z.number().int().positive().max(99),
  unitPrice: z.number().nonnegative().max(100000),
});

const createSchema = z.object({
  tableNumber: z.number().int().positive().max(999).optional(),
  customerName: z.string().trim().max(120).optional(),
  items: z.array(itemSchema).min(1, 'An order needs at least one item').max(50),
});

const statusSchema = z.object({
  toStatus: z.enum(['PREPARING', 'READY', 'COMPLETED']),
  // Required, not optional: the client must state which version of the order it
  // was looking at. This is what makes a stale screen detectable.
  expectedVersion: z.number().int().positive(),
});

const listSchema = z.object({
  status: z.enum(['PREPARING', 'READY', 'COMPLETED']).optional(),
  // Hard cap on limit — a list endpoint must never be able to return the table.
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const idSchema = z.object({ id: z.coerce.number().int().positive() });

router.post(
  '/',
  rateLimit({ name: 'order_create', max: 60, windowMs: 60_000 }),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const { order, replayed } = await orders.createOrder({
      ...req.body,
      actor: req.user,
      idempotencyKey: req.headers['idempotency-key'],
    });
    res.status(replayed ? 200 : 201).json({ order, replayed });
  }),
);

router.get(
  '/',
  validate(listSchema, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await orders.listOrders(req.query));
  }),
);

router.get(
  '/:id',
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json({ order: await orders.getOrderById(req.params.id) });
  }),
);

router.get(
  '/:id/history',
  validate(idSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(await orders.getOrderHistory(req.params.id));
  }),
);

/**
 * The concurrency-critical endpoint.
 *
 *   200 - advanced
 *   409 ORDER_BUSY          - another request holds the lock this instant
 *   409 VERSION_CONFLICT    - someone else already moved it; your screen is stale
 *   422 INVALID_TRANSITION  - would skip a stage or go backwards
 *   422 TERMINAL_STATE      - already COMPLETED
 *   404 NOT_FOUND           - no such order
 */
router.patch(
  '/:id/status',
  rateLimit({ name: 'order_status', max: 120, windowMs: 60_000 }),
  validate(idSchema, 'params'),
  validate(statusSchema),
  asyncHandler(async (req, res) => {
    const order = await orders.updateOrderStatus({
      orderId: req.params.id,
      toStatus: req.body.toStatus,
      expectedVersion: req.body.expectedVersion,
      actor: req.user,
      requestId: req.id,
    });
    res.json({ order });
  }),
);

export default router;
