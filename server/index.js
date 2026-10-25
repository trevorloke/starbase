// Starbase server. Hono app: /api/auth (public), /api/* (workspace-scoped),
// static web build. Exported for in-process tests via app.request().
import { Hono } from 'hono';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import authRoutes from './routes/auth.js';
import apiRoutes from './routes/api.js';
import publicRoutes from './routes/public.js';
import { getDb } from './db/client.js';
import { EXTENSIONS } from './ext.js';
import { startJobRunner, stopJobRunner } from './lib/jobs.js';
import { staleTimeZoneData } from './lib/tzcheck.js';
import { siteApp, siteOnItsOwnHost } from './ext/website/site.js';

export const app = new Hono();

// The public website (ext/website). On a host listed in STARBASE_SITE_HOSTS
// (imaginesurrey.ca, www.imaginesurrey.ca) the site answers at / and its own
// paths (/news, /events, /store, /about …); everything the staff app and the
// public forms use (/api, /assets, /login, /e, /d, /n, …) falls through to
// the routes below, unchanged. Every host also has the site at /site.
app.use('*', siteOnItsOwnHost);
app.route('/site', siteApp);

app.get('/api/health', (c) => c.json({ ok: true, service: 'starbase', tzdataCurrent: !staleTimeZoneData() }));
app.route('/api/auth', authRoutes);
app.route('/', publicRoutes); // /p, /n, /v, /u, /api/public — no auth
for (const e of EXTENSIONS) if (e.publicRoutes) app.route('/', e.publicRoutes);
app.route('/api', apiRoutes);

// Static web build (SPA fallback to index.html for URL routing). Resolved
// from this file, not the working directory, so any launch location works.
const WEB_ROOT = relative(process.cwd(), fileURLToPath(new URL('../web/dist', import.meta.url))) || '.';
app.use('*', serveStatic({ root: WEB_ROOT }));
app.get('*', serveStatic({ root: WEB_ROOT, path: 'index.html' }));

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const port = Number(process.env.PORT) || 3200;
  const server = serve({ fetch: app.fetch, port }, () => {
    console.log(`starbase on :${port}`);
  });
  const tz = staleTimeZoneData();
  if (tz) console.warn(`starbase: ${tz}`);
  // Background jobs (ladder steps, A/B winners). STARBASE_JOBS=off disables.
  if (process.env.STARBASE_JOBS !== 'off') {
    getDb().then((db) => startJobRunner(db, { everyMs: Number(process.env.STARBASE_JOBS_EVERY_MS) || 30_000 }));
  }
  // Deploys send SIGTERM: stop accepting requests, then close the database so
  // the embedded store flushes cleanly.
  const shutdown = async (sig) => {
    console.log(`${sig}: shutting down`);
    server.close();
    stopJobRunner();
    try { await (await getDb()).close(); } catch { /* already closed */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
