// The website admin's shell: a white header with the campaign's logo, who is
// signed in, and the editors (pages/Website.jsx and its tabs) underneath.
// The editors read { me } from the outlet, as they do in the field app.
import { Suspense, lazy, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api.js';
import Login from '../pages/Login.jsx';
import './site-admin.css';

const Website = lazy(() => import('../pages/Website.jsx'));

function RequireAuth() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => apiGet('/auth/me'), retry: false, staleTime: 60_000 });
  if (me.isLoading) return null;
  if (me.isError) return <Navigate to="/login" replace />;
  if (!['manager', 'staff', 'treasurer'].includes(me.data?.role)) return <NotForYou me={me.data} />;
  return <Frame me={me.data} />;
}

function NotForYou({ me }) {
  return (
    <div className="auth-page">
      <span className="brand">Website admin</span>
      <span className="brand-org">Imagine Surrey</span>
      <h1>Not for your role</h1>
      <p className="muted">Managers and staff edit the website; treasurers see the store's orders. You are signed in as {me?.user?.name} ({me?.role}).</p>
    </div>
  );
}

function Frame({ me }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    try { await apiPost('/auth/logout'); } catch { /* the cookie is gone either way */ }
    queryClient.clear();
    navigate('/login', { replace: true });
  };
  const appUrl = me.site_admin_url && me.site_admin_url.startsWith('http') ? null : '/';
  return (
    <>
      <header className="sa-head">
        <div className="sa-head__in">
          <a className="sa-brand" href="/website-admin/" aria-label="Website admin">
            <img src="/site-assets/logo.png" alt="" height="40" />
            <span>Website admin</span>
          </a>
          <span className="sa-who">{me.user.name} <span className="muted">· {me.role}</span></span>
          {appUrl && <a className="btn btn-quiet sa-app" href={appUrl}>Starbase ↗</a>}
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className="page sa-main">
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <Outlet context={{ me }} />
        </Suspense>
      </main>
    </>
  );
}

export default function SiteAdmin() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<Navigate to="/website/pages" replace />} />
        <Route path="/website" element={<Website />} />
        <Route path="/website/:tab" element={<Website />} />
        <Route path="/website/:tab/:id" element={<Website />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
