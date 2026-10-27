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
import { bodyLimit } from 'hono/body-limit';
import { siteApp, siteOnItsOwnHost, siteOnEveryHost } from './ext/website/site.js';
import { serveMode, siteApiAllows } from './lib/serve.js';

export const app = new Hono();

// The public website (ext/website). On a host listed in STARBASE_SITE_HOSTS
// (imaginesurrey.ca, www.imaginesurrey.ca) the site answers at / and its own
// paths (/news, /events, /store, /about …); everything the staff app and the
// public forms use (/api, /assets, /login, /e, /d, /n, …) falls through to
// the routes below, unchanged. Every host also has the site at /site.
// How big a request body may be: 256 KB for anything, more for the two
// uploads (a CSV import's 2,000 rows; a picture, as base64). Hono buffers a
// body before parsing, so without this a few big requests could take all
// the memory — no sign-in needed.
const BODY_MAX = { '/api/data/import': 16 * 1024 * 1024, '/api/actions/site.media.upload': 4 * 1024 * 1024, '/api/actions/learn.asset.upload': 17 * 1024 * 1024, '/api/actions/blast.attach': 7 * 1024 * 1024, '/api/actions/blast.picture': 4 * 1024 * 1024 };
app.use('*', (c, next) => bodyLimit({
  maxSize: BODY_MAX[c.req.path] || 256 * 1024,
  onError: (cc) => cc.json({ error: 'request too large' }, 413),
})(c, next));
// Headers every answer carries: not framed by another site (voter data on
// screen), no sniffing a type, no full URLs leaking off-site. A route that
// set its own keeps it.
app.use('*', async (c, next) => {
  await next();
  const h = c.res.headers;
  if (!h.has('X-Frame-Options')) h.set('X-Frame-Options', 'DENY');
  if (!h.has('X-Content-Type-Options')) h.set('X-Content-Type-Options', 'nosniff');
  if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
});
// What this process serves (lib/serve.js): the app, the site, or both.
app.use('*', (c, next) => {
  const mode = serveMode();
  if (mode === 'site') return siteOnEveryHost(c, next);
  if (mode === 'all') return siteOnItsOwnHost(c, next);
  return next();
});
app.use('/site/*', (c, next) => (serveMode() === 'app' ? c.text('not on this service', 404) : next()));
app.route('/site', siteApp);

app.get('/api/health', (c) => c.json({ ok: true, service: 'starbase', tzdataCurrent: !staleTimeZoneData() }));
app.route('/api/auth', authRoutes);
app.route('/', publicRoutes); // /p, /n, /v, /u, /api/public — no auth
for (const e of EXTENSIONS) if (e.publicRoutes) app.route('/', e.publicRoutes);
// The site's own service answers only the API its admin needs.
app.use('/api/*', (c, next) => (serveMode() === 'site' && !siteApiAllows(c.req.path) ? c.json({ error: 'not on this service' }, 404) : next()));
app.route('/api', apiRoutes);

// Static web build (SPA fallback to index.html for URL routing). Resolved
// from this file, not the working directory, so any launch location works.
const WEB_ROOT = relative(process.cwd(), fileURLToPath(new URL('../web/dist', import.meta.url))) || '.';
app.use('*', serveStatic({ root: WEB_ROOT }));
// The website's admin: its own small app (web/website-admin.html), on any
// service that serves the site.
app.get('/website-admin', (c, next) => (serveMode() === 'app' ? c.text('not on this service', 404) : next()), serveStatic({ root: WEB_ROOT, path: 'website-admin.html' }));
app.get('/website-admin/*', (c, next) => (serveMode() === 'app' ? c.text('not on this service', 404) : next()), serveStatic({ root: WEB_ROOT, path: 'website-admin.html' }));
app.get('*', (c, next) => (serveMode() === 'site' ? c.text('not found', 404) : next()), serveStatic({ root: WEB_ROOT, path: 'index.html' }));

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const port = Number(process.env.PORT) || 3200;
  const server = serve({ fetch: app.fetch, port }, () => {
    console.log(`starbase on :${port}`);
  });
  const tz = staleTimeZoneData();
  if (tz) console.warn(`starbase: ${tz}`);
  // Background jobs (ladder steps, A/B winners). STARBASE_JOBS=off disables.
  // The site's own service leaves the campaign's jobs to the app's.
  if (process.env.STARBASE_JOBS !== 'off' && serveMode() !== 'site') {
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
