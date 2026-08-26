import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { unauthorized, forbidden } from '../lib/errors.js';

export function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), email: user.email, role: user.role, name: user.name },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn },
  );
}

/** Rejects the request unless it carries a valid, unexpired bearer token. */
export function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(unauthorized('Missing bearer token'));
  }

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.user = {
      id: Number(payload.sub),
      email: payload.email,
      role: payload.role,
      name: payload.name,
    };
    return next();
  } catch (err) {
    const message =
      err.name === 'TokenExpiredError' ? 'Session expired, please log in again' : 'Invalid token';
    return next(unauthorized(message));
  }
}

export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user?.role) ? next() : next(forbidden(`Requires role: ${roles.join(' or ')}`));
