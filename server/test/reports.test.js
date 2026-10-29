// Reports and exports: the desk reads the campaign in numbers and downloads
// any of them, or a whole table, as CSV; volunteers are refused.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

const tag = Math.random().toString(36).slice(2, 8);
let mgr; let vol;

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', email: `rep.${tag}@example.org`, jurisdiction: 'bc-municipal' });
  const inv = await mgr.action('member.invite', { email: `vol.${tag}@example.org`, role: 'volunteer' });
  vol = new Client();
  await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vic', password: 'reports-pass-2026' });
  const a = await mgr.createPerson('Anne Donor', { email: `anne.${tag}@example.org`, tags: ['member'], city: 'Surrey' });
  await mgr.createPerson('Bob Voter', { phone: '604-555-0102', tags: ['member', 'yard-sign'], city: 'Delta' });
  await mgr.action('gift.log', { person_id: a.id, amount_cents: 5000, date: new Date().toISOString().slice(0, 10), method: 'cash' });
  await mgr.action('contact.log', { person_id: a.id, channel: 'door', outcome: 'contacted', rating: '1' });
  await mgr.action('subscription.add', { email: `anne.${tag}@example.org`, name: 'Anne' });
});

test('the reports: totals and tables; CSV of any report and any dataset; volunteers refused', async () => {
  const r = await mgr.get('/api/reports');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.totals.people.total, 2);
  assert.equal(r.json.totals.donations.cents, 5000);
  assert.equal(r.json.totals.newsletter.subscribed, 1);
  assert.equal(r.json.totals.contacts.week, 1);
  const tags = r.json.reports.tags.rows;
  assert.deepEqual(tags[0], ['member', 2]);
  assert.ok(r.json.reports.rating.rows.some((x) => x[1] === '1' && x[2] === 1), JSON.stringify(r.json.reports.rating));
  assert.equal(r.json.reports.donations.rows.length, 1);
  assert.equal(r.json.reports.contacts.rows[0][1], 1, 'one door this week');
  const csv = await app.request('/api/reports/tags.csv', { headers: { cookie: mgr.cookie } });
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /Tag,People\r\nmember,2/);
  const people = await app.request('/api/export/people.csv', { headers: { cookie: mgr.cookie } });
  assert.equal(people.status, 200);
  const text = await people.text();
  assert.match(text, /^﻿?name,email,phone/);
  assert.match(text, /Bob Voter,,604-555-0102/);
  assert.match(text, /member; yard-sign/);
  for (const d of ['gifts', 'pledges', 'subscribers', 'signatures', 'rsvps', 'contacts', 'lists']) {
    const res = await app.request(`/api/export/${d}.csv`, { headers: { cookie: mgr.cookie } });
    assert.equal(res.status, 200, d);
  }
  assert.equal((await app.request('/api/export/nope.csv', { headers: { cookie: mgr.cookie } })).status, 404);
  assert.equal((await vol.get('/api/reports')).status, 403);
  assert.equal((await app.request('/api/export/people.csv', { headers: { cookie: vol.cookie } })).status, 403);
});
