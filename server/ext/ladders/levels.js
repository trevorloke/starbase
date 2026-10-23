// Engagement level — computed from what people did, never stored:
//   Contact → Supporter (rated 1 or 2) → Signer (a petition, the newsletter,
//   an RSVP) → Donor or volunteer (a gift; a volunteer role or a shift) →
//   Leader (a captain, host or committee role, or 3+ shifts done).
// A person is the highest level they reached.
export const LEVELS = [
  { code: 'contact', label: 'Contact' },
  { code: 'supporter', label: 'Supporter' },
  { code: 'signer', label: 'Signer' },
  { code: 'doer', label: 'Donor or volunteer' },
  { code: 'leader', label: 'Leader' },
];
const LEADER_ROLES = ['zone_house_captain', 'highrise_captain', 'event_hosting', 'community_committee'];

// One row per person (or just `personId`): the facts each level needs.
const factsSql = (onePerson) => `
  with lead as (
    select person_id from volunteer_roles where workspace_id = $1 and role = any($2::text[])
    union
    select person_id from shift_assignments where workspace_id = $1 and status = 'completed'
    group by person_id having count(*) >= 3
  ),
  donor as (select distinct person_id from gifts where workspace_id = $1 and deleted_at is null),
  vol as (
    select person_id from volunteer_roles where workspace_id = $1
    union
    select person_id from shift_assignments where workspace_id = $1 and status in ('assigned', 'confirmed', 'completed')
  ),
  signed as (
    select lower(email) as email from petition_signatures where workspace_id = $1 and email is not null
    union
    select email from subscriptions where workspace_id = $1 and status = 'subscribed'
  ),
  rsvp as (select distinct person_id from event_rsvps where workspace_id = $1 and person_id is not null and status <> 'cancelled')
  select p.id,
    exists (select 1 from lead where lead.person_id = p.id) as leader,
    exists (select 1 from donor where donor.person_id = p.id) as donor,
    exists (select 1 from vol where vol.person_id = p.id) as volunteer,
    (exists (select 1 from rsvp where rsvp.person_id = p.id)
      or (p.email is not null and exists (select 1 from signed where signed.email = lower(p.email)))
      or coalesce(p.tags, '[]'::jsonb) ?| array['petition', 'newsletter', 'event']) as signer,
    coalesce(p.rating in ('1', '2'), false) as supporter
  from persons p
  where p.workspace_id = $1 and p.deleted_at is null ${onePerson ? 'and p.id = $3' : ''}`;

const levelOf = (r) => (r.leader ? 'leader' : r.donor || r.volunteer ? 'doer' : r.signer ? 'signer' : r.supporter ? 'supporter' : 'contact');

// { code, label } for one person; the label of "Donor or volunteer" says which.
export const levelFor = async (db, workspaceId, personId) => {
  const r = (await db.query(factsSql(true), [workspaceId, LEADER_ROLES, personId])).rows[0];
  if (!r) return null;
  const code = levelOf(r);
  const label = code === 'doer'
    ? [r.donor && 'Donor', r.volunteer && 'Volunteer'].filter(Boolean).join(' · ')
    : LEVELS.find((l) => l.code === code).label;
  return { code, label, step: LEVELS.findIndex((l) => l.code === code) + 1, of: LEVELS.length };
};

// How many people are at each level, lowest first.
export const levelCounts = async (db, workspaceId) => {
  const rows = (await db.query(
    `select level, count(*)::int as n from (
       select case when f.leader then 'leader' when f.donor or f.volunteer then 'doer'
                   when f.signer then 'signer' when f.supporter then 'supporter' else 'contact' end as level
       from (${factsSql(false)}) f
     ) x group by level`,
    [workspaceId, LEADER_ROLES],
  )).rows;
  const by = Object.fromEntries(rows.map((r) => [r.level, r.n]));
  return LEVELS.map((l) => ({ ...l, n: by[l.code] || 0 }));
};
