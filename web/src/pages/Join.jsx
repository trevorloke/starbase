// Join a campaign from an invite link. New people set a name and password;
// people who already use Starbase confirm with their existing password.
// Everyone lands on Today, whose one big button is "Start canvassing".
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api.js';

const ROLE_LABEL = { manager: 'a manager', treasurer: 'the treasurer', staff: 'staff', volunteer: 'a volunteer' };

// Big, thumb-sized controls (auth pages load before any page stylesheet).
const AUTH_INPUT = { minHeight: 48, fontSize: 16 };
const AUTH_BUTTON = { width: '100%', minHeight: 52, fontSize: 13, marginTop: 'var(--s-2)' };

export default function Join() {
  const { token } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // An invite works once: after joining it 404s, so never refetch it.
  const inv = useQuery({
    queryKey: ['invite', token], queryFn: () => apiGet(`/auth/invite/${token}`),
    retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await apiPost('/auth/join', inv.data.hasAccount ? { token, password } : { token, name, password });
      // Drop whatever an earlier login cached — except this (now used)
      // invite, which this screen still shows until Today takes over.
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'invite' });
      queryClient.setQueryData(['me'], me);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (inv.isPending) return <div className="auth-page"><span className="brand">Starbase</span></div>;
  if (inv.isError) {
    return (
      <div className="auth-page">
        <span className="brand">Starbase</span>
        <h1>{inv.error.status === 404 ? 'Invite not found' : 'Can’t open this invite'}</h1>
        <p className="muted">{inv.error.status === 404 ? 'Ask an Imagine Surrey manager for a new link.' : inv.error.message}</p>
      </div>
    );
  }

  const { email, role, workspaceName, hasAccount } = inv.data;
  return (
    <div className="auth-page">
      <span className="brand">Starbase</span>
      <h1>Join {workspaceName}</h1>
      <p className="muted">As {ROLE_LABEL[role] || role} · <strong>{email}</strong></p>
      <form onSubmit={submit}>
        {!hasAccount && (
          <div className="field">
            <label htmlFor="join-name">Your name</label>
            <input id="join-name" className="input" required autoFocus autoComplete="name" maxLength={200} style={AUTH_INPUT}
              value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="join-password">{hasAccount ? 'Your Starbase password' : 'Choose a password'}</label>
          <input id="join-password" className="input" type="password" required minLength={8} maxLength={200} style={AUTH_INPUT}
            autoFocus={hasAccount} autoComplete={hasAccount ? 'current-password' : 'new-password'}
            placeholder={hasAccount ? undefined : '8 or more characters'}
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-primary" style={AUTH_BUTTON} disabled={busy}>
          {busy ? 'Joining…' : 'Join'}
        </button>
      </form>
    </div>
  );
}
