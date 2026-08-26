import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../db/postgres.js';
import { config } from '../config/env.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import * as activity from '../services/activityLog.js';

const router = Router();

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  role: z.enum(['staff', 'manager']).default('staff'),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

router.post(
  '/register',
  rateLimit({ name: 'register', max: 10, windowMs: 60_000 }),
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const { name, email, password, role } = req.body;

    // Passwords are never stored, only their bcrypt hash (per-password salt included).
    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);

    try {
      const { rows } = await query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, email, role`,
        [name, email, passwordHash, role],
      );
      const user = rows[0];
      res.status(201).json({ user, token: signToken(user) });
    } catch (err) {
      if (err.code === '23505') throw badRequest('EMAIL_TAKEN', 'That email is already registered');
      throw err;
    }
  }),
);

router.post(
  '/login',
  // Tighter limit than the write endpoints: this one is a credential-stuffing target.
  rateLimit({ name: 'login', max: 10, windowMs: 60_000 }),
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const { rows } = await query(
      'SELECT id, name, email, role, password_hash FROM users WHERE email = $1',
      [email],
    );
    const user = rows[0];

    // Compare even when the user does not exist, so response time does not
    // reveal which emails are registered.
    const fallbackHash = '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const ok = await bcrypt.compare(password, user?.password_hash || fallbackHash);
    if (!user || !ok) throw unauthorized('Invalid email or password');

    const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role };
    await activity.record({ type: 'auth.login', actorId: user.id, actorName: user.name });
    res.json({ user: safeUser, token: signToken(safeUser) });
  }),
);

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

export default router;
