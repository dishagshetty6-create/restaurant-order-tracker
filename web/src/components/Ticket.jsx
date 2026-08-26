import { useEffect, useState } from 'react';

const LABEL = { READY: 'Mark ready', COMPLETED: 'Mark completed' };

function elapsed(since) {
  const minutes = Math.floor((Date.now() - new Date(since).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * One order docket. Holds no server state of its own — the conflict message is
 * passed down so a stale-screen rejection stays pinned to the order it concerns.
 */
export default function Ticket({ order, conflict, busy, onAdvance, onHistory }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    // Re-render once a minute so the age on each docket stays truthful.
    const id = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const age = elapsed(order.createdAt);
  const isLate = order.status !== 'COMPLETED' && Date.now() - new Date(order.createdAt).getTime() > 15 * 60000;

  return (
    <article className={`ticket s-${order.status}${conflict ? ' conflicted' : ''}`}>
      <div className="ticket-head">
        <span className="ticket-no">#{order.id}</span>
        <span className={`ticket-timer${isLate ? ' late' : ''}`}>{age}</span>
      </div>

      <div className="ticket-meta">
        {order.tableNumber ? `Table ${order.tableNumber}` : 'No table'}
        {order.customerName ? ` · ${order.customerName}` : ''}
        {' · ₹'}
        {Number(order.totalAmount).toFixed(2)}
      </div>

      <ul className="items">
        {order.items.map((item) => (
          <li key={item.id}>
            <span>
              <span className="qty">{item.quantity}×</span>
              {item.name}
            </span>
            <span className="qty">₹{Number(item.unitPrice).toFixed(2)}</span>
          </li>
        ))}
      </ul>

      {conflict && (
        <div className="conflict">
          {conflict.message}
          <br />
          <code>{conflict.code}</code>
        </div>
      )}

      <div className="ticket-foot">
        <span className="version">v{order.version}</span>
        <button className="link-btn" onClick={() => onHistory(order)}>
          History
        </button>
        {order.nextStatus && (
          <button
            className={`advance to-${order.nextStatus}`}
            disabled={busy}
            // The version the screen is currently showing travels with the
            // request. If it is stale, the server rejects rather than applies.
            onClick={() => onAdvance(order, order.nextStatus, order.version)}
          >
            {busy ? 'Sending…' : LABEL[order.nextStatus]}
          </button>
        )}
      </div>
    </article>
  );
}
