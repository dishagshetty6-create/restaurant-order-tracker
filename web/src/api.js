const TOKEN_KEY = 'rot.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/**
 * Thin fetch wrapper. Every non-2xx response is turned into an ApiError that
 * carries the server's machine-readable code, so the UI can react to a
 * VERSION_CONFLICT differently from a generic failure.
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Network-level failure: the server is unreachable, not returning an error.
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check it is running.');
  }

  if (response.status === 204) return null;

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = payload?.error || {};
    throw new ApiError(
      response.status,
      error.code || 'UNKNOWN',
      error.message || 'Something went wrong',
      error.details,
    );
  }
  return payload;
}

export const api = {
  login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password } }),
  register: (payload) => request('/api/auth/register', { method: 'POST', body: payload }),
  me: () => request('/api/auth/me'),
  listOrders: (status) =>
    request(`/api/orders?limit=50${status ? `&status=${status}` : ''}`),
  createOrder: (payload, idempotencyKey) =>
    request('/api/orders', {
      method: 'POST',
      body: payload,
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
    }),
  advance: (id, toStatus, expectedVersion) =>
    request(`/api/orders/${id}/status`, { method: 'PATCH', body: { toStatus, expectedVersion } }),
  history: (id) => request(`/api/orders/${id}/history`),
  stats: () => request('/api/stats'),
};
