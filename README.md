# Restaurant Order Tracker

Orders move through a fixed sequence — **Preparing → Ready → Completed** — and
several staff work the same board at once. The whole system is built around one
requirement: when two people act on the same order at the same moment, the order
must never skip a stage, move backwards, or end up recorded in two states.

Stack: React · Node/Express · PostgreSQL (transactional core) · MongoDB (activity
trail) · Redis (cache, distributed lock, rate limiting).

---

## Quick start

**Prerequisites:** Node 18+ and Docker (for the three datastores).

```bash
# 1. Start PostgreSQL, MongoDB and Redis
docker compose up -d

# 2. Backend
cd server
cp .env.example .env          # then set JWT_SECRET to any long random string
npm install
npm run seed                  # creates the schema + demo users and orders
npm run dev                   # http://localhost:4000

# 3. Frontend (in a second terminal)
cd web
npm install
npm run dev                   # http://localhost:5173
```

Sign in with either seeded account — both use the password `password123`:

| Email | Role |
|---|---|
| `priya@restaurant.test` | manager |
| `arjun@restaurant.test` | staff |

To see the concurrency handling by hand, open the app in two browser windows,
sign in as a different user in each, and tap the two buttons on the same order at
the same time. One wins; the other is told exactly what happened.

---

## Proving the concurrency handling

```bash
cd server
npm run race
```

This fires competing status updates at one order **simultaneously** (via
`Promise.all`, not in sequence), then re-reads the stored state and asserts the
order did not skip a stage, go backwards, or record a stage twice.

```
  Staff A taps READY      200 OK      -> now READY, version 2
  Staff B taps COMPLETED  409 VERSION_CONFLICT
                          Order #6 was already moved to READY by someone else.

  Status        READY
  Version       2
  History       NEW->PREPARING  PREPARING->READY

  PASS  Exactly one request succeeded
  PASS  Order did not skip a stage
  PASS  No stage recorded twice
  PASS  Version incremented exactly once
```

Turn up the pressure with `CONTENDERS=10 npm run race` — ten simultaneous
requests, still exactly one winner.

**Worth trying:** stop Redis (`docker compose stop redis`) and run it again. The
rejection code changes from `ORDER_BUSY` to `VERSION_CONFLICT` because the Redis
lock is gone, but the result is still correct — the PostgreSQL row lock and
version check carry it alone. Redis is a speed layer here, never the guarantee.

---

## How the race is actually prevented

Four independent layers. Any one of them would mostly hold; they are stacked so
that no single failure can produce a wrong order state.

| # | Layer | What it does |
|---|---|---|
| 1 | **Redis lock** — `SET lock:order:58 <token> NX PX 3000` | Rejects a competing request immediately with `409 ORDER_BUSY` instead of letting it queue on a database row and hold a pooled connection. Optimisation only. |
| 2 | **Postgres row lock** — `SELECT … FOR UPDATE` in a transaction | The real guarantee. Locks that one row; a concurrent transaction waits there, then re-reads the committed new state. The two updates cannot interleave. |
| 3 | **Optimistic version check** | Every order carries a `version`, and the client must send the version it was showing. Once the first update commits, 1 → 2, so the stale request is rejected with `409 VERSION_CONFLICT` and a message naming what actually happened. |
| 4 | **Database constraints** | `UNIQUE(order_id, to_status)` means an order can physically enter each stage only once. A `CHECK` rejects any status outside the three legal values. These hold even against a buggy client or a manual `psql` session. |

Layer 3 is what makes the brief's scenario behave sensibly rather than merely
safely. Without it, staff B's "Completed" arrives after A's "Ready" has
committed, looks like a perfectly legal `READY → COMPLETED`, and silently
succeeds — the order jumps two stages from B's point of view and the kitchen
never registers that it was ever Ready. The version check turns that into an
honest "someone else already moved this."

---

## API

All `/api/orders` routes require `Authorization: Bearer <token>`.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/auth/register` | → `{ user, token }` |
| `POST` | `/api/auth/login` | → `{ user, token }`; rate limited to 10/min |
| `GET` | `/api/auth/me` | current user from the token |
| `POST` | `/api/orders` | accepts optional `Idempotency-Key` header |
| `GET` | `/api/orders?status=&page=&limit=` | paginated, `limit` capped at 100, Redis-cached |
| `GET` | `/api/orders/:id` | single order with items |
| `PATCH` | `/api/orders/:id/status` | `{ toStatus, expectedVersion }` — the critical endpoint |
| `GET` | `/api/orders/:id/history` | Postgres transitions + Mongo activity trail |
| `GET` | `/api/stats` | counts per stage |
| `GET` | `/api/activity` | recent activity from MongoDB |
| `GET` | `/health` | per-dependency status |

Errors are always shaped the same way, with a machine-readable code the frontend
branches on:

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Order #58 was already moved to READY by someone else.",
    "details": { "currentStatus": "READY", "currentVersion": 2 }
  },
  "requestId": "0f3c…"
}
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | body or query failed schema validation |
| 401 | `UNAUTHENTICATED` | missing, invalid or expired token |
| 404 | `NOT_FOUND` | no such order |
| 409 | `ORDER_BUSY` | another request holds the lock this instant |
| 409 | `VERSION_CONFLICT` | someone else already moved it; your screen is stale |
| 422 | `INVALID_TRANSITION` | would skip a stage or go backwards |
| 422 | `TERMINAL_STATE` | already Completed |
| 429 | `RATE_LIMITED` | too many requests; `Retry-After` header included |

---

## Why three datastores

**PostgreSQL** holds orders, items, users and the transition log — the data that
needs real transactions and row-level locking. Everything the concurrency
control depends on lives here.

**MongoDB** holds the activity trail: high volume, write-only, never joined, and
a different shape per event type (a rejected transition carries different fields
from a login). Keeping it out of Postgres means audit writes never contend with
the tables the locking depends on. Audit writes are also allowed to fail
silently — losing a log line is bad, failing a customer's order because the audit
database hiccuped is worse.

**Redis** does three real jobs: caches the orders board (the endpoint every
screen polls), provides the per-order distributed lock, and backs the rate
limiter. Cache invalidation uses a generation counter baked into each key, so a
write orphans the previous generation with one `INCR` rather than an O(n)
`KEYS`/`SCAN` sweep.

---

## Failure behaviour

Deliberate, and easy to demonstrate by stopping containers one at a time:

| Failure | Behaviour |
|---|---|
| **Redis down** | Cache becomes a permanent miss, lock is skipped, rate limiter fails open. Correctness unaffected — Postgres still serialises. `/health` reports `degraded`. |
| **MongoDB down** | Activity logging is skipped with a warning. Orders work normally. `/health` reports `degraded`. |
| **Postgres down** | Hard dependency. `/health` returns 503 and writes fail with `SERVICE_UNAVAILABLE` rather than a stack trace. |
| **Server restart** | `SIGTERM` stops new connections, then drains the pools so in-flight transactions are not cut mid-commit. |

A raw stack trace is never sent to a client. Unexpected errors are logged in full
server-side with a request id, and the client gets that id to quote.

---

## Security

- JWT bearer auth on every order route; passwords stored as bcrypt hashes only.
- Login compares against a dummy hash when the user does not exist, so response
  time does not reveal which emails are registered.
- Every input parsed by a Zod schema, and the parsed result *replaces* the raw
  input — handlers never see unvalidated data.
- All SQL uses parameterised queries; no string interpolation anywhere.
- Rate limits on login, registration, order creation and status updates, using an
  atomic Lua `INCR`+`PEXPIRE` so a crash between the two cannot leave a key
  without a TTL.
- Secrets come from environment variables; `.env` is gitignored and
  `.env.example` holds no real values.
- `helmet` for security headers, JSON body capped at 100 kB, `limit` on list
  endpoints capped at 100.

---

## Layout

```
server/
  src/
    config/env.js            environment parsing, fails fast on missing vars
    db/{postgres,mongo,redis,migrate}.js
    lib/{lock,cache,errors,logger}.js
    middleware/{auth,validate,rateLimit,errorHandler,requestContext}.js
    services/orderService.js   ← the concurrency logic lives here
    services/activityLog.js
    routes/{auth,orders,stats}.js
  scripts/{seed,race-test}.js
web/
  src/
    App.jsx                  board, polling, conflict handling
    api.js                   fetch wrapper, typed errors
    components/{Login,Ticket,NewOrderForm,HistoryPanel}.jsx
```

---

## Known limits and next steps

- **Polling, not push.** The board polls every 3s. WebSockets or SSE would make
  another staff member's action appear instantly instead of within 3s. Polling
  was the right call for two days, and the Redis cache keeps its cost flat.
- **Fixed-window rate limiting** allows a short burst across a window boundary.
  A sliding-window log would be smoother and more expensive.
- **Single-node Redis lock.** Fine here because the lock is an optimisation. If
  it were load-bearing, a multi-node setup would need Redlock or a move to
  Postgres advisory locks.
- **No automated test suite.** `npm run race` covers the critical path; unit
  tests around the state machine and integration tests per endpoint are the first
  thing to add.
- **Idempotency keys are never cleaned up.** They need a TTL sweep or a periodic
  delete job before this runs for long.
