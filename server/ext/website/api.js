// Website + store reads for the staff app, mounted under /api (signed in).
// Content is for managers and staff; orders for managers, staff and
// treasurers. Volunteers are refused all of it (index.js deskOnlyReads, and
// each handler checks again).
//
//   GET /site/overview         settings, counts, Stripe status, the site's address
//   GET /site/pages[/:id]      pages (one with its body)
//   GET /site/posts[/:id]      news posts
//   GET /site/team             people cards
//   GET /site/events           campaign events + the picture each shows on the site
//   GET /site/media            uploaded pictures, newest first
//   GET /store/products[/:id]  products, sizes and stock
//   GET /store/orders          orders (?status=open|done|unpaid|all)
import { Hono } from 'hono';
import { stripeConfigured } from '../../lib/stripe.js';
import { ensureSite, loadSettings, parseJ, dateOnly } from './content.js';
import { productRow } from './store.js';
import { siteHosts } from './hosts.js';

export const api = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDITORS = ['manager', 'staff'];
const ORDERS = ['manager', 'staff', 'treasurer'];
const may = (c, roles) => roles.includes(c.get('ctx').role);
const refuse = (c) => c.json({ error: 'not for your role' }, 403);
const ws = (c) => c.get('ctx').workspaceId;

// Where the public site is: its own domain when one is set, else /site here.
const siteUrl = (c) => {
  const host = siteHosts()[0];
  if (host) return `https://${host}/`;
  return `${new URL(c.req.url).origin}/site/`;
};

api.get('/site/overview', async (c) => {
  if (!may(c, ORDERS)) return refuse(c);
  const db = c.get('db');
  const ctx = c.get('ctx');
  const wsRow = { id: ctx.workspaceId, name: ctx.workspace.name };
  if (may(c, EDITORS)) await ensureSite(db, wsRow, ctx.user.id);
  const { settings } = await loadSettings(db, wsRow);
  const count = async (sqlText) => (await db.query(sqlText, [ctx.workspaceId])).rows[0];
  const counts = {
    pages: await count('select count(*)::int as n, (count(*) filter (where published))::int as live from site_pages where workspace_id = $1'),
    posts: await count('select count(*)::int as n, (count(*) filter (where published))::int as live from site_posts where workspace_id = $1'),
    team: await count('select count(*)::int as n, (count(*) filter (where published))::int as live from site_team where workspace_id = $1'),
    products: await count('select count(*)::int as n, (count(*) filter (where active))::int as live from store_products where workspace_id = $1 and deleted_at is null'),
    orders: await count(`select (count(*) filter (where status in ('paid', 'packed')))::int as open, (count(*) filter (where status <> 'pending'))::int as n from store_orders where workspace_id = $1`),
  };
  return c.json({
    settings: may(c, EDITORS) ? settings : null,
    counts,
    stripe: { configured: stripeConfigured(), webhook: !!process.env.STRIPE_WEBHOOK_SECRET },
    site_url: siteUrl(c),
    own_domain: siteHosts().length > 0,
    ws_slug: ctx.workspace.slug,
  });
});

api.get('/site/pages', async (c) => {
  if (!may(c, EDITORS)) return refuse(c);
  const rows = (await c.get('db').query(
    `select id, slug, title, hero_image, show_in_nav, nav_order, published, updated_at
     from site_pages where workspace_id = $1 order by (slug = 'home') desc, nav_order, lower(title)`,
    [ws(c)],
  )).rows;
  return c.json({ pages: rows });
});

api.get('/site/pages/:id', async (c) => {
  if (!may(c, EDITORS)) return refuse(c);
  if (!UUID_RE.test(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
  const row = (await c.get('db').query('select * from site_pages where id = $1 and workspace_id = $2', [c.req.param('id'), ws(c)])).rows[0];
  return row ? c.json({ page: row }) : c.json({ error: 'not found' }, 404);
});

const postOut = (p) => ({ ...p, date: dateOnly(p.date) });
api.get('/site/posts', async (c) => {
  if (!may(c, EDITORS)) return refuse(c);
  const rows = (await c.get('db').query(
    `select id, slug, title, date, summary, cover_image, published, pinned, updated_at
     from site_posts where workspace_id = $1 order by date desc, created_at desc limit 500`,
    [ws(c)],
  )).rows;
  return c.json({ posts: rows.map(postOut) });
});

api.get('/site/posts/:id', async (c) => {
  if (!may(c, EDITORS)) return refuse(c);
  if (!UUID_RE.test(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
  const row = (await c.get('db').query('select * from site_posts where id = $1 and workspace_id = $2', [c.req.param('id'), ws(c)])).rows[0];
  return row ? c.json({ post: postOut(row) }) : c.json({ error: 'not found' }, 404);
});

api.get('/site/team', async (c) => {
  if (!may(c, EDITORS)) return refuse(c);
  const rows = (await c.get('db').query(
    'select * from site_team where workspace_id = $1 order by position, lower(name)', [ws(c)],
  )).rows;
  return c.json({ team: rows.map((t) => ({ ...t, socials: parseJ(t.socials, {}) })) });
});

api.get('/site/events', async (c) => {
  if (!may(c, EDITORS)) return refuse(c);
  const rows = (await c.get('db').query(
    `select e.id, e.slug, e.title, e.description, e.location, e.starts_at, e.ends_at, e.capacity, e.public, x.image,
       coalesce((select sum(1 + r.guests) from event_rsvps r where r.event_id = e.id and r.status <> 'cancelled'), 0)::int as going
     from campaign_events e left join site_event_extras x on x.event_id = e.id
     where e.workspace_id = $1 and e.deleted_at is null order by e.starts_at desc limit 500`,
    [ws(c)],
  )).rows;
  return c.json({ events: rows, ws_slug: c.get('ctx').workspace.slug });
});

api.get('/site/media', async (c) => {
  if (!may(c, EDITORS)) return refuse(c);
  const rows = (await c.get('db').query(
    `select id, content_type, bytes, width, height, name, created_at from site_media
     where workspace_id = $1 order by created_at desc limit 300`,
    [ws(c)],
  )).rows;
  return c.json({ media: rows.map((m) => ({ ...m, url: `/media/${m.id}` })) });
});

api.get('/store/products', async (c) => {
  if (!may(c, EDITORS)) return refuse(c);
  const rows = (await c.get('db').query(
    `select * from store_products where workspace_id = $1 and deleted_at is null order by position, lower(name)`, [ws(c)],
  )).rows;
  return c.json({ products: rows.map(productRow), stripe: stripeConfigured() });
});

api.get('/store/products/:id', async (c) => {
  if (!may(c, EDITORS)) return refuse(c);
  if (!UUID_RE.test(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
  const row = (await c.get('db').query(
    'select * from store_products where id = $1 and workspace_id = $2 and deleted_at is null', [c.req.param('id'), ws(c)],
  )).rows[0];
  return row ? c.json({ product: productRow(row) }) : c.json({ error: 'not found' }, 404);
});

// open: paid and packed (to do) · done: shipped, picked up, refunded,
// cancelled after paying · unpaid: checkouts never finished.
const ORDER_FILTERS = {
  open: "status in ('paid', 'packed')",
  done: "status in ('shipped', 'picked_up', 'refunded') or (status = 'cancelled' and paid_at is not null)",
  unpaid: "status = 'pending' or (status = 'cancelled' and paid_at is null)",
  all: "status <> 'pending'",
};
api.get('/store/orders', async (c) => {
  if (!may(c, ORDERS)) return refuse(c);
  const f = ORDER_FILTERS[c.req.query('status')] || ORDER_FILTERS.open;
  const rows = (await c.get('db').query(
    `select id, status, fulfilment, items, subtotal_cents, shipping_cents, total_cents, paid_cents, buyer_name, email, phone,
            ship_address, person_id, note, paid_at, created_at, updated_at
     from store_orders where workspace_id = $1 and (${f}) order by coalesce(paid_at, created_at) desc limit 500`,
    [ws(c)],
  )).rows;
  return c.json({
    orders: rows.map((o) => ({ ...o, items: parseJ(o.items, []), ship_address: parseJ(o.ship_address, null) })),
    stripe: { configured: stripeConfigured(), webhook: !!process.env.STRIPE_WEBHOOK_SECRET },
  });
});
