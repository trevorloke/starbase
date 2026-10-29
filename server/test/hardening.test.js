// What faces the open internet, hardened (lib/guard.js and friends): body
// size, the address a request is from, sign-in guessing, cross-site writes,
// open-checkout caps, odd ids, and the headers every answer carries.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { clientIp, makeLimiter } from '../lib/guard.js';

let mgr, slug, wsId;
const env = { ...process.env };

before(async () => {
  await freshDb();
  delete process.env.STARBASE_TRUSTED_PROXIES;
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: 'Imagine Surrey', email: 'hard.manager@example.org', password: 'hardening-2026', jurisdiction: 'bc-municipal' });
  slug = r.json.workspace.slug;
  wsId = r.json.workspace.id;
});
after(() => {
  for (const k of ['STARBASE_TRUSTED_PROXIES', 'STRIPE_SECRET_KEY']) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
});

const req = (path, { method = 'GET', body, headers = {}, cookie } = {}) => app.request(path, {
  method,
  headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
  body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('clientIp: the proxy’s own entry wins; what the sender wrote further left is ignored', () => {
  const c = (xff, real) => ({ req: { header: (h) => (h === 'x-forwarded-for' ? xff : h === 'x-real-ip' ? real : undefined) } });
  assert.equal(clientIp(c('1.2.3.4, 203.0.113.9')), '203.0.113.9', 'the attacker wrote 1.2.3.4; the proxy appended the real one');
  assert.equal(clientIp(c('203.0.113.9')), '203.0.113.9');
  assert.equal(clientIp(c(undefined, '198.51.100.1')), '198.51.100.1');
  assert.equal(clientIp(c(undefined, undefined)), 'local');
  process.env.STARBASE_TRUSTED_PROXIES = '2';
  assert.equal(clientIp(c('1.2.3.4, 203.0.113.9, 10.0.0.1')), '203.0.113.9', 'two proxies: the entry two from the right');
  delete process.env.STARBASE_TRUSTED_PROXIES;
});

test('a limiter sweeps old entries and never keeps more than its cap of keys', () => {
  const lim = makeLimiter({ windowMs: 1000, max: 2 });
  assert.equal(lim('a'), false); assert.equal(lim('a'), false); assert.equal(lim('a'), true);
  assert.equal(lim.count('a'), 3);
  for (let i = 0; i < 20_500; i++) lim(`k${i}`);
  assert.ok(lim._size() <= 20_501, 'a sweep ran');
  lim.clear('a');
  assert.equal(lim.count('a'), 0);
});

test('a spoofed X-Forwarded-For no longer dodges the public rate limit', async () => {
  // 31 newsletter sign-ups, each claiming a different address on the left —
  // the proxy's entry on the right is the same every time.
  let last;
  for (let i = 0; i < 31; i++) {
    last = await req(`/n/${slug}`, { method: 'POST', body: { email: `spoof${i}@example.org` },
      headers: { 'x-forwarded-for': `1.2.3.${i}, 203.0.113.77` } });
  }
  assert.equal(last.status, 429);
});

test('request bodies are capped: 256 KB in general, more for an import or a picture', async () => {
  const big = JSON.stringify({ email: 'x@example.org', note: 'a'.repeat(300 * 1024) });
  const r = await req(`/n/${slug}`, { method: 'POST', body: big, headers: { 'x-forwarded-for': '203.0.113.80' } });
  assert.equal(r.status, 413);
  const login = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'a'.repeat(300 * 1024), password: 'x' }) });
  assert.equal(login.status, 413);
  // An import of 1,000 rows (about 400 KB) is over 256 KB and goes through.
  const rows = Array.from({ length: 1000 }, (_, i) => ({ name: `Row Person ${i}`, address: `${10000 + i} 72 Ave`, note: 'x'.repeat(350) }));
  const imp = await req('/api/data/import', { method: 'POST', body: { rows, dryRun: true }, cookie: mgr.cookie });
  assert.equal(imp.status, 200, JSON.stringify(imp.json?.() ?? ''));
});

test('sign-in guessing: 10 failures against one email, or 30 tries from one address, then 429', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await req('/api/auth/login', { method: 'POST', body: { email: 'hard.manager@example.org', password: `wrong-${i}` },
      headers: { 'x-forwarded-for': `203.0.113.${100 + i}` } });
    assert.equal(r.status, 401);
  }
  const blocked = await req('/api/auth/login', { method: 'POST', body: { email: 'Hard.Manager@example.org', password: 'hardening-2026' },
    headers: { 'x-forwarded-for': '203.0.113.120' } });
  assert.equal(blocked.status, 429, 'even the right password waits now');
  // Someone else's account is not affected by that.
  const other = await req('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.org', password: 'x' }, headers: { 'x-forwarded-for': '203.0.113.121' } });
  assert.equal(other.status, 401);
  // One address, many emails.
  let last;
  for (let i = 0; i < 31; i++) {
    last = await req('/api/auth/login', { method: 'POST', body: { email: `guess${i}@example.org`, password: 'x' }, headers: { 'x-forwarded-for': '203.0.113.150' } });
  }
  assert.equal(last.status, 429);
  const join = await req('/api/auth/join', { method: 'POST', body: { token: 'x', name: 'x', password: 'xxxxxxxx' }, headers: { 'x-forwarded-for': '203.0.113.150' } });
  assert.equal(join.status, 429, 'join shares the per-address limit');
});

test('a write with the cookie must be the app’s own: JSON, from the same origin', async () => {
  const form = await app.request('/api/actions/person.create', {
    method: 'POST', headers: { cookie: mgr.cookie, 'content-type': 'text/plain' }, body: '{"name":"CSRF Victim","x":"="}',
  });
  assert.equal(form.status, 415, 'a text/plain form post is refused');
  const urlenc = await app.request('/api/actions/person.create', {
    method: 'POST', headers: { cookie: mgr.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=CSRF',
  });
  assert.equal(urlenc.status, 415);
  const cross = await req('/api/actions/person.create', { method: 'POST', body: { name: 'CSRF Victim' }, cookie: mgr.cookie, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.status, 403);
  const sibling = await req('/api/actions/person.create', { method: 'POST', body: { name: 'CSRF Victim' }, cookie: mgr.cookie, headers: { 'sec-fetch-site': 'same-site' } });
  assert.equal(sibling.status, 403, 'another host under the domain is not the app');
  const own = await req('/api/actions/person.create', { method: 'POST', body: { name: 'Real Person' }, cookie: mgr.cookie, headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(own.status, 200);
  assert.equal((await req('/api/auth/logout', { method: 'POST', cookie: mgr.cookie, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const list = await (await req('/api/persons?q=CSRF%20Victim', { cookie: mgr.cookie })).json();
  assert.equal(list.persons.length, 0, 'nothing was created');
  // Reads are untouched; the session cookie is Strict.
  const me = await req('/api/auth/me', { cookie: mgr.cookie });
  assert.equal(me.status, 200);
  const inv = await mgr.action('member.invite', { email: 'hard.staff@example.org', role: 'staff' });
  const join = await req('/api/auth/join', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.200' },
    body: { token: inv.json.joinUrl.split('/join/')[1], name: 'Hard Staff', password: 'hardening-2026' } });
  assert.equal(join.status, 200);
  assert.match(join.headers.get('set-cookie') || '', /SameSite=Strict/i);
});

test('odd ids and names are a 400 or 404, never a 500', async () => {
  assert.equal((await req('/media/constructor')).status, 404);
  assert.equal((await req('/media/__proto__')).status, 404);
  assert.equal((await req('/api/actions/constructor', { method: 'POST', body: {}, cookie: mgr.cookie })).status, 404);
  assert.equal((await req('/u/constructor')).status, 404);
});

test('every answer says: not framed, no sniffing, referrer trimmed — a route’s own choice stands', async () => {
  for (const path of ['/login', '/api/health', `/p/${slug}/nope`, `/n/${slug}`]) {
    const r = await req(path);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    assert.ok(r.headers.get('referrer-policy'), path);
  }
});
