// The site, headless: a website built elsewhere reads the campaign's
// content as JSON (drafts never show; pictures at their full address;
// Markdown as written and rendered) and sends every form here — signup
// kinds, the donate form, the store's checkout — with Stripe bringing
// people back to the site's own pages, and only to those.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.headless.${tag}@example.org`;
let db;
let mgr;
let slug;
let tee;

let ipN = 0;
const pub = async (method, path, body, headers = {}) => {
  ipN += 1;
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.${Math.floor(ipN / 250)}.0.1, 198.51.100.${ipN % 250}`, origin: 'https://imaginesurrey.test', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, json: ct.includes('json') ? await res.json() : null, text: ct.includes('json') ? '' : await res.text(), headers: res.headers };
};
const get = (path) => pub('GET', `/api/public/${slug}/site${path}`);

// Stripe stood in for: every Checkout Session asked for is kept.
const sessions = [];
const realFetch = globalThis.fetch;
const mockStripe = () => {
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://api.stripe.com/v1/checkout/sessions') {
      const params = new URLSearchParams(init.body);
      sessions.push(Object.fromEntries(params));
      return new Response(JSON.stringify({ id: `cs_${tag}_${sessions.length}`, url: `https://checkout.stripe.test/s/${sessions.length}` }), { status: 200 });
    }
    return realFetch(url, init);
  };
};

before(async () => {
  db = await freshDb();
  delete process.env.STRIPE_SECRET_KEY;
  process.env.STARBASE_SITE_ORIGINS = 'https://imaginesurrey.test';
  process.env.STARBASE_PUBLIC_URL = 'https://starbase.test';
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: 'Imagine Surrey', email: mail('manager'), jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  slug = r.json.workspace.slug;
  await mgr.get('/api/site/overview'); // the starter site
  await mgr.action('site.settings.save', { tagline: 'A city that works', contact_email: 'hello@imaginesurrey.test', socials: { instagram: 'https://instagram.com/imagine.surrey' }, authorized_by: 'Authorized by the financial agent', shipping: true, shipping_cents: 1200, pickup: true });
  await mgr.action('site.page.save', { slug: 'our-story', title: 'About us', body: '## Who we are\n\nA **coalition** <script>alert(1)</script>', published: true });
  await mgr.action('site.page.save', { slug: 'secret', title: 'Draft page', body: 'not yet', published: false });
  await mgr.action('site.post.save', { title: 'Transit plan unveiled', date: '2026-10-20', summary: 'Rail to South Surrey.', body: 'The **plan** is out.', published: true });
  await mgr.action('site.post.save', { title: 'Unpublished post', date: '2026-10-21', summary: 'x', body: 'y', published: false });
  await mgr.action('site.team.save', { name: 'Anne Blunt', role: 'President', bio: 'Leads the board.' });
  await mgr.action('site.team.save', { name: 'Hidden Person', role: 'x', published: false });
  await mgr.action('cevent.create', { slug: 'rally', title: 'Rally on Saturday', starts_at: '2030-05-02T19:00:00Z', location: 'Holland Park', description: 'Bring a **friend**.', capacity: 100 });
  await mgr.action('cevent.create', { slug: 'old-rally', title: 'Last year', starts_at: '2020-05-02T19:00:00Z' });
  await mgr.action('cevent.create', { slug: 'private', title: 'Board meeting', starts_at: '2030-05-03T19:00:00Z', public: false });
  await mgr.action('petition.create', { slug: 'skytrain', title: 'SkyTrain to South Surrey', body: 'Sign it.' });
  const closed = await mgr.action('petition.create', { slug: 'closed', title: 'Done', body: 'x' });
  assert.equal((await mgr.action('petition.update', { id: closed.json.petition.id, active: false })).status, 200);
  tee = (await mgr.action('store.product.save', {
    name: 'Campaign T-shirt', price_cents: 2500, description: 'Soft **cotton**.', track_stock: true,
    variants: [{ label: 'S', stock: 2 }, { label: 'M', stock: 0 }],
  })).json.product;
  await mgr.action('store.product.save', { name: 'Hidden mug', price_cents: 1500, active: false });
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STARBASE_SITE_ORIGINS;
  delete process.env.STARBASE_PUBLIC_URL;
});

test('GET /site: the campaign, its settings, links, published pages, people and open petitions; CORS-open; nothing for an unknown campaign', async () => {
  const r = await get('');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.ok(r.headers.get('etag'), 'revalidates by ETag');
  const j = r.json;
  assert.equal(j.campaign.slug, slug);
  assert.equal(j.site.tagline, 'A city that works');
  assert.equal(j.site.contact_email, 'hello@imaginesurrey.test');
  assert.equal(j.site.socials.instagram, 'https://instagram.com/imagine.surrey');
  assert.equal(j.site.authorized_by, 'Authorized by the financial agent');
  assert.equal(j.links.donate, `https://starbase.test/d/${slug}`);
  assert.equal(j.links.api, `https://starbase.test/api/public/${slug}`);
  assert.ok(j.pages.some((p) => p.slug === 'our-story') && !j.pages.some((p) => p.slug === 'secret' || p.slug === 'about'), 'drafts never show');
  assert.deepEqual(j.team.map((t) => t.name), ['Anne Blunt']);
  assert.deepEqual(j.petitions.map((p) => p.slug), ['skytrain']);
  assert.equal(j.store.open, false);
  assert.equal(j.store.ways.length, 2);
  assert.equal((await pub('GET', '/api/public/nobody/site')).status, 404);
  const pre = await pub('OPTIONS', `/api/public/${slug}/site/news`);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
});

test('pages and news: Markdown as written and rendered safely; drafts are not found; posts page', async () => {
  const p = await get('/pages/our-story');
  assert.equal(p.status, 200);
  assert.equal(p.json.page.title, 'About us');
  assert.match(p.json.page.html, /<h3>Who we are<\/h3>/);
  assert.match(p.json.page.html, /<strong>coalition<\/strong> &lt;script&gt;/, 'nothing typed reaches the page as a tag');
  assert.equal(p.json.page.body.includes('<script>'), true, 'the source is the source');
  assert.equal((await get('/pages/secret')).status, 404);
  assert.equal((await get('/pages/Not%20A%20Slug')).status, 404);
  const news = await get('/news?limit=10');
  assert.equal(news.status, 200);
  assert.deepEqual(news.json.posts.map((x) => x.slug), ['transit-plan-unveiled']);
  assert.equal(news.json.total, 1);
  assert.equal(news.json.posts[0].date, '2026-10-20');
  assert.equal(news.json.posts[0].cover_image, null);
  const one = await get('/news/transit-plan-unveiled');
  assert.equal(one.json.post.html, '<p>The <strong>plan</strong> is out.</p>');
  assert.equal(one.json.post.text, 'The plan is out.');
  assert.equal((await get('/news/unpublished-post')).status, 404);
});

test('events: upcoming public ones with their RSVP link and count; past ones on request; a private one never', async () => {
  const r = await get('/events');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.events.map((e) => e.slug), ['rally']);
  const ev = r.json.events[0];
  assert.equal(ev.rsvp_url, `https://starbase.test/e/${slug}/rally`);
  assert.equal(ev.going, 0);
  assert.equal(ev.full, false);
  assert.equal(ev.summary, 'Bring a friend.');
  const past = await get('/events?past=1');
  assert.deepEqual(past.json.events.map((e) => e.slug), ['old-rally']);
  assert.equal(past.json.events[0].past, true);
  assert.equal((await get('/events/private')).status, 404);
  const one = await get('/events/rally');
  assert.equal(one.json.event.html, '<p>Bring a <strong>friend</strong>.</p>');
  // An RSVP through the bridge counts.
  const rs = await pub('POST', `/api/public/${slug}/signup`, { kind: 'rsvp', event: 'rally', name: 'Priya Patel', email: mail('priya'), guests: 2 });
  assert.equal(rs.status, 200, JSON.stringify(rs.json));
  assert.equal((await get('/events/rally')).json.event.going, 3);
});

test('team, products and petitions: only what is published, open or active; what is left of each size', async () => {
  assert.deepEqual((await get('/team')).json.team.map((t) => [t.name, t.role]), [['Anne Blunt', 'President']]);
  const pr = await get('/products');
  assert.deepEqual(pr.json.products.map((p) => p.slug), ['campaign-t-shirt']);
  const t = pr.json.products[0];
  assert.deepEqual(t.variants, [{ label: 'S', left: 2 }, { label: 'M', left: 0 }]);
  assert.equal(t.sold_out, false);
  assert.equal(t.summary, 'Soft cotton.');
  assert.equal((await get('/products/campaign-t-shirt')).json.product.html, '<p>Soft <strong>cotton</strong>.</p>');
  assert.equal((await get('/products/hidden-mug')).status, 404);
  const pets = await get('/petitions');
  assert.deepEqual(pets.json.petitions.map((p) => [p.slug, p.signatures]), [['skytrain', 0]]);
  assert.equal(pets.json.petitions[0].sign_url, `https://starbase.test/p/${slug}/skytrain`);
  const closed = await get('/petitions/closed');
  assert.equal(closed.status, 410);
  assert.equal(closed.json.closed, true);
  await pub('POST', `/api/public/${slug}/signup`, { kind: 'petition', petition: 'skytrain', name: 'Sam Signer', email: mail('sam'), subscribe: true });
  assert.equal((await get('/petitions/skytrain')).json.petition.signatures, 1);
});

test('donate JSON without Stripe: the checks answer with a field; a good one is a pledge, the person tagged donor and on the list when asked', async () => {
  const d = `/api/public/${slug}/donate`;
  const short = await pub('POST', d, { amount_cents: 50, name: 'Dev Donor', email: mail('dev'), address: '1 Main St' });
  assert.equal(short.status, 400);
  assert.equal(short.json.field, 'amount');
  const noAttest = await pub('POST', d, { amount: '25', first_name: 'Dev', last_name: 'Donor', email: mail('dev'), address: '1 Main St', city: 'Surrey', postal: 'V3T 1A1' });
  assert.equal(noAttest.status, 400);
  assert.equal(noAttest.json.field, 'attest');
  const over = await pub('POST', d, { amount_cents: 200000, name: 'Dev Donor', email: mail('dev'), address: '1 Main St', attest: { individual: true, resident: true, own_funds: true } });
  assert.equal(over.status, 400);
  assert.match(over.json.error, /most one person can give/);
  const ok = await pub('POST', d, {
    amount: '$25.00', first_name: 'Dev', last_name: 'Donor', email: mail('dev'), phone: '604-555-0100',
    address: '1 Main St', city: 'Surrey', postal: 'V3T 1A1', attest: { individual: true, resident: true, own_funds: true }, subscribe: true,
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.ok, ok.json.pledged], [true, true]);
  const pledges = (await mgr.get('/api/pledges')).json.pledges;
  const p = pledges.find((x) => x.email === mail('dev'));
  assert.ok(p, 'the pledge is on record');
  assert.equal(p.amount_cents, 2500);
  assert.equal(p.address, '1 Main St, Surrey, V3T 1A1');
  const people = (await mgr.get(`/api/persons?q=${encodeURIComponent('Dev Donor')}`)).json.persons;
  assert.ok(people[0].tags.includes('donor'));
  const subs = (await mgr.get('/api/subscriptions')).json.subscriptions;
  assert.ok(subs.some((s) => s.email === mail('dev')), 'subscribed too');
});

test('with Stripe: donate and store checkout answer Stripe’s page, returning to the site’s own pages — never to a stranger’s', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_headless';
  mockStripe();
  const d = `/api/public/${slug}/donate`;
  const body = (ret) => ({
    amount_cents: 5000, monthly: true, name: 'Mona Monthly', email: mail('mona'), address: '2 Oak St, Surrey',
    attest: { individual: true, resident: true, own_funds: true }, return: ret,
  });
  const r = await pub('POST', d, body({ success: 'https://imaginesurrey.test/donate/thanks', cancel: 'https://imaginesurrey.test/donate?cancelled=1' }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.url, /^https:\/\/checkout\.stripe\.test\//);
  const s1 = sessions.at(-1);
  assert.equal(s1.mode, 'subscription');
  assert.equal(s1.success_url, 'https://imaginesurrey.test/donate/thanks');
  assert.equal(s1.cancel_url, 'https://imaginesurrey.test/donate?cancelled=1');
  const bad = await pub('POST', d, body({ success: 'https://evil.example/steal', cancel: 'javascript:alert(1)' }));
  assert.equal(bad.status, 200);
  const s2 = sessions.at(-1);
  assert.equal(s2.success_url, `https://starbase.test/d/${slug}/thanks`, 'a stranger’s address is not used');
  assert.equal(s2.cancel_url, `https://starbase.test/d/${slug}`);

  const co = await pub('POST', `/api/public/${slug}/site/store/checkout`, {
    items: [{ product_id: tee.id, variant: 'S', qty: 1 }], fulfilment: 'ship',
    return: { success: 'https://imaginesurrey.test/shop/thanks', cancel: 'https://imaginesurrey.test/shop' },
  });
  assert.equal(co.status, 200, JSON.stringify(co.json));
  assert.ok(co.json.order_id);
  const s3 = sessions.at(-1);
  assert.equal(s3.success_url, `https://imaginesurrey.test/shop/thanks?order=${co.json.order_id}`);
  assert.equal(s3.cancel_url, `https://imaginesurrey.test/shop?cancel=${co.json.order_id}`);
  const q = await pub('POST', `/api/public/${slug}/site/store/quote`, { items: [{ product_id: tee.id, variant: 'S', qty: 1 }] });
  assert.equal(q.json.open, true);
  assert.equal(q.json.subtotal_cents, 2500);
  const sold = await pub('POST', `/api/public/${slug}/site/store/checkout`, { items: [{ product_id: tee.id, variant: 'M', qty: 1 }], fulfilment: 'pickup' });
  assert.equal(sold.status, 409, 'sold out is refused here, never in the browser');
  // What's left counts the open checkout's hold.
  assert.deepEqual((await get('/products/campaign-t-shirt')).json.product.variants, [{ label: 'S', left: 1 }, { label: 'M', left: 0 }]);
});
