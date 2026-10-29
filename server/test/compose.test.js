// Richer emails from Starbase: a newsletter or press release is written in
// Markdown and goes out laid out (headings, bold, lists, pictures from
// /media with their full address), its links — typed as [words](url) or as
// bare addresses — tracked by number, a plain-text part alongside, and
// files attached on Send with every copy. "Send me a test" emails the
// writer alone, untracked, with nothing on record.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

const tag = Math.random().toString(36).slice(2, 8);
let db;
let mgr;
let treas;
let ws;

const tokenOf = (url) => url.split('/join/')[1];
const joinAs = async (role, name) => {
  const inv = await mgr.action('member.invite', { email: `${name}.${tag}@example.org`, role });
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  const cl = new Client();
  const r = await cl.post('/api/auth/join', { token: tokenOf(inv.json.joinUrl), name, password: 'compose-pass-2026' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return cl;
};

// Stand in for the email provider: every message's JSON body kept.
const withEmail = async (fn) => {
  const sent = [];
  const realFetch = globalThis.fetch;
  const hadKey = Object.hasOwn(process.env, 'RESEND_API_KEY');
  const oldKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-key';
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.resend.com/')) return realFetch(url, init);
    sent.push(JSON.parse(init.body));
    return new Response('{"id":"msg"}', { status: 200 });
  };
  try {
    return await fn(sent);
  } finally {
    globalThis.fetch = realFetch;
    if (hadKey) process.env.RESEND_API_KEY = oldKey; else delete process.env.RESEND_API_KEY;
  }
};

const b64 = (s) => Buffer.from(s).toString('base64');
const PDF = b64('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
// A 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

before(async () => {
  db = await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Compose ${tag}`, email: `compose.${tag}@example.org` });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  ws = r.json.workspace.id;
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await mgr.action('subscription.add', { email: `reader${i}.${tag}@example.org`, name: `Reader ${i}` })).status, 200);
  }
  treas = await joinAs('treasurer', 'Tess');
});

test('a Markdown message goes out laid out, with a plain-text part, its pictures at their full address and its links tracked by number', async () => {
  await withEmail(async (sent) => {
    const body = [
      '## Hello **friends**',
      '',
      'Read [the plan](https://imaginesurrey.example/plan) and https://imaginesurrey.example/news.',
      '',
      '![Holland Park](/media/11111111-1111-4111-8111-111111111111)',
      '',
      '- one',
      '- *two*',
      '',
      'See you <there> & then.',
    ].join('\n');
    const r = await mgr.action('blast.send', { kind: 'newsletter', subject: 'Laid out', body });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(sent.length, 3);
    const m = sent[0];
    // HTML: the layout, every tag with its own style, nothing typed reaching the page as a tag.
    assert.match(m.html, /<h3 style="[^"]+">Hello <strong>friends<\/strong><\/h3>/);
    assert.match(m.html, /<ul style="[^"]+"><li style="[^"]+">one<\/li><li style="[^"]+"><em>two<\/em><\/li><\/ul>/);
    assert.ok(m.html.includes('See you &lt;there&gt; &amp; then.'), 'typed angle brackets are words, not tags');
    assert.ok(m.html.includes('src="http://localhost/media/11111111-1111-4111-8111-111111111111"') || /src="[^"]+\/media\/11111111-1111-4111-8111-111111111111"/.test(m.html),
      `the picture at its full address: ${m.html.match(/<img[^>]+>/)?.[0]}`);
    // Links: the typed one is link 1, the bare one link 2, both through /c/<token>/<n>.
    const hrefs = [...m.html.matchAll(/<a href="([^"]+)"/g)].map((x) => x[1]);
    assert.equal(hrefs.length, 3, `two tracked links and Unsubscribe: ${hrefs}`);
    assert.match(hrefs[0], /\/c\/[A-Za-z0-9_-]{24}\/1$/);
    assert.match(hrefs[1], /\/c\/[A-Za-z0-9_-]{24}\/2$/);
    assert.match(hrefs[2], /\/u\//);
    assert.ok(m.html.includes('>the plan</a>'), 'the link keeps its words');
    assert.ok(m.html.includes('>https://imaginesurrey.example/news</a>'), 'a bare address shows as itself');
    const links = (await db.query('select n, url from blast_links where blast_id = $1 order by n', [r.json.blast.id])).rows;
    assert.deepEqual(links.map((l) => [l.n, l.url]), [[1, 'https://imaginesurrey.example/plan'], [2, 'https://imaginesurrey.example/news']]);
    // Text: the words, no marks, the link's address after its words.
    assert.ok(m.text.startsWith('Hello friends\n\nRead the plan (https://imaginesurrey.example/plan) and https://imaginesurrey.example/news.'), m.text);
    assert.ok(!m.text.includes('**') && !m.text.includes('##'), 'no formatting marks in the text part');
    assert.ok(/\/media\/11111111-1111-4111-8111-111111111111/.test(m.text));
    assert.ok(m.text.includes('Unsubscribe: '), 'the newsletter footer');
    assert.equal(m.attachments, undefined, 'nothing attached');
  });
});

test('files attached on Send go with every copy; too big, too many, or the wrong kind is refused; the list names them', async () => {
  const up = await mgr.action('blast.attach', { data: `data:application/pdf;base64,${PDF}`, name: 'Transit plan.pdf' });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.attachment.filename, 'Transit plan.pdf');
  const pic = await mgr.action('blast.attach', { data: PNG, name: 'map.png' });
  assert.equal(pic.status, 200);
  assert.equal((await mgr.action('blast.attach', { data: PDF, name: 'run.exe' })).status, 400, 'not a kind that goes by email');
  assert.equal((await mgr.action('blast.attach', { data: PDF, name: 'noext' })).status, 400);
  assert.equal((await mgr.action('blast.attach', { data: '', name: 'x.pdf' })).status, 400);
  const big = await mgr.action('blast.attach', { data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'), name: 'big.pdf' });
  assert.equal(big.status, 400);
  assert.match(big.json.error, /too big/);
  // Not the sender's own upload: refused on Send.
  const theirs = await treas.action('blast.attach', { data: PDF, name: 'tess.pdf' });
  assert.equal(theirs.status, 200, 'a treasurer may attach too');
  const wrong = await mgr.action('blast.send', { kind: 'newsletter', subject: 'x', body: 'y', attachment_ids: [theirs.json.attachment.id] });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /gone/);
  // Taken back: gone from the send.
  const spare = await mgr.action('blast.attach', { data: PDF, name: 'spare.pdf' });
  assert.equal((await mgr.action('blast.unattach', { id: spare.json.attachment.id })).status, 200);
  assert.equal((await mgr.action('blast.unattach', { id: spare.json.attachment.id })).status, 404);

  await withEmail(async (sent) => {
    const ids = [up.json.attachment.id, pic.json.attachment.id];
    const r = await mgr.action('blast.send', { kind: 'newsletter', subject: 'With files', body: 'Attached.', attachment_ids: ids });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.blast.attachments.map((a) => a.filename), ['Transit plan.pdf', 'map.png']);
    assert.equal(sent.length, 3);
    for (const m of sent) {
      assert.deepEqual(m.attachments.map((a) => a.filename), ['Transit plan.pdf', 'map.png']);
      assert.equal(Buffer.from(m.attachments[0].content, 'base64').toString().slice(0, 5), '%PDF-');
      assert.equal(m.attachments[1].content_type, 'image/png');
    }
    const listed = (await mgr.get('/api/blasts')).json.blasts.find((b) => b.id === r.json.blast.id);
    assert.deepEqual(listed.attachments.map((a) => a.filename), ['Transit plan.pdf', 'map.png']);
    assert.ok(listed.attachments.every((a) => a.bytes > 0 && !('data' in a)));
    // Bound now: a second send can't take them.
    assert.equal((await mgr.action('blast.send', { kind: 'newsletter', subject: 'Again', body: 'y', attachment_ids: ids })).status, 400);
    // The export names the files, never their bytes.
    const ex = (await mgr.get('/api/export')).json;
    assert.ok(ex.blast_attachments.some((a) => a.filename === 'map.png' && !('data' in a)));
  });
});

test('a picture for the message is stored like the website’s and served from /media — by a treasurer too', async () => {
  const r = await treas.action('blast.picture', { data: PNG, name: 'door.png', width: 1, height: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.media.url, `/media/${r.json.media.id}`);
  const got = await treas.get(r.json.media.url);
  assert.equal(got.status, 200);
  assert.equal((await treas.action('blast.picture', { data: PDF, name: 'plan.pdf' })).status, 400, 'pictures only');
});

test('"Send me a test" emails the writer alone — no tracking, no record — and is refused while email isn’t connected', async () => {
  delete process.env.RESEND_API_KEY;
  const off = await mgr.action('blast.test', { kind: 'newsletter', subject: 'Draft', body: 'Hi' });
  assert.equal(off.status, 409);
  await withEmail(async (sent) => {
    const file = await mgr.action('blast.attach', { data: PDF, name: 'draft.pdf' });
    const before = (await mgr.get('/api/blasts')).json.blasts.length;
    const r = await mgr.action('blast.test', {
      kind: 'newsletter', subject: 'Draft', body: 'Hi **all** — see https://imaginesurrey.example/plan', attachment_ids: [file.json.attachment.id],
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.sent, true);
    assert.equal(r.json.to, `compose.${tag}@example.org`);
    assert.equal(sent.length, 1);
    const m = sent[0];
    assert.deepEqual(m.to, [`compose.${tag}@example.org`]);
    assert.equal(m.subject, '[Test] Draft');
    assert.ok(!m.html.includes('/o/') && !m.html.includes('/c/'), 'nothing tracked on a test');
    assert.ok(m.html.includes('href="https://imaginesurrey.example/plan"'), 'the link as typed');
    assert.ok(m.html.includes('each recipient gets their own link'));
    assert.deepEqual(m.attachments.map((a) => a.filename), ['draft.pdf']);
    assert.equal((await mgr.get('/api/blasts')).json.blasts.length, before, 'nothing on record');
    // The file is still the writer's to send for real.
    const real = await mgr.action('blast.send', { kind: 'newsletter', subject: 'Real', body: 'Hi', attachment_ids: [file.json.attachment.id] });
    assert.equal(real.status, 200, JSON.stringify(real.json));
    assert.equal(sent.length, 4);
  });
});
