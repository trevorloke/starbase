// Lessons for supporters: a lesson whose audience is "public" has a page
// of its own — /learn/<slug> lists them, /learn/<slug>/<id> is one — in
// the look of Starbase's public pages (lib/publicpage.js). Its file is at
// /learn-files/<id>. Nothing else of ImagineU is public.
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { renderMarkdown, markdownText, escapeHtml as esc } from '@starbase/shared/markdown';
import { page as publicPage } from '../../lib/publicpage.js';
import { kindOfType } from './files.js';
import { serveAsset } from './api.js';

export const publicRoutes = new Hono();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const settingsOf = (ws) => (typeof ws.settings === 'string' ? JSON.parse(ws.settings) : (ws.settings || {}));
const wsBySlug = async (db, slug) => {
  const ws = (await db.query('select id, name, slug, jurisdiction, settings from workspaces where slug = $1', [slug])).rows[0];
  if (ws) ws.settings = settingsOf(ws);
  return ws;
};
const page = (c, db, ws, title, inner) => c.html(publicPage(ws, title, inner, { wide: true, noindex: true }));
const KIND_WORD = { note: 'Note', document: 'Document', video: 'Video', audio: 'Audio', picture: 'Picture', contacts: 'Contacts', procedure: 'Procedure' };
const PUBLIC = `l.workspace_id = $1 and l.deleted_at is null and l.published and l.audience = 'public'`;

const embed = (link) => {
  const m = /^https:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,20})/i.exec(link || '');
  if (m) return `<div class="learn-video"><iframe src="https://www.youtube-nocookie.com/embed/${esc(m[1])}" title="Video" allow="encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
  const v = /^https:\/\/(?:www\.)?vimeo\.com\/(\d{5,12})/i.exec(link || '');
  if (v) return `<div class="learn-video"><iframe src="https://player.vimeo.com/video/${esc(v[1])}" title="Video" allow="fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
  return link ? `<p><a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(link)}</a></p>` : '';
};
const media = (l) => {
  if (l.asset_id) {
    const url = `/learn-files/${l.asset_id}`;
    const k = kindOfType(l.asset_type);
    if (k === 'picture') return `<p><img src="${url}" alt="${esc(l.title)}" style="max-width:100%;height:auto;border-radius:12px"></p>`;
    if (k === 'audio') return `<p><audio controls preload="none" src="${url}"></audio></p>`;
    if (k === 'video') return `<p><video controls preload="metadata" src="${url}" style="max-width:100%;border-radius:12px"></video></p>`;
    if (l.asset_type === 'application/pdf') return `<p><a class="btn" href="${url}" target="_blank" rel="noopener">Open the PDF</a> <a href="${url}?download=1">Download</a></p>`;
    return `<p><a class="btn" href="${url}?download=1">Download ${esc(l.asset_name)}</a></p>`;
  }
  return embed(l.link);
};

publicRoutes.get('/learn/:ws', async (c) => {
  const db = await getDb();
  const ws = await wsBySlug(db, c.req.param('ws'));
  if (!ws) return c.text('not found', 404);
  const rows = (await db.query(
    `select l.id, l.title, l.kind, l.body, s.title as section from learn_lessons l left join learn_sections s on s.id = l.section_id and s.deleted_at is null
     where ${PUBLIC} order by s.position nulls last, l.position, lower(l.title)`, [ws.id],
  )).rows;
  const items = rows.map((l) => `<li><a href="/learn/${esc(ws.slug)}/${l.id}"><b>${esc(l.title)}</b></a> <span class="muted">· ${KIND_WORD[l.kind] || ''}${l.section ? ` · ${esc(l.section)}` : ''}</span>${l.body ? `<br><span class="muted">${esc(markdownText(l.body, 140))}</span>` : ''}</li>`).join('');
  return page(c, db, ws, 'ImagineU', `<h1>ImagineU</h1><p>What ${esc(ws.name)} is about, and how to help.</p>${items ? `<ul class="learn-list">${items}</ul>` : '<p class="muted">Nothing here yet.</p>'}`);
});

publicRoutes.get('/learn/:ws/:id', async (c) => {
  const db = await getDb();
  const ws = await wsBySlug(db, c.req.param('ws'));
  const id = c.req.param('id');
  if (!ws || !UUID.test(id)) return c.text('not found', 404);
  const l = (await db.query(
    `select l.*, a.name as asset_name, a.content_type as asset_type from learn_lessons l left join learn_assets a on a.id = l.asset_id where l.id = $2 and ${PUBLIC}`, [ws.id, id],
  )).rows[0];
  if (!l) return c.text('not found', 404);
  return page(c, db, ws, l.title, `<p><a href="/learn/${esc(ws.slug)}">← ImagineU</a></p><h1>${esc(l.title)}</h1>${media(l)}<div class="prose">${renderMarkdown(l.body || '')}</div>`);
});

publicRoutes.get('/learn-files/:id', async (c) => {
  const db = await getDb();
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.text('not found', 404);
  const a = (await db.query(
    `select a.id, a.name, a.content_type, a.data from learn_assets a
      where a.id = $1 and exists (select 1 from learn_lessons l where l.asset_id = a.id and l.workspace_id = a.workspace_id and l.deleted_at is null and l.published and l.audience = 'public')`, [id],
  )).rows[0];
  if (!a) return c.text('not found', 404);
  return serveAsset(c, a, c.req.query('download') === '1');
});
