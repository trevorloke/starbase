// Start a campaign: name, email, password, campaign name. The jurisdiction
// (BC municipal unless changed) sits under "More".
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { apiPost } from '../api.js';

const JURISDICTIONS = [
  { value: 'bc-municipal', label: 'BC — Municipal' },
  { value: 'bc-provincial', label: 'BC — Provincial' },
  { value: 'federal', label: 'Federal (Canada)' },
];

// Big, thumb-sized controls (auth pages load before any page stylesheet).
const AUTH_INPUT = { minHeight: 48, fontSize: 16 };
const AUTH_BUTTON = { width: '100%', minHeight: 52, fontSize: 13, marginTop: 'var(--s-2)' };
// "More" is the shared .disclose--inline look (app.css, loaded before any page).
const MORE = { marginBottom: 'var(--s-2)' };

// A box the browser won't accept yet, said in one line under the form.
const MISSING = {
  'su-name': 'Add your name',
  'su-email': 'Add your email',
  'su-password': 'Password: 8 or more characters',
  'su-workspace': 'Add your campaign name',
};
const missingLine = (el) => {
  if (el.id === 'su-email' && el.validity.typeMismatch) return 'Check your email';
  return MISSING[el.id] || 'Fill in every box';
};

export default function Signup() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: '', email: '', password: '', workspaceName: '', jurisdiction: 'bc-municipal',
  });
  const [more, setMore] = useState(false);
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
      <h1>Start your campaign</h1>
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
        <div className="field">
          <label htmlFor="su-workspace">Campaign name</label>
          <input id="su-workspace" className="input" required placeholder="e.g. Imagine Surrey" style={AUTH_INPUT}
            value={form.workspaceName} onChange={set('workspaceName')} />
        </div>

        <button type="button" className="disclose disclose--inline" style={MORE} aria-expanded={more} aria-controls="su-more" onClick={() => setMore((v) => !v)}>
          More
        </button>
        {more ? (
          <div id="su-more" className="field">
            <label htmlFor="su-jurisdiction">Jurisdiction</label>
            <select id="su-jurisdiction" className="input" style={AUTH_INPUT} value={form.jurisdiction} onChange={set('jurisdiction')}>
              {JURISDICTIONS.map((j) => <option key={j.value} value={j.value}>{j.label}</option>)}
            </select>
          </div>
        ) : (
          // Closed, the form still carries the jurisdiction (BC municipal by default).
          <input type="hidden" id="su-jurisdiction" name="jurisdiction" value={form.jurisdiction} />
        )}

        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" style={AUTH_BUTTON} disabled={busy}
          onClick={() => { saidMissing.current = false; }}>
          {busy ? 'Creating…' : 'Create campaign'}
        </button>
      </form>
      <hr className="hairline" />
      <p className="muted"><Link to="/login">Sign in</Link></p>
    </div>
  );
}
