import { randomUUID } from 'node:crypto';

/** Tags every request with an id so a client error can be traced to a log line. */
export function requestContext(req, res, next) {
  req.id = req.headers['x-request-id'] || randomUUID();
  req.startedAt = Date.now();
  res.set('X-Request-Id', req.id);
  next();
}
