// The website's settings and shared helpers.
//
// Which campaign the site belongs to: STARBASE_SITE_WORKSPACE (a workspace
// slug) when set, else the oldest workspace. Starbase runs for one campaign
// (Imagine Surrey), so that is it; tests and dev with open sign-up have
// several, and the first one made is the site's.
//
// Settings live in site_settings.data. Nothing here is invented about the
// campaign: words left empty simply don't show on the site.
import { runAction, newId } from '../../lib/events.js';
import { ORG_NAME } from '../../lib/org.js';

export const SOCIALS = [
  ['instagram', 'Instagram'], ['x', 'X'], ['tiktok', 'TikTok'],
  ['reddit', 'Reddit'], ['facebook', 'Facebook'], ['youtube', 'YouTube'],
];
// The site's own sections, in the menu next to the pages.
export const SECTIONS = [
  ['news', 'News'], ['events', 'Events'], ['team', 'Team'], ['store', 'Store'],
];
// Imagine Surrey's colours (brand guidelines 2.1): Surrey Navy leads; the
// accent is the text-safe red, for buttons (Signal Red only reads on white
// at 24px and up). Marigold is in the stylesheet as the fixed --gold.
export const DEFAULT_PRIMARY = '#003979';
export const DEFAULT_ACCENT = '#c8151b';

export const DEFAULTS = {
  title: '',              // '' → the campaign's name
  tagline: '',
  hero_headline: '',      // '' → the title
  hero_text: '',
  hero_image: null,
  logo: null,             // the reversed logo (for the navy header and footer)
  mark: null,             // the star device (square): browser tab, pins
  primary: DEFAULT_PRIMARY,
  accent: DEFAULT_ACCENT,
  contact_email: '',
  contact_phone: '',
  socials: {},
  authorized_by: '',
  donate_label: 'Donate',
  involved_label: 'Get involved',
  seo_description: '',
  // Menu: keys in order — 'news', 'events', 'team', 'store', 'page:<slug>'.
  // Anything missing goes after, in its own order.
  nav_order: ['page:about', 'page:platform', 'team', 'news', 'events', 'store', 'page:get-involved', 'page:contact'],
  hidden_sections: [],    // sections taken off the menu
  shipping: true,
  shipping_cents: 1200,
  pickup: true,
  pickup_note: '',
  // Membership (ext/members): the yearly fee in cents; 0 for free membership.
  membership_fee_cents: 1000,
};

export const settingsOut = (data, ws) => {
  const s = { ...DEFAULTS, ...(data || {}) };
  s.socials = { ...(s.socials || {}) };
  s.site_title = s.title || ws?.name || ORG_NAME;
  return s;
};

export const loadSettings = async (db, ws) => {
  const row = (await db.query('select data from site_settings where workspace_id = $1', [ws.id])).rows[0];
  return { exists: !!row, settings: settingsOut(row?.data, ws) };
};

export const siteWorkspace = async (db) => {
  const slug = (process.env.STARBASE_SITE_WORKSPACE || '').trim();
  const sel = 'select id, name, slug, jurisdiction, settings, created_at from workspaces';
  const ws = slug
    ? (await db.query(`${sel} where slug = $1`, [slug])).rows[0]
    : (await db.query(`${sel} order by created_at, id limit 1`)).rows[0];
  if (ws && typeof ws.settings === 'string') ws.settings = JSON.parse(ws.settings);
  return ws || null;
};

// Lowercase words joined by hyphens, for links.
export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

// A free link in one table: "rally", then "rally-2", "rally-3", …
export const freeSlug = async (tx, table, ws, base, exceptId = null) => {
  const root = base || 'item';
  for (let i = 1; i < 200; i += 1) {
    const s = i === 1 ? root : `${root.slice(0, 55)}-${i}`;
    const hit = (await tx.query(
      `select id from ${table} where workspace_id = $1 and slug = $2 and ($3::uuid is null or id <> $3::uuid)`,
      [ws, s, exceptId],
    )).rows[0];
    if (!hit) return s;
  }
  return `${root.slice(0, 50)}-${newId().slice(0, 6)}`;
};

// Page links a page can't take: the site's own sections, and the staff
// app's and public forms' top-level paths (on the site's own domain they
// share the root — server/index.js).
export const RESERVED_SLUGS = new Set([
  'news', 'events', 'our-team', 'store', 'cart', 'media', 'site', 'site-assets', 'sitemap-xml', 'robots-txt',
  'home', 'api', 'assets', 'login', 'signup', 'join', 'map', 'calls', 'people', 'shifts', 'turfs', 'signs',
  'inbox', 'my-people', 'money', 'outreach', 'team', 'ladders', 'follow-ups', 'surveys',
  'rating-scale', 'website', 'e', 'd', 'n', 'v', 'u', 'p', 'r', 'lu', 'o', 'c', 'index-html',
]);

// The pages a new site starts with: drafts, with placeholder words for the
// campaign to replace — nothing here is a fact about the campaign. Home's
// body is the welcome under the big picture on the front page.
const SEED_PAGES = [
  ['home', 'Home', 'Write a short welcome to Imagine Surrey here.', false, 0],
  ['about', 'About', 'Write about Imagine Surrey here: who you are and why you are running.', true, 10],
  ['platform', 'Platform', 'Write your platform here.\n\n## First priority\n\nDescribe it here.', true, 20],
  ['get-involved', 'Get involved', 'Write how people can help here: volunteering, hosting, signs.', true, 60],
  ['contact', 'Contact', 'Write how to reach the campaign here.', true, 70],
];

// First look at the site (the admin or a visitor): give it its settings
// row and the starter pages, once. A system action when no one is signed in.
export const ensureSite = async (db, ws, actorId = null) => {
  const have = (await db.query('select 1 from site_settings where workspace_id = $1', [ws.id])).rows[0];
  if (have) return;
  await runAction(db, { workspaceId: ws.id, actorId, action: 'site.seed' }, async (tx, emit) => {
    // Checked again under the campaign lock runAction holds.
    if ((await tx.query('select 1 from site_settings where workspace_id = $1', [ws.id])).rows[0]) return;
    await tx.query('insert into site_settings (workspace_id, data) values ($1, $2)', [ws.id, JSON.stringify({})]);
    emit('site_settings', ws.id, 'create', {});
    const hasPages = (await tx.query('select 1 from site_pages where workspace_id = $1 limit 1', [ws.id])).rows[0];
    if (hasPages) return;
    for (const [slug, title, body, nav, order] of SEED_PAGES) {
      const id = newId();
      await tx.query(
        `insert into site_pages (id, workspace_id, slug, title, body, show_in_nav, nav_order, published)
         values ($1, $2, $3, $4, $5, $6, $7, false)`,
        [id, ws.id, slug, title, body, nav, order],
      );
      emit('site_page', id, 'create', { slug, title, show_in_nav: nav, nav_order: order, published: false, seeded: true });
    }
  });
};

export const parseJ = (v, fallback) => {
  if (v == null) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
  return v;
};

export const dateOnly = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));

export const money = (cents) => `$${(Number(cents || 0) / 100).toLocaleString('en-CA', {
  minimumFractionDigits: Number(cents) % 100 ? 2 : 0, maximumFractionDigits: 2,
})}`;
