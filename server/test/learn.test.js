// ImagineU (ext/learn): sections and lessons of every kind, a file behind
// one, who may see what (volunteers: published, everyone/public; the desk:
// all), "done" per person and the desk's progress view, and the public
// pages for lessons marked public — nothing else.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

let mgr, staff, vol;
let ids = {};
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n').toString('base64');
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40, 1)]).toString('base64');
const tokenOf = (url) => url.split('/join/')[1];
const joinAs = async (role, name) => {
  const inv = await mgr.action('member.invite', { email: `${name}.learn@example.org`, role });
  const cl = new Client();
  const r = await cl.post('/api/auth/join', { token: tokenOf(inv.json.joinUrl), name, password: 'learn-pass-2026' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  ids[name] = r.json.user.id;
  return cl;
};
const get = async (path, headers = {}) => {
  const res = await app.request(path, { headers });
  return { status: res.status, headers: res.headers, text: await res.text() };
};
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', email: 'mgr.learn@example.org', jurisdiction: 'bc-municipal' });
  staff = await joinAs('staff', 'Sam');
  vol = await joinAs('volunteer', 'Vic');
});

test('sections and lessons of every kind, with a file or a link; who may edit', async () => {
  const sec = ok(await mgr.action('learn.section.save', { title: 'Start here', note: 'Your first hour' })).section;
  ids.sec = sec.id;
  assert.equal((await vol.action('learn.section.save', { title: 'x' })).status, 403, 'volunteers read, never write');
  assert.equal((await mgr.action('learn.section.save', { title: '   ' })).status, 400);
  const pdf = ok(await staff.action('learn.asset.upload', { data: PDF, name: 'Door script.pdf' })).asset;
  assert.equal(pdf.content_type, 'application/pdf'); assert.equal(pdf.kind, 'document');
  const pic = ok(await staff.action('learn.asset.upload', { data: `data:image/png;base64,${PNG}`, name: 'map.png' })).asset;
  assert.equal(pic.kind, 'picture');
  const mp3 = ok(await staff.action('learn.asset.upload', { data: MP3, name: 'pitch.mp3' })).asset;
  assert.equal(mp3.content_type, 'audio/mpeg');
  assert.equal((await staff.action('learn.asset.upload', { data: Buffer.from('hello there, this is text').toString('base64'), name: 'x.txt' })).status, 400, 'not a file we take');
  const L = {};
  for (const [key, input] of [
    ['welcome', { kind: 'note', title: 'Welcome to Imagine Surrey', body: '# Hello\n\nWhat we stand for.' }],
    ['script', { kind: 'document', title: 'The door script', body: 'Read it twice.', asset_id: pdf.id }],
    ['video', { kind: 'video', title: 'How to knock', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }],
    ['audio', { kind: 'audio', title: 'The 30-second pitch', asset_id: mp3.id }],
    ['picture', { kind: 'picture', title: 'The turf map', asset_id: pic.id, audience: 'public' }],
    ['contacts', { kind: 'contacts', title: 'Who to call', body: '- Field director: 604-555-0100\n- Office: 604-555-0101' }],
    ['procedure', { kind: 'procedure', title: 'Closing a canvass shift', body: '1. Count the sheets\n2. Hand them in', audience: 'desk' }],
    ['draft', { kind: 'note', title: 'Not ready', body: 'soon', published: false }],
  ]) {
    L[key] = ok(await mgr.action('learn.lesson.save', { section_id: sec.id, ...input })).lesson;
  }
  ids.L = L;
  assert.equal((await mgr.action('learn.lesson.save', { title: 'bad', kind: 'video', link: 'javascript:alert(1)' })).status, 400, 'links are https');
  assert.equal((await mgr.action('learn.lesson.save', { title: 'bad', kind: 'note', section_id: '00000000-0000-4000-8000-000000000000' })).status, 404);

  const desk = ok(await staff.get('/api/learn'));
  assert.equal(desk.sections.length, 1);
  assert.equal(desk.sections[0].lessons.length, 8, 'the desk sees drafts and desk-only lessons');
  assert.equal(desk.total, 8);
  assert.equal(desk.sections[0].lessons[1].asset.url, `/api/learn/assets/${pdf.id}`);
  const theirs = ok(await vol.get('/api/learn'));
  assert.deepEqual(theirs.sections[0].lessons.map((l) => l.title), ['Welcome to Imagine Surrey', 'The door script', 'How to knock', 'The 30-second pitch', 'The turf map', 'Who to call'], 'not the draft, not the desk-only procedure');
  assert.equal(theirs.members, undefined, 'the headcount is the desk’s');
  assert.equal((await vol.get(`/api/learn/lessons/${L.procedure.id}`)).status, 404);
  assert.equal((await vol.get(`/api/learn/lessons/${L.draft.id}`)).status, 404);
  const one = ok(await vol.get(`/api/learn/lessons/${L.welcome.id}`)).lesson;
  assert.equal(one.body, '# Hello\n\nWhat we stand for.');
  assert.equal(one.done, false);
});

test('files: served to those who may see the lesson; a desk-only lesson’s file stays with the desk', async () => {
  const { L } = ids;
  const r = await vol.req('GET', `/api/learn/assets/${L.script.asset_id || (await mgr.get(`/api/learn/lessons/${L.script.id}`)).json.lesson.asset.id}`);
  assert.equal(r.status, 200);
  const pdfId = (await mgr.get(`/api/learn/lessons/${L.script.id}`)).json.lesson.asset.id;
  const res = await app.request(`/api/learn/assets/${pdfId}`, { headers: { cookie: vol.cookie } });
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /^inline; filename="Door script.pdf"/);
  const dl = await app.request(`/api/learn/assets/${pdfId}?download=1`, { headers: { cookie: vol.cookie } });
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  // A file behind a desk-only lesson only.
  const secret = ok(await mgr.action('learn.asset.upload', { data: PDF, name: 'Donor list.pdf' })).asset;
  ok(await mgr.action('learn.lesson.save', { title: 'Donor procedure', kind: 'document', asset_id: secret.id, audience: 'desk' }));
  assert.equal((await app.request(`/api/learn/assets/${secret.id}`, { headers: { cookie: vol.cookie } })).status, 404);
  assert.equal((await app.request(`/api/learn/assets/${secret.id}`, { headers: { cookie: staff.cookie } })).status, 200);
  assert.equal((await app.request(`/api/learn/assets/${secret.id}`)).status, 401, 'signed in only');
});

test('done: each person marks their own; the desk sees who has done what', async () => {
  const { L } = ids;
  const d = ok(await vol.action('learn.done', { lesson_id: L.welcome.id }));
  assert.equal(d.done, true);
  ok(await vol.action('learn.done', { lesson_id: L.script.id }));
  assert.equal((await vol.action('learn.done', { lesson_id: L.procedure.id })).status, 403, 'not theirs to do');
  const mine = ok(await vol.get('/api/learn'));
  assert.equal(mine.done, 2);
  assert.equal(mine.sections[0].lessons.find((l) => l.id === L.welcome.id).done, true);
  ok(await vol.action('learn.done', { lesson_id: L.script.id, done: false }));
  assert.equal(ok(await vol.get('/api/learn')).done, 1);
  assert.equal((await vol.get('/api/learn/progress')).status, 403);
  const prog = ok(await mgr.get('/api/learn/progress'));
  const vic = prog.members.find((m) => m.name === 'Vic');
  assert.equal(vic.done, 1);
  assert.equal(vic.of, 6, 'of the lessons a volunteer may see');
  assert.ok(vic.lessons[L.welcome.id]);
  const deskView = ok(await mgr.get('/api/learn'));
  assert.equal(deskView.sections[0].lessons.find((l) => l.id === L.welcome.id).done_by, 1);
  assert.equal(deskView.members, 3);
});

test('public: a lesson marked public has a page on the site; nothing else does', async () => {
  const { L } = ids;
  const list = await get('/learn/imagine-surrey');
  assert.equal(list.status, 200);
  assert.match(list.text, /The turf map/);
  assert.doesNotMatch(list.text, /Welcome to Imagine Surrey|Donor procedure|Not ready/);
  const page = await get(`/learn/imagine-surrey/${L.picture.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>The turf map · Imagine Surrey<\/title>/);
  assert.match(page.text, new RegExp(`<img src="/learn-files/${L.picture.asset_id}"`));
  assert.equal((await get(`/learn/imagine-surrey/${L.welcome.id}`)).status, 404, 'everyone-signed-in is not public');
  assert.equal((await get(`/learn/imagine-surrey/${L.procedure.id}`)).status, 404);
  assert.equal((await get(`/learn-files/${L.picture.asset_id}`)).status, 200, 'the public lesson’s picture');
  const pdfId = (await mgr.get(`/api/learn/lessons/${L.script.id}`)).json.lesson.asset.id;
  assert.equal((await get(`/learn-files/${pdfId}`)).status, 404, 'a signed-in lesson’s file is not');
  assert.equal((await get('/learn/no-such-campaign')).status, 404);
  // The video lesson, made public, embeds YouTube without cookies.
  ok(await mgr.action('learn.lesson.save', { id: L.video.id, title: L.video.title, kind: 'video', link: L.video.link, audience: 'public' }));
  const vid = await get(`/learn/imagine-surrey/${L.video.id}`);
  assert.match(vid.text, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
});

test('removing: a section leaves its lessons unfiled; a removed lesson is gone from every view', async () => {
  const { L } = ids;
  ok(await mgr.action('learn.lesson.remove', { id: L.draft.id }));
  assert.equal((await mgr.get(`/api/learn/lessons/${L.draft.id}`)).status, 404);
  ok(await mgr.action('learn.section.remove', { id: ids.sec }));
  const after = ok(await mgr.get('/api/learn'));
  assert.equal(after.sections.length, 0);
  assert.ok(after.unfiled.some((l) => l.id === L.welcome.id), 'its lessons stay, unfiled');
  assert.equal((await get(`/learn/imagine-surrey/${L.picture.id}`)).status, 200, 'the public page stays');
});
