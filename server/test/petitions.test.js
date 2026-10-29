// Petitions: the website's two, as it first published them, seeded into a
// campaign with none (petition.seed) so the site's forms find their slugs;
// a petition's question, and each signer's answer kept with the signature.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { SEED_PETITIONS } from '../lib/petitions.js';

let c, slug;
const pub = async (method, path, body, headers = {}) => {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, json: ct.includes('json') ? await res.json() : null, text: ct.includes('json') ? '' : await res.text() };
};

before(async () => {
  await freshDb();
  c = new Client();
  const r = await c.signup({ workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal' });
  slug = r.json.workspace.slug;
});

test('petition.seed: the website’s petitions by their slugs, once', async () => {
  const seeded = await c.action('petition.seed', {});
  assert.equal(seeded.status, 200, JSON.stringify(seeded.json));
  assert.deepEqual(seeded.json.petitions.map((p) => p.slug), ['stop-mccallum-pledge', 'skytrain-south-surrey']);
  const again = await c.action('petition.seed', {});
  assert.equal(again.status, 409, 'never on top of what is there');
  const list = (await c.get('/api/petitions')).json.petitions;
  assert.deepEqual(list.map((p) => [p.slug, p.active, p.signatures]).sort(), [['skytrain-south-surrey', true, 0], ['stop-mccallum-pledge', true, 0]]);
  const sky = list.find((p) => p.slug === 'skytrain-south-surrey');
  assert.equal(sky.question, 'Where do you think the line should end?');
  assert.match(sky.body, /64 Avenue/);
  assert.equal(list.find((p) => p.slug === 'stop-mccallum-pledge').question, null);
  const site = await pub('GET', `/api/public/${slug}/site`);
  assert.deepEqual(site.json.petitions.map((p) => p.slug), SEED_PETITIONS.map((p) => p.slug), 'the site lists both');
  const one = await pub('GET', `/api/public/${slug}/site/petitions/skytrain-south-surrey`);
  assert.equal(one.json.petition.question, 'Where do you think the line should end?');
  const events = (await c.get('/api/events?since=0&limit=100')).json.events.filter((e) => e.action === 'petition.seed');
  assert.equal(events.length, 2, 'each petition is an event');
});

test('a signer’s answer to the petition’s question stays with the signature; the sign page asks it', async () => {
  const page = await pub('GET', `/p/${slug}/skytrain-south-surrey`);
  assert.match(page.text, /<label for="answer">Where do you think the line should end\?<\/label>/);
  const plain = await pub('GET', `/p/${slug}/stop-mccallum-pledge`);
  assert.doesNotMatch(plain.text, /name="answer"/, 'no question, no field');

  const fromSite = await pub('POST', `/api/public/${slug}/signup`, { kind: 'petition', petition: 'skytrain-south-surrey', name: 'Harjit Gill', email: 'harjit@example.org', answer: 'White Rock', subscribe: true });
  assert.equal(fromSite.status, 200);
  const asNote = await pub('POST', `/api/public/${slug}/signup`, { kind: 'petition', petition: 'skytrain-south-surrey', name: 'Maya Chen', email: 'maya@example.org', note: 'Crescent Beach' });
  assert.equal(asNote.status, 200, 'the site’s first wording (note) still lands');
  const onPage = await pub('POST', `/p/${slug}/skytrain-south-surrey`, { name: 'Ben Thompson', answer: 'x'.repeat(300) }, { accept: 'application/json' });
  assert.equal(onPage.status, 200);

  const id = (await c.get('/api/petitions')).json.petitions.find((p) => p.slug === 'skytrain-south-surrey').id;
  const sigs = (await c.get(`/api/petitions/${id}/signatures`)).json.signatures;
  assert.deepEqual(sigs.map((s) => [s.name, s.answer]), [['Ben Thompson', 'x'.repeat(200)], ['Maya Chen', 'Crescent Beach'], ['Harjit Gill', 'White Rock']]);
  const ev = (await c.get('/api/events?since=0&limit=100')).json.events.filter((e) => e.action === 'public.sign' && e.entity_type === 'petition_signature');
  assert.deepEqual(ev.map((e) => e.payload.answer), ['White Rock', 'Crescent Beach', 'x'.repeat(200)]);

  const csv = await app.request('/api/export/signatures.csv', { headers: { cookie: c.cookie } });
  assert.equal(csv.status, 200);
  const text = (await csv.text()).replace(/^﻿?/, '');
  assert.match(text.split(/\r?\n/)[0], /answer/);
  assert.match(text, /Harjit Gill,harjit@example.org,,,White Rock,true/);

  // The question is the desk's to change or clear.
  assert.equal((await c.action('petition.update', { id, question: 'Which station?' })).status, 200);
  assert.equal((await c.get('/api/petitions')).json.petitions.find((p) => p.id === id).question, 'Which station?');
  assert.equal((await c.action('petition.update', { id, question: '' })).status, 200);
  assert.equal((await c.get('/api/petitions')).json.petitions.find((p) => p.id === id).question, null);
  assert.equal((await c.action('petition.update', { id, title: 'Renamed' })).status, 200);
  assert.equal((await c.get('/api/petitions')).json.petitions.find((p) => p.id === id).question, null, 'absent leaves it');
});
