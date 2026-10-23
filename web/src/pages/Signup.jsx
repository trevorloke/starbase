// First-run setup: Starbase runs for Imagine Surrey only. The first person
// sets it up (name, email, password) and becomes its manager; once that's
// done this page says so and points to Sign in — everyone else joins by invite.
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api.js';

// Big, thumb-sized controls (auth pages load before any page stylesheet).
const AUTH_INPUT = { minHeight: 48, fontSize: 16 };
const AUTH_BUTTON = { width: '100%', minHeight: 52, fontSize: 13, marginTop: 'var(--s-2)' };

// A box the browser won't accept yet, said in one line under the form.
const MISSING = {
  'su-name': 'Add your name',
  'su-email': 'Add your email',
  'su-password': 'Password: 8 or more characters',
};
const missingLine = (el) => {
  if (el.id === 'su-email' && el.validity.typeMismatch) return 'Check your email';
  return MISSING[el.id] || 'Fill in every box';
};

export default function Signup() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setup = useQuery({ queryKey: ['auth-setup'], queryFn: () => apiGet('/auth/setup'), retry: false });
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const saidMissing = useRef(false);

  const set = (key) => (e) => { saidMissing.current = false; setForm((f) => ({ ...f, [key]: e.target.value })); };

  // Say the first empty box in words (and put the cursor there), instead of
  // a browser bubble that's easy to miss.
  const onInvalid = (e) => {
    e.preventDefault();
    if (saidMissing.current) return;
    saidMissing.current = true;
    setError(missingLine(e.target));
    e.target.focus();
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await apiPost('/auth/signup', form);
      queryClient.setQueryData(['me'], me);
      queryClient.invalidateQueries({ queryKey: ['auth-setup'] });
      navigate('/');
    } catch (err) {
      // Someone else finished setup first: show the closed page.
      if (err.status === 403) queryClient.invalidateQueries({ queryKey: ['auth-setup'] });
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const brand = (
    <>
      <span className="brand">Starbase</span>
      <span className="brand-org">Imagine Surrey</span>
    </>
  );

  if (setup.isPending) return <div className="auth-page">{brand}</div>;

  // Already set up: no form, just where to go.
  if (setup.data && !setup.data.open) {
    return (
      <div className="auth-page">
        {brand}
        <h1>Already set up</h1>
        <p className="muted">Starbase is set up for Imagine Surrey. Ask a manager for an invite.</p>
        <hr className="hairline" />
        <p className="muted"><Link to="/login">Sign in</Link></p>
      </div>
    );
  }

  return (
    <div className="auth-page">
      {brand}
      <h1>Set up Starbase for Imagine Surrey</h1>
      <form onSubmit={submit} onInvalidCapture={onInvalid}>
        <div className="field">
          <label htmlFor="su-name">Your name</label>
          <input id="su-name" className="input" required autoFocus autoComplete="name" style={AUTH_INPUT}
            value={form.name} onChange={set('name')} />
        </div>
        <div className="field">
          <label htmlFor="su-email">Email</label>
          <input id="su-email" className="input" type="email" required autoComplete="email" style={AUTH_INPUT}
            value={form.email} onChange={set('email')} />
        </div>
        <div className="field">
          <label htmlFor="su-password">Password</label>
          <input id="su-password" className="input" type="password" required minLength={8} autoComplete="new-password" style={AUTH_INPUT}
            placeholder="8 or more characters" value={form.password} onChange={set('password')} />
        </div>

        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" style={AUTH_BUTTON} disabled={busy}
          onClick={() => { saidMissing.current = false; }}>
          {busy ? 'Setting up…' : 'Set up Starbase'}
        </button>
      </form>
      <hr className="hairline" />
      <p className="muted"><Link to="/login">Sign in</Link></p>
    </div>
  );
}
