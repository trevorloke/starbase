// Petitions: a petition's question, and each signer's answer kept with the
// signature — from the sign page and from a website's own form alike.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

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
  const sky = await c.action('petition.create', { slug: 'skytrain-south-surrey', title: 'SkyTrain to South Surrey petition', body: 'All the way to 64 Avenue.', question: 'Where do you think the line should end?' });
  assert.equal(sky.status, 200, JSON.stringify(sky.json));
  assert.equal((await c.action('petition.create', { slug: 'stop-mccallum-pledge', title: 'The pledge' })).status, 200);
  const list = (await c.get('/api/petitions')).json.petitions;
  assert.equal(list.find((p) => p.slug === 'skytrain-south-surrey').question, 'Where do you think the line should end?');
  assert.equal(list.find((p) => p.slug === 'stop-mccallum-pledge').question, null);
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
