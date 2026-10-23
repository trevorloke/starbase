// Sign in: email, password, one button.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { apiPost } from '../api.js';

// Big, thumb-sized controls (auth pages load before any page stylesheet).
const AUTH_INPUT = { minHeight: 48, fontSize: 16 };
const AUTH_BUTTON = { width: '100%', minHeight: 52, fontSize: 13, marginTop: 'var(--s-2)' };

export default function Login() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await apiPost('/auth/login', { email, password });
      queryClient.setQueryData(['me'], me);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <span className="brand">Starbase</span>
      <h1>Sign in</h1>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input id="login-email" className="input" type="email" required autoFocus autoComplete="email" style={AUTH_INPUT}
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input id="login-password" className="input" type="password" required autoComplete="current-password" style={AUTH_INPUT}
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-primary" style={AUTH_BUTTON} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <hr className="hairline" />
      <p className="muted"><Link to="/signup">Start a new campaign</Link></p>
    </div>
  );
}
