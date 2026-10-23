// Website — the campaign's public site and store, edited here.
//   /website/:tab        Pages · News · Events · Team · Store · Orders · Settings
//   /website/:tab/new    a new one;  /website/:tab/:id  edit one
// Managers and staff edit everything; treasurers see Orders only (the
// server refuses the rest). "View site" opens the live site in a new tab.
import { lazy, Suspense } from 'react';
import { Navigate, NavLink, useOutletContext, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { canEdit } from '../components/WebsiteBits.jsx';
import './shifts.css';
import './surveys.css';
import './website.css';

const TABS = {
  pages: { label: 'Pages', el: lazy(() => import('./WebsitePages.jsx')) },
  news: { label: 'News', el: lazy(() => import('./WebsiteNews.jsx')) },
  events: { label: 'Events', el: lazy(() => import('./WebsiteEvents.jsx')) },
  team: { label: 'Team', el: lazy(() => import('./WebsiteTeam.jsx')) },
  store: { label: 'Store', el: lazy(() => import('./WebsiteStore.jsx')) },
  orders: { label: 'Orders', el: lazy(() => import('./WebsiteOrders.jsx')) },
  settings: { label: 'Settings', el: lazy(() => import('./WebsiteSettings.jsx')) },
};

export default function Website() {
  const { me } = useOutletContext();
  const { tab, id } = useParams();
  const editor = canEdit(me);
  const tabs = editor ? Object.keys(TABS) : ['orders'];
  const ov = useQuery({ queryKey: ['site-overview'], queryFn: () => apiGet('/site/overview') });
  if (!tab || !tabs.includes(tab)) return <Navigate to={`/website/${tabs[0]}`} replace />;
  const Tab = TABS[tab].el;
  const open = ov.data?.counts?.orders?.open || 0;
  const needsAuth = editor && ov.data?.settings && !ov.data.settings.authorized_by;

  return (
    <div className="ws-page">
      <div className="ops-head">
        <h1>Website</h1>
        {ov.data?.site_url && (
          <a className="btn btn-quiet ops-tap ws-view" href={ov.data.site_url} target="_blank" rel="noopener">View site ↗</a>
        )}
      </div>
      {tabs.length > 1 && (
        <nav className="ws-tabs" aria-label="Website">
          {tabs.map((t) => (
            <NavLink key={t} to={`/website/${t}`} className="ws-tab">
              {TABS[t].label}
              {t === 'orders' && open > 0 && <span className="ws-tab__n">{open}</span>}
            </NavLink>
          ))}
        </nav>
      )}
      {needsAuth && !id && tab !== 'settings' && (
        <NavLink className="ws-need" to="/website/settings#authorized">Add the “Authorized by” line — election ads need it</NavLink>
      )}
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Tab me={me} id={id} overview={ov.data} />
      </Suspense>
    </div>
  );
}
