// Sign in: email, password, one button. The first-run setup link shows only
// until Imagine Surrey is set up (after that, people join by invite).
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api.js';
import { landing } from '../mode.js';

// Big, thumb-sized controls (auth pages load before any page stylesheet).
const AUTH_INPUT = { minHeight: 48, fontSize: 16 };
const AUTH_BUTTON = { width: '100%', minHeight: 52, fontSize: 13, marginTop: 'var(--s-2)' };

export default function Login({ mode = 'field' }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setup = useQuery({ queryKey: ['auth-setup'], queryFn: () => apiGet('/auth/setup'), retry: false });
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
      const go = landing(me, mode);
      if (go.href) window.location.assign(go.href); else navigate(go.to);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <span className="brand">Starbase</span>
      <span className="brand-org">Imagine Surrey</span>
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
      {setup.data?.open && (
        <>
          <hr className="hairline" />
          <p className="muted"><Link to="/signup">Set up Starbase for Imagine Surrey</Link></p>
        </>
      )}
    </div>
  );
}
