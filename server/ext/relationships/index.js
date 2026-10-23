// Relationships — relational organizing: who knows whom.
//
// A link says two people in the directory know each other ("Priya knows
// Sam"), with a kind (Family · Friend · Neighbour · Work · Community · Other)
// and an optional short note. Links are undirected and deduped; removing one
// is an action too. A volunteer keeps "My people" — the people they know —
// adds someone new (found first by the dedupe rules, else added, "Brought in
// by" them), and reaches them from there: Call or Text (the Calls card) or a
// talk in person, logged through contact.log (channel 'in_person'), so counts,
// ladders and surveys work as for any other contact. The desk sees a
// profile's Knows (with a nudge naming a supporter who knows an undecided
// voter) and People → Most connected.
//
//   sql.js      the relationships table; contacts.channel takes 'in_person'
//   match.js    the signed-in person's record; who is already on the list
//   actions.js  relationship.add · relationship.remove
//   api.js      GET /api/relationships/mine (any role) and the desk-only reads
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
import { myPeopleCount } from './api.js';

// Today: the in-person talks of the last 7 days — inPerson: { week, mine }
// beside the core's field counts (doors, calls, texts; field.week already
// counts every contact, these too) — and how many people the signed-in
// person knows (myPeople: "My people · 6").
const brief = async (db, ctx, body) => {
  const r = (await db.query(
    `select count(*)::int as n, (count(*) filter (where created_by = $2))::int as mine from contacts
     where workspace_id = $1 and channel = 'in_person' and created_at >= now() - interval '7 days'`,
    [ctx.workspaceId, ctx.user.id],
  )).rows[0];
  body.inPerson = { week: r.n, mine: r.mine };
  body.myPeople = await myPeopleCount(db, ctx);
};

export const hooks = { brief };

// In the full export: every link, removed ones included.
export const exportTables = ['relationships'];

// Volunteers read only their own circle (/relationships/mine). A profile's
// Knows and Most connected are desk reads.
export const deskOnlyReads = [
  '/persons/:id/knows',
  '/relationships/connected',
];
