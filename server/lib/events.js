// The write spine. Every mutation in the product goes through runAction():
// one transaction in which the handler's table writes, the event-log append,
// and the hash chain advance commit together or not at all. The events table
// IS the audit trail — there is no dual write to drift.
import { createHash, randomUUID } from 'node:crypto';
import { runHooks } from './hooks.js';

// Canonical JSON: object keys sorted recursively, so the same payload always
// hashes the same regardless of construction order.
export const canonical = (v) => {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
};

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export const chainHash = (prevHash, seq, action, entityType, entityId, op, actorId, payloadHash) =>
  sha256([prevHash, seq, action, entityType, entityId, op, actorId || '', payloadHash].join('|'));

// Run one action transactionally. `emit` collects events; they are appended
// with sequence numbers and chained hashes just before commit, under a row
// lock on the workspace so the per-workspace sequence is gapless and ordered.
export const runAction = async (db, { workspaceId, actorId, action, clientTs }, handler) => {
  return db.transaction(async (tx) => {
    const ws = (await tx.query(
      'select event_seq, last_event_hash from workspaces where id = $1 for update',
      [workspaceId],
    )).rows[0];
    if (!ws) throw new Error('workspace not found');

    const pending = [];
    const emit = (entityType, entityId, op, payload) =>
      pending.push({ entityType, entityId, op, payload });

    const result = await handler(tx, emit);
    // Feature modules see this write's events before they are chained (a
    // ladder enrolling a petition signer, say); what they emit joins them.
    if (pending.length) await runHooks('events', tx, { workspaceId, actorId, action, emit }, [...pending]);

    let seq = Number(ws.event_seq);
    let prev = ws.last_event_hash;
    for (const ev of pending) {
      seq += 1;
      // Normalize exactly as it will be stored (drops undefined, etc.) so the
      // hash we compute is the hash a verifier recomputes from the row.
      const payload = JSON.parse(JSON.stringify(ev.payload ?? {}));
      const payloadHash = sha256(canonical(payload));
      const hash = chainHash(prev, seq, action, ev.entityType, ev.entityId, ev.op, actorId, payloadHash);
      await tx.query(
        `insert into events (workspace_id, seq, action, entity_type, entity_id, op, payload, actor_id, client_ts, payload_hash, hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [workspaceId, seq, action, ev.entityType, ev.entityId, ev.op,
         JSON.stringify(payload), actorId || null, clientTs || null, payloadHash, hash],
      );
      prev = hash;
    }
    await tx.query(
      'update workspaces set event_seq = $2, last_event_hash = $3 where id = $1',
      [workspaceId, seq, prev],
    );
    return { result, lastSeq: seq };
  });
};

// Replay the chain and verify every link. Streams by cursor batches so a
// long log never loads at once. Returns { ok, checked, brokenAt? }.
export const verifyChain = async (db, workspaceId) => {
  let prev = '';
  let cursor = 0;
  let checked = 0;
  for (;;) {
    const { rows } = await db.query(
      `select seq, action, entity_type, entity_id, op, actor_id, payload, payload_hash, hash
       from events where workspace_id = $1 and seq > $2 order by seq limit 500`,
      [workspaceId, cursor],
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      const seq = Number(r.seq);
      if (seq !== checked + 1) return { ok: false, checked, brokenAt: seq, reason: 'gap' };
      const payloadHash = sha256(canonical(r.payload));
      if (payloadHash !== r.payload_hash) return { ok: false, checked, brokenAt: seq, reason: 'payload' };
      const expect = chainHash(prev, seq, r.action, r.entity_type, r.entity_id, r.op, r.actor_id, payloadHash);
      if (expect !== r.hash) return { ok: false, checked, brokenAt: seq, reason: 'chain' };
      prev = r.hash;
      checked = seq;
      cursor = seq;
    }
  }
  return { ok: true, checked };
};

export const newId = () => randomUUID();
