import { badRequest } from '../lib/errors.js';

/**
 * Validates and REPLACES the given request property with the parsed result, so
 * downstream handlers only ever see data that has been through the schema.
 * Nothing the client sends is trusted or passed through unvalidated.
 */
export const validate = (schema, property = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[property]);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || property,
      message: issue.message,
    }));
    return next(badRequest('VALIDATION_ERROR', 'Request failed validation', fields));
  }
  req[property] = result.data;
  return next();
};
