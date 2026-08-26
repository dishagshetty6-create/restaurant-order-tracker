import { useEffect, useState } from 'react';
import { api } from '../api.js';

/** Shows the authoritative transition list from Postgres plus the Mongo trail. */
export default function HistoryPanel({ order, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .history(order.id)
      .then((result) => !cancelled && setData(result))
      .catch((err) => !cancelled && setError(err.message));
    return () => { cancelled = true; };
  }, [order.id]);

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel">
        <h2>Order #{order.id} history</h2>

        {error && <div className="form-error">{error}</div>}
        {!data && !error && <p style={{ color: 'var(--paper-dim)' }}>Loading…</p>}

        {data && (
          <>
            <ul className="history">
              {data.transitions.map((entry, index) => (
                <li key={index}>
                  <span className="stage">{entry.from} → {entry.to}</span>
                  <span>{entry.by || 'system'}</span>
                  <span className="when">{new Date(entry.at).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>

            {data.activity?.length > 0 && (
              <>
                <h2 style={{ marginTop: '1.5rem', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--paper-dim)' }}>
                  Activity log (MongoDB)
                </h2>
                <ul className="history">
                  {data.activity.map((entry) => (
                    <li key={entry._id}>
                      <span className="stage">{entry.type.replace('order.', '')}</span>
                      <span>
                        {entry.actorName}
                        {entry.payload?.reason ? ` · ${entry.payload.reason}` : ''}
                      </span>
                      <span className="when">{new Date(entry.ts).toLocaleTimeString()}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        <div className="actions">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
