// learn.section.save    { id?, title, note?, position? }        desk
// learn.section.remove  { id }                                   desk: void (its lessons stay, unfiled)
// learn.lesson.save     { id?, section_id?, title, kind, body?, link?, asset_id?, audience?, published?, position? }  desk
// learn.lesson.remove   { id }                                   desk: void
// learn.asset.upload    { data (base64), name }                  desk → { asset }
// learn.done            { lesson_id, done }                      anyone: I have done this lesson (or not)
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { readFile, kindOfType } from './files.js';

const DESK = ['manager', 'staff', 'treasurer'];
const ALL = ['manager', 'treasurer', 'staff', 'volunteer'];
const uuid = () => z.uuid();
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const KINDS = ['note', 'document', 'video', 'audio', 'picture', 'contacts', 'procedure'];
export const AUDIENCES = ['everyone', 'desk', 'public'];
const LINK_RE = /^https:\/\/[^\s]{1,500}$/i;

const sectionOf = async (tx, ws, id) => {
  const s = (await tx.query('select * from learn_sections where id = $1 and workspace_id = $2 and deleted_at is null', [id, ws])).rows[0];
  if (!s) throw httpError(404, 'section not found');
  return s;
};
const lessonOf = async (tx, ws, id) => {
  const l = (await tx.query('select * from learn_lessons where id = $1 and workspace_id = $2 and deleted_at is null', [id, ws])).rows[0];
  if (!l) throw httpError(404, 'lesson not found');
  return l;
};
const nextPosition = async (tx, table, ws, extra = '', params = []) => {
  const r = (await tx.query(`select coalesce(max(position), 0) + 1 as p from ${table} where workspace_id = $1 and deleted_at is null ${extra}`, [ws, ...params])).rows[0];
  return Number(r.p) || 1;
};

export const actions = {
  'learn.section.save': {
    roles: DESK,
    input: z.object({ id: uuid().optional(), title: z.string().max(120), note: z.string().max(500).nullish(), position: z.number().int().min(0).max(10_000).optional() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const title = clean(input.title);
      if (!title) throw httpError(400, 'a section needs a title');
      const note = clean(input.note) || null;
      if (input.id) {
        const cur = await sectionOf(tx, ws, input.id);
        const position = input.position ?? cur.position;
        await tx.query('update learn_sections set title = $3, note = $4, position = $5, updated_at = now() where id = $1 and workspace_id = $2', [cur.id, ws, title, note, position]);
        emit('learn_section', cur.id, 'update', { title, note, position });
        return { section: { ...cur, title, note, position } };
      }
      const id = newId();
      const position = input.position ?? await nextPosition(tx, 'learn_sections', ws);
      await tx.query('insert into learn_sections (id, workspace_id, title, note, position) values ($1, $2, $3, $4, $5)', [id, ws, title, note, position]);
      emit('learn_section', id, 'create', { title, note, position });
      return { section: { id, title, note, position } };
    },
  },
  'learn.section.remove': {
    roles: DESK,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await sectionOf(tx, ctx.workspaceId, input.id);
      await tx.query('update learn_sections set deleted_at = now(), updated_at = now() where id = $1', [cur.id]);
      await tx.query('update learn_lessons set section_id = null, updated_at = now() where section_id = $1', [cur.id]);
      emit('learn_section', cur.id, 'void', {});
      return { removed: true };
    },
  },
  'learn.lesson.save': {
    roles: DESK,
    input: z.object({
      id: uuid().optional(),
      section_id: uuid().nullish(),
      title: z.string().max(160),
      kind: z.enum(KINDS),
      body: z.string().max(30_000).nullish(),
      link: z.string().max(500).nullish(),
      asset_id: uuid().nullish(),
      audience: z.enum(AUDIENCES).optional(),
      published: z.boolean().optional(),
      position: z.number().int().min(0).max(10_000).optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const title = clean(input.title);
      if (!title) throw httpError(400, 'a lesson needs a title');
      const link = clean(input.link) || null;
      if (link && !LINK_RE.test(link)) throw httpError(400, 'a link starts with https://');
      if (input.section_id) await sectionOf(tx, ws, input.section_id);
      if (input.asset_id) {
        const a = (await tx.query('select id from learn_assets where id = $1 and workspace_id = $2', [input.asset_id, ws])).rows[0];
        if (!a) throw httpError(404, 'file not found');
      }
      const body = String(input.body ?? '');
      const cur = input.id ? await lessonOf(tx, ws, input.id) : null;
      const row = {
        section_id: input.section_id === undefined ? (cur?.section_id ?? null) : input.section_id,
        title, kind: input.kind, body, link,
        asset_id: input.asset_id === undefined ? (cur?.asset_id ?? null) : input.asset_id,
        audience: input.audience ?? cur?.audience ?? 'everyone',
        published: input.published ?? cur?.published ?? true,
      };
      if (cur) {
        const position = input.position ?? cur.position;
        await tx.query(
          `update learn_lessons set section_id = $3, title = $4, kind = $5, body = $6, link = $7, asset_id = $8, audience = $9, published = $10, position = $11, updated_at = now()
           where id = $1 and workspace_id = $2`,
          [cur.id, ws, row.section_id, row.title, row.kind, row.body, row.link, row.asset_id, row.audience, row.published, position],
        );
        emit('learn_lesson', cur.id, 'update', { ...row, body: undefined, position });
        return { lesson: { ...cur, ...row, position } };
      }
      const id = newId();
      const position = input.position ?? await nextPosition(tx, 'learn_lessons', ws, 'and section_id is not distinct from $2', [row.section_id]);
      await tx.query(
        `insert into learn_lessons (id, workspace_id, section_id, title, kind, body, link, asset_id, audience, published, position, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [id, ws, row.section_id, row.title, row.kind, row.body, row.link, row.asset_id, row.audience, row.published, position, ctx.user.id],
      );
      emit('learn_lesson', id, 'create', { ...row, body: undefined, position });
      return { lesson: { id, ...row, position } };
    },
  },
  'learn.lesson.remove': {
    roles: DESK,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await lessonOf(tx, ctx.workspaceId, input.id);
      await tx.query('update learn_lessons set deleted_at = now(), updated_at = now() where id = $1', [cur.id]);
      emit('learn_lesson', cur.id, 'void', {});
      return { removed: true };
    },
  },
  'learn.asset.upload': {
    roles: DESK,
    input: z.object({ data: z.string().min(1), name: z.string().max(200) }),
    handler: async (tx, ctx, input, emit) => {
      const name = clean(input.name) || 'file';
      const up = readFile(input.data, name);
      if (up.error) throw httpError(400, up.error);
      const id = newId();
      await tx.query(
        'insert into learn_assets (id, workspace_id, name, content_type, bytes, data, created_by) values ($1, $2, $3, $4, $5, $6, $7)',
        [id, ctx.workspaceId, name, up.type, up.buf.length, up.buf, ctx.user.id],
      );
      emit('learn_asset', id, 'create', { name, content_type: up.type, bytes: up.buf.length });
      return { asset: { id, name, content_type: up.type, bytes: up.buf.length, kind: kindOfType(up.type), url: `/api/learn/assets/${id}` } };
    },
  },
  'learn.done': {
    roles: ALL,
    input: z.object({ lesson_id: uuid(), done: z.boolean().optional() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const l = await lessonOf(tx, ws, input.lesson_id);
      if (l.audience === 'desk' && ctx.role === 'volunteer') throw httpError(403, 'this lesson is not for volunteers');
      const done = input.done !== false;
      if (done) {
        await tx.query(
          'insert into learn_done (workspace_id, user_id, lesson_id) values ($1, $2, $3) on conflict (workspace_id, user_id, lesson_id) do update set done_at = now()',
          [ws, ctx.user.id, l.id],
        );
      } else {
        await tx.query('delete from learn_done where workspace_id = $1 and user_id = $2 and lesson_id = $3', [ws, ctx.user.id, l.id]);
      }
      emit('learn_done', l.id, 'update', { user_id: ctx.user.id, done });
      return { lesson_id: l.id, done };
    },
  },
};
