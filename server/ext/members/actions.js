// member.set   { id, status: 'active' | 'cancelled' | 'expired', note?, expires_at? }
//              the desk's hand on a membership: cancel one, mark one active
//              (a fee paid some other way, an old roll imported), or set
//              when it ends
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { markMember } from './public.js';
import { addYear } from './rules.js';

const DESK = ['manager', 'treasurer', 'staff'];

export const actions = {
  'member.set': {
    roles: DESK,
    input: z.object({
      id: z.uuid(),
      status: z.enum(['active', 'cancelled', 'expired']).optional(),
      expires_at: z.string().datetime({ offset: true }).nullish(),
      note: z.string().max(2000).nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = { id: ctx.workspaceId };
      const m = (await tx.query('select * from members where id = $1 and workspace_id = $2 for update', [input.id, ws.id])).rows[0];
      if (!m) throw httpError(404, 'membership not found');
      const status = input.status || m.status;
      let startsAt = m.starts_at;
      let expiresAt = input.expires_at !== undefined && input.expires_at !== null ? new Date(input.expires_at) : m.expires_at;
      if (status === 'active' && m.status !== 'active') {
        startsAt = startsAt || new Date();
        expiresAt = input.expires_at ? new Date(input.expires_at) : addYear(startsAt);
      }
      await tx.query(
        `update members set status = $3, starts_at = $4, expires_at = $5, note = coalesce($6, note), updated_at = now()
         where id = $1 and workspace_id = $2`,
        [m.id, ws.id, status, startsAt ? new Date(startsAt).toISOString() : null, expiresAt ? new Date(expiresAt).toISOString() : null, input.note ?? null],
      );
      if (status !== m.status) {
        if (status === 'active') await markMember(tx, emit, ws, m.person_id, true);
        else {
          // No other active membership: the tag goes.
          const other = (await tx.query(
            `select 1 from members where workspace_id = $1 and person_id = $2 and status = 'active' and id <> $3 limit 1`, [ws.id, m.person_id, m.id],
          )).rows[0];
          if (!other) {
            const row = (await tx.query('select tags from persons where id = $1 and workspace_id = $2', [m.person_id, ws.id])).rows[0];
            const tags = (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags || []).filter((t) => t !== 'member' && t !== 'member-pending');
            await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2', [m.person_id, ws.id, JSON.stringify(tags)]);
            emit('person', m.person_id, 'update', { tags, source: 'membership' });
          }
        }
      }
      const out = { id: m.id, status, starts_at: startsAt, expires_at: expiresAt, note: input.note ?? m.note };
      emit('member', m.id, 'update', { ...out, by: 'desk' });
      return { member: out };
    },
  },
};
