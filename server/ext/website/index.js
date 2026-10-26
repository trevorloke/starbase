// Website — the campaign's public website and merch store, hosted by
// Starbase and edited from the staff app (Website: Pages · News · Events ·
// Team · Store · Orders · Settings).
//
//   sql.js       tables (site_*, store_*)
//   content.js   settings, the site's campaign, links, the starter pages
//   markdown     @starbase/shared/markdown — the safe renderer (and Preview)
//   media.js     image uploads (checked by their bytes) and /media/:id
//   layout.js    the site's header, footer, stylesheet and icons; routes/public.js
//                uses it too, so the RSVP, donate and signup pages match
//   site.js      the public pages (/site/… everywhere; / on STARBASE_SITE_HOSTS)
//   store.js     prices, stock, Stripe Checkout and the paid webhook
//   actions.js   site.* and store.* actions
//   api.js       the staff app's reads
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { serveMedia } from './media.js';
import { ASSETS } from './layout.js';

export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';

// /media/:id and /site-assets/* answer on every host (the site's pages use
// them under /site too).
export const publicRoutes = new Hono();
publicRoutes.get('/media/:id', async (c) => serveMedia(c, await getDb()));
publicRoutes.get('/site-assets/:file', (c) => {
  const a = Object.hasOwn(ASSETS, c.req.param('file')) ? ASSETS[c.req.param('file')] : null;
  if (!a) return c.text('not found', 404);
  return c.body(a.body, 200, {
    'Content-Type': a.type,
    // Links carry ?v=<hash of the file>, so a new version is a new address.
    'Cache-Control': c.req.query('v') === a.hash ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
});

// The export carries everything but the picture bytes (they are in the
// database and its backups; /media/:id serves each one).
export const exportTables = [
  'site_settings', 'site_pages', 'site_posts', 'site_team', 'site_event_extras',
  { table: 'site_media', omit: ['data'] }, 'store_products', 'store_orders',
];

// Volunteers never read the website's or the store's admin data.
export const deskOnlyReads = [/^\/api\/site\//, /^\/api\/store\//];
