import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { config } from '../config/env.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` },
    requestId: req.id,
  });
}

/**
 * The single place errors become HTTP responses.
 *
 * Deliberate errors (AppError) carry their own status, machine-readable code and
 * a message written for a human. Anything else is unexpected: it is logged in
 * full with a stack, and the client gets a generic 500 with a request id. A raw
 * stack trace is never sent to the client — it leaks file paths, dependency
 * versions and sometimes query fragments.
 */
export function errorHandler(err, req, res, _next) {
  const durationMs = Date.now() - (req.startedAt || Date.now());

  if (err instanceof AppError) {
    logger.warn('request.rejected', {
      requestId: req.id,
      code: err.code,
      status: err.status,
      path: req.originalUrl,
      method: req.method,
      userId: req.user?.id,
      durationMs,
    });
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
      requestId: req.id,
    });
  }

  // Connection-level failures from a datastore: say "unavailable", not "broken".
  const isConnectionError = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(err.code);
  if (isConnectionError) {
    logger.error('dependency.unreachable', { requestId: req.id, error: err.message, code: err.code });
    return res.status(503).json({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'A required service is temporarily unavailable. Please retry shortly.',
      },
      requestId: req.id,
    });
  }

  logger.error('request.failed', {
    requestId: req.id,
    path: req.originalUrl,
    method: req.method,
    error: err.message,
    stack: err.stack,
    durationMs,
  });

  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side.',
      // Only in development, and only the message — never the stack.
      ...(config.nodeEnv === 'development' ? { debug: err.message } : {}),
    },
    requestId: req.id,
  });
}

/** Wraps async handlers so a rejected promise reaches errorHandler. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
