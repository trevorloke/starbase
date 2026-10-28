// The promise tracker's writes (managers and staff, like the website):
//   tracker.promise.save        { id?, number, title, specifics, area, sources: [{label, url?}],
//                                 status?, test_kept, test_partly, test_broken, test_record }
//   tracker.promise.delete      { id }
//   tracker.update.add          { promise_id, date, status?, note, url? } — the record behind a
//                               score; with a status it changes the promise's, and the date
//   tracker.update.delete       { id }
//   tracker.announcement.save   { id?, date, date_label, title, commitments, sources }
//   tracker.announcement.delete { id }
//   tracker.seed                {} — the 26 promises as first published, into a campaign with none
import { z } from 'zod';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import { SEED } from './seed.js';

const EDIT = ['manager', 'staff'];
export const STATUSES = ['not_started', 'in_progress', 'kept', 'partly_kept', 'broken'];
const text = (max) => z.string().trim().max(max);
const date = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-11-02');
const url = () => z.union([z.literal(''), z.string().trim().max(500).regex(/^https?:\/\/[^\s"'<>]+$/, 'a link starting with http')]);
const sources = () => z.array(z.object({ label: text(200).min(1), url: url().optional() })).max(20);
const status = () => z.enum(STATUSES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const promiseOut = (r) => ({ ...r, sources: typeof r.sources === 'string' ? JSON.parse(r.sources) : r.sources });

export const actions = {
  'tracker.promise.save': {
    roles: EDIT,
    input: z.object({
      id: z.uuid().optional(),
      number: z.number().int().min(1).max(999),
      title: text(300).min(1),
      specifics: text(2000).default(''),
      area: text(80).default(''),
      sources: sources().default([]),
      status: status().optional(),
      test_kept: text(2000).nullish(),
      test_partly: text(2000).nullish(),
      test_broken: text(2000).nullish(),
      test_record: text(2000).nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const cur = input.id ? (await tx.query('select * from tracker_promises where id = $1 and workspace_id = $2 for update', [input.id, ws])).rows[0] : null;
      if (input.id && !cur) throw httpError(404, 'promise not found');
      const taken = (await tx.query('select id from tracker_promises where workspace_id = $1 and number = $2', [ws, input.number])).rows[0];
      if (taken && taken.id !== cur?.id) throw httpError(400, `promise ${input.number} is already there`);
      const id = cur?.id || newId();
      const st = input.status || cur?.status || 'not_started';
      const changed = st !== (cur?.status || 'not_started');
      const row = [id, ws, input.number, input.title, input.specifics, input.area, JSON.stringify(input.sources), st,
        input.test_kept ?? cur?.test_kept ?? null, input.test_partly ?? cur?.test_partly ?? null, input.test_broken ?? cur?.test_broken ?? null, input.test_record ?? cur?.test_record ?? null];
      if (cur) {
        await tx.query(
          `update tracker_promises set number = $3, title = $4, specifics = $5, area = $6, sources = $7, status = $8,
             test_kept = $9, test_partly = $10, test_broken = $11, test_record = $12,
             status_changed_at = case when $8 <> status then now() else status_changed_at end, updated_at = now()
           where id = $1 and workspace_id = $2`, row,
        );
      } else {
        await tx.query(
          `insert into tracker_promises (id, workspace_id, number, title, specifics, area, sources, status, test_kept, test_partly, test_broken, test_record, status_changed_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, case when $8 <> 'not_started' then now() end)`, row,
        );
      }
      emit('tracker_promise', id, cur ? 'update' : 'create', { number: input.number, title: input.title, area: input.area, status: st, ...(changed ? { status_changed: true } : {}) });
      return { promise: { id, number: input.number, title: input.title, status: st } };
    },
  },

  'tracker.promise.delete': {
    roles: EDIT,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const n = await tx.query('delete from tracker_promises where id = $1 and workspace_id = $2', [input.id, ctx.workspaceId]);
      if (n.affectedRows === 0) throw httpError(404, 'promise not found');
      emit('tracker_promise', input.id, 'void', {});
      return { id: input.id };
    },
  },

  'tracker.update.add': {
    roles: EDIT,
    input: z.object({
      promise_id: z.uuid(),
      date: date(),
      status: status().nullish(),
      note: text(2000).min(1),
      url: url().optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const p = (await tx.query('select id, status from tracker_promises where id = $1 and workspace_id = $2 for update', [input.promise_id, ws])).rows[0];
      if (!p) throw httpError(404, 'promise not found');
      const id = newId();
      await tx.query(
        'insert into tracker_updates (id, workspace_id, promise_id, date, status, note, url) values ($1, $2, $3, $4, $5, $6, $7)',
        [id, ws, p.id, input.date, input.status || null, input.note, input.url || null],
      );
      if (input.status && input.status !== p.status) {
        await tx.query(
          `update tracker_promises set status = $3, status_changed_at = ($4::date)::timestamptz, updated_at = now() where id = $1 and workspace_id = $2`,
          [p.id, ws, input.status, input.date],
        );
        emit('tracker_promise', p.id, 'update', { status: input.status, status_changed_at: input.date });
      }
      emit('tracker_update', id, 'create', { promise_id: p.id, date: input.date, status: input.status || null, note: input.note, url: input.url || null });
      return { update: { id, promise_id: p.id, date: input.date, status: input.status || null, note: input.note, url: input.url || null }, promise_status: input.status || p.status };
    },
  },

  'tracker.update.delete': {
    roles: EDIT,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const n = await tx.query('delete from tracker_updates where id = $1 and workspace_id = $2', [input.id, ctx.workspaceId]);
      if (n.affectedRows === 0) throw httpError(404, 'update not found');
      emit('tracker_update', input.id, 'void', {});
      return { id: input.id };
    },
  },

  'tracker.announcement.save': {
    roles: EDIT,
    input: z.object({
      id: z.uuid().optional(),
      date: date(),
      date_label: text(80).default(''),
      title: text(300).min(1),
      commitments: text(4000).default(''),
      sources: sources().default([]),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const cur = input.id ? (await tx.query('select id from tracker_announcements where id = $1 and workspace_id = $2', [input.id, ws])).rows[0] : null;
      if (input.id && !cur) throw httpError(404, 'announcement not found');
      const id = cur?.id || newId();
      const row = [id, ws, input.date, input.date_label, input.title, input.commitments, JSON.stringify(input.sources)];
      if (cur) {
        await tx.query('update tracker_announcements set date = $3, date_label = $4, title = $5, commitments = $6, sources = $7 where id = $1 and workspace_id = $2', row);
      } else {
        await tx.query('insert into tracker_announcements (id, workspace_id, date, date_label, title, commitments, sources) values ($1, $2, $3, $4, $5, $6, $7)', row);
      }
      emit('tracker_announcement', id, cur ? 'update' : 'create', { date: input.date, title: input.title });
      return { announcement: { id, date: input.date, date_label: input.date_label, title: input.title } };
    },
  },

  'tracker.announcement.delete': {
    roles: EDIT,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const n = await tx.query('delete from tracker_announcements where id = $1 and workspace_id = $2', [input.id, ctx.workspaceId]);
      if (n.affectedRows === 0) throw httpError(404, 'announcement not found');
      emit('tracker_announcement', input.id, 'void', {});
      return { id: input.id };
    },
  },

  // The tracker as first published, for a campaign with no promises yet.
  'tracker.seed': {
    roles: EDIT,
    input: z.object({}),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const n = (await tx.query('select count(*)::int as n from tracker_promises where workspace_id = $1', [ws])).rows[0].n;
      if (n > 0) throw httpError(409, 'this campaign already has promises — add the rest by hand');
      const testOf = new Map();
      for (const t of SEED.tests) for (const num of t.promises) testOf.set(num, t);
      for (const p of SEED.promises) {
        const t = testOf.get(p.number) || {};
        await tx.query(
          `insert into tracker_promises (id, workspace_id, number, title, specifics, area, sources, status, test_kept, test_partly, test_broken, test_record)
           values ($1, $2, $3, $4, $5, $6, $7, 'not_started', $8, $9, $10, $11)`,
          [newId(), ws, p.number, p.title, p.specifics || '', p.area || '', JSON.stringify(p.sources || []), t.kept || null, t.partly || null, t.broken || null, t.record || null],
        );
      }
      for (const a of SEED.announcements) {
        await tx.query(
          'insert into tracker_announcements (id, workspace_id, date, date_label, title, commitments, sources) values ($1, $2, $3, $4, $5, $6, $7)',
          [newId(), ws, a.date, a.dateLabel || '', a.title, a.commitments || '', JSON.stringify(a.sources || [])],
        );
      }
      emit('tracker_promise', ws, 'create', { seeded: SEED.promises.length, announcements: SEED.announcements.length });
      return { promises: SEED.promises.length, announcements: SEED.announcements.length };
    },
  },
};

export { promiseOut, UUID };
