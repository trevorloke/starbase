// First-run setup: the first sign-up makes the Imagine Surrey workspace;
// after that sign-up is closed and people join by invite.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

const tokenOf = (joinUrl) => joinUrl.split('/join/')[1];

before(async () => {
  await freshDb();
  delete process.env.RESEND_API_KEY;
  delete process.env.STARBASE_OPEN_SIGNUP; // the real, closed-after-setup behaviour
});
after(() => { process.env.STARBASE_OPEN_SIGNUP = '1'; });

let mgr;

test('setup is open before anything exists, and names Imagine Surrey', async () => {
  const r = await new Client().get('/api/auth/setup');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { open: true, organization: 'Imagine Surrey' });
});

test('the first sign-up needs no campaign name: it sets up Imagine Surrey, BC municipal', async () => {
  mgr = new Client();
  const r = await mgr.post('/api/auth/signup', {
    name: 'Trevor Loke', email: 'trevor@imaginesurrey.example', password: 'surrey-forward-2026',
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.role, 'manager');
  assert.equal(r.json.workspace.name, 'Imagine Surrey');
  assert.equal(r.json.workspace.jurisdiction, 'bc-municipal');
  assert.equal(r.json.workspace.slug, 'imagine-surrey');
});

test('after setup, sign-up is closed (403) and /setup says so', async () => {
  const setup = await new Client().get('/api/auth/setup');
  assert.deepEqual(setup.json, { open: false, organization: 'Imagine Surrey' });
  const r = await new Client().post('/api/auth/signup', {
    name: 'Someone Else', email: 'else@example.org', password: 'another-pass-1', workspaceName: 'Another Campaign',
  });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /already set up for Imagine Surrey/);
  assert.match(r.json.error, /invite/);
  // Nothing was made for them.
  const li = await new Client().post('/api/auth/login', { email: 'else@example.org', password: 'another-pass-1' });
  assert.equal(li.status, 401);
});

test('a second person still gets in by invite', async () => {
  const inv = await mgr.action('member.invite', { email: 'jas@example.org', role: 'volunteer' });
  assert.equal(inv.status, 200);
  const anon = new Client();
  const joined = await anon.post('/api/auth/join', { token: tokenOf(inv.json.joinUrl), name: 'Jas Volunteer', password: 'knock-knock-2026' });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.role, 'volunteer');
  assert.equal(joined.json.workspace.name, 'Imagine Surrey');
  const me = await anon.get('/api/auth/me');
  assert.equal(me.status, 200);
});

test('STARBASE_OPEN_SIGNUP=1 opens sign-up again (tests, local dev)', async () => {
  process.env.STARBASE_OPEN_SIGNUP = '1';
  try {
    assert.equal((await new Client().get('/api/auth/setup')).json.open, true);
    const r = await new Client().signup();
    assert.equal(r.status, 201);
  } finally {
    delete process.env.STARBASE_OPEN_SIGNUP;
  }
});
