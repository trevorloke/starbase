// Files with a send: a PDF, a picture, a Word, PowerPoint or Excel file, a
// calendar invite, a plain-text or CSV file — at most ATTACH_MAX bytes
// each, ATTACH_COUNT per send, ATTACH_TOTAL together (the email service
// takes 40 MB a message; a newsletter should stay far under it).
//
//   blast.attach     { data (base64), name } → { attachment: { id, filename, bytes } }
//                    an upload of the person's own, not yet on any send
//   blast.unattach   { id } — takes one of those back
//   blast.picture    { data, name?, width?, height? } → { media: { id, url } }
//                    a picture for the message's body (/media/:id serves it
//                    to every mail app), for anyone who may send
//   bindAttachments  on Send: the uploads named become the send's
//   loadAttachments  the send's files, as the email service takes them
//   attachmentsOf    { blastId: [{ id, filename, bytes }] } for GET /blasts
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { readUpload } from './media.js';

export const ATTACH_MAX = 5 * 1024 * 1024;
export const ATTACH_TOTAL = 10 * 1024 * 1024;
export const ATTACH_COUNT = 5;
const DESK = ['manager', 'treasurer', 'staff'];

// What a file is, by its name. Anything else is refused: an email with a
// program or a script in it is one most mail services refuse anyway.
const TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain', csv: 'text/csv', ics: 'text/calendar',
};
export const ATTACH_KINDS = 'a PDF, a picture (JPG, PNG, WebP, GIF), a Word, PowerPoint or Excel file, a calendar invite (.ics), or a plain-text or CSV file';
const mb = (n) => `${Math.round(n / 1024 / 1024)} MB`;

export const readAttachment = (data, name) => {
  const filename = String(name || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200);
  const ext = filename.toLowerCase().split('.').pop();
  if (!filename || !filename.includes('.') || !TYPES[ext]) return { error: `use ${ATTACH_KINDS}` };
  const b64 = String(data || '').replace(/^data:[^;,]*;base64,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return { error: 'not a file' };
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return { error: 'empty file' };
  if (buf.length > ATTACH_MAX) return { error: `this file is too big — ${mb(ATTACH_MAX)} at most; link to it instead` };
  return { buf, filename, type: TYPES[ext] };
};

export const actions = {
  'blast.attach': {
    roles: DESK,
    input: z.object({ data: z.string().min(1).max(7_200_000), name: z.string().min(1).max(300) }),
    handler: async (tx, ctx, input, emit) => {
      const f = readAttachment(input.data, input.name);
      if (f.error) throw httpError(400, f.error);
      // Uploads nobody ever sent go after a day.
      await tx.query(
        `delete from blast_attachments where workspace_id = $1 and blast_id is null and created_at < now() - interval '1 day'`,
        [ctx.workspaceId],
      );
      const id = newId();
      await tx.query(
        `insert into blast_attachments (id, workspace_id, filename, content_type, bytes, data, created_by)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ctx.workspaceId, f.filename, f.type, f.buf.length, f.buf, ctx.user.id],
      );
      const attachment = { id, filename: f.filename, bytes: f.buf.length };
      emit('blast_attachment', id, 'create', attachment);
      return { attachment };
    },
  },

  'blast.unattach': {
    roles: DESK,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const n = await tx.query(
        'delete from blast_attachments where id = $1 and workspace_id = $2 and blast_id is null and created_by = $3',
        [input.id, ctx.workspaceId, ctx.user.id],
      );
      if (n.affectedRows === 0) throw httpError(404, 'file not found');
      emit('blast_attachment', input.id, 'void', {});
      return { id: input.id };
    },
  },

  'blast.picture': {
    roles: DESK,
    input: z.object({
      data: z.string().min(1).max(3_000_000),
      name: z.string().trim().max(200).optional(),
      width: z.number().int().min(1).max(20_000).optional(),
      height: z.number().int().min(1).max(20_000).optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const up = readUpload(input.data);
      if (up.error) throw httpError(400, up.error);
      const id = newId();
      await tx.query(
        `insert into media (id, workspace_id, content_type, bytes, width, height, name, data, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, ctx.workspaceId, up.type, up.buf.length, input.width ?? null, input.height ?? null, input.name || null, up.buf, ctx.user?.id || null],
      );
      const media = { id, content_type: up.type, bytes: up.buf.length, width: input.width ?? null, height: input.height ?? null, name: input.name || null };
      emit('media', id, 'create', media);
      return { media: { ...media, url: `/media/${id}` } };
    },
  },
};

// On Send: the named uploads (the sender's own, on no send yet) become the
// send's. Answers them, in the order named; refuses what isn't there, too
// many, or too much together.
export const bindAttachments = async (tx, ctx, blastId, ids = []) => {
  const list = [...new Set(ids || [])];
  if (!list.length) return [];
  if (list.length > ATTACH_COUNT) throw httpError(400, `${ATTACH_COUNT} files at most on one send`);
  const { rows } = await tx.query(
    `select id, filename, bytes from blast_attachments
     where workspace_id = $1 and blast_id is null and created_by = $2 and id = any($3::uuid[])`,
    [ctx.workspaceId, ctx.user.id, list],
  );
  if (rows.length !== list.length) throw httpError(400, 'a file on this send is gone — attach it again');
  const total = rows.reduce((n, r) => n + Number(r.bytes), 0);
  if (total > ATTACH_TOTAL) throw httpError(400, `the files together are over ${mb(ATTACH_TOTAL)} — link to the big ones instead`);
  await tx.query('update blast_attachments set blast_id = $1 where workspace_id = $2 and id = any($3::uuid[])', [blastId, ctx.workspaceId, list]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return list.map((id) => ({ id, filename: byId.get(id).filename, bytes: Number(byId.get(id).bytes) }));
};

// A send's files (or, for a test, the sender's unbound uploads named), as
// the email service takes them: { filename, content (base64), content_type }.
export const loadAttachments = async (db, workspaceId, { blastId = null, ids = null, userId = null } = {}) => {
  const { rows } = blastId
    ? await db.query(
      'select filename, content_type, data from blast_attachments where workspace_id = $1 and blast_id = $2 order by created_at, id',
      [workspaceId, blastId],
    )
    : await db.query(
      `select id, filename, content_type, data from blast_attachments
       where workspace_id = $1 and blast_id is null and created_by = $2 and id = any($3::uuid[])`,
      [workspaceId, userId, ids || []],
    );
  const ordered = ids ? ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean) : rows;
  return ordered.map((r) => ({ filename: r.filename, content_type: r.content_type, content: Buffer.from(r.data).toString('base64') }));
};

// Every send's files, without their bytes: { blastId: [{ id, filename, bytes }] }.
export const attachmentsOf = async (db, workspaceId) => {
  const { rows } = await db.query(
    'select id, blast_id, filename, bytes from blast_attachments where workspace_id = $1 and blast_id is not null order by created_at, id',
    [workspaceId],
  );
  const out = {};
  for (const r of rows) (out[r.blast_id] ||= []).push({ id: r.id, filename: r.filename, bytes: Number(r.bytes) });
  return out;
};
