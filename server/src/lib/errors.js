/**
 * Every error the API deliberately returns is an AppError. Anything else that
 * reaches the error handler is treated as an unexpected 500: it is logged in
 * full server-side and reduced to a generic message for the client.
 */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = true;
  }
}

export const badRequest = (code, message, details) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Resource not found') =>
  new AppError(404, 'NOT_FOUND', message);
export const conflict = (code, message, details) => new AppError(409, code, message, details);
export const unprocessable = (code, message, details) => new AppError(422, code, message, details);
export const serviceUnavailable = (message = 'A dependency is unavailable') =>
  new AppError(503, 'SERVICE_UNAVAILABLE', message);
