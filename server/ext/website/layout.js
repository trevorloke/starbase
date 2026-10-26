// The public website's look: one header, one footer, one stylesheet, used by
// every site page (site.js) and by the public forms in routes/public.js, so
// the visitor sees one site.
//
//   loadChrome(db, ws, { base, origin })  what the header and footer show
//   layout(chrome, { title, description, image, path, main, … })  a whole page
//   ASSETS / assetUrl()                    /site-assets/* (site.css, cart.js,
//                                          logo.png, star.png, rise.svg), cached a year
//                                          under a content hash
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { escapeHtml as esc } from '@starbase/shared/markdown';
import { loadSettings, SECTIONS, SOCIALS, DEFAULT_PRIMARY, DEFAULT_ACCENT } from './content.js';

// ── Static files, read once at boot ──
const here = (p) => new URL(p, import.meta.url);
const file = (p, type) => {
  const body = readFileSync(here(p));
  return { body, type, hash: createHash('sha256').update(body).digest('hex').slice(0, 10) };
};
export const ASSETS = {
  'site.css': file('./assets/site.css', 'text/css; charset=utf-8'),
  'cart.js': file('./assets/cart.js', 'text/javascript; charset=utf-8'),
  'rise.svg': file('./assets/rise.svg', 'image/svg+xml'),
  // The campaign's own artwork, as supplied: the full-colour logo (for the
  // white header) and its star device (the browser tab). Website → Settings
  // can replace either with an upload.
  'logo.png': file('./assets/logo.png', 'image/png'),
  'star.png': file('./assets/star.png', 'image/png'),
};
export const assetUrl = (name) => `/site-assets/${name}?v=${ASSETS[name].hash}`;

// ── Icons (24×24 line icons, like the staff app's) ──
const svg = (inner, label) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>${inner}</svg>`;
export const ICON = {
  instagram: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r=".6" fill="currentColor"/>',
  x: '<path d="M4 4l16 16M20 4L4 20" />',
  tiktok: '<path d="M14 3.5v11a4 4 0 1 1-4-4"/><path d="M14 3.5c.6 2.6 2.4 4.3 5.5 4.6"/>',
  reddit: '<ellipse cx="12" cy="14" rx="7.5" ry="5.5"/><path d="M12 8.5l1.5-5 4 1"/><circle cx="18.5" cy="4.8" r="1.3"/><circle cx="9.2" cy="13.5" r=".7" fill="currentColor"/><circle cx="14.8" cy="13.5" r=".7" fill="currentColor"/><path d="M9.5 16.5c1.5 1 3.5 1 5 0"/>',
  facebook: '<path d="M14.5 8H17V4.2h-2.8A4.2 4.2 0 0 0 10 8.4V11H7.5v3.8H10V21h3.9v-6.2h2.7l.6-3.8h-3.3V8.9c0-.5.3-.9.6-.9z"/>',
  youtube: '<rect x="2.8" y="5.5" width="18.4" height="13" rx="3.5"/><path d="M10.2 9.2v5.6l4.8-2.8z" fill="currentColor"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  bag: '<path d="M5.5 8h13l-1 12h-11z"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
  phone: '<path d="M6.5 3.5h3l1.6 4.3-2.1 1.4a10.5 10.5 0 0 0 5.8 5.8l1.4-2.1 4.3 1.6v3a2 2 0 0 1-2.1 2A15.5 15.5 0 0 1 4.5 5.6a2 2 0 0 1 2-2.1z"/>',
  pin: '<path d="M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
};
export const icon = (name, label) => svg(ICON[name], label);

export const socialLinks = (links = {}) => {
  const items = SOCIALS.filter(([k]) => /^https:\/\//.test(links[k] || ''));
  if (!items.length) return '';
  return `<div class="socials">${items.map(([k, label]) => `<a href="${esc(links[k])}" rel="noopener me" target="_blank">${icon(k, label)}</a>`).join('')}</div>`;
};

// What the header and footer need, read per request (it's a few small
// queries). base: '' on the site's own domain, '/site' elsewhere.
// canon: where this site's pages live for search engines (its own domain
// when one is set — so /site pages on the staff host aren't a second copy).
export const loadChrome = async (db, ws, { base = '/site', origin = '', canon = null } = {}) => {
  const { settings } = await loadSettings(db, ws);
  const pages = (await db.query(
    `select slug, title, nav_order from site_pages
     where workspace_id = $1 and published and show_in_nav and slug <> 'home' order by nav_order, lower(title)`,
    [ws.id],
  )).rows;
  const has = (await db.query(
    `select exists(select 1 from site_posts where workspace_id = $1 and published) as news,
            exists(select 1 from campaign_events where workspace_id = $1 and public and deleted_at is null) as events,
            exists(select 1 from site_team where workspace_id = $1 and published) as team,
            exists(select 1 from store_products where workspace_id = $1 and active and deleted_at is null) as store,
            exists(select 1 from site_pages where workspace_id = $1 and published and slug = 'get-involved') as involved`,
    [ws.id],
  )).rows[0];
  const hidden = new Set(settings.hidden_sections || []);
  const path = { news: '/news', events: '/events', team: '/our-team', store: '/store' };
  const items = [
    ...SECTIONS.filter(([k]) => has[k] && !hidden.has(k)).map(([k, label]) => ({ key: k, label, href: `${base}${path[k]}` })),
    ...pages.map((p) => ({ key: `page:${p.slug}`, label: p.title, href: `${base}/${p.slug}`, order: p.nav_order })),
  ];
  const rank = new Map((settings.nav_order || []).map((k, i) => [k, i]));
  const nav = items
    .map((it, i) => ({ ...it, r: rank.has(it.key) ? rank.get(it.key) : 1000 + (it.order ?? 500) + i / 100 }))
    .sort((a, b) => a.r - b.r);
  return {
    ws, settings, base, origin, nav, canon: canon ?? `${origin}${base}`,
    store: !!has.store,
    donate: `/d/${ws.slug}`,
    involved: has.involved ? `${base}/get-involved` : `/v/${ws.slug}`,
    newsletter: `/n/${ws.slug}`,
  };
};

// The campaign's mark: the full-colour logo on the white header (the one
// uploaded under Website → Settings, else the supplied file). The footer is
// navy, where full colour never goes, so it carries the site's name.
const brand = (ch, { footer = false } = {}) => {
  const s = ch.settings;
  const inner = footer
    ? `<span>${esc(s.site_title)}</span>`
    : `<img class="logo" src="${s.logo ? `/media/${esc(s.logo)}` : assetUrl('logo.png')}" alt="${esc(s.site_title)}" height="52">`;
  return `<a class="brand" href="${esc(`${ch.base}/`)}">${inner}</a>`;
};

// The header's menu: a row of links on wide screens, a drop-down on phones.
const header = (ch, current) => {
  const s = ch.settings;
  const links = ch.nav.map((n) => `<a href="${esc(n.href)}"${current === n.href ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`).join('');
  const cart = ch.store ? `<a class="cart-link" href="${esc(`${ch.base}/cart`)}" aria-label="Cart">${icon('bag')}<span class="cart-n"></span></a>` : '';
  return `<a class="skip" href="#main">Skip to content</a>
<header class="sh"><div class="wrap sh-in">
  ${brand(ch)}
  <nav class="sn" aria-label="Main">${links}</nav>
  <div class="sh-actions">
    ${cart}
    <a class="btn btn-gold btn-sm sh-cta" href="${esc(ch.donate)}">${esc(s.donate_label)}</a>
    <details class="menu"><summary aria-label="Menu">${icon('menu')}</summary>
      <nav class="menu-panel" aria-label="Menu">
        <a href="${esc(`${ch.base}/`)}">Home</a>${links}
        <a class="btn btn-gold" href="${esc(ch.donate)}">${esc(s.donate_label)}</a>
        <a class="btn btn-ghost" href="${esc(ch.involved)}">${esc(s.involved_label)}</a>
      </nav>
    </details>
  </div>
</div></header>`;
};

const footer = (ch, backlink) => {
  const s = ch.settings;
  const contact = [
    s.contact_email ? `<li><a href="mailto:${esc(s.contact_email)}">${esc(s.contact_email)}</a></li>` : '',
    s.contact_phone ? `<li><a href="tel:${esc(s.contact_phone.replace(/[^\d+]/g, ''))}">${esc(s.contact_phone)}</a></li>` : '',
  ].join('');
  return `<footer class="sf"><div class="wrap sf-grid">
  <div>
    ${brand(ch, { footer: true })}
    ${s.tagline ? `<p>${esc(s.tagline)}</p>` : ''}
    ${socialLinks(s.socials)}
  </div>
  <div><h2>Explore</h2><ul><li><a href="${esc(`${ch.base}/`)}">Home</a></li>${ch.nav.map((n) => `<li><a href="${esc(n.href)}">${esc(n.label)}</a></li>`).join('')}</ul></div>
  <div><h2>Take part</h2><ul>
    <li><a href="${esc(ch.donate)}">${esc(s.donate_label)}</a></li>
    <li><a href="${esc(ch.involved)}">${esc(s.involved_label)}</a></li>
    <li><a href="${esc(ch.newsletter)}">Newsletter</a></li>
  </ul></div>
  ${contact ? `<div><h2>Contact</h2><ul>${contact}</ul></div>` : '<div></div>'}
</div>
<div class="wrap sf-legal">
  ${s.authorized_by ? `<p class="auth">${esc(s.authorized_by)}</p>` : ''}
  <p>${backlink && /^https?:\/\//.test(backlink) ? `<a href="${esc(backlink)}">← ${esc(backlink.replace(/^https?:\/\//, ''))}</a> · ` : ''}© ${new Date().getFullYear()} ${esc(s.site_title)} · Powered by Starbase</p>
</div></footer>`;
};

const absolute = (ch, url) => (!url ? '' : /^https?:/.test(url) ? url : `${ch.origin}${url}`);

// A whole page. main is trusted HTML built by the caller (every value in it
// already escaped). path is this page's own path (for the canonical link).
export const layout = (ch, {
  title, description = '', image = null, path = '/', main, type = 'website', noindex = false, current = null, home = false, scripts = false, backlink = null,
}) => {
  const s = ch.settings;
  const full = home ? s.site_title : `${title} · ${s.site_title}`;
  const desc = description || s.seo_description || s.tagline || '';
  const img = absolute(ch, image || (s.hero_image ? `/media/${s.hero_image}` : ''));
  const canonical = `${ch.canon}${path}`;
  // Only #rrggbb ever reaches here (site.settings.save checks it).
  const col = (v, d) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : d);
  return `<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(full)}</title>
${desc ? `<meta name="description" content="${esc(desc)}">` : ''}
${noindex ? '<meta name="robots" content="noindex">' : ''}
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="${esc(s.site_title)}">
<meta property="og:title" content="${esc(home ? (s.hero_headline || s.site_title) : title)}">
${desc ? `<meta property="og:description" content="${esc(desc)}">` : ''}
<meta property="og:url" content="${esc(canonical)}">
${img ? `<meta property="og:image" content="${esc(img)}"><meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}
<meta name="theme-color" content="${col(s.primary, DEFAULT_PRIMARY)}">
<link rel="icon" href="${s.mark ? `/media/${esc(s.mark)}` : assetUrl('star.png')}" type="image/png">
<link rel="stylesheet" href="/fonts/fonts.css">
<link rel="stylesheet" href="${assetUrl('site.css')}">
<style>:root{--primary:${col(s.primary, DEFAULT_PRIMARY)};--accent:${col(s.accent, DEFAULT_ACCENT)}}</style>
${ch.store || scripts ? `<script src="${assetUrl('cart.js')}" defer></script>` : ''}
</head>
<body data-base="${esc(ch.base)}">
${header(ch, current)}
<main id="main">
${main}
</main>
${footer(ch, backlink)}
</body>
</html>`;
};

// ── Small shared pieces ──
export const img = (id, alt = '', { cls = '', eager = false, w, h } = {}) => (id
  ? `<img src="/media/${esc(id)}" alt="${esc(alt)}"${cls ? ` class="${cls}"` : ''}${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async"${w ? ` width="${w}" height="${h}"` : ''}>`
  : '');

export const fmtDay = (d, tz = 'America/Vancouver') => new Date(d).toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric', timeZone: tz });
export const fmtWhen = (d, tz = 'America/Vancouver') => new Date(d).toLocaleString('en-CA', {
  weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz,
});
export const fmtTime = (d, tz = 'America/Vancouver') => new Date(d).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone: tz });
const part = (d, tz, opt) => new Date(d).toLocaleDateString('en-CA', { ...opt, timeZone: tz });

// A date tile: "OCT / 23".
export const dateTile = (d, tz = 'America/Vancouver') => `<div class="ev-date" aria-hidden="true"><span>${esc(part(d, tz, { month: 'short' }).replace('.', ''))}</span><b>${esc(part(d, tz, { day: 'numeric' }))}</b></div>`;
