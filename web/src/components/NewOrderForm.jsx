import { useState } from 'react';

const blankItem = () => ({ name: '', quantity: 1, unitPrice: '' });

export default function NewOrderForm({ onClose, onCreate }) {
  const [tableNumber, setTableNumber] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [items, setItems] = useState([blankItem()]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const updateItem = (index, key, value) =>
    setItems(items.map((item, i) => (i === index ? { ...item, [key]: value } : item)));

  async function submit(event) {
    event.preventDefault();
    setError(null);

    const cleaned = items
      .filter((item) => item.name.trim())
      .map((item) => ({
        name: item.name.trim(),
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice || 0),
      }));

    if (cleaned.length === 0) {
      setError('Add at least one item to the order.');
      return;
    }

    setBusy(true);
    try {
      await onCreate({
        ...(tableNumber ? { tableNumber: Number(tableNumber) } : {}),
        ...(customerName.trim() ? { customerName: customerName.trim() } : {}),
        items: cleaned,
      });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const total = items.reduce(
    (sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0),
    0,
  );

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel">
        <h2>New order</h2>
        <form onSubmit={submit}>
          {error && <div className="form-error">{error}</div>}

          <div className="row">
            <div className="field">
              <label htmlFor="table">Table number</label>
              <input id="table" type="number" min="1" value={tableNumber} onChange={(e) => setTableNumber(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="customer">Customer</label>
              <input id="customer" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Optional" />
            </div>
          </div>

          <div className="field">
            <label>Items</label>
            {items.map((item, index) => (
              <div className="item-row" key={index}>
                <div className="field name">
                  <input
                    value={item.name}
                    onChange={(e) => updateItem(index, 'name', e.target.value)}
                    placeholder="Dish"
                    aria-label={`Item ${index + 1} name`}
                  />
                </div>
                <div className="field qty">
                  <input
                    type="number" min="1" value={item.quantity}
                    onChange={(e) => updateItem(index, 'quantity', e.target.value)}
                    aria-label={`Item ${index + 1} quantity`}
                  />
                </div>
                <div className="field price">
                  <input
                    type="number" min="0" step="0.01" value={item.unitPrice}
                    onChange={(e) => updateItem(index, 'unitPrice', e.target.value)}
                    placeholder="₹" aria-label={`Item ${index + 1} price`}
                  />
                </div>
                {items.length > 1 && (
                  <button type="button" className="remove" onClick={() => setItems(items.filter((_, i) => i !== index))} aria-label="Remove item">
                    ×
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="btn" onClick={() => setItems([...items, blankItem()])}>
              Add item
            </button>
          </div>

          <div className="actions">
            <span style={{ marginRight: 'auto', alignSelf: 'center', fontFamily: 'var(--mono)', fontSize: '0.85rem' }}>
              ₹{total.toFixed(2)}
            </span>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Sending…' : 'Send to kitchen'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
