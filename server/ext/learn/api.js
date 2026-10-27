// Reads:
//   GET /learn                 the sections and lessons this person may see
//                              (volunteers: published, everyone/public; the
//                              desk: all, drafts too), with "done" for me and,
//                              for the desk, how many have done each
//   GET /learn/lessons/:id     one lesson, its body and file
//   GET /learn/assets/:id      the file's bytes (signed in; a desk-only
//                              lesson's file stays with the desk)
//   GET /learn/progress        desk: every member, which lessons they've done
import { Hono } from 'hono';
import { kindOfType } from './files.js';

export const api = new Hono();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isDesk = (ctx) => ctx.role !== 'volunteer';
const visible = (ctx) => (isDesk(ctx) ? '' : "and l.published and l.audience in ('everyone', 'public')");

const assetOut = (a) => (a?.id ? { id: a.id, name: a.name, content_type: a.content_type, bytes: a.bytes, kind: kindOfType(a.content_type), url: `/api/learn/assets/${a.id}` } : null);
const lessonOut = (l, extra = {}) => ({
  id: l.id, section_id: l.section_id, title: l.title, kind: l.kind, link: l.link, audience: l.audience, published: l.published,
  position: l.position, updated_at: l.updated_at,
  asset: assetOut({ id: l.asset_id, name: l.asset_name, content_type: l.asset_type, bytes: l.asset_bytes }),
  ...extra,
});
const LESSON_SELECT = `select l.*, a.name as asset_name, a.content_type as asset_type, a.bytes as asset_bytes
  from learn_lessons l left join learn_assets a on a.id = l.asset_id`;

api.get('/learn', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db'); const ws = ctx.workspaceId;
  const sections = (await db.query('select id, title, note, position from learn_sections where workspace_id = $1 and deleted_at is null order by position, lower(title)', [ws])).rows;
  const lessons = (await db.query(`${LESSON_SELECT} where l.workspace_id = $1 and l.deleted_at is null ${visible(ctx)} order by l.position, lower(l.title)`, [ws])).rows;
  const mine = new Set((await db.query('select lesson_id from learn_done where workspace_id = $1 and user_id = $2', [ws, ctx.user.id])).rows.map((r) => r.lesson_id));
  let doneBy = new Map();
  if (isDesk(ctx)) {
    doneBy = new Map((await db.query('select lesson_id, count(*)::int as n from learn_done where workspace_id = $1 group by lesson_id', [ws])).rows.map((r) => [r.lesson_id, r.n]));
  }
  const out = lessons.map((l) => lessonOut(l, { done: mine.has(l.id), ...(isDesk(ctx) ? { done_by: doneBy.get(l.id) || 0 } : {}), excerpt: String(l.body || '').replace(/[#*_>`\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140) }));
  const members = isDesk(ctx) ? (await db.query('select count(*)::int as n from memberships where workspace_id = $1', [ws])).rows[0].n : undefined;
  return c.json({
    sections: sections.map((s) => ({ ...s, lessons: out.filter((l) => l.section_id === s.id) })),
    unfiled: out.filter((l) => !l.section_id || !sections.some((s) => s.id === l.section_id)),
    done: mine.size, total: out.length, members,
    public_url: `/learn/${ctx.workspace.slug}`,
  });
});

api.get('/learn/lessons/:id', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db');
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json({ error: 'not found' }, 404);
  const l = (await db.query(`${LESSON_SELECT} where l.id = $1 and l.workspace_id = $2 and l.deleted_at is null ${visible(ctx)}`, [id, ctx.workspaceId])).rows[0];
  if (!l) return c.json({ error: 'not found' }, 404);
  const done = (await db.query('select 1 from learn_done where workspace_id = $1 and user_id = $2 and lesson_id = $3', [ctx.workspaceId, ctx.user.id, id])).rows.length > 0;
  return c.json({ lesson: lessonOut(l, { body: l.body, done, public_url: l.audience === 'public' ? `/learn/${ctx.workspace.slug}/${l.id}` : null }) });
});

api.get('/learn/assets/:id', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db');
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.text('not found', 404);
  const a = (await db.query('select id, name, content_type, data from learn_assets where id = $1 and workspace_id = $2', [id, ctx.workspaceId])).rows[0];
  if (!a) return c.text('not found', 404);
  if (!isDesk(ctx)) {
    const ok = (await db.query(
      `select 1 from learn_lessons l where l.workspace_id = $1 and l.asset_id = $2 and l.deleted_at is null and l.published and l.audience in ('everyone', 'public')`,
      [ctx.workspaceId, id],
    )).rows.length > 0;
    if (!ok) return c.text('not found', 404);
  }
  return serveAsset(c, a, c.req.query('download') === '1');
});

export const serveAsset = (c, a, download = false) => {
  const body = Buffer.from(a.data);
  const safeName = String(a.name || 'file').replace(/[^\w.() -]+/g, '_').slice(0, 120);
  return c.body(body, 200, {
    'Content-Type': a.content_type,
    'Content-Length': String(body.length),
    'Content-Disposition': `${download || /officedocument|octet-stream/.test(a.content_type) ? 'attachment' : 'inline'}; filename="${safeName}"`,
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
};

api.get('/learn/progress', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db'); const ws = ctx.workspaceId;
  if (!isDesk(ctx)) return c.json({ error: 'desk only' }, 403);
  const lessons = (await db.query(`select id, title, kind, section_id, audience, published from learn_lessons where workspace_id = $1 and deleted_at is null order by position, lower(title)`, [ws])).rows;
  const members = (await db.query('select u.id, u.name, m.role from memberships m join users u on u.id = m.user_id where m.workspace_id = $1 order by lower(u.name)', [ws])).rows;
  const done = (await db.query('select user_id, lesson_id, done_at from learn_done where workspace_id = $1', [ws])).rows;
  const by = new Map();
  for (const d of done) { if (!by.has(d.user_id)) by.set(d.user_id, {}); by.get(d.user_id)[d.lesson_id] = d.done_at; }
  const forRole = (role) => lessons.filter((l) => l.published && (role !== 'volunteer' || l.audience !== 'desk'));
  return c.json({
    lessons,
    members: members.map((m) => {
      const mine = by.get(m.id) || {};
      const theirs = forRole(m.role);
      return { id: m.id, name: m.name, role: m.role, done: theirs.filter((l) => mine[l.id]).length, of: theirs.length, lessons: mine };
    }),
  });
});
