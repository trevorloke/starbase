// The public website, server-rendered. Mounted at /site on every host and,
// on the site's own domain (STARBASE_SITE_HOSTS), at / (siteOnItsOwnHost,
// used by server/index.js). Links inside it carry the base ('' or '/site').
//
//   /                 home: hero, welcome, news, events, team, store, newsletter
//   /news, /news/:slug          news (9 a page), one post
//   /events                     upcoming events (past ones folded away) → /e/… RSVP
//   /our-team                   candidates and team
//   /store, /store/:slug, /cart the shop, a product, the cart (cart.js)
//   POST /store/quote           the cart priced here, never in the browser
//   POST /store/checkout        → Stripe Checkout (or "Online store opens soon")
//   /store/thanks               after paying
//   /sitemap.xml, /robots.txt
//   /:slug                      a published page (About, Platform, …)
// Drafts never show. Pages revalidate on every visit (ETag), so an edit is
// live at once; pictures and the stylesheet are cached for a year.
import { Hono } from 'hono';
import { etag } from 'hono/etag';
import { getDb } from '../../db/client.js';
import { runAction, newId } from '../../lib/events.js';
import { stripeConfigured, stripePost } from '../../lib/stripe.js';
import { renderMarkdown, markdownText, escapeHtml as esc } from '@starbase/shared/markdown';
import { siteWorkspace, parseJ, dateOnly, money } from './content.js';
import { loadChrome, layout, img, fmtDay, fmtWhen, fmtTime, dateTile, socialLinks, icon } from './layout.js';
import { priceCart, checkoutParams, productRow, leftOf } from './store.js';
import { onSiteHost, originOf, siteHosts } from './hosts.js';
import { clientIp, makeLimiter } from '../../lib/guard.js';
import { getCookie } from 'hono/cookie';
import { loadContext, SESSION_COOKIE } from '../../lib/auth.js';

export const siteApp = new Hono();
siteApp.use('*', etag());

const PER_PAGE = 9;
const tzOf = (ws) => ws.settings?.tz || 'America/Vancouver';

// Everything a page needs: the campaign, its chrome, the base for links.
const site = async (c) => {
  const db = await getDb();
  const ws = await siteWorkspace(db);
  if (!ws) return null;
  const base = c.req.path === '/site' || c.req.path.startsWith('/site/') ? '/site' : '';
  const origin = originOf(c);
  const own = siteHosts()[0];
  const ch = await loadChrome(db, ws, { base, origin, canon: own ? `https://${own}` : `${origin}${base}` });
  return { db, ws, base, ch, tz: tzOf(ws) };
};

const send = (c, html, status = 200) => {
  c.header('Cache-Control', 'no-cache');
  return c.html(html, status);
};
const noSite = (c) => c.text('This website is not set up yet.', 404);

// Draft preview: ?preview on a page or post shows it unpublished — only to
// the campaign's own desk staff, signed in on this host (the staff app's
// /site; the site's own domain has no staff sign-in). Never cached or indexed.
const EDITORS = ['manager', 'staff'];
const canPreview = async (c, s) => {
  if (c.req.query('preview') === undefined) return false;
  const ctx = await loadContext(s.db, getCookie(c, SESSION_COOKIE)).catch(() => null);
  return Boolean(ctx && ctx.workspaceId === s.ws.id && EDITORS.includes(ctx.role));
};
const draftNote = (editUrl) => `<div class="wrap narrow" style="padding-top:16px"><p class="notice" role="status">
  <strong>Draft preview</strong> — only signed-in staff can see this. <a href="${esc(editUrl)}">Back to editing</a></p></div>`;
const sendDraft = (c, html) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex');
  return c.html(html);
};

const notFound = (c, s) => send(c, layout(s.ch, {
  title: 'Page not found', noindex: true, path: c.req.path.replace(/^\/site/, ''),
  main: `<section class="band"><div class="wrap"><h1>Page not found</h1><p>That page isn’t here — it may have moved.</p></div></section>
<div class="wrap narrow lift"><div class="sheet"><a class="btn btn-accent" href="${esc(`${s.base}/`)}">Go to the home page</a></div></div>`,
}), 404);

// ── Cards ──
const postCard = (s, p) => `<a class="card" href="${esc(`${s.base}/news/${p.slug}`)}">
  <div class="card-img${p.cover_image ? '' : ' ph'}">${img(p.cover_image)}</div>
  <div class="card-body">
    ${p.pinned ? '<span class="pin">Pinned</span>' : ''}
    <span class="meta">${esc(fmtDay(`${dateOnly(p.date)}T12:00:00Z`, 'UTC'))}</span>
    <h3>${esc(p.title)}</h3>
    ${p.summary ? `<p>${esc(p.summary)}</p>` : ''}
  </div></a>`;

const eventCard = (s, e) => {
  const where = e.location ? `<p>${icon('pin')} ${esc(e.location)}</p>` : '';
  return `<article class="card ev-card">
  ${e.image ? `<div class="card-img">${img(e.image)}</div>` : ''}
  <div class="ev">
    ${dateTile(e.starts_at, s.tz)}
    <div>
      <h3>${esc(e.title)}</h3>
      <p>${esc(fmtWhen(e.starts_at, s.tz))}${e.ends_at ? ` – ${esc(fmtTime(e.ends_at, s.tz))}` : ''}</p>
      ${where}
      <a class="btn btn-line btn-sm" href="${esc(`/e/${s.ws.slug}/${e.slug}`)}">${new Date(e.starts_at) < new Date() ? 'Details' : 'Details & RSVP'}</a>
    </div>
  </div></article>`;
};

const personCard = (p) => {
  const initials = String(p.name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  return `<article class="card person">
  ${p.photo ? img(p.photo, p.name) : `<div class="ph-photo" aria-hidden="true">${esc(initials)}</div>`}
  <h3>${esc(p.name)}</h3>
  ${p.role ? `<div class="role">${esc(p.role)}</div>` : ''}
  ${p.bio ? `<p>${esc(p.bio)}</p>` : ''}
  ${socialLinks(parseJ(p.socials, {}))}
</article>`;
};

const soldOut = (p) => p.track_stock && (p.variants.length ? p.variants.every((v) => !(Number(v.stock) > 0)) : !(Number(p.stock) > 0));
const productCard = (s, p) => `<a class="card" href="${esc(`${s.base}/store/${p.slug}`)}">
  <div class="card-img prod-img${p.images[0] ? '' : ' ph'}">${img(p.images[0], '')}</div>
  <div class="card-body">
    <h3>${esc(p.name)}</h3>
    <span class="price">${esc(money(p.price_cents))}</span>
    ${soldOut(p) ? '<span class="chip chip-out">Sold out</span>' : ''}
  </div></a>`;

// ── Queries ──
const upcomingEvents = (db, ws, limit) => db.query(
  `select e.*, x.image from campaign_events e left join site_event_extras x on x.event_id = e.id
   where e.workspace_id = $1 and e.public and e.deleted_at is null and coalesce(e.ends_at, e.starts_at) >= now()
   order by e.starts_at limit $2`,
  [ws.id, limit],
).then((r) => r.rows);
const products = (db, ws, limit = 200) => db.query(
  `select * from store_products where workspace_id = $1 and active and deleted_at is null order by position, lower(name) limit $2`,
  [ws.id, limit],
).then((r) => r.rows.map(productRow));

// ── Home ──
const home = async (c) => {
  const s = await site(c);
  if (!s) return noSite(c);
  const { db, ws, ch } = s;
  const st = ch.settings;
  const intro = (await db.query(`select title, body from site_pages where workspace_id = $1 and slug = 'home' and published`, [ws.id])).rows[0];
  const posts = (await db.query(
    `select slug, title, date, summary, cover_image, pinned from site_posts where workspace_id = $1 and published
     order by pinned desc, date desc, created_at desc limit 3`, [ws.id],
  )).rows;
  const events = await upcomingEvents(db, ws, 3);
  const team = (await db.query('select * from site_team where workspace_id = $1 and published order by position, lower(name) limit 8', [ws.id])).rows;
  const shop = await products(db, ws, 4);
  const headline = st.hero_headline || st.site_title;
  const main = `
<section class="hero${st.hero_image ? '' : ' no-img'}">
  ${st.hero_image ? img(st.hero_image, '', { cls: 'hero-img', eager: true }) : ''}
  <div class="wrap hero-in">
    ${st.tagline ? `<span class="eyebrow">${esc(st.tagline)}</span>` : ''}
    <h1>${esc(headline)}</h1>
    ${st.hero_text ? `<p>${esc(st.hero_text)}</p>` : ''}
    <div class="ctas">
      <a class="btn btn-gold" href="${esc(ch.donate)}">${esc(st.donate_label)}</a>
      <a class="btn btn-ghost" href="${esc(ch.involved)}">${esc(st.involved_label)}</a>
    </div>
  </div>
</section>
${intro ? `<section class="sec"><div class="wrap intro">
  <div><span class="kicker">Welcome</span><h2>${esc(/^home$/i.test(intro.title) ? st.site_title : intro.title)}</h2></div>
  <div class="prose">${renderMarkdown(intro.body)}</div>
</div></section>` : ''}
${posts.length ? `<section class="sec"><div class="wrap">
  <div class="sec-head"><div><span class="kicker">News</span><h2>Latest updates</h2></div><a class="more" href="${esc(`${s.base}/news`)}">All news</a></div>
  <div class="grid">${posts.map((p) => postCard(s, p)).join('')}</div>
</div></section>` : ''}
${events.length ? `<section class="sec"><div class="wrap">
  <div class="sec-head"><div><span class="kicker">Events</span><h2>Come meet us</h2></div><a class="more" href="${esc(`${s.base}/events`)}">All events</a></div>
  <div class="grid">${events.map((e) => eventCard(s, e)).join('')}</div>
</div></section>` : ''}
${team.length ? `<section class="sec"><div class="wrap">
  <div class="sec-head"><div><span class="kicker">Team</span><h2>Meet the team</h2></div><a class="more" href="${esc(`${s.base}/our-team`)}">Everyone</a></div>
  <div class="grid grid-4">${team.slice(0, 4).map(personCard).join('')}</div>
</div></section>` : ''}
${shop.length ? `<section class="sec"><div class="wrap">
  <div class="sec-head"><div><span class="kicker">Store</span><h2>Wear it proudly</h2></div><a class="more" href="${esc(`${s.base}/store`)}">Shop</a></div>
  <div class="grid grid-4">${shop.map((p) => productCard(s, p)).join('')}</div>
</div></section>` : ''}
<section class="sec"><div class="wrap">${joinBand(s)}</div></section>`;
  return send(c, layout(ch, { title: st.site_title, home: true, path: '/', main }));
};

const joinBand = (s) => `<div class="join">
  <div><h2>Stay in the loop</h2><p>News and events from ${esc(s.ch.settings.site_title)}, straight to your inbox.</p></div>
  <div>
    <form method="post" action="${esc(s.ch.newsletter)}">
      <label class="sr" for="join-email">Email</label>
      <input id="join-email" name="email" type="email" required autocomplete="email" placeholder="you@example.com">
      <button class="btn btn-gold" type="submit">Subscribe</button>
    </form>
    <p class="alt">Want to do more? <a href="${esc(s.ch.involved)}">${esc(s.ch.settings.involved_label)}</a></p>
  </div>
</div>`;

siteApp.get('/', home);

// ── News ──
siteApp.get('/news', async (c) => {
  const s = await site(c);
  if (!s) return noSite(c);
  const page = Math.max(1, Math.min(1000, Number.parseInt(c.req.query('page'), 10) || 1));
  const rows = (await s.db.query(
    `select slug, title, date, summary, cover_image, pinned, count(*) over ()::int as total from site_posts
     where workspace_id = $1 and published order by date desc, created_at desc limit $2 offset $3`,
    [s.ws.id, PER_PAGE, (page - 1) * PER_PAGE],
  )).rows;
  const total = rows[0]?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  if (page > pages) return notFound(c, s);
  const link = (n) => `${s.base}/news${n > 1 ? `?page=${n}` : ''}`;
  const main = `<section class="band"><div class="wrap"><span class="kicker" style="color:var(--gold)">News</span><h1>Latest updates</h1></div></section>
<div class="wrap lift">
  ${rows.length ? `<div class="grid">${rows.map((p) => postCard(s, p)).join('')}</div>` : '<div class="sheet"><p class="empty">No news yet.</p></div>'}
  ${pages > 1 ? `<nav class="pager" aria-label="More news">
    ${page > 1 ? `<a class="btn btn-line btn-sm" href="${esc(link(page - 1))}" rel="prev">Newer</a>` : ''}
    <span class="meta" style="align-self:center">Page ${page} of ${pages}</span>
    ${page < pages ? `<a class="btn btn-line btn-sm" href="${esc(link(page + 1))}" rel="next">Older</a>` : ''}
  </nav>` : ''}
</div>`;
  return send(c, layout(s.ch, { title: page > 1 ? `News · page ${page}` : 'News', path: `/news${page > 1 ? `?page=${page}` : ''}`, main, current: `${s.base}/news` }));
});

siteApp.get('/news/:slug', async (c) => {
  const s = await site(c);
  if (!s) return noSite(c);
  const preview = await canPreview(c, s);
  const p = (await s.db.query(`select * from site_posts where workspace_id = $1 and slug = $2${preview ? '' : ' and published'}`,
    [s.ws.id, c.req.param('slug')])).rows[0];
  if (!p) return notFound(c, s);
  const draft = preview && !p.published;
  const day = dateOnly(p.date);
  const main = `${draft ? draftNote(`/website/news/${p.id}`) : ''}<section class="band"><div class="wrap narrow">
  <span class="meta">${esc(fmtDay(`${day}T12:00:00Z`, 'UTC'))}</span>
  <h1>${esc(p.title)}</h1>
  ${p.summary ? `<p>${esc(p.summary)}</p>` : ''}
</div></section>
<div class="wrap narrow lift"><article class="sheet">
  ${p.cover_image ? `<div class="cover">${img(p.cover_image, '', { eager: true })}</div>` : ''}
  <div class="prose">${renderMarkdown(p.body)}</div>
  <a class="back" href="${esc(`${s.base}/news`)}">All news</a>
</article></div>`;
  return (draft ? sendDraft : send)(c, layout(s.ch, {
    title: p.title, description: p.summary || markdownText(p.body, 180), image: p.cover_image ? `/media/${p.cover_image}` : null,
    path: `/news/${p.slug}`, type: 'article', main, current: `${s.base}/news`, noindex: draft,
  }));
});

// ── Events ──
siteApp.get('/events', async (c) => {
  const s = await site(c);
  if (!s) return noSite(c);
  const upcoming = await upcomingEvents(s.db, s.ws, 200);
  const past = (await s.db.query(
    `select e.*, x.image from campaign_events e left join site_event_extras x on x.event_id = e.id
     where e.workspace_id = $1 and e.public and e.deleted_at is null and coalesce(e.ends_at, e.starts_at) < now()
     order by e.starts_at desc limit 30`, [s.ws.id],
  )).rows;
  const main = `<section class="band"><div class="wrap"><span class="kicker" style="color:var(--gold)">Events</span><h1>Come meet us</h1></div></section>
<div class="wrap lift">
  ${upcoming.length ? `<div class="grid">${upcoming.map((e) => eventCard(s, e)).join('')}</div>`
    : '<div class="sheet"><p class="empty" style="margin:0">No upcoming events right now — check back soon.</p></div>'}
  ${past.length ? `<details class="past"><summary>Past events · ${past.length}</summary><div class="grid">${past.map((e) => eventCard(s, e)).join('')}</div></details>` : ''}
</div>`;
  return send(c, layout(s.ch, { title: 'Events', path: '/events', main, current: `${s.base}/events` }));
});

// ── Team ──
siteApp.get('/our-team', async (c) => {
  const s = await site(c);
  if (!s) return noSite(c);
  const team = (await s.db.query('select * from site_team where workspace_id = $1 and published order by position, lower(name)', [s.ws.id])).rows;
  const main = `<section class="band"><div class="wrap"><span class="kicker" style="color:var(--gold)">Team</span><h1>Meet the team</h1></div></section>
<div class="wrap lift">${team.length ? `<div class="grid grid-4">${team.map(personCard).join('')}</div>` : '<div class="sheet"><p class="empty" style="margin:0">Coming soon.</p></div>'}</div>`;
  return send(c, layout(s.ch, { title: 'Team', path: '/our-team', main, current: `${s.base}/our-team` }));
});

// ── Store ──
const opensSoon = '<p class="notice">Online store opens soon.</p>';

siteApp.get('/store', async (c) => {
  const s = await site(c);
  if (!s) return noSite(c);
  const list = await products(s.db, s.ws);
  const main = `<section class="band"><div class="wrap"><span class="kicker" style="color:var(--gold)">Store</span><h1>Campaign store</h1>
  <p>Shirts, signs and more.${stripeConfigured() ? '' : ' Online store opens soon.'}</p></div></section>
<div class="wrap lift">${list.length ? `<div class="grid grid-4">${list.map((p) => productCard(s, p)).join('')}</div>` : '<div class="sheet"><p class="empty" style="margin:0">Nothing for sale yet.</p></div>'}</div>`;
  return send(c, layout(s.ch, { title: 'Store', path: '/store', main, current: `${s.base}/store` }));
});

siteApp.get('/store/thanks', async (c) => {
  const s = await site(c);
  if (!s) return noSite(c);
  const main = `<section class="band"><div class="wrap narrow"><h1>Thank you!</h1><p>Your order is in.</p></div></section>
<div class="wrap narrow lift"><div class="sheet" data-clear-cart>
  <p class="prose">Stripe emails your payment receipt.</p>
  <a class="btn btn-accent" href="${esc(`${s.base}/`)}">Back to the home page</a>
</div></div>`;
  return send(c, layout(s.ch, { title: 'Thank you', path: '/store/thanks', main, noindex: true, scripts: true }));
});

siteApp.get('/store/:slug', async (c) => {
  const s = await site(c);
  if (!s) return noSite(c);
  const row = (await s.db.query(
    'select * from store_products where workspace_id = $1 and slug = $2 and active and deleted_at is null', [s.ws.id, c.req.param('slug')],
  )).rows[0];
  if (!row) return notFound(c, s);
  const p = productRow(row);
  const out = soldOut(p);
  const sizes = p.variants.length ? `<fieldset class="sizes"><legend class="opt-label">Size</legend>${p.variants.map((v) => {
    const left = leftOf(p, v.label);
    return `<label><input type="radio" name="variant" value="${esc(v.label)}"${left === 0 ? ' disabled' : ''}><span>${esc(v.label)}</span></label>`;
  }).join('')}</fieldset>` : '';
  const main = `<div class="wrap" style="padding-top:clamp(28px,5vw,56px)">
<div class="pd">
  <div>
    <div class="gallery-main${p.images[0] ? '' : ' card-img ph'}">${img(p.images[0], p.name, { eager: true })}</div>
    ${p.images.length > 1 ? `<div class="thumbs">${p.images.map((id, i) => `<button type="button" data-src="/media/${esc(id)}" aria-pressed="${i === 0}" aria-label="Picture ${i + 1}">${img(id)}</button>`).join('')}</div>` : ''}
  </div>
  <div>
    <a class="back" style="margin:0 0 12px" href="${esc(`${s.base}/store`)}">Store</a>
    <h1>${esc(p.name)}</h1>
    <span class="price">${esc(money(p.price_cents))}</span>
    <form id="buy" data-product="${esc(p.id)}">
      ${sizes}
      <div class="buy">
        <label class="sr" for="qty">How many</label>
        <input class="qty" id="qty" name="qty" type="number" min="1" max="20" value="1" inputmode="numeric">
        <button class="btn btn-accent" type="submit"${out ? ' disabled' : ''}>${out ? 'Sold out' : 'Add to cart'}</button>
      </div>
      <p class="added" role="status"></p>
      <noscript><p class="notice">Turn on JavaScript to use the cart.</p></noscript>
    </form>
    ${stripeConfigured() ? '' : opensSoon}
    <div class="prose">${renderMarkdown(p.description)}</div>
  </div>
</div></div>`;
  return send(c, layout(s.ch, {
    title: p.name, description: markdownText(p.description, 180) || `${p.name} · ${money(p.price_cents)}`,
    image: p.images[0] ? `/media/${p.images[0]}` : null, path: `/store/${p.slug}`, type: 'product', main, current: `${s.base}/store`,
  }));
});

// Back from Stripe without paying (its cancel link): close that payment page
// first — so it can't be paid later for an order that's gone — then let the
// order's hold on its items go, so the buyer can try again straight away.
// The order id is the key (random, only in that link); only an open order of
// this store is touched, and if Stripe can't be reached the hold simply runs
// out with the session.
const releaseCheckout = async (s, orderId) => {
  if (!/^[0-9a-f-]{36}$/i.test(orderId || '') || !stripeConfigured()) return;
  const o = (await s.db.query(
    `select id, stripe_session_id from store_orders where id = $1 and workspace_id = $2 and status = 'pending'`,
    [orderId, s.ws.id],
  )).rows[0];
  if (!o?.stripe_session_id) return;
  try {
    await stripePost(`checkout/sessions/${encodeURIComponent(o.stripe_session_id)}/expire`, {});
  } catch {
    return; // already paid or expired, or no answer: the webhook decides
  }
  await runAction(s.db, { workspaceId: s.ws.id, actorId: null, action: 'store.expire' }, async (tx, emit) => {
    const r = await tx.query(`update store_orders set status = 'cancelled', updated_at = now()
      where id = $1 and workspace_id = $2 and status = 'pending' returning id`, [o.id, s.ws.id]);
    if (r.rows[0]) emit('store_order', o.id, 'update', { status: 'cancelled', reason: 'left the payment page' });
  });
};

siteApp.get('/cart', async (c) => {
  const s = await site(c);
  if (!s) return noSite(c);
  c.header('Cache-Control', 'no-store');
  await releaseCheckout(s, c.req.query('cancel'));
  const main = `<section class="band"><div class="wrap narrow"><h1>Your cart</h1></div></section>
<div class="wrap narrow lift"><div class="sheet">
  <div id="cart" data-open="${stripeConfigured() ? '1' : '0'}"><p class="meta">Loading your cart…</p></div>
  <noscript><p class="notice">Turn on JavaScript to use the cart.</p></noscript>
</div></div>`;
  return c.html(layout(s.ch, { title: 'Cart', path: '/cart', main, noindex: true, scripts: true }));
});

// Ways to get an order: shipping (with its fee) and/or pick-up, from Settings.
const waysOf = (st) => {
  const ways = [];
  if (st.shipping) ways.push({ code: 'ship', label: 'Ship to me', note: `${money(st.shipping_cents)} · Canada only`, cents: st.shipping_cents });
  if (st.pickup || !ways.length) ways.push({ code: 'pickup', label: 'Pick up at the campaign office', note: st.pickup_note || 'Free', cents: 0 });
  return ways;
};

// Public writes: 30 per 10 minutes from one address (lib/guard.js).
const hitsFrom = makeLimiter({ windowMs: 600000, max: 30 });
const limited = (c) => hitsFrom(clientIp(c));
// Open checkouts (unpaid, holding their items) from one address at once.
// Beyond this, "sold out" could be faked by starting checkouts and never paying.
const OPEN_CHECKOUTS_PER_IP = 2;

siteApp.post('/store/quote', async (c) => {
  const s = await site(c);
  if (!s) return c.json({ error: 'no store' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const q = await priceCart(s.db, s.ws, b.items);
  c.header('Cache-Control', 'no-store');
  return c.json({ ...q, ways: waysOf(s.ch.settings), open: stripeConfigured() });
});

// Checkout: price the cart here, refuse anything sold out, make the order
// (pending) and its Stripe Checkout Session, and send the buyer there.
siteApp.post('/store/checkout', async (c) => {
  if (limited(c)) return c.json({ error: 'Too many tries — wait a few minutes.' }, 429);
  const s = await site(c);
  if (!s) return c.json({ error: 'no store' }, 404);
  if (!stripeConfigured()) return c.json({ error: 'Online store opens soon.' }, 503);
  const b = await c.req.json().catch(() => ({}));
  const st = s.ch.settings;
  const way = waysOf(st).find((w) => w.code === b.fulfilment);
  if (!way) return c.json({ error: 'Choose shipping or pick-up.' }, 400);
  // Check what's left and hold it in one step: the order is saved as pending
  // (holding its items) before the buyer goes to Stripe. Actions take the
  // campaign's row lock, so two buyers of the last shirt can't both get it.
  const orderId = newId();
  const ip = clientIp(c);
  let order;
  let refused = null;
  await runAction(s.db, { workspaceId: s.ws.id, actorId: null, action: 'store.checkout' }, async (tx, emit) => {
    const open = (await tx.query(
      `select count(*)::int as n from store_orders where workspace_id = $1 and status = 'pending' and client_ip = $2
         and created_at > now() - interval '35 minutes'`, [s.ws.id, ip],
    )).rows[0].n;
    if (open >= OPEN_CHECKOUTS_PER_IP) { refused = [429, { error: 'You have a checkout open already — finish or cancel it first.' }]; return; }
    const q = await priceCart(tx, s.ws, b.items);
    if (!q.lines.length) { refused = [400, { error: 'Your cart is empty.' }]; return; }
    if (q.problems.length) {
      const p = q.problems[0];
      refused = [409, { error: `${p.name || 'An item'}${p.variant ? ` (${p.variant})` : ''}: ${p.error}.`, problems: q.problems }];
      return;
    }
    order = {
      id: orderId,
      fulfilment: way.code,
      items: q.lines.map(({ product_id, slug, name, variant, qty, unit_cents, line_cents, image }) => ({ product_id, slug, name, variant, qty, unit_cents, line_cents, image })),
      subtotal_cents: q.subtotal_cents,
      shipping_cents: way.cents,
      total_cents: q.subtotal_cents + way.cents,
    };
    await tx.query(
      `insert into store_orders (id, workspace_id, status, fulfilment, items, subtotal_cents, shipping_cents, total_cents, client_ip)
       values ($1, $2, 'pending', $3, $4, $5, $6, $7, $8)`,
      [order.id, s.ws.id, order.fulfilment, JSON.stringify(order.items), order.subtotal_cents, order.shipping_cents, order.total_cents, ip],
    );
    emit('store_order', order.id, 'create', {
      status: 'pending', fulfilment: order.fulfilment, total_cents: order.total_cents,
      items: order.items.map((l) => ({ product_id: l.product_id, variant: l.variant, qty: l.qty, unit_cents: l.unit_cents })),
    });
  });
  if (refused) return c.json(refused[1], refused[0]);
  const back = `${originOf(c)}${s.base}`;
  let session;
  try {
    session = await stripePost('checkout/sessions', checkoutParams({
      order, ws: s.ws, settings: st,
      successUrl: `${back}/store/thanks?order=${order.id}`,
      cancelUrl: `${back}/cart?cancel=${order.id}`,
      imageUrl: /^https:/.test(back) ? (id) => `${back.replace(/\/site$/, '')}/media/${id}` : null,
    }));
  } catch (e) {
    // No payment page: let the hold go at once.
    await runAction(s.db, { workspaceId: s.ws.id, actorId: null, action: 'store.expire' }, async (tx, emit) => {
      const r = await tx.query(`update store_orders set status = 'cancelled', updated_at = now()
        where id = $1 and workspace_id = $2 and status = 'pending' returning id`, [order.id, s.ws.id]);
      if (r.rows[0]) emit('store_order', order.id, 'update', { status: 'cancelled', reason: 'checkout could not open' });
    });
    return c.json({ error: `Card payment isn’t available right now (${String(e.message).slice(0, 120)}). Please try again shortly.` }, 502);
  }
  await runAction(s.db, { workspaceId: s.ws.id, actorId: null, action: 'store.checkout' }, async (tx, emit) => {
    await tx.query('update store_orders set stripe_session_id = $3, updated_at = now() where id = $1 and workspace_id = $2',
      [order.id, s.ws.id, session.id]);
    emit('store_order', order.id, 'update', { stripe_session_id: session.id });
  });
  return c.json({ url: session.url, order_id: order.id });
});

// ── Search engines ──
siteApp.get('/sitemap.xml', async (c) => {
  const s = await site(c);
  if (!s) return noSite(c);
  const { db, ws, ch } = s;
  const q = async (sqlText) => (await db.query(sqlText, [ws.id])).rows;
  const urls = [{ loc: '/' }];
  if (ch.nav.some((n) => n.key === 'news')) urls.push({ loc: '/news' });
  for (const p of await q('select slug, updated_at from site_posts where workspace_id = $1 and published')) urls.push({ loc: `/news/${p.slug}`, at: p.updated_at });
  urls.push({ loc: '/events' });
  if (ch.nav.some((n) => n.key === 'team')) urls.push({ loc: '/our-team' });
  if (ch.store) urls.push({ loc: '/store' });
  for (const p of await q('select slug, updated_at from store_products where workspace_id = $1 and active and deleted_at is null')) urls.push({ loc: `/store/${p.slug}`, at: p.updated_at });
  for (const p of await q(`select slug, updated_at from site_pages where workspace_id = $1 and published and slug <> 'home'`)) urls.push({ loc: `/${p.slug}`, at: p.updated_at });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(`${ch.canon}${u.loc}`)}</loc>${u.at ? `<lastmod>${new Date(u.at).toISOString().slice(0, 10)}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`;
  c.header('Cache-Control', 'public, max-age=3600');
  return c.body(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
});

siteApp.get('/robots.txt', async (c) => {
  const s = await site(c);
  const lines = ['User-agent: *', 'Disallow: /api/', `Disallow: ${s?.base || ''}/cart`];
  if (s) lines.push(`Sitemap: ${s.ch.canon}/sitemap.xml`);
  c.header('Cache-Control', 'public, max-age=3600');
  return c.text(`${lines.join('\n')}\n`);
});

// ── Pages (About, Platform, …) — last, so the sections above win ──
siteApp.get('/:slug', async (c) => {
  const s = await site(c);
  if (!s) return noSite(c);
  const slug = c.req.param('slug');
  if (slug === 'home') return c.redirect(`${s.base}/`, 301);
  const preview = await canPreview(c, s);
  const p = (await s.db.query(`select * from site_pages where workspace_id = $1 and slug = $2${preview ? '' : ' and published'}`,
    [s.ws.id, slug])).rows[0];
  if (!p) return notFound(c, s);
  const draft = preview && !p.published;
  const involved = slug === 'get-involved';
  const main = `${draft ? draftNote(`/website/pages/${p.id}`) : ''}<section class="band${p.hero_image ? ' with-img' : ''}"><div class="wrap narrow"><h1>${esc(p.title)}</h1></div></section>
<div class="wrap narrow lift"><article class="sheet">
  ${p.hero_image ? `<div class="cover">${img(p.hero_image, '', { eager: true })}</div>` : ''}
  <div class="prose">${renderMarkdown(p.body)}</div>
  ${involved ? `<div class="ctas" style="margin-top:28px"><a class="btn btn-accent" href="${esc(`/v/${s.ws.slug}`)}">Volunteer</a><a class="btn btn-line" href="${esc(s.ch.donate)}">${esc(s.ch.settings.donate_label)}</a></div>` : ''}
</article></div>`;
  return (draft ? sendDraft : send)(c, layout(s.ch, {
    title: p.title, description: markdownText(p.body, 180), image: p.hero_image ? `/media/${p.hero_image}` : null,
    path: `/${p.slug}`, main, current: `${s.base}/${p.slug}`, noindex: draft,
  }));
});

siteApp.get('*', async (c) => {
  // /site/ (with the slash) is the home page too.
  if (c.req.path === '/site/') return home(c);
  const s = await site(c);
  return s ? notFound(c, s) : noSite(c);
});

// ── The site at / on its own domain ──
// Paths the staff app and the public forms own at the top level; on the
// site's domain they still reach the app (keep in step with web/src/App.jsx
// and the public routes). Everything else single-segment is the site's.
const APP_PATHS = new Set([
  'api', 'assets', 'site', 'site-assets', 'media', 'login', 'signup', 'join', 'map', 'calls', 'people', 'shifts', 'turfs',
  'signs', 'inbox', 'my-people', 'money', 'outreach', 'filings', 'team', 'ladders', 'follow-ups', 'surveys', 'rating-scale',
  'website', 'website-admin', 'admin', 'fonts', 'tiles', 'imagineu', 'banks', 'learn', 'learn-files', 'e', 'd', 'n', 'v', 'u', 'p', 'r', 'lu', 'o', 'c',
]);
const SITE_PATH = /^\/(?:news|events|our-team|store|cart)(?:\/|$)|^\/(?:sitemap\.xml|robots\.txt)$/;

export const claimsPath = (path) => {
  if (path === '/' || path === '' || SITE_PATH.test(path)) return true;
  const m = /^\/([^/.]+)\/?$/.exec(path);
  return !!m && !APP_PATHS.has(m[1].toLowerCase());
};

export const siteOnItsOwnHost = async (c, next) => {
  if (!onSiteHost(c) || !claimsPath(c.req.path)) return next();
  return siteApp.fetch(c.req.raw, c.env);
};
// The site as its own service (STARBASE_SERVE=site): at / on every host.
export const siteOnEveryHost = async (c, next) => {
  if (!claimsPath(c.req.path)) return next();
  return siteApp.fetch(c.req.raw, c.env);
};
