/**
 * Creates two demo staff accounts and a handful of orders so the app has
 * something on screen immediately. Safe to re-run.
 *
 *   npm run seed
 */
import bcrypt from 'bcryptjs';
import { pool, query } from '../src/db/postgres.js';
import { migrate } from '../src/db/migrate.js';
import { config } from '../src/config/env.js';

const USERS = [
  { name: 'Priya Nair', email: 'priya@restaurant.test', password: 'password123', role: 'manager' },
  { name: 'Arjun Rao', email: 'arjun@restaurant.test', password: 'password123', role: 'staff' },
];

const ORDERS = [
  { tableNumber: 4, customerName: 'Walk-in', items: [{ name: 'Margherita Pizza', quantity: 1, unitPrice: 349 }, { name: 'Iced Tea', quantity: 2, unitPrice: 99 }] },
  { tableNumber: 7, customerName: 'Deepa', items: [{ name: 'Paneer Butter Masala', quantity: 1, unitPrice: 289 }, { name: 'Butter Naan', quantity: 3, unitPrice: 45 }] },
  { tableNumber: 2, customerName: 'Table 2', items: [{ name: 'Veg Biryani', quantity: 2, unitPrice: 259 }] },
  { tableNumber: 11, customerName: 'Sameer', items: [{ name: 'Masala Dosa', quantity: 2, unitPrice: 149 }, { name: 'Filter Coffee', quantity: 2, unitPrice: 69 }] },
];

async function run() {
  await migrate();

  const userIds = [];
  for (const user of USERS) {
    const hash = await bcrypt.hash(user.password, config.bcryptRounds);
    const { rows } = await query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [user.name, user.email, hash, user.role],
    );
    userIds.push(rows[0].id);
    console.log(`  user  ${user.email}  /  ${user.password}  (${user.role})`);
  }

  const { rows: existing } = await query('SELECT COUNT(*)::int AS count FROM orders');
  if (existing[0].count > 0) {
    console.log(`\n  ${existing[0].count} order(s) already present — skipping order seed.`);
  } else {
    for (const order of ORDERS) {
      const total = order.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
      const { rows } = await query(
        `INSERT INTO orders (table_number, customer_name, total_amount, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [order.tableNumber, order.customerName, total, userIds[0]],
      );
      const orderId = rows[0].id;
      for (const item of order.items) {
        await query(
          `INSERT INTO order_items (order_id, name, quantity, unit_price) VALUES ($1, $2, $3, $4)`,
          [orderId, item.name, item.quantity, item.unitPrice],
        );
      }
      await query(
        `INSERT INTO order_status_transitions (order_id, from_status, to_status, actor_id)
         VALUES ($1, 'NEW', 'PREPARING', $2) ON CONFLICT DO NOTHING`,
        [orderId, userIds[0]],
      );
      console.log(`  order #${orderId}  table ${order.tableNumber}  PREPARING`);
    }
  }

  console.log('\nSeed complete.\n');
  await pool.end();
}

run().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
