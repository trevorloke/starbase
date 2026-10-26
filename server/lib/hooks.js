// Extension points the core calls and feature modules (server/ext/*) fill.
// Kept free of imports so any module can use it without import cycles.
//
//   events(tx, meta, events)        every runAction, just before its events
//                                   are chained — meta { workspaceId,
//                                   actorId, action }, events [{ entityType,
//                                   entityId, op, payload }]. A hook may emit
//                                   more events with meta.emit(...) and they
//                                   join the same transaction and chain.
//   contactLogged(tx, ctx, { contact, input, reply }, emit)
//                                   after contact.log stores a contact (or
//                                   finishes the visit's earlier one); input
//                                   carries any extras such as survey answers;
//                                   fields put on reply go back to the caller.
//   brief(db, ctx, brief)           GET /api/brief, just before it is sent:
//                                   a feature may correct the counts it owns
//                                   (texts sent through the app, say).
//   textOut(tx, ctx, { phone, personId, kind }, out)
//                                   before the core texts someone from the
//                                   campaign's number (a shift notice): a
//                                   feature may set out.to (the number to
//                                   use) or out.status + out.detail
//                                   ('opted_out', 'quiet', 'failed') to hold
//                                   it back — nothing is sent then.
const registry = { events: [], contactLogged: [], brief: [], textOut: [] };

// People lists, imports and the sample campaign (ext/fields fills these):
//   personsWhere(db, ctx, query, w) GET /persons: a feature may narrow the
//                                   list by its own query parameters —
//                                   w.params.push(value), then append
//                                   ' and …$n…' to w.where.
//   importRows(db, ctx, extras)     POST /data/import, once per call: a
//                                   feature may push { check(raw) →
//                                   { value } | { error } (refuses the row),
//                                   apply(tx, personId, value, { write },
//                                   emit) → [words for what it filled] }.
//   sampleLoaded(tx, ctx, { people, emit })   the sample is loading;
//                                   people: { sample name → person id }.
//   sampleCleared(tx, ctx, { emit, said })    the sample is clearing, just
//                                   before its people go (void what it
//                                   made while they are still here);
//                                   said: sentences for the clear message.
//   workspaceCreated(tx, ctx, { emit })   the campaign was just set up
//                                   (routes/auth.js): a feature may make
//                                   what every campaign starts with.
Object.assign(registry, { personsWhere: [], importRows: [], sampleLoaded: [], sampleCleared: [], workspaceCreated: [] });

export const onHook = (name, fn) => {
  if (!registry[name]) throw new Error(`unknown hook ${name}`);
  registry[name].push(fn);
};

export const hasHook = (name) => (registry[name] || []).length > 0;

export const runHooks = async (name, ...args) => {
  for (const fn of registry[name] || []) await fn(...args);
};
