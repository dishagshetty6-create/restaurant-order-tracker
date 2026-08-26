import { useState } from 'react';
import { api, setToken } from '../api.js';

export default function Login({ onSignedIn }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: 'priya@restaurant.test', password: 'password123' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'login'
          ? await api.login(form.email, form.password)
          : await api.register({ name: form.name, email: form.email, password: form.password });
      setToken(result.token);
      onSignedIn(result.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login">
        <h1>Expo</h1>
        <p className="sub">Restaurant order tracker · kitchen display</p>

        <form onSubmit={submit}>
          {error && <div className="form-error">{error}</div>}

          {mode === 'register' && (
            <div className="field">
              <label htmlFor="name">Your name</label>
              <input id="name" value={form.name} onChange={update('name')} required minLength={2} />
            </div>
          )}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={form.email} onChange={update('email')} required autoComplete="off" />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={form.password}
              onChange={update('password')}
              required
              minLength={8}
            />
          </div>

          <div className="actions">
            <button
              type="button"
              className="btn"
              onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}
            >
              {mode === 'login' ? 'Create account' : 'Back to sign in'}
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </div>
        </form>

        <p className="hint">
          Seeded accounts: <code>usha@restaurant.test</code> (manager) and{' '}
          <code>deeks@restaurant.test</code> (staff), both <code>password123</code>.
          <br />
          Open a second browser window and sign in as the other one to see two staff
          competing for the same order.
        </p>
      </div>
    </div>
  );
}
