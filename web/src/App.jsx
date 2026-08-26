import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken, clearToken } from './api.js';
import Login from './components/Login.jsx';
import Ticket from './components/Ticket.jsx';
import NewOrderForm from './components/NewOrderForm.jsx';
import HistoryPanel from './components/HistoryPanel.jsx';

const COLUMNS = [
  { status: 'PREPARING', label: 'Preparing', className: 'col-preparing' },
  { status: 'READY', label: 'Ready', className: 'col-ready' },
  { status: 'COMPLETED', label: 'Completed', className: 'col-completed' },
];

const POLL_MS = 3000;

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [orders, setOrders] = useState([]);
  const [conflicts, setConflicts] = useState({}); // orderId -> {code, message}
  const [pending, setPending] = useState({});     // orderId -> true while in flight
  const [toasts, setToasts] = useState([]);
  const [showNewOrder, setShowNewOrder] = useState(false);
  const [historyFor, setHistoryFor] = useState(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const toastId = useRef(0);

  const pushToast = useCallback((kind, title, message) => {
    const id = (toastId.current += 1);
    setToasts((current) => [...current, { id, kind, title, message }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 6000);
  }, []);

  /* ---- session ---- */
  useEffect(() => {
    if (!getToken()) { setChecking(false); return; }
    api.me()
      .then((result) => setUser(result.user))
      .catch(() => clearToken())
      .finally(() => setChecking(false));
  }, []);

  /* ---- polling ----
     Every screen in the restaurant polls the board, which is exactly why the
     list endpoint is the one cached in Redis. Three seconds is frequent enough
     that staff see each other's actions almost immediately, and the cache keeps
     the database load flat regardless of how many screens are mounted. */
  const refresh = useCallback(async () => {
    try {
      const result = await api.listOrders();
      setOrders(result.orders);
      setConnectionLost(false);
    } catch (err) {
      if (err.status === 401) { clearToken(); setUser(null); return; }
      setConnectionLost(true);
    }
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [user, refresh]);

  /* ---- the concurrency-critical action ---- */
  async function advance(order, toStatus, expectedVersion) {
    setPending((current) => ({ ...current, [order.id]: true }));
    setConflicts((current) => {
      const next = { ...current };
      delete next[order.id];
      return next;
    });

    try {
      const result = await api.advance(order.id, toStatus, expectedVersion);
      // Apply the server's copy immediately rather than guessing locally, so the
      // version we hold is always the one the server just wrote.
      setOrders((current) => current.map((o) => (o.id === order.id ? result.order : o)));
      pushToast('success', `Order #${order.id}`, `Moved to ${toStatus}.`);
    } catch (err) {
      const stale = ['VERSION_CONFLICT', 'ORDER_BUSY', 'DUPLICATE_TRANSITION'].includes(err.code);
      const illegal = ['INVALID_TRANSITION', 'TERMINAL_STATE'].includes(err.code);

      if (stale || illegal) {
        // Pin the explanation to the docket it belongs to, and pull the true
        // state so the screen stops being stale.
        setConflicts((current) => ({ ...current, [order.id]: { code: err.code, message: err.message } }));
        await refresh();
      } else {
        pushToast('error', err.code || 'Error', err.message);
      }
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[order.id];
        return next;
      });
    }
  }

  async function createOrder(payload) {
    // A random idempotency key means a double-click, or a retry after a flaky
    // network, cannot produce two identical orders.
    const key = crypto.randomUUID();
    const result = await api.createOrder(payload, key);
    await refresh();
    pushToast('success', `Order #${result.order.id}`, 'Sent to the kitchen.');
  }

  function signOut() {
    clearToken();
    setUser(null);
    setOrders([]);
  }

  if (checking) return null;
  if (!user) return <Login onSignedIn={setUser} />;

  const counts = COLUMNS.map((column) => orders.filter((o) => o.status === column.status).length);

  return (
    <>
      <header className="topbar">
        <div className="brand">Expo <span>· order tracker</span></div>
        <div className="topbar-spacer" />
        <div className="counts">
          {COLUMNS.map((column, index) => (
            <div key={column.status}>
              <strong>{counts[index]}</strong>
              {column.label}
            </div>
          ))}
        </div>
        <span className="who">{user.name} · {user.role}</span>
        <button className="btn btn-primary" onClick={() => setShowNewOrder(true)}>New order</button>
        <button className="btn" onClick={signOut}>Sign out</button>
      </header>

      {connectionLost && (
        <div className="form-error" style={{ margin: '1rem 1.5rem 0' }}>
          Lost contact with the server. Showing the last known board and retrying every {POLL_MS / 1000}s.
        </div>
      )}

      <main className="board">
        {COLUMNS.map((column) => {
          const columnOrders = orders.filter((order) => order.status === column.status);
          return (
            <section key={column.status} className={column.className}>
              <div className="column-head">
                <h2>{column.label}</h2>
                <span className="tally">{columnOrders.length}</span>
              </div>

              {columnOrders.length === 0 ? (
                <p className="empty">
                  {column.status === 'PREPARING' ? 'Nothing in the kitchen. Start an order.' : `No orders ${column.label.toLowerCase()}.`}
                </p>
              ) : (
                columnOrders.map((order) => (
                  <Ticket
                    key={order.id}
                    order={order}
                    conflict={conflicts[order.id]}
                    busy={Boolean(pending[order.id])}
                    onAdvance={advance}
                    onHistory={setHistoryFor}
                  />
                ))
              )}
            </section>
          );
        })}
      </main>

      {showNewOrder && <NewOrderForm onClose={() => setShowNewOrder(false)} onCreate={createOrder} />}
      {historyFor && <HistoryPanel order={historyFor} onClose={() => setHistoryFor(null)} />}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            <strong>{toast.title}</strong>
            {toast.message}
          </div>
        ))}
      </div>
    </>
  );
}
