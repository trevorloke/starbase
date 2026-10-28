// A membership waiting on its fee turns active when its pledge is paid
// (the Stripe webhook's stripe.payment) or received (Donations → Mark
// received: pledge.receive) — in the same write, on the same chain.
import { addYear } from './rules.js';
import { markMember } from './public.js';

export const onEvents = async (tx, meta, events) => {
  for (const e of events) {
    if (e.entityType !== 'pledge' || e.op !== 'update' || !['paid', 'received'].includes(e.payload?.status)) continue;
    const m = (await tx.query(
      `select id, person_id from members where workspace_id = $1 and pledge_id = $2 and status = 'pending_payment' for update`,
      [meta.workspaceId, e.entityId],
    )).rows[0];
    if (!m) continue;
    // A renewal starts when the current membership ends.
    const current = (await tx.query(
      `select expires_at from members where workspace_id = $1 and person_id = $2 and status = 'active' and expires_at > now()
       order by expires_at desc limit 1`, [meta.workspaceId, m.person_id],
    )).rows[0];
    const startsAt = current ? new Date(current.expires_at) : new Date();
    const expiresAt = addYear(startsAt);
    await tx.query(
      `update members set status = 'active', starts_at = $3, expires_at = $4, updated_at = now() where id = $1 and workspace_id = $2`,
      [m.id, meta.workspaceId, startsAt.toISOString(), expiresAt.toISOString()],
    );
    const ws = { id: meta.workspaceId };
    await markMember(tx, meta.emit, ws, m.person_id, true);
    meta.emit('member', m.id, 'update', { status: 'active', starts_at: startsAt.toISOString(), expires_at: expiresAt.toISOString(), pledge_id: e.entityId });
  }
};
