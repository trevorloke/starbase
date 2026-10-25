// The website: content edited in the staff app (desk only), shown on the
// public site only when published, Markdown that can never carry a script,
// picture uploads checked by their bytes, and the site at / on its own
// domain while every other host keeps the staff app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { renderMarkdown, markdownText } from '@starbase/shared/markdown';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who.toLowerCase().replace(/\W+/g, '-')}.web.${tag}@example.org`;
let mgr, staff, vol, treas, slug;

const get = async (path, headers = {}) => {
  const res = await app.request(path, { headers });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, text: ct.includes('json') ? '' : await res.text(), ct };
};

// A real 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const invite = async (role, who) => {
  const inv = await mgr.action('member.invite', { email: mail(who), role });
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  const cl = new Client();
  const r = await cl.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: who, password: 'surrey-2026-pass' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return cl;
};

before(async () => {
  await freshDb();
  delete process.env.STARBASE_SITE_HOSTS;
  delete process.env.STARBASE_SITE_WORKSPACE;
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: 'Imagine Surrey', email: mail('manager'), jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  slug = r.json.workspace.slug;
  staff = await invite('staff', 'Sam Staff');
  vol = await invite('volunteer', 'Val Volunteer');
  treas = await invite('treasurer', 'Tia Treasurer');
});

after(() => { delete process.env.STARBASE_SITE_HOSTS; });

test('markdown: formatting works and no HTML, script, javascript: link or event handler ever comes through', () => {
  const html = renderMarkdown('# Title\n\nSome **bold** and *it* with [a link](https://surrey.ca/x?a=1&b=2).\n\n- one\n- two\n\n> said\n\n![p](/media/0b6f3c2e-1f3a-4a43-9a6e-111111111111)');
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<strong>bold<\/strong> and <em>it<\/em>/);
  assert.match(html, /<a href="https:\/\/surrey\.ca\/x\?a=1&amp;b=2" rel="noopener">a link<\/a>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<img src="\/media\/0b6f3c2e-1f3a-4a43-9a6e-111111111111" alt="p" loading="lazy"/);
  const evil = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click]( javascript:alert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
    '[x](//evil.example/)',
    '![x](x" onerror="alert(1))',
    '![x](javascript:alert(1))',
    '![x](http://insecure.example/p.png)',
    '<a href="javascript:alert(1)">x</a>',
    '**<svg onload=alert(1)>**',
    '[x](https://ok.example/"onmouseover="alert(1))',
  ];
  for (const src of evil) {
    const out = renderMarkdown(src);
    assert.doesNotMatch(out, /<script|<svg|<iframe/i, src);
    assert.doesNotMatch(out, /<[^>]+\son\w+\s*=/i, `no event handler attribute: ${src}`);
    assert.doesNotMatch(out, /href="\s*(javascript|data):|src="\s*(javascript|data|http:)/i, src);
    assert.doesNotMatch(out, /href="\/\//, src);
  }
  assert.equal(markdownText('## Hi **there** [link](https://x.ca)'), 'Hi there link');
});

test('permissions: volunteers are refused every website read and write; treasurers see orders only', async () => {
  for (const path of ['/api/site/overview', '/api/site/pages', '/api/site/posts', '/api/site/team', '/api/site/media', '/api/site/events', '/api/store/products', '/api/store/orders']) {
    assert.equal((await vol.get(path)).status, 403, path);
  }
  for (const [name, input] of [
    ['site.settings.save', { title: 'x' }], ['site.page.save', { title: 'x' }], ['site.post.save', { title: 'x', date: '2026-10-01' }],
    ['site.team.save', { name: 'x' }], ['site.media.upload', { data: PNG }], ['store.product.save', { name: 'x', price_cents: 1000 }],
  ]) {
    assert.equal((await vol.action(name, input)).status, 403, `volunteer ${name}`);
    assert.equal((await treas.action(name, input)).status, 403, `treasurer ${name}`);
  }
  assert.equal((await treas.get('/api/store/orders')).status, 200);
  assert.equal((await treas.get('/api/site/pages')).status, 403);
  const ov = await treas.get('/api/site/overview');
  assert.equal(ov.status, 200);
  assert.equal(ov.json.settings, null, 'the treasurer gets counts, not the editor');
  assert.equal((await staff.get('/api/site/pages')).status, 200);
});

test('first look seeds draft pages with placeholder words; drafts never show; publishing puts a page in the menu', async () => {
  const ov = await mgr.get('/api/site/overview');
  assert.equal(ov.status, 200);
  assert.equal(ov.json.settings.site_title, 'Imagine Surrey');
  assert.equal(ov.json.stripe.configured, false);
  const pages = (await mgr.get('/api/site/pages')).json.pages;
  assert.deepEqual(pages.map((p) => p.slug).sort(), ['about', 'contact', 'get-involved', 'home', 'platform']);
  assert.ok(pages.every((p) => !p.published), 'seeded as drafts');
  const about = (await mgr.get(`/api/site/pages/${pages.find((p) => p.slug === 'about').id}`)).json.page;
  assert.match(about.body, /Write about Imagine Surrey here/);
  // Seeding again changes nothing.
  await mgr.get('/api/site/overview');
  assert.equal((await mgr.get('/api/site/pages')).json.pages.length, 5);

  assert.equal((await get('/site/about')).status, 404, 'a draft is not on the site');
  const home0 = await get('/site/');
  assert.equal(home0.status, 200);
  assert.doesNotMatch(home0.text, /href="\/site\/about"/);

  const saved = await staff.action('site.page.save', {
    id: about.id, title: 'About us', body: 'We are **local**.\n\n<script>alert(1)</script>', show_in_nav: true, nav_order: 10, published: true,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.page.slug, 'about', 'the link stays when only the title changes');
  const page = await get('/site/about');
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1>About us<\/h1>/);
  assert.match(page.text, /We are <strong>local<\/strong>\./);
  assert.doesNotMatch(page.text, /<script>alert/);
  assert.match(page.text, /<title>About us · Imagine Surrey<\/title>/);
  assert.match(page.text, /<meta name="description" content="We are local\./);
  assert.match((await get('/site/')).text, /href="\/site\/about"/, 'published pages are in the menu');

  // Links the site itself uses are refused; a taken link is a 409.
  assert.equal((await mgr.action('site.page.save', { title: 'News', slug: 'news' })).status, 400);
  assert.equal((await mgr.action('site.page.save', { title: 'Other', slug: 'about' })).status, 409);
  // Unpublish: gone again.
  assert.equal((await mgr.action('site.page.save', { id: about.id, title: 'About us', body: 'x', published: false })).status, 200);
  assert.equal((await get('/site/about')).status, 404);
});

test('settings: colours, links and words are checked; the site wears them', async () => {
  assert.equal((await mgr.action('site.settings.save', { accent: 'red;}</style><script>' })).status, 400);
  assert.equal((await mgr.action('site.settings.save', { socials: { instagram: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await mgr.action('site.settings.save', { donate_label: '' })).status, 400);
  const ok = await mgr.action('site.settings.save', {
    title: 'Imagine Surrey', tagline: 'Municipal election 2026', hero_headline: 'Our headline', hero_text: 'One line.',
    primary: '#123456', accent: '#ab12cd', authorized_by: 'Authorized by the test agent', contact_email: 'hello@example.org',
    socials: { instagram: 'https://instagram.com/example', x: '' }, donate_label: 'Give', involved_label: 'Join us',
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const home = (await get('/site/')).text;
  assert.match(home, /--primary:#123456;--accent:#ab12cd/);
  assert.match(home, /<h1>Our headline<\/h1>/);
  assert.match(home, /Authorized by the test agent/);
  assert.match(home, /href="https:\/\/instagram\.com\/example"/);
  assert.match(home, />Give</);
  assert.match(home, new RegExp(`href="/d/${slug}"`), 'Donate goes to the donate page');
  assert.match(home, new RegExp(`href="/v/${slug}"`), 'Get involved goes to the volunteer page until that page is published');
  // The public forms wear the same site.
  const donate = (await get(`/d/${slug}`)).text;
  assert.match(donate, /class="sh"/);
  assert.match(donate, /Authorized by the test agent/);
  assert.match(donate, /Powered by Starbase/);
});

test('news: drafts hidden, published listed and pinned first on home, paginated, each post its own page', async () => {
  const d = await staff.action('site.post.save', { title: 'Draft thoughts', date: '2026-09-01', body: 'not yet' });
  assert.equal(d.status, 200);
  assert.equal((await get(`/site/news/${d.json.post.slug}`)).status, 404);
  for (let i = 1; i <= 10; i += 1) {
    const r = await staff.action('site.post.save', {
      title: `Update ${i}`, date: `2026-08-${String(i).padStart(2, '0')}`, summary: `Summary ${i}`, body: `Body ${i}`, published: true,
    });
    assert.equal(r.status, 200);
  }
  const pin = await staff.action('site.post.save', { title: 'Pinned note', date: '2026-01-01', body: 'Read me', published: true, pinned: true });
  const list = await get('/site/news');
  assert.equal(list.status, 200);
  assert.doesNotMatch(list.text, /Draft thoughts/);
  assert.match(list.text, /Page 1 of 2/);
  assert.match((await get('/site/news?page=2')).text, /Update 1</);
  assert.equal((await get('/site/news?page=9')).status, 404);
  const home = (await get('/site/')).text;
  assert.ok(home.indexOf('Pinned note') > -1 && home.indexOf('Pinned note') < home.indexOf('Update 10'), 'pinned first on home');
  assert.doesNotMatch(home, /Update 8</, 'home shows three');
  const post = await get('/site/news/update-3');
  assert.match(post.text, /<p>Body 3<\/p>/);
  assert.match(post.text, /<meta property="og:type" content="article">/);
  // Publish / unpublish in one tap.
  assert.equal((await staff.action('site.post.publish', { id: pin.json.post.id, published: false })).status, 200);
  assert.doesNotMatch((await get('/site/')).text, /Pinned note/);
  assert.equal((await staff.action('site.post.publish', { id: d.json.post.id, published: true })).status, 200);
  assert.equal((await get(`/site/news/${d.json.post.slug}`)).status, 200);
});

test('media: JPG/PNG/WebP by their bytes only, size capped; served with its type and a year-long cache', async () => {
  const up = await mgr.action('site.media.upload', { data: `data:image/png;base64,${PNG}`, name: 'dot.png', width: 1, height: 1 });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.media.content_type, 'image/png');
  const m = await app.request(up.json.media.url);
  assert.equal(m.status, 200);
  assert.equal(m.headers.get('content-type'), 'image/png');
  assert.match(m.headers.get('cache-control'), /max-age=31536000/);
  assert.equal(m.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(await m.arrayBuffer()).toString('base64'), PNG);

  const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary').toString('base64');
  assert.equal((await mgr.action('site.media.upload', { data: `data:image/png;base64,${gif}` })).status, 400, 'a GIF named png is refused');
  const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
  assert.equal((await mgr.action('site.media.upload', { data: html })).status, 400);
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2.1 * 1024 * 1024)]).toString('base64');
  const tooBig = await mgr.action('site.media.upload', { data: big });
  assert.equal(tooBig.status, 400);
  assert.equal((await app.request('/media/not-an-id')).status, 404);
  // No picture bytes on the event log.
  const ev = (await mgr.get('/api/events?since=0&limit=1000')).json.events.filter((e) => e.action === 'site.media.upload');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.data, undefined);

  // A picture from another campaign can't be used.
  const other = new Client();
  await other.signup({ workspaceName: 'Other Campaign', email: mail('other') });
  const theirs = await other.action('site.media.upload', { data: PNG });
  assert.equal((await mgr.action('site.settings.save', { hero_image: theirs.json.media.id })).status, 400);
  assert.equal((await mgr.action('site.settings.save', { hero_image: up.json.media.id })).status, 200);
  assert.match((await get('/site/')).text, new RegExp(`<img src="/media/${up.json.media.id}"[^>]*class="hero-img"[^>]*fetchpriority="high"`));
});

test('events: campaign events with a site picture; upcoming listed, past folded, each linking to its RSVP page', async () => {
  const soon = new Date(Date.now() + 3 * 86400e3).toISOString();
  const e = await staff.action('cevent.create', { slug: `rally-${tag}`, title: 'Newton rally', location: 'Newton Rec Centre', starts_at: soon, public: true });
  assert.equal(e.status, 200);
  const hidden = await staff.action('cevent.create', { slug: `private-${tag}`, title: 'Volunteer only huddle', starts_at: soon, public: false });
  assert.equal(hidden.status, 200);
  const past = await staff.action('cevent.create', { slug: `past-${tag}`, title: 'Old meetup', starts_at: new Date(Date.now() - 5 * 86400e3).toISOString() });
  const media = (await staff.get('/api/site/media')).json.media[0];
  assert.equal((await staff.action('site.event.image', { event_id: e.json.event.id, image: media.id })).status, 200);
  const list = (await staff.get('/api/site/events')).json.events;
  assert.equal(list.find((x) => x.id === e.json.event.id).image, media.id);
  const pg = (await get('/site/events')).text;
  assert.match(pg, /Newton rally/);
  assert.match(pg, new RegExp(`href="/e/${slug}/rally-${tag}"`));
  assert.doesNotMatch(pg, /Volunteer only huddle/);
  assert.match(pg, /Past events · 1/);
  assert.ok(pg.indexOf('Old meetup') > pg.indexOf('Past events'));
  const rsvp = (await get(`/e/${slug}/rally-${tag}`)).text;
  assert.match(rsvp, new RegExp(`/media/${media.id}`), 'the RSVP page shows the picture');
  assert.match(rsvp, /<button type="submit">RSVP<\/button>/);
  assert.ok(past.json.event.id);
  assert.equal((await vol.action('site.event.image', { event_id: e.json.event.id, image: null })).status, 403);
});

test('team: published people show on the team page', async () => {
  const a = await staff.action('site.team.save', { name: 'Pat Example', role: 'Council candidate', bio: 'Placeholder bio.', position: 1, socials: { x: 'https://x.com/example' } });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  const b = await staff.action('site.team.save', { name: 'Hidden Person', role: 'Mayor candidate', published: false });
  assert.equal(b.status, 200);
  const pg = (await get('/site/our-team')).text;
  assert.match(pg, /Pat Example/);
  assert.match(pg, /Council candidate/);
  assert.doesNotMatch(pg, /Hidden Person/);
  assert.equal((await staff.action('site.team.delete', { id: b.json.member.id })).status, 200);
});

test('search engines: sitemap lists published pages only; robots points at it; pages revalidate by ETag', async () => {
  const sm = await get('/site/sitemap.xml');
  assert.equal(sm.status, 200);
  assert.match(sm.ct, /xml/);
  assert.match(sm.text, /\/site\/news\/update-3<\/loc>/);
  assert.doesNotMatch(sm.text, /\/site\/about</, 'a draft page is not listed');
  assert.match((await get('/site/robots.txt')).text, /Sitemap: http:\/\/localhost\/site\/sitemap\.xml/);
  const first = await app.request('/site/news');
  const tagv = first.headers.get('etag');
  assert.ok(tagv);
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  assert.equal((await app.request('/site/news', { headers: { 'if-none-match': tagv } })).status, 304);
  const css = await app.request('/site-assets/site.css?v=wrong');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
});

test('host routing: on a site host / is the website; the staff app, its API and the public forms still answer; other hosts keep the app', async () => {
  process.env.STARBASE_SITE_HOSTS = 'imaginesurrey.test, www.imaginesurrey.test';
  try {
    const on = (path, host = 'imaginesurrey.test') => get(`http://${host}${path}`, { host });
    const home = await on('/');
    assert.equal(home.status, 200);
    assert.match(home.text, /class="hero/);
    assert.match(home.text, /href="\/news"/, 'links have no /site on the site domain');
    assert.match(home.text, /<link rel="canonical" href="https:\/\/imaginesurrey\.test\/">/);
    assert.match((await on('/', 'www.imaginesurrey.test')).text, /class="hero/);
    assert.equal((await on('/news')).status, 200);
    assert.match((await on('/news/update-3')).text, /Body 3/);
    assert.equal((await on('/our-team')).status, 200);
    assert.equal((await on('/robots.txt')).status, 200);
    assert.equal((await on('/not-a-page')).status, 404, 'an unknown page is the site’s own 404');
    // The app and the forms keep working on the site's domain.
    const health = await app.request('http://imaginesurrey.test/api/health', { headers: { host: 'imaginesurrey.test' } });
    const h = await health.json();
    assert.equal(h.ok, true);
    assert.equal(h.service, 'starbase');
    const donate = await on(`/d/${slug}`);
    assert.equal(donate.status, 200);
    assert.match(donate.text, /Donate/);
    assert.match(donate.text, /href="\/"/, 'the form’s header links home on the site domain');
    assert.doesNotMatch((await on('/login')).text, /class="hero/, '/login is still the staff app');
    // The staff host: / is the app, the site lives at /site.
    assert.doesNotMatch((await on('/', 'starbase.imaginesurrey.test')).text, /class="hero/);
    assert.match((await on('/site/', 'starbase.imaginesurrey.test')).text, /class="hero/);
    const staffDonate = (await on(`/d/${slug}`, 'starbase.imaginesurrey.test')).text;
    assert.match(staffDonate, /href="\/site\/"/);
    // A published page answers at the root of the site domain.
    const pages = (await mgr.get('/api/site/pages')).json.pages;
    const contact = pages.find((p) => p.slug === 'contact');
    await mgr.action('site.page.save', { id: contact.id, title: 'Contact', body: 'Email us.', published: true });
    assert.match((await on('/contact')).text, /Email us\./);
    assert.match((await mgr.get('/api/site/overview')).json.site_url, /^https:\/\/imaginesurrey\.test\/$/);
  } finally {
    delete process.env.STARBASE_SITE_HOSTS;
  }
});

test('every website write is on the chain and the chain verifies', async () => {
  const all = (await mgr.get('/api/events?since=0&limit=2000')).json.events;
  const names = new Set(all.map((e) => e.action));
  for (const a of ['site.seed', 'site.page.save', 'site.post.save', 'site.post.publish', 'site.settings.save', 'site.media.upload', 'site.team.save', 'site.event.image']) {
    assert.ok(names.has(a), a);
  }
  assert.equal((await mgr.get('/api/audit/verify')).json.ok, true);
});
