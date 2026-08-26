/**
 * THE CONCURRENCY PROOF — run this on camera during the video walkthrough.
 *
 *   npm run race
 *
 * It reproduces the exact scenario from the brief:
 *
 *   Order #58 is PREPARING. Two staff are looking at the same board.
 *   Staff A taps "Ready" and Staff B taps "Completed" in the same instant,
 *   both from screens showing version 1.
 *
 * Both requests are fired with Promise.all so they hit the server genuinely
 * concurrently, not one after the other. Exactly one must win. The other must
 * be rejected with a clear reason — never silently applied, never lost.
 *
 * The script then re-reads the order and its transition history from Postgres
 * and asserts that the order did not skip a stage, go backwards, or record the
 * same stage twice.
 */
const BASE = process.env.API_URL || 'http://localhost:4000';
const EMAIL = process.env.SEED_EMAIL || 'usha@restaurant.test';
const PASSWORD = process.env.SEED_PASSWORD || 'password123';
const CONTENDERS = Number(process.env.CONTENDERS || 2);

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: payload };
}

async function main() {
  console.log(bold('\n  Concurrency test — two staff, one order, same instant\n'));

  // --- 1. Log in --------------------------------------------------------
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { email: EMAIL, password: PASSWORD },
  });
  if (login.status !== 200) {
    console.error(red(`  Login failed (${login.status}). Run "npm run seed" first.`));
    process.exit(1);
  }
  const token = login.body.token;
  console.log(dim(`  Logged in as ${login.body.user.name}`));

  // --- 2. Create a fresh order to race on -------------------------------
  const created = await api('/api/orders', {
    method: 'POST',
    token,
    body: {
      tableNumber: 58,
      customerName: 'Race Test',
      items: [{ name: 'Pizza', quantity: 1, unitPrice: 349 }],
    },
  });
  const order = created.body.order;
  console.log(dim(`  Created order #${order.id} — status ${order.status}, version ${order.version}\n`));

  // --- 3. Fire competing requests simultaneously ------------------------
  // Both carry expectedVersion 1: both staff are looking at the same stale screen.
  const attempts = [
    { label: 'Staff A taps READY    ', toStatus: 'READY' },
    { label: 'Staff B taps COMPLETED', toStatus: 'COMPLETED' },
  ];
  for (let i = 2; i < CONTENDERS; i += 1) {
    attempts.push({ label: `Staff ${String.fromCharCode(65 + i)} taps READY    `, toStatus: 'READY' });
  }

  console.log(bold(`  Firing ${attempts.length} requests at the same moment...\n`));

  const results = await Promise.all(
    attempts.map((attempt) =>
      api(`/api/orders/${order.id}/status`, {
        method: 'PATCH',
        token,
        body: { toStatus: attempt.toStatus, expectedVersion: order.version },
      }).then((res) => ({ ...res, label: attempt.label })),
    ),
  );

  let winners = 0;
  for (const result of results) {
    if (result.status === 200) {
      winners += 1;
      console.log(`  ${result.label}  ${green(`200 OK`)}      -> now ${result.body.order.status}, version ${result.body.order.version}`);
    } else {
      const { code, message } = result.body?.error || {};
      console.log(`  ${result.label}  ${yellow(`${result.status} ${code}`)}`);
      console.log(dim(`                          ${message}`));
    }
  }

  // --- 4. Verify the stored state --------------------------------------
  const after = await api(`/api/orders/${order.id}`, { token });
  const history = await api(`/api/orders/${order.id}/history`, { token });
  const stages = history.body.transitions.map((t) => `${t.from}->${t.to}`);

  console.log(bold('\n  Final state\n'));
  console.log(`  Status        ${after.body.order.status}`);
  console.log(`  Version       ${after.body.order.version}`);
  console.log(`  History       ${stages.join('  ')}`);

  // --- 5. Assertions ----------------------------------------------------
  const toStages = history.body.transitions.map((t) => t.to);
  const checks = [
    ['Exactly one request succeeded', winners === 1],
    ['Order did not skip a stage', after.body.order.status === 'READY'],
    ['No stage recorded twice', new Set(toStages).size === toStages.length],
    ['Version incremented exactly once', after.body.order.version === 2],
  ];

  console.log(bold('\n  Checks\n'));
  let allPassed = true;
  for (const [name, passed] of checks) {
    console.log(`  ${passed ? green('PASS') : red('FAIL')}  ${name}`);
    if (!passed) allPassed = false;
  }

  console.log(
    allPassed
      ? green(bold('\n  All checks passed — the order is in exactly one correct state.\n'))
      : red(bold('\n  A check failed.\n')),
  );
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(red(`\n  Test failed to run: ${err.message}`));
  console.error(dim('  Is the API running on ' + BASE + '?\n'));
  process.exit(1);
});
