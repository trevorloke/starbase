// Public pages + the website bridge. No auth. Each campaign workspace gets:
//   GET/POST /p/:ws/:petition   petition signature page
//   GET/POST /n/:ws             newsletter signup page
//   GET/POST /v/:ws             volunteer signup page
//   GET/POST /u/:subscriptionId unsubscribe (GET asks, POST does it)
//   GET/POST /e/:ws/:event      event page + RSVP
//   GET/POST /d/:ws             donate (BC eligibility attestations; Stripe
//                               Checkout when configured, else a pledge)
//   POST     /api/public/stripe/webhook   payment confirmations → gifts, and
//                                        the website store's paid orders
//   POST     /api/public/:ws/signup   CORS-open JSON for the campaign website's
//                                     own forms (kind: newsletter | volunteer | petition | rsvp)
//   POST     /api/public/:ws/donate   CORS-open JSON donate: the same checks and
//                                     pledge as /d, Stripe's return on the site's own pages
// Server-rendered HTML keeps these dead simple to link from the website;
// the JSON endpoint lets the website keep its own design and post here.
//
// Every public write goes through runAction as the system (actor null), so
// the hash-chained event log — "Verify the records" — covers it like any desk
// action. The person a submission creates or tags is logged under
// 'public.signup'; the submission itself under its own action:
//   public.subscribe  newsletter signup (/n, bridge)  subscription create/update
//   public.unsubscribe one-click unsubscribe (/u)    subscription update
//   public.sign       petition signature (/p, bridge) petition_signature create
//   public.rsvp       event RSVP (/e, bridge)         rsvp create
//   public.volunteer  roles ticked + note (/v, bridge) volunteer_role create, person update
//   public.pledge     donate page pledge (/d)         pledge create
//   stripe.checkout   card checkout opened for a pledge  pledge update
//   stripe.payment    Stripe webhook                  pledge update, gift create
//   store.payment / store.expire / store.refund  Stripe webhook for website store orders
import { Hono } from 'hono';
import { clientIp, makeLimiter } from '../lib/guard.js';
import { getDb } from '../db/client.js';
import { runAction, newId } from '../lib/events.js';
import { publicAction, upsertPersonTx, upsertPersonFromPublic, subscribeTx, subscribe } from '../lib/publicwrites.js';
import { VOLUNTEER_ROLES, VOLUNTEER_ROLE_CODES } from '@starbase/shared/canvass';
import { capFor, donorYearTotal } from '../lib/cap.js';
import { logGift, campaignDay, voidGift } from '../lib/gifts.js';
import { stripeConfigured, createCheckoutSession, verifyStripeSignature } from '../lib/stripe.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { renderMarkdown } from '@starbase/shared/markdown';
// The website's look and its store's webhook half (ext/website).
import { loadChrome, layout, assetUrl, img, dateTile } from '../ext/website/layout.js';
import { siteWorkspace } from '../ext/website/content.js';
import { onSiteHost, originOf, returnUrl } from '../ext/website/hosts.js';
import { applyStorePayment, expireStoreOrder, refundStoreOrder } from '../ext/website/store.js';

const app = new Hono();

// Per-IP rate limit: 30 public writes per 10 minutes (lib/guard.js).
const limited = makeLimiter({ windowMs: 600000, max: 30 });
const ipOf = clientIp;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const settingsOf = (ws) => (typeof ws.settings === 'string' ? JSON.parse(ws.settings) : (ws.settings || {}));

// Every public form sits inside the campaign's website (ext/website): its
// header, footer and look, so RSVP, donate and signup feel like one site.
// The form itself is one column in a white card, thumb-sized inputs and one
// big button. ws may be null (a link that names no campaign): the page then
// wears the site's own campaign. Async: c.html() takes the promise.
// The request's host decides the site links' base (/ on the site's own
// domain, /site elsewhere): a middleware below keeps it for page().
const reqInfo = new AsyncLocalStorage();
const page = async (ws, title, inner, { wide = false } = {}) => {
  const db = await getDb();
  const info = reqInfo.getStore() || { base: '/site', origin: '' };
  const owner = ws?.id ? ws : await siteWorkspace(db);
  const chrome = owner
    ? await loadChrome(db, { ...owner, settings: settingsOf(owner) }, { base: info.base, origin: info.origin, canon: info.origin })
    : null;
  const main = `<div class="wrap ${wide ? 'narrow' : 'form-wrap'}" style="padding-top:clamp(28px,5vw,64px)"><div class="sheet form-card">
${inner}
</div></div>`;
  if (!chrome) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="${assetUrl('site.css')}"></head><body>${main}
<footer class="sf"><div class="wrap sf-legal"><p>Powered by Starbase</p></div></footer></body></html>`;
  }
  // The tab says the page and the campaign, as it always has.
  return layout(chrome, { title, path: info.path || '/', main, noindex: /^\/u\//.test(info.path || ''), backlink: settingsOf(owner).website })
    .replace(/<title>[^<]*<\/title>/, () => `<title>${esc(title)}${ws ? ` · ${esc(ws.name)}` : ''}</title>`);
};

// Public form paths remember their request's base and origin for page().
for (const path of ['/p/*', '/n/*', '/v/*', '/u/*', '/e/*', '/d/*']) {
  app.use(path, (c, next) => reqInfo.run({
    base: onSiteHost(c) ? '' : '/site', origin: originOf(c), path: c.req.path,
  }, next));
}

const loadWs = async (db, slug) => {
  const ws = (await db.query(
    'select id, name, slug, jurisdiction, settings from workspaces where slug = $1', [slug],
  )).rows[0];
  if (ws) ws.settings = settingsOf(ws);
  return ws;
};

// A petition signature (plus the newsletter opt-in, when ticked) as one action.
const signPetition = (db, ws, pet, { name, email, phone, address, wantsNews }) =>
  publicAction(db, ws, 'public.sign', async (tx, emit) => {
    const id = newId();
    await tx.query(
      `insert into petition_signatures (id, workspace_id, petition_id, name, email, phone, address, subscribe) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, ws.id, pet.id, name, email || null, phone || null, address || null, wantsNews],
    );
    emit('petition_signature', id, 'create', {
      petition_id: pet.id, petition: pet.slug, name, email: email ? email.toLowerCase() : null,
      phone: phone || null, address: address || null, subscribe: wantsNews,
    });
    if (wantsNews && email) await subscribeTx(tx, emit, ws, email, name, `petition:${pet.slug}`);
    return { id };
  });

// Petitions by slug, open or closed: a closed one answers "closed", not "not found".
const loadPetition = async (db, ws, slug) => (await db.query(
  'select * from petitions where workspace_id = $1 and slug = $2', [ws.id, slug],
)).rows[0];
const closedPage = (ws, pet) => page(ws, pet.title, `<h1>${esc(pet.title)}</h1><div class="done">This petition is closed.</div>`);

const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// Accept either form-encoded or JSON bodies.
const readBody = async (c) => {
  const ct = c.req.header('content-type') || '';
  if (ct.includes('application/json')) return c.req.json().catch(() => ({}));
  // all: a form with several ticked roles posts roles=a&roles=b — keep them all.
  const form = await c.req.parseBody({ all: true }).catch(() => ({}));
  return form;
};

// ── Petition ──
app.get('/p/:ws/:slug', async (c) => {
  const db = await getDb();
  const ws = await loadWs(db, c.req.param('ws'));
  if (!ws) return c.text('not found', 404);
  const pet = await loadPetition(db, ws, c.req.param('slug'));
  if (!pet) return c.text('petition not found', 404);
  if (!pet.active) return c.html(closedPage(ws, pet), 410);
  const n = (await db.query('select count(*)::int as n from petition_signatures where petition_id = $1', [pet.id])).rows[0].n;
  return c.html(page(ws, pet.title, `
<h1>${esc(pet.title)}</h1>
${pet.body ? `<p>${esc(pet.body).replace(/\n/g, '<br>')}</p>` : ''}
<p class="big">${n} ${n === 1 ? 'signature' : 'signatures'}</p>
<form method="post">
  <label for="name">Your name</label><input id="name" name="name" required autocomplete="name">
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email">
  <label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel">
  <label for="address">Address</label><input id="address" name="address" autocomplete="street-address">
  <label class="check"><input type="checkbox" name="subscribe" value="1"> Email me updates</label>
  <button type="submit">Sign the petition</button>
</form>`));
});

app.post('/p/:ws/:slug', async (c) => {
  if (limited(ipOf(c))) return c.text('too many requests', 429);
  const db = await getDb();
  const ws = await loadWs(db, c.req.param('ws'));
  if (!ws) return c.text('not found', 404);
  const pet = await loadPetition(db, ws, c.req.param('slug'));
  if (!pet) return c.text('petition not found', 404);
  const wantsJson = (c.req.header('accept') || '').includes('application/json');
  if (!pet.active) return wantsJson ? c.json({ error: 'this petition is closed' }, 410) : c.html(closedPage(ws, pet), 410);
  const b = await readBody(c);
  const name = str(b.name); const email = str(b.email, 320); const phone = str(b.phone, 40); const address = str(b.address, 400);
  if (!name) return c.text('name required', 400);
  if (email && !emailOk(email)) return c.text('invalid email', 400);
  const wantsNews = b.subscribe === '1' || b.subscribe === true || b.subscribe === 'true';
  await signPetition(db, ws, pet, { name, email, phone, address, wantsNews });
  await upsertPersonFromPublic(db, ws, { name, email, phone, address }, ['petition', `petition:${pet.slug}`]);
  if (wantsJson) return c.json({ ok: true });
  return c.html(page(ws, pet.title, `<h1>Thank you, ${esc(name.split(' ')[0])}.</h1><div class="done">Your signature on <b>${esc(pet.title)}</b> is recorded.</div>`));
});

// ── Newsletter ──
app.get('/n/:ws', async (c) => {
  const db = await getDb();
  const ws = await loadWs(db, c.req.param('ws'));
  if (!ws) return c.text('not found', 404);
  return c.html(page(ws, 'Stay in the loop', `
<h1>Stay in the loop.</h1>
<form method="post">
  <label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email">
  <label for="name">Your name</label><input id="name" name="name" autocomplete="name">
  <button type="submit">Subscribe</button>
</form>
<p class="note">We count opens and clicks in our emails.</p>`));
});

app.post('/n/:ws', async (c) => {
  if (limited(ipOf(c))) return c.text('too many requests', 429);
  const db = await getDb();
  const ws = await loadWs(db, c.req.param('ws'));
  if (!ws) return c.text('not found', 404);
  const b = await readBody(c);
  const email = str(b.email, 320); const name = str(b.name);
  if (!emailOk(email)) return c.text('valid email required', 400);
  await subscribe(db, ws, email, name, 'signup-page');
  if (name) await upsertPersonFromPublic(db, ws, { name, email }, ['newsletter']);
  if ((c.req.header('accept') || '').includes('application/json')) return c.json({ ok: true });
  // Only what happened: the address is on the list. Whether and when the
  // campaign writes depends on email being connected, so this promises nothing.
  return c.html(page(ws, 'Subscribed', `<h1>You're on the list.</h1><div class="done"><b>${esc(email)}</b> is on the newsletter list.</div>`));
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const badUnsubscribe = (c) => c.html(page(null, 'Unsubscribe',
  `<h1>This unsubscribe link isn't valid — reply to the email to be removed.</h1>`), 404);

// The link in every newsletter. Opening it only asks (mail scanners open
// links by themselves); the one button — or a mail app's one-click
// unsubscribe (List-Unsubscribe-Post) — sends the POST that does it.
const loadSub = async (db, sid) => {
  if (!UUID.test(sid)) return null;
  const row = (await db.query(
    'select s.id, s.status, s.workspace_id, w.name, w.slug, w.settings from subscriptions s join workspaces w on w.id = s.workspace_id where s.id = $1',
    [sid],
  )).rows[0];
  return row ? { row, ws: { id: row.workspace_id, name: row.name, slug: row.slug, settings: row.settings } } : null;
};
const unsubscribedPage = (c, ws) => c.html(page(ws, 'Unsubscribed', `<h1>Unsubscribed.</h1><div class="done">You won't receive further newsletters from ${esc(ws.name)}.</div>`));

app.get('/u/:id', async (c) => {
  const found = await loadSub(await getDb(), c.req.param('id'));
  if (!found) return badUnsubscribe(c);
  if (found.row.status === 'unsubscribed') return unsubscribedPage(c, found.ws);
  return c.html(page(found.ws, 'Unsubscribe', `<h1>Unsubscribe from ${esc(found.ws.name)}?</h1>
<form method="post" action="/u/${esc(found.row.id)}"><button type="submit">Unsubscribe</button></form>`));
});

app.post('/u/:id', async (c) => {
  const db = await getDb();
  const found = await loadSub(db, c.req.param('id'));
  if (!found) return badUnsubscribe(c);
  const { row, ws } = found;
  // A second click finds them already off the list: nothing to write or log.
  await publicAction(db, ws, 'public.unsubscribe', async (tx, emit) => {
    const n = await tx.query(
      `update subscriptions set status = 'unsubscribed', unsubscribed_at = now()
       where id = $1 and workspace_id = $2 and status <> 'unsubscribed'`,
      [row.id, ws.id],
    );
    if (n.affectedRows > 0) emit('subscription', row.id, 'update', { status: 'unsubscribed', source: 'unsubscribe-link' });
  });
  return unsubscribedPage(c, ws);
});

// ── Volunteer signup ──
// Six plain choices up front; the rest under "More ways to help". Campaign
// words get a short gloss. A role with a detail (building, language,
// community) shows one line for it once it's ticked.
const FIRST_ROLES = ['doorknocking', 'phoning', 'highrise_captain', 'zone_house_captain', 'translation', 'driver'];
const GLOSS = {
  driver: 'drive voters to vote',
  scrutineer: 'watch the vote count',
  mainstreeting: 'meet people on the street',
  zone_house_captain: 'look after your street',
  highrise_captain: 'look after your building',
  burmashave: 'roadside sign waving',
};
const roleBox = (r) => `<div class="role"><label class="check"><input type="checkbox" name="roles" value="${r.code}"><span>${esc(r.label)}${GLOSS[r.code] ? `<span class="gl">${esc(GLOSS[r.code])}</span>` : ''}</span></label>${r.detail
  ? `<div class="rd"><label for="detail_${r.code}">${esc(r.detail)}</label><input id="detail_${r.code}" name="detail_${r.code}" maxlength="200"></div>` : ''}</div>`;
const roleBoxes = () => {
  const first = FIRST_ROLES.map((c) => VOLUNTEER_ROLES.find((r) => r.code === c)).filter(Boolean);
  const rest = VOLUNTEER_ROLES.filter((r) => !FIRST_ROLES.includes(r.code));
  return `<div class="roles">${first.map(roleBox).join('')}</div>
  <details><summary>More ways to help</summary><div class="roles">${rest.map(roleBox).join('')}</div></details>`;
};

app.get('/v/:ws', async (c) => {
  const db = await getDb();
  const ws = await loadWs(db, c.req.param('ws'));
  if (!ws) return c.text('not found', 404);
  return c.html(page(ws, 'Volunteer', `
<h1>Volunteer with us.</h1>
<form method="post">
  <label for="name">Your name</label><input id="name" name="name" required autocomplete="name">
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email">
  <label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel">
  <label for="address">Address</label><input id="address" name="address" autocomplete="street-address">
  <fieldset><legend>How can you help?</legend>${roleBoxes()}</fieldset>
  <label for="note">Anything else?</label><textarea id="note" name="note" rows="3" placeholder="When you're free"></textarea>
  <button type="submit">Sign me up</button>
</form>`));
});

// The thank-you names what they ticked: "doorknocking, phoning and being a
// hi-rise building captain".
const HELP_WORDS = {
  driver: 'driving voters',
  scrutineer: 'scrutineering',
  event_hosting: 'hosting an event',
  zone_house_captain: 'being a zone house captain',
  highrise_captain: 'being a hi-rise building captain',
  food: 'helping with food',
  translation: 'translating',
  community_committee: 'the community committee',
  burmashave: 'sign waving',
};
const helpWords = (roles) => {
  const words = roles.map((code) => HELP_WORDS[code]
    || (VOLUNTEER_ROLES.find((r) => r.code === code)?.label || code).toLowerCase());
  if (words.length === 0) return 'volunteering';
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
};

const asList = (v) => Array.from(new Set((Array.isArray(v) ? v : v ? [v] : []).map(String).filter((r) => VOLUNTEER_ROLE_CODES.includes(r))));
const ROLE_HAS_DETAIL = new Set(VOLUNTEER_ROLES.filter((r) => r.detail).map((r) => r.code));

// Each ticked role keeps its own detail (detail_<code>: building, language,
// community); the free "Anything else?" note is kept once, on the person.
// One action for the lot; a signup that ticked nothing and wrote no note has
// nothing to save beyond the person (logged by 'public.signup').
const saveVolunteer = async (db, ws, personId, b) => {
  const roles = asList(b.roles);
  const note = str(b.note, 2000);
  if (!roles.length && !note) return roles;
  await publicAction(db, ws, 'public.volunteer', async (tx, emit) => {
    for (const role of roles) {
      const id = newId();
      const detail = (ROLE_HAS_DETAIL.has(role) ? str(b[`detail_${role}`], 200) : '') || null;
      await tx.query(
        'insert into volunteer_roles (id, workspace_id, person_id, role, detail) values ($1, $2, $3, $4, $5)',
        [id, ws.id, personId, role, detail],
      );
      emit('volunteer_role', id, 'create', { id, person_id: personId, role, detail, source: 'public' });
    }
    if (note) {
      const row = (await tx.query(
        `update persons set attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{note}',
           to_jsonb(case when coalesce(attrs->>'note', '') = '' then $3::text else (attrs->>'note') || chr(10) || $3::text end)),
           updated_at = now()
         where id = $1 and workspace_id = $2
         returning attrs->>'note' as note`,
        [personId, ws.id, note],
      )).rows[0];
      if (row) emit('person', personId, 'update', { note: row.note, added_note: note, source: 'public' });
    }
  });
  return roles;
};

app.post('/v/:ws', async (c) => {
  if (limited(ipOf(c))) return c.text('too many requests', 429);
  const db = await getDb();
  const ws = await loadWs(db, c.req.param('ws'));
  if (!ws) return c.text('not found', 404);
  const b = await readBody(c);
  const name = str(b.name); const email = str(b.email, 320); const phone = str(b.phone, 40); const address = str(b.address, 400);
  if (!name) return c.text('name required', 400);
  if (email && !emailOk(email)) return c.text('invalid email', 400);
  const { id } = await upsertPersonFromPublic(db, ws, { name, email, phone, address }, ['volunteer-prospect']);
  const roles = await saveVolunteer(db, ws, id, b);
  if ((c.req.header('accept') || '').includes('application/json')) return c.json({ ok: true });
  return c.html(page(ws, 'Thank you', `<h1>Thank you, ${esc(name.split(' ')[0])}.</h1><div class="done">We'll be in touch about ${esc(helpWords(roles))}.</div>`));
});

// ── Events + RSVP ──
const fmtWhen = (d, tz = 'America/Vancouver') => new Date(d).toLocaleString('en-CA', {
  weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz,
});
const loadEvent = async (db, ws, slug) => (await db.query(
  `select e.*, coalesce((select sum(1 + r.guests) from event_rsvps r where r.event_id = e.id and r.status <> 'cancelled'), 0)::int as going
   from campaign_events e where e.workspace_id = $1 and e.slug = $2 and e.deleted_at is null and e.public`,
  [ws.id, slug],
)).rows[0];

const rsvp = async (db, ws, ev, { name, email, phone, guests }) => {
  const g = Math.min(Math.max(Number(guests) || 0, 0), 10);
  if (ev.capacity && ev.going + 1 + g > ev.capacity) return { full: true };
  const { id: personId } = await upsertPersonFromPublic(db, ws, { name, email, phone }, ['event', `event:${ev.slug}`]);
  return publicAction(db, ws, 'public.rsvp', async (tx, emit) => {
    // Count again under the workspace lock: two RSVPs for the last seats
    // can't both land.
    if (ev.capacity) {
      const going = (await tx.query(
        `select coalesce(sum(1 + guests), 0)::int as n from event_rsvps where event_id = $1 and status <> 'cancelled'`, [ev.id],
      )).rows[0].n;
      if (going + 1 + g > ev.capacity) return { full: true };
    }
    const id = newId();
    await tx.query(
      `insert into event_rsvps (id, workspace_id, event_id, person_id, name, email, phone, guests) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, ws.id, ev.id, personId, name, email || null, phone || null, g],
    );
    emit('rsvp', id, 'create', {
      event_id: ev.id, event: ev.slug, person_id: personId, name, email: email || null, phone: phone || null, guests: g, status: 'going',
    });
    return { ok: true, id };
  });
};

app.get('/e/:ws/:slug', async (c) => {
  const db = await getDb();
  const ws = await loadWs(db, c.req.param('ws'));
  if (!ws) return c.text('not found', 404);
  const ev = await loadEvent(db, ws, c.req.param('slug'));
  if (!ev) return c.text('event not found', 404);
  const tz = ws.settings.tz || 'America/Vancouver';
  const full = ev.capacity && ev.going >= ev.capacity;
  const past = new Date(ev.starts_at) < new Date();
  // The picture the website gives this event (Website → Events), if any.
  const pic = (await db.query('select image from site_event_extras where event_id = $1', [ev.id])).rows[0]?.image;
  return c.html(page(ws, ev.title, `
${pic ? `<div class="ev-img">${img(pic, '', { eager: true })}</div>` : ''}
<div class="ev" style="padding:0;margin-bottom:8px">${dateTile(ev.starts_at, tz)}<div>
<h1>${esc(ev.title)}</h1>
<p class="when">${esc(fmtWhen(ev.starts_at, tz))}</p>
${ev.location ? `<p>${esc(ev.location)}</p>` : ''}
</div></div>
${ev.description ? `<div class="prose">${renderMarkdown(ev.description)}</div>` : ''}
${past ? '<div class="done">This event has already happened.</div>'
  : full ? '<div class="done">This event is full.</div>'
  : `<form method="post">
  <label for="name">Your name</label><input id="name" name="name" required autocomplete="name">
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email">
  <label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel">
  <label for="guests">Bringing guests?</label>
  <select id="guests" name="guests">${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n === 0 ? 'Just me' : `+${n}`}</option>`).join('')}</select>
  <button type="submit">RSVP</button>
</form>`}`));
});

app.post('/e/:ws/:slug', async (c) => {
  if (limited(ipOf(c))) return c.text('too many requests', 429);
  const db = await getDb();
  const ws = await loadWs(db, c.req.param('ws'));
  if (!ws) return c.text('not found', 404);
  const ev = await loadEvent(db, ws, c.req.param('slug'));
  if (!ev || new Date(ev.starts_at) < new Date()) return c.text('event not found', 404);
  const b = await readBody(c);
  const name = str(b.name); const email = str(b.email, 320); const phone = str(b.phone, 40);
  if (!name) return c.text('name required', 400);
  if (email && !emailOk(email)) return c.text('invalid email', 400);
  const r = await rsvp(db, ws, ev, { name, email, phone, guests: b.guests });
  const json = (c.req.header('accept') || '').includes('application/json');
  if (r.full) return json ? c.json({ error: 'this event is full' }, 409) : c.html(page(ws, ev.title, '<h1>Sorry — this event is full.</h1>'), 409);
  if (json) return c.json({ ok: true });
  return c.html(page(ws, ev.title, `<h1>You're in, ${esc(name.split(' ')[0])}.</h1><div class="done"><b>${esc(ev.title)}</b><br>${esc(fmtWhen(ev.starts_at, ws.settings.tz))}${ev.location ? `<br>${esc(ev.location)}` : ''}</div>`));
});

// ── Donations ──
// BC rules (verify with Elections BC for the current cycle): contributions only
// from eligible individuals — BC residents who are Canadian citizens or
// permanent residents — from their own funds; name and address recorded.
const ATTESTATIONS = [
  ['individual', 'I am an individual (not a business, union, or organization).'],
  ['resident', 'I live in British Columbia and am a Canadian citizen or permanent resident.'],
  ['own_funds', 'This contribution is from my own funds and I will not be reimbursed.'],
];
const PRESETS = [2500, 5000, 10000, 25000, 50000, 100000];
const dollars = (c2) => `$${(c2 / 100).toLocaleString('en-CA', { minimumFractionDigits: c2 % 100 ? 2 : 0 })}`;
const publicBase = (c) => (process.env.STARBASE_PUBLIC_URL || new URL(c.req.url).origin).replace(/\/$/, '');

const donateForm = (ws, cap, err = '', v = {}) => {
  const card = stripeConfigured();
  return `
<h1>Donate</h1>
<p>${card ? 'Secure card payment by Stripe.' : esc(ws.settings.donateInstructions || 'Pledge now and the campaign will contact you to complete your contribution by e-transfer or cheque.')}</p>
${err ? `<div class="done err" role="alert">${esc(err)}</div>` : ''}
<form method="post">
  <fieldset><legend>Amount</legend>
  <div class="checks amounts">${PRESETS.map((a) => `<label class="check"><input type="radio" name="amount" value="${a / 100}" ${String(v.amount) === String(a / 100) ? 'checked' : ''}> ${dollars(a)}</label>`).join('')}</div>
  </fieldset>
  <label for="other">Other amount ($)</label><input id="other" name="other" inputmode="decimal" value="${esc(v.other || '')}">
  <label class="check"><input type="checkbox" name="monthly" value="1" ${v.monthly ? 'checked' : ''}> Make it monthly</label>
  <label for="name">Full name</label><input id="name" name="name" required autocomplete="name" value="${esc(v.name || '')}">
  <label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email" value="${esc(v.email || '')}">
  <label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel" value="${esc(v.phone || '')}">
  <label for="address">Home address</label><input id="address" name="address" required autocomplete="street-address" value="${esc(v.address || '')}">
  <fieldset><legend>Eligibility</legend>
  ${ATTESTATIONS.map(([k, t]) => `<label class="check attest"><input type="checkbox" name="attest_${k}" value="1" required> ${esc(t)}</label>`).join('')}
  </fieldset>
  ${cap ? `<p class="note">The annual limit is ${dollars(cap)} per contributor, including monthly gifts.</p>` : ''}
  <button type="submit">${card ? 'Continue to payment' : 'Pledge my contribution'}</button>
</form>`;
};

app.get('/d/:ws', async (c) => {
  const db = await getDb();
  const ws = await loadWs(db, c.req.param('ws'));
  if (!ws) return c.text('not found', 404);
  const rule = await capFor(db, ws.jurisdiction, new Date().getUTCFullYear(), ws.settings);
  return c.html(page(ws, 'Contribute', donateForm(ws, rule?.capCents)));
});

app.post('/d/:ws', async (c) => {
  if (limited(ipOf(c))) return c.text('too many requests', 429);
  const db = await getDb();
  const ws = await loadWs(db, c.req.param('ws'));
  if (!ws) return c.text('not found', 404);
  const b = await readBody(c);
  const v = { amount: str(b.amount, 12), other: str(b.other, 12), monthly: b.monthly === '1' || b.monthly === true,
    name: str(b.name), email: str(b.email, 320), phone: str(b.phone, 40), address: str(b.address, 400) };
  const year = new Date().getUTCFullYear();
  const rule = await capFor(db, ws.jurisdiction, year, ws.settings);
  const fail = (msg) => c.html(page(ws, 'Contribute', donateForm(ws, rule?.capCents, msg, v)), 400);

  const raw = v.other || v.amount;
  const cents = Math.round(Number.parseFloat(String(raw).replace(/[$,\s]/g, '')) * 100);
  const attested = ATTESTATIONS.every(([k]) => b[`attest_${k}`] === '1' || b[`attest_${k}`] === true);
  const base = publicBase(c);
  const r = await startDonation(db, ws, { ...v, cents }, attested, {
    ip: ipOf(c), successUrl: `${base}/d/${ws.slug}/thanks`, cancelUrl: `${base}/d/${ws.slug}`,
  });
  if (r.fail) return fail(r.fail);
  if (r.url) return c.redirect(r.url, 303);
  return c.html(page(ws, 'Thank you', `<h1>Thank you, ${esc(v.name.split(' ')[0])}.</h1>
<div class="done">Your ${v.monthly ? 'monthly ' : ''}pledge of <b>${dollars(cents)}</b> is recorded.
${esc(ws.settings.donateInstructions || 'The campaign will be in touch to complete it by e-transfer or cheque.')}</div>`));
});

// One contribution, from the donate page or the website's JSON: the checks,
// the person, the pledge, and Stripe Checkout when it is connected. Answers
// { fail } (a sentence for the contributor), { url } (Stripe's page), or
// { pledged: true } (no card payment: the campaign follows up).
const startDonation = async (db, ws, v, attested, { ip, successUrl, cancelUrl, subscribeToo = false }) => {
  const year = new Date().getUTCFullYear();
  const rule = await capFor(db, ws.jurisdiction, year, ws.settings);
  const cents = v.cents;
  if (!Number.isFinite(cents) || cents < 100) return { fail: 'Choose an amount of at least $1.', field: 'amount' };
  if (!v.name || !v.address) return { fail: 'Your full name and home address are required by election law.', field: !v.name ? 'name' : 'address' };
  if (!emailOk(v.email)) return { fail: 'A valid email is required so the campaign can confirm your contribution.', field: 'email' };
  if (!attested) return { fail: 'Please confirm each eligibility statement — only eligible individuals may contribute.', field: 'attest' };

  // Cap pre-check against this person's gifts so far this year (by email).
  if (rule) {
    if (cents > rule.capCents) return { fail: `The most one person can give this year is ${dollars(rule.capCents)}.`, field: 'amount' };
    const known = (await db.query(
      'select id from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null limit 1',
      [ws.id, v.email.toLowerCase()],
    )).rows[0];
    if (known) {
      const so = await donorYearTotal(db, ws.id, known.id, year);
      if (so + cents > rule.capCents) {
        const left = Math.max(rule.capCents - so, 0);
        return { fail: left > 0
          ? `Thank you — you can contribute up to ${dollars(left)} more this year under the annual limit.`
          : `Thank you — you've reached this year's ${dollars(rule.capCents)} limit.`, field: 'amount' };
      }
    }
  }

  const { id: personId } = await upsertPersonFromPublic(db, ws,
    { name: v.name, email: v.email, phone: v.phone, address: v.address }, ['donor']);
  if (subscribeToo) await subscribe(db, ws, v.email, v.name, 'donation');
  const cadence = v.monthly ? 'monthly' : 'one-time';
  // The attestation (what was ticked, when, from where) is part of the record
  // and of its event, so the log shows the contributor declared eligibility.
  const attest = { ...Object.fromEntries(ATTESTATIONS.map(([k]) => [k, true])), at: new Date().toISOString(), ip };
  const pledgeId = await publicAction(db, ws, 'public.pledge', async (tx, emit) => {
    const id = newId();
    const status = stripeConfigured() ? 'pending' : 'pledged';
    await tx.query(
      `insert into pledges (id, workspace_id, person_id, name, email, phone, address, amount_cents, cadence, status, attest)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, ws.id, personId, v.name, v.email.toLowerCase(), v.phone || null, v.address, cents,
       cadence, status, JSON.stringify(attest)],
    );
    emit('pledge', id, 'create', {
      person_id: personId, name: v.name, email: v.email.toLowerCase(), phone: v.phone || null, address: v.address,
      amount_cents: cents, cadence, status, attest, source: 'donate-page',
    });
    return id;
  });

  if (stripeConfigured()) {
    try {
      const session = await createCheckoutSession({
        pledge: { id: pledgeId, amount_cents: cents, cadence, email: v.email },
        workspace: ws, successUrl, cancelUrl,
      });
      await publicAction(db, ws, 'stripe.checkout', async (tx, emit) => {
        await tx.query('update pledges set stripe_session_id = $3, updated_at = now() where id = $1 and workspace_id = $2',
          [pledgeId, ws.id, session.id]);
        emit('pledge', pledgeId, 'update', { stripe_session_id: session.id });
      });
      return { url: session.url, pledge_id: pledgeId };
    } catch (e) {
      return { fail: `Card payment isn't available right now (${String(e.message).slice(0, 120)}). Please try again shortly.`, field: null };
    }
  }
  return { pledged: true, pledge_id: pledgeId };
};

app.get('/d/:ws/thanks', async (c) => {
  const db = await getDb();
  const ws = await loadWs(db, c.req.param('ws'));
  if (!ws) return c.text('not found', 404);
  return c.html(page(ws, 'Thank you', `<h1>Thank you.</h1><div class="done">Your contribution to ${esc(ws.name)} is being processed. Stripe emails the payment receipt.</div>`));
});

// Stripe → gifts. One-time: checkout.session.completed (paid). Monthly: every
// invoice.paid. Each delivery applies once (stripe_events), and every payment
// enters the books through logGift, so the cap check always runs.
app.post('/api/public/stripe/webhook', async (c) => {
  const raw = await c.req.text();
  if (!verifyStripeSignature(raw, c.req.header('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET)) {
    return c.json({ error: 'bad signature' }, 400);
  }
  const evt = JSON.parse(raw);
  const obj = evt.data?.object || {};
  if (evt.type === 'charge.refunded') return refundWebhook(c, evt, obj);
  if (obj.metadata?.store_order) return storeWebhook(c, evt, obj);
  const meta = obj.metadata?.pledge_id ? obj.metadata
    : obj.subscription_details?.metadata?.pledge_id ? obj.subscription_details.metadata
    : obj.parent?.subscription_details?.metadata?.pledge_id ? obj.parent.subscription_details.metadata
    : obj.lines?.data?.[0]?.metadata?.pledge_id ? obj.lines.data[0].metadata
    : null;
  if (!meta) return c.json({ ok: true, ignored: 'no pledge metadata' });
  const db = await getDb();
  const ws = (await db.query('select id, name, slug, jurisdiction, settings from workspaces where id = $1', [meta.workspace_id])).rows[0];
  if (!ws) return c.json({ ok: true, ignored: 'unknown workspace' });
  ws.settings = settingsOf(ws);

  const paidOneTime = evt.type === 'checkout.session.completed' && obj.mode === 'payment' && obj.payment_status === 'paid';
  const paidMonthly = evt.type === 'invoice.paid';
  const subStarted = evt.type === 'checkout.session.completed' && obj.mode === 'subscription';
  if (!paidOneTime && !paidMonthly && !subStarted) return c.json({ ok: true, ignored: evt.type });

  const { result } = await runAction(db, { workspaceId: ws.id, actorId: null, action: 'stripe.payment' }, async (tx, emit) => {
    const fresh = await tx.query('insert into stripe_events (id, workspace_id, type) values ($1, $2, $3) on conflict do nothing',
      [evt.id, ws.id, evt.type]);
    if (fresh.affectedRows === 0) return { duplicate: true };
    const pledge = (await tx.query('select * from pledges where id = $1 and workspace_id = $2 for update', [meta.pledge_id, ws.id])).rows[0];
    if (!pledge) return { ignored: 'unknown pledge' };
    if (subStarted) {
      await tx.query(`update pledges set status = 'paid', updated_at = now() where id = $1`, [pledge.id]);
      emit('pledge', pledge.id, 'update', { status: 'paid', subscription: obj.subscription || null });
      return { subscription: true };
    }
    const cents = paidOneTime ? Number(obj.amount_total) : Number(obj.amount_paid);
    const paidAt = new Date(((paidMonthly ? obj.status_transitions?.paid_at : obj.created) || evt.created) * 1000);
    // The campaign's calendar day, not the UTC one: a card gift at 7:30 pm
    // Pacific on Oct 21 is dated Oct 21 (and Dec 31 stays in its own year).
    const date = campaignDay(paidAt, ws.settings.tz);
    // pledge_id links each card gift to its pledge (as pledge.receive does), so
    // voiding one keeps the pledge honest (lib/gifts.js).
    const { gift, compliance } = await logGift(tx, ws, {
      person_id: pledge.person_id, amount_cents: cents, date,
      method: 'card', cadence: pledge.cadence, note: `Stripe ${paidOneTime ? obj.payment_intent || obj.id : obj.id}`,
      pledge_id: pledge.id,
    }, emit);
    if (pledge.cadence === 'monthly') {
      // A monthly pledge records its latest month in, like pledge.receive.
      const row = (await tx.query(
        `update pledges set status = 'paid',
           gift_id = case when last_received_on is null or $3::date >= last_received_on then $2 else gift_id end,
           last_received_on = greatest(coalesce(last_received_on, $3::date), $3::date), updated_at = now()
         where id = $1 returning gift_id, last_received_on`,
        [pledge.id, gift.id, date],
      )).rows[0];
      const lastOn = row.last_received_on instanceof Date ? row.last_received_on.toISOString().slice(0, 10) : String(row.last_received_on).slice(0, 10);
      emit('pledge', pledge.id, 'update', { status: 'paid', gift_id: row.gift_id, last_received_on: lastOn });
    } else {
      const row = (await tx.query(
        `update pledges set status = 'paid', gift_id = coalesce(gift_id, $2), updated_at = now() where id = $1 returning gift_id`,
        [pledge.id, gift.id],
      )).rows[0];
      emit('pledge', pledge.id, 'update', { status: 'paid', gift_id: row.gift_id });
    }
    return { gift_id: gift.id, flagged: gift.flagged, compliance };
  });
  return c.json({ ok: true, ...result });
});

// The website's store (ext/website/store.js): a finished checkout pays its
// order — once, however often Stripe retries (stripe_events, then the
// order's own status) — takes the items out of stock and puts the buyer in
// People (tag 'store'). An abandoned checkout cancels its unpaid order.
//   store.payment   checkout.session.completed   store_order update, person create/update
//   store.expire    checkout.session.expired     store_order update
const storeWebhook = async (c, evt, obj) => {
  const paid = evt.type === 'checkout.session.completed' || evt.type === 'checkout.session.async_payment_succeeded';
  const expired = evt.type === 'checkout.session.expired';
  if (!paid && !expired) return c.json({ ok: true, ignored: evt.type });
  const db = await getDb();
  const ws = (await db.query('select id, name, slug, settings from workspaces where id = $1', [obj.metadata.workspace_id])).rows[0];
  if (!ws) return c.json({ ok: true, ignored: 'unknown workspace' });
  const { result } = await runAction(db, { workspaceId: ws.id, actorId: null, action: paid ? 'store.payment' : 'store.expire' }, async (tx, emit) => {
    const fresh = await tx.query('insert into stripe_events (id, workspace_id, type) values ($1, $2, $3) on conflict do nothing',
      [evt.id, ws.id, evt.type]);
    if (fresh.affectedRows === 0) return { duplicate: true };
    return paid ? applyStorePayment(tx, emit, ws, obj, { upsertPersonTx }) : expireStoreOrder(tx, emit, ws, obj);
  });
  return c.json({ ok: true, ...result });
};

// store.refund    charge.refunded             store_order update
// stripe.refund   charge.refunded             gift void (+ pledge, receipt)
// A charge carries no order or pledge id, so what it paid for is found by
// the reference the paid webhook kept: a store order's payment intent, or a
// gift's note ("Stripe <payment intent>" for a one-time gift, "Stripe
// <invoice>" for a monthly one). A gift refunded in full leaves the books
// as a hand void does (lib/gifts.js: its pledge reopens or its month is
// forgotten; ext/receipts voids its receipt); a partial refund is noted on
// the gift and nothing else moves — the treasurer decides.
const claimEvent = async (tx, evt, wsId) => (await tx.query(
  'insert into stripe_events (id, workspace_id, type) values ($1, $2, $3) on conflict do nothing', [evt.id, wsId, evt.type],
)).affectedRows > 0;
const refundWebhook = async (c, evt, obj) => {
  const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id;
  const invoice = typeof obj.invoice === 'string' ? obj.invoice : obj.invoice?.id;
  if (!pi && !invoice) return c.json({ ok: true, ignored: evt.type });
  const db = await getDb();
  // A delivery already applied (a voided gift is no longer found, so this
  // comes first); the claim inside the action still guards two at once.
  if ((await db.query('select 1 from stripe_events where id = $1', [evt.id])).rows.length) return c.json({ ok: true, duplicate: true });
  const refunded = Number(obj.amount_refunded) || 0;
  const full = obj.refunded === true || (Number(obj.amount) > 0 && refunded >= Number(obj.amount));

  const order = pi ? (await db.query('select id, workspace_id from store_orders where payment_intent = $1 limit 1', [pi])).rows[0] : null;
  if (order) {
    const ws = (await db.query('select id, name, slug, settings from workspaces where id = $1', [order.workspace_id])).rows[0];
    const { result } = await runAction(db, { workspaceId: ws.id, actorId: null, action: 'store.refund' }, async (tx, emit) => {
      if (!(await claimEvent(tx, evt, ws.id))) return { duplicate: true };
      return refundStoreOrder(tx, emit, ws, order.id, obj);
    });
    return c.json({ ok: true, ...result });
  }

  const refs = [pi && `Stripe ${pi}`, invoice && `Stripe ${invoice}`].filter(Boolean);
  const gift = (await db.query(
    // The reference is the note's first part: a partial refund adds to it.
    `select id, workspace_id, note from gifts where split_part(note, ' · ', 1) = any($1::text[]) and deleted_at is null limit 1`, [refs],
  )).rows[0];
  if (!gift) return c.json({ ok: true, ignored: 'nothing of ours for this charge' });
  const { result } = await runAction(db, { workspaceId: gift.workspace_id, actorId: null, action: 'stripe.refund' }, async (tx, emit) => {
    if (!(await claimEvent(tx, evt, gift.workspace_id))) return { duplicate: true };
    const note = `${gift.note} · ${full ? 'Refunded' : 'Partly refunded'} in Stripe (${dollars(refunded)})`;
    await tx.query('update gifts set note = $3 where id = $1 and workspace_id = $2', [gift.id, gift.workspace_id, note]);
    if (!full) {
      emit('gift', gift.id, 'update', { note, refunded_cents: refunded, partial: true, stripe: true });
      return { gift_id: gift.id, partial: refunded };
    }
    const v = await voidGift(tx, gift.workspace_id, gift.id, emit);
    return { gift_id: gift.id, voided: true, pledge: v.pledge };
  });
  return c.json({ ok: true, ...result });
};

// ── Website bridge: JSON endpoint for the campaign site's own forms ──
app.options('/api/public/:ws/signup', (c) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  return c.body(null, 204);
});

app.post('/api/public/:ws/signup', async (c) => {
  c.header('Access-Control-Allow-Origin', '*');
  if (limited(ipOf(c))) return c.json({ error: 'too many requests' }, 429);
  const db = await getDb();
  const ws = await loadWs(db, c.req.param('ws'));
  if (!ws) return c.json({ error: 'unknown workspace' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const kind = str(b.kind, 20);
  const name = str(b.name); const email = str(b.email, 320); const phone = str(b.phone, 40); const address = str(b.address, 400);
  if (email && !emailOk(email)) return c.json({ error: 'invalid email' }, 400);

  if (kind === 'newsletter') {
    if (!emailOk(email)) return c.json({ error: 'email required' }, 400);
    await subscribe(db, ws, email, name, 'website');
    if (name) await upsertPersonFromPublic(db, ws, { name, email }, ['newsletter']);
    return c.json({ ok: true, kind });
  }
  if (kind === 'volunteer') {
    if (!name) return c.json({ error: 'name required' }, 400);
    const { id } = await upsertPersonFromPublic(db, ws, { name, email, phone, address }, ['volunteer-prospect']);
    await saveVolunteer(db, ws, id, b);
    return c.json({ ok: true, kind });
  }
  if (kind === 'petition') {
    const pet = await loadPetition(db, ws, str(b.petition, 60));
    if (!pet) return c.json({ error: 'unknown petition' }, 404);
    if (!pet.active) return c.json({ error: 'this petition is closed' }, 410);
    if (!name) return c.json({ error: 'name required' }, 400);
    // A website checkbox posts true, "1", "true" or "on"; "0"/"false" is a no.
    const wantsNews = [true, 1, '1', 'true', 'on', 'yes'].includes(b.subscribe);
    await signPetition(db, ws, pet, { name, email, phone, address, wantsNews });
    await upsertPersonFromPublic(db, ws, { name, email, phone, address }, ['petition', `petition:${pet.slug}`]);
    return c.json({ ok: true, kind });
  }
  if (kind === 'rsvp') {
    const ev = await loadEvent(db, ws, str(b.event, 60));
    if (!ev || new Date(ev.starts_at) < new Date()) return c.json({ error: 'unknown event' }, 404);
    if (!name) return c.json({ error: 'name required' }, 400);
    const r = await rsvp(db, ws, ev, { name, email, phone, guests: b.guests });
    if (r.full) return c.json({ error: 'this event is full' }, 409);
    return c.json({ ok: true, kind });
  }
  return c.json({ error: "kind must be 'newsletter', 'volunteer', 'petition', or 'rsvp'" }, 400);
});

// The website's own donate form: the same checks, person, pledge and Stripe
// Checkout as /d, answered as JSON. Stripe brings the contributor back to
// the site's own pages when `return` names them (hosts.js returnUrl: only
// the site's origins), else to Starbase's thank-you page.
//   { amount_cents | amount ("25" or "25.00"), monthly, name | first_name + last_name,
//     email, phone, address, city, postal, attest: { individual, resident, own_funds }
//     (or attest_individual…), subscribe, return: { success, cancel } }
//   → { url } (go to Stripe) · { ok, pledged: true } (no card payment yet)
//   · 400 { error, field }
const yes = (v) => [true, 1, '1', 'true', 'on', 'yes'].includes(v);
app.options('/api/public/:ws/donate', (c) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  return c.body(null, 204);
});
app.post('/api/public/:ws/donate', async (c) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Cache-Control', 'no-store');
  if (limited(ipOf(c))) return c.json({ error: 'too many requests' }, 429);
  const db = await getDb();
  const ws = await loadWs(db, c.req.param('ws'));
  if (!ws) return c.json({ error: 'unknown workspace' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const cents = Number.isInteger(b.amount_cents) ? b.amount_cents
    : Math.round(Number.parseFloat(String(b.amount ?? '').replace(/[$,\s]/g, '')) * 100);
  const name = str(b.name) || `${str(b.first_name, 80)} ${str(b.last_name, 80)}`.trim();
  const address = [str(b.address, 400), str(b.city, 80), str(b.postal || b.postal_code, 20)].filter(Boolean).join(', ');
  const v = { cents, monthly: yes(b.monthly), name, email: str(b.email, 320), phone: str(b.phone, 40), address };
  const at = b.attest && typeof b.attest === 'object' ? b.attest : {};
  const attested = ATTESTATIONS.every(([k]) => yes(at[k]) || yes(b[`attest_${k}`]));
  const base = publicBase(c);
  const ret = b.return && typeof b.return === 'object' ? b.return : {};
  const r = await startDonation(db, ws, v, attested, {
    ip: ipOf(c),
    successUrl: returnUrl(ret.success, `${base}/d/${ws.slug}/thanks`),
    cancelUrl: returnUrl(ret.cancel, `${base}/d/${ws.slug}`),
    subscribeToo: yes(b.subscribe),
  });
  if (r.fail) return c.json({ error: r.fail, ...(r.field ? { field: r.field } : {}) }, 400);
  if (r.url) return c.json({ url: r.url });
  return c.json({
    ok: true, pledged: true,
    instructions: ws.settings.donateInstructions || 'The campaign will be in touch to complete it by e-transfer or cheque.',
  });
});

export default app;
