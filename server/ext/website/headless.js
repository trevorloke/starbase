// The site, headless: public JSON for a website built elsewhere — the
// campaign's own Next.js site — so it can be edited from Starbase's website
// admin and send every form here. No sign-in; every answer is CORS-open and
// revalidates on each visit (ETag), so an edit in the admin is live at once.
// Drafts never show. Pictures carry their full address (/media/:id on
// STARBASE_PUBLIC_URL). Markdown comes as written (`body`) and rendered by
// the site's own safe renderer (`html`).
//
//   GET  /api/public/:ws/site                  the campaign, settings, links, nav pages, team
//   GET  /api/public/:ws/site/pages/:slug      a published page
//   GET  /api/public/:ws/site/news[/:slug]     published posts (?limit, ?offset), one post
//   GET  /api/public/:ws/site/events[/:slug]   upcoming public events (?past=1: the last 20), one event
//   GET  /api/public/:ws/site/team             published people cards
//   GET  /api/public/:ws/site/products[/:slug] the store (what's left, sizes, ways to get it), one product
//   GET  /api/public/:ws/site/petitions[/:slug] open petitions with their counts; a closed one answers 410
//   POST /api/public/:ws/site/store/quote      { items } → priced here, never in the browser
//   POST /api/public/:ws/site/store/checkout   { items, fulfilment, return: { success, cancel } } → { url, order_id }
//
// The forms post to routes/public.js: /api/public/:ws/signup (newsletter,
// volunteer, petition, rsvp) and /api/public/:ws/donate. A return address
// is used only on the site's own origins (hosts.js returnUrl).
import { Hono } from 'hono';
import { etag } from 'hono/etag';
import { getDb } from '../../db/client.js';
import { renderMarkdown, markdownText } from '@starbase/shared/markdown';
import { loadSettings, parseJ, dateOnly } from './content.js';
import { productRow, leftOf, priceCart, heldQty } from './store.js';
import { startCheckout, waysOf } from './site.js';
import { originOf, returnUrl, withParam } from './hosts.js';
import { stripeConfigured } from '../../lib/stripe.js';
import { clientIp, makeLimiter } from '../../lib/guard.js';
import { MIN_MEMBER_AGE, NEIGHBOURHOODS, OUTSIDE_SURREY, CAMPUSES, CITIZENSHIP } from '../members/rules.js';

export const headless = new Hono();

// Public writes: 30 per 10 minutes from one address (lib/guard.js).
const hitsFrom = makeLimiter({ windowMs: 600000, max: 30 });

headless.use('/api/public/:ws/site/*', etag());
headless.use('/api/public/:ws/site', etag());
const cors = (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  c.header('Cache-Control', 'no-cache');
  return next();
};
headless.use('/api/public/:ws/site', cors);
headless.use('/api/public/:ws/site/*', cors);
headless.options('/api/public/:ws/site', (c) => c.body(null, 204));
headless.options('/api/public/:ws/site/*', (c) => c.body(null, 204));

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const publicBase = (c) => (process.env.STARBASE_PUBLIC_URL || originOf(c)).replace(/\/$/, '');
const mediaUrl = (base, id) => (id ? `${base}/media/${id}` : null);

// The campaign by its slug, with its website settings.
const load = async (c) => {
  const db = await getDb();
  const ws = (await db.query(
    'select id, name, slug, jurisdiction, settings from workspaces where slug = $1', [c.req.param('ws')],
  )).rows[0];
  if (!ws) return null;
  ws.settings = typeof ws.settings === 'string' ? JSON.parse(ws.settings) : (ws.settings || {});
  const { settings } = await loadSettings(db, ws);
  return { db, ws, settings, base: publicBase(c), tz: ws.settings.tz || 'America/Vancouver' };
};
const notFound = (c) => c.json({ error: 'not found' }, 404);
const noSuch = (c) => c.json({ error: 'unknown campaign' }, 404);

const postOut = (base, p, full = false) => ({
  slug: p.slug, title: p.title, date: dateOnly(p.date), summary: p.summary, pinned: !!p.pinned,
  cover_image: mediaUrl(base, p.cover_image),
  ...(full ? { body: p.body, html: renderMarkdown(p.body), text: markdownText(p.body, 300) } : {}),
});
const eventOut = (s, e, full = false) => {
  const past = new Date(e.ends_at || e.starts_at) < new Date();
  const full_ = !!(e.capacity && e.going >= e.capacity);
  return {
    slug: e.slug, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, location: e.location,
    capacity: e.capacity, going: e.going, past, full: full_,
    image: mediaUrl(s.base, e.image),
    rsvp_url: `${s.base}/e/${s.ws.slug}/${e.slug}`,
    summary: markdownText(e.description, 200),
    ...(full ? { description: e.description || '', html: renderMarkdown(e.description || '') } : {}),
  };
};
const personOut = (base, p) => ({
  id: p.id, name: p.name, role: p.role, bio: p.bio, photo: mediaUrl(base, p.photo), socials: parseJ(p.socials, {}),
});
// What's left is after other buyers' open checkouts (store.js heldQty), as
// the cart counts it — so the site never offers the last shirt twice.
const productOut = (base, p, held, full = false) => {
  const row = productRow(p);
  const after = (variant) => {
    const stock = leftOf(row, variant);
    return stock === null ? null : Math.max(0, stock - (held[`${row.id}|${variant || ''}`] || 0));
  };
  const variants = row.variants.map((v) => ({ label: v.label, left: after(v.label) }));
  const left = row.variants.length ? null : after('');
  const soldOut = row.track_stock && (row.variants.length ? variants.every((v) => !(v.left > 0)) : !(left > 0));
  return {
    id: row.id, slug: row.slug, name: row.name, price_cents: row.price_cents, images: row.images.map((id) => mediaUrl(base, id)),
    variants, left, sold_out: soldOut, track_stock: !!row.track_stock,
    summary: markdownText(row.description, 160),
    ...(full ? { description: row.description || '', html: renderMarkdown(row.description || '') } : {}),
  };
};
const storeOut = (settings) => ({ open: stripeConfigured(), ways: waysOf(settings) });

const eventsSql = (where, order, limit) => `
  select e.*, x.image,
    coalesce((select sum(1 + r.guests) from event_rsvps r where r.event_id = e.id and r.status <> 'cancelled'), 0)::int as going
  from campaign_events e left join site_event_extras x on x.event_id = e.id
  where e.workspace_id = $1 and e.public and e.deleted_at is null and ${where}
  order by ${order} limit ${limit}`;

// ── Reads ──
headless.get('/api/public/:ws/site', async (c) => {
  const s = await load(c);
  if (!s) return noSuch(c);
  const { db, ws, settings: st, base } = s;
  const pages = (await db.query(
    `select slug, title, show_in_nav, nav_order from site_pages where workspace_id = $1 and published
     order by (slug = 'home') desc, nav_order, lower(title)`, [ws.id],
  )).rows;
  const team = (await db.query('select * from site_team where workspace_id = $1 and published order by position, lower(name)', [ws.id])).rows;
  const petitions = (await db.query('select slug, title from petitions where workspace_id = $1 and active order by created_at', [ws.id])).rows;
  return c.json({
    campaign: { name: ws.name, slug: ws.slug, jurisdiction: ws.jurisdiction, tz: s.tz },
    site: {
      title: st.site_title, tagline: st.tagline, hero_headline: st.hero_headline || st.site_title, hero_text: st.hero_text,
      hero_image: mediaUrl(base, st.hero_image), logo: mediaUrl(base, st.logo), mark: mediaUrl(base, st.mark),
      primary: st.primary, accent: st.accent, contact_email: st.contact_email, contact_phone: st.contact_phone,
      socials: st.socials, authorized_by: st.authorized_by, donate_label: st.donate_label, involved_label: st.involved_label,
      seo_description: st.seo_description, nav_order: st.nav_order, hidden_sections: st.hidden_sections,
    },
    links: {
      donate: `${base}/d/${ws.slug}`, volunteer: `${base}/v/${ws.slug}`, newsletter: `${base}/n/${ws.slug}`,
      unsubscribe: `${base}/u/`, api: `${base}/api/public/${ws.slug}`,
    },
    pages: pages.map((p) => ({ slug: p.slug, title: p.title, show_in_nav: p.show_in_nav, nav_order: p.nav_order })),
    petitions: petitions.map((p) => ({ slug: p.slug, title: p.title })),
    team: team.map((p) => personOut(base, p)),
    store: storeOut(st),
    membership: {
      fee_cents: Number(st.membership_fee_cents) || 0, min_age: MIN_MEMBER_AGE,
      neighbourhoods: [...NEIGHBOURHOODS, OUTSIDE_SURREY], campuses: CAMPUSES, citizenship: CITIZENSHIP,
      join: `${base}/api/public/${ws.slug}/join`,
    },
  });
});

headless.get('/api/public/:ws/site/pages/:slug', async (c) => {
  const s = await load(c);
  if (!s) return noSuch(c);
  if (!SLUG.test(c.req.param('slug'))) return notFound(c);
  const p = (await s.db.query(
    'select slug, title, body, hero_image, updated_at from site_pages where workspace_id = $1 and slug = $2 and published',
    [s.ws.id, c.req.param('slug')],
  )).rows[0];
  if (!p) return notFound(c);
  return c.json({ page: {
    slug: p.slug, title: p.title, body: p.body, html: renderMarkdown(p.body), text: markdownText(p.body, 300),
    hero_image: mediaUrl(s.base, p.hero_image), updated_at: p.updated_at,
  } });
});

headless.get('/api/public/:ws/site/news', async (c) => {
  const s = await load(c);
  if (!s) return noSuch(c);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 50);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const rows = (await s.db.query(
    `select slug, title, date, summary, cover_image, pinned, count(*) over()::int as total
     from site_posts where workspace_id = $1 and published
     order by pinned desc, date desc, created_at desc limit $2 offset $3`, [s.ws.id, limit, offset],
  )).rows;
  return c.json({ posts: rows.map((p) => postOut(s.base, p)), total: rows[0]?.total ?? 0, limit, offset });
});

headless.get('/api/public/:ws/site/news/:slug', async (c) => {
  const s = await load(c);
  if (!s) return noSuch(c);
  if (!SLUG.test(c.req.param('slug'))) return notFound(c);
  const p = (await s.db.query('select * from site_posts where workspace_id = $1 and slug = $2 and published', [s.ws.id, c.req.param('slug')])).rows[0];
  if (!p) return notFound(c);
  return c.json({ post: postOut(s.base, p, true) });
});

headless.get('/api/public/:ws/site/events', async (c) => {
  const s = await load(c);
  if (!s) return noSuch(c);
  const past = c.req.query('past') !== undefined;
  const rows = (await s.db.query(
    past
      ? eventsSql('coalesce(e.ends_at, e.starts_at) < now()', 'e.starts_at desc', 20)
      : eventsSql('coalesce(e.ends_at, e.starts_at) >= now()', 'e.starts_at', 50),
    [s.ws.id],
  )).rows;
  return c.json({ events: rows.map((e) => eventOut(s, e)) });
});

headless.get('/api/public/:ws/site/events/:slug', async (c) => {
  const s = await load(c);
  if (!s) return noSuch(c);
  if (!SLUG.test(c.req.param('slug'))) return notFound(c);
  const e = (await s.db.query(eventsSql('e.slug = $2', 'e.starts_at', 1), [s.ws.id, c.req.param('slug')])).rows[0];
  if (!e) return notFound(c);
  return c.json({ event: eventOut(s, e, true) });
});

headless.get('/api/public/:ws/site/team', async (c) => {
  const s = await load(c);
  if (!s) return noSuch(c);
  const rows = (await s.db.query('select * from site_team where workspace_id = $1 and published order by position, lower(name)', [s.ws.id])).rows;
  return c.json({ team: rows.map((p) => personOut(s.base, p)) });
});

headless.get('/api/public/:ws/site/products', async (c) => {
  const s = await load(c);
  if (!s) return noSuch(c);
  const rows = (await s.db.query(
    'select * from store_products where workspace_id = $1 and active and deleted_at is null order by position, lower(name) limit 200', [s.ws.id],
  )).rows;
  const held = await heldQty(s.db, s.ws);
  return c.json({ products: rows.map((p) => productOut(s.base, p, held)), store: storeOut(s.settings) });
});

headless.get('/api/public/:ws/site/products/:slug', async (c) => {
  const s = await load(c);
  if (!s) return noSuch(c);
  if (!SLUG.test(c.req.param('slug'))) return notFound(c);
  const p = (await s.db.query(
    'select * from store_products where workspace_id = $1 and slug = $2 and active and deleted_at is null', [s.ws.id, c.req.param('slug')],
  )).rows[0];
  if (!p) return notFound(c);
  return c.json({ product: productOut(s.base, p, await heldQty(s.db, s.ws), true), store: storeOut(s.settings) });
});

const petitionOut = (s, p) => ({ slug: p.slug, title: p.title, body: p.body || '', signatures: p.signatures, sign_url: `${s.base}/p/${s.ws.slug}/${p.slug}` });
const petitionSql = `select p.slug, p.title, p.body, p.active,
  (select count(*) from petition_signatures g where g.petition_id = p.id)::int as signatures
  from petitions p where p.workspace_id = $1`;
headless.get('/api/public/:ws/site/petitions', async (c) => {
  const s = await load(c);
  if (!s) return noSuch(c);
  const rows = (await s.db.query(`${petitionSql} and p.active order by p.created_at`, [s.ws.id])).rows;
  return c.json({ petitions: rows.map((p) => petitionOut(s, p)) });
});
headless.get('/api/public/:ws/site/petitions/:slug', async (c) => {
  const s = await load(c);
  if (!s) return noSuch(c);
  if (!SLUG.test(c.req.param('slug'))) return notFound(c);
  const p = (await s.db.query(`${petitionSql} and p.slug = $2`, [s.ws.id, c.req.param('slug')])).rows[0];
  if (!p) return notFound(c);
  if (!p.active) return c.json({ error: 'this petition is closed', closed: true, petition: petitionOut(s, p) }, 410);
  return c.json({ petition: petitionOut(s, p) });
});

// ── The store's writes ──
headless.post('/api/public/:ws/site/store/quote', async (c) => {
  const s = await load(c);
  if (!s) return noSuch(c);
  const b = await c.req.json().catch(() => ({}));
  const q = await priceCart(s.db, s.ws, b.items);
  c.header('Cache-Control', 'no-store');
  return c.json({ ...q, ...storeOut(s.settings) });
});

headless.post('/api/public/:ws/site/store/checkout', async (c) => {
  if (hitsFrom(clientIp(c))) return c.json({ error: 'Too many tries — wait a few minutes.' }, 429);
  const s = await load(c);
  if (!s) return noSuch(c);
  const b = await c.req.json().catch(() => ({}));
  const own = `${s.base}/site`;
  const ret = b.return || {};
  const [status, out] = await startCheckout({ db: s.db, ws: s.ws, settings: s.settings }, b, {
    ip: clientIp(c),
    successUrl: (id) => withParam(returnUrl(ret.success, `${own}/store/thanks`), 'order', id),
    cancelUrl: (id) => withParam(returnUrl(ret.cancel, `${own}/cart`), 'cancel', id),
    imageUrl: /^https:/.test(s.base) ? (id) => `${s.base}/media/${id}` : null,
  });
  c.header('Cache-Control', 'no-store');
  return c.json(out, status);
});
