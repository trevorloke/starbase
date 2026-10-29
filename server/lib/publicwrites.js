// What every public submission does, shared by the public pages and
// bridge (routes/public.js) and any feature with a public form of its
// own: a write as the system, a person made or found and tagged, an
// address put on the newsletter list. Kept out of routes/* so a feature
// module can import it without an import cycle.
import { runAction, newId } from './events.js';

// Run one public write as a system action (no actor): its table writes and
// its events commit together, on the workspace's hash chain.
export const publicAction = async (db, ws, action, handler) =>
  (await runAction(db, { workspaceId: ws.id, actorId: null, action }, handler)).result;

// Create or reuse a person from a public submission (matched by email, else by
// name+phone), tag them, and record the source. Runs as a system action.
// upsertPersonTx is the same inside a caller's action (the store's paid
// webhook matches its buyer this way, in the payment's own transaction).
export const upsertPersonTx = async (tx, emit, ws, { name, email, phone, address }, tags) => {
  const em = email ? email.toLowerCase() : null;
  let person = em
    ? (await tx.query('select id, tags from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null limit 1', [ws.id, em])).rows[0]
    : null;
  if (!person && phone) {
    person = (await tx.query('select id, tags from persons where workspace_id = $1 and phone = $2 and lower(name) = lower($3) and deleted_at is null limit 1', [ws.id, phone, name])).rows[0];
  }
  if (person) {
    const existing = typeof person.tags === 'string' ? JSON.parse(person.tags) : (person.tags || []);
    const merged = Array.from(new Set([...existing, ...tags]));
    await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2', [person.id, ws.id, JSON.stringify(merged)]);
    emit('person', person.id, 'update', { tags: merged, source: 'public' });
    return { id: person.id, created: false };
  }
  const id = newId();
  await tx.query(
    `insert into persons (id, workspace_id, name, email, phone, address, tags) values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, ws.id, name, em, phone || null, address || null, JSON.stringify(tags)],
  );
  emit('person', id, 'create', { name, email: em, phone, address, tags, source: 'public' });
  return { id, created: true };
};
export const upsertPersonFromPublic = (db, ws, fields, tags) =>
  publicAction(db, ws, 'public.signup', (tx, emit) => upsertPersonTx(tx, emit, ws, fields, tags));

// Put an email on the newsletter list inside the caller's action. A new
// address is a create; a returning one is re-subscribed (and takes the newly
// given name, if any). Signing up again with nothing new writes nothing, so
// nothing is logged. The workspace row lock runAction holds serializes this
// read-then-write against every other action.
// They asked for email themselves, so a ladder email's unsubscribe
// (do-not-email, for an address that was never on the list) is lifted.
export const liftNoEmail = async (tx, emit, ws, em) => {
  const rows = (await tx.query(
    `select id, tags from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null
       and tags @> '"do-not-email"'::jsonb`,
    [ws.id, em],
  )).rows;
  for (const p of rows) {
    const tags = (typeof p.tags === 'string' ? JSON.parse(p.tags) : p.tags).filter((t) => t !== 'do-not-email');
    await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2', [p.id, ws.id, JSON.stringify(tags)]);
    emit('person', p.id, 'update', { tags, source: 'public' });
  }
};

export const subscribeTx = async (tx, emit, ws, email, name, source) => {
  const em = email.toLowerCase();
  await liftNoEmail(tx, emit, ws, em);
  const prev = (await tx.query(
    'select id, name, status from subscriptions where workspace_id = $1 and email = $2', [ws.id, em],
  )).rows[0];
  if (prev) {
    const nextName = name || prev.name || null;
    if (prev.status === 'subscribed' && nextName === (prev.name || null)) return { id: prev.id, changed: false };
    await tx.query(
      `update subscriptions set status = 'subscribed', name = $3, unsubscribed_at = null where id = $1 and workspace_id = $2`,
      [prev.id, ws.id, nextName],
    );
    emit('subscription', prev.id, 'update', { email: em, name: nextName, status: 'subscribed', source });
    return { id: prev.id, changed: true };
  }
  const id = newId();
  await tx.query(
    `insert into subscriptions (id, workspace_id, email, name, status, source) values ($1, $2, $3, $4, 'subscribed', $5)`,
    [id, ws.id, em, name || null, source],
  );
  emit('subscription', id, 'create', { email: em, name: name || null, status: 'subscribed', source });
  return { id, changed: true };
};

export const subscribe = (db, ws, email, name, source) =>
  publicAction(db, ws, 'public.subscribe', (tx, emit) => subscribeTx(tx, emit, ws, email, name, source));

