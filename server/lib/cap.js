// The contribution-cap engine. Entity-keyed and SQL-summed: a donor's cycle
// total is SUM(amount_cents) over their person_id — never a name-string
// match, so two donors who share a name can never pool a cap, and a renamed
// donor keeps their history. O(1) per gift via the person/date index.
//
// Cycle model: calendar year (BC annual individual limit), per slate (the
// council slate and the school board slate are each one limit). The rule
// table is per (jurisdiction, year); a workspace may override via
// settings.capCents.
import { DEFAULT_SLATE } from '@starbase/shared/canvass';

export const capFor = async (tx, jurisdiction, year, settings = {}) => {
  if (Number.isInteger(settings.capCents)) {
    return { capCents: settings.capCents, source: 'workspace override' };
  }
  const exact = (await tx.query(
    'select cap_cents, source_note from cap_rules where jurisdiction = $1 and year = $2',
    [jurisdiction, year],
  )).rows[0];
  if (exact) return { capCents: exact.cap_cents, source: exact.source_note };
  const latest = (await tx.query(
    'select cap_cents, source_note, year from cap_rules where jurisdiction = $1 and year <= $2 order by year desc limit 1',
    [jurisdiction, year],
  )).rows[0];
  if (latest) {
    return { capCents: latest.cap_cents, source: `${latest.source_note} (latest known: ${latest.year})` };
  }
  return null; // no rule known — never guess a cap
};

// Total for one donor in one calendar year on one slate, excluding voided
// gifts. The limit is per slate (shared/canvass.js SLATES): a gift that
// names none is on the first slate.
export const donorYearTotal = async (tx, workspaceId, personId, year, slate = DEFAULT_SLATE) => {
  const { rows } = await tx.query(
    `select coalesce(sum(amount_cents), 0)::bigint as total
     from gifts
     where workspace_id = $1 and person_id = $2 and deleted_at is null
       and coalesce(slate, $4) = $5
       and date >= make_date($3, 1, 1) and date < make_date($3 + 1, 1, 1)`,
    [workspaceId, personId, year, DEFAULT_SLATE, slate || DEFAULT_SLATE],
  );
  return Number(rows[0].total);
};

// What a donor's open monthly pledges on a slate will still take this
// calendar year: a card subscription or a standing pledge pays every month
// left after this one (a pledge that has not paid yet, this month too).
export const donorYearCommitted = async (tx, workspaceId, personId, monthIndex, slate = DEFAULT_SLATE) => {
  const { rows } = await tx.query(
    `select status, amount_cents from pledges
     where workspace_id = $1 and person_id = $2 and cadence = 'monthly'
       and status in ('pledged', 'pending', 'paid') and coalesce(slate, $3) = $4`,
    [workspaceId, personId, DEFAULT_SLATE, slate || DEFAULT_SLATE],
  );
  return rows.reduce((n, p) => n + Number(p.amount_cents) * ((p.status === 'paid' ? 11 : 12) - monthIndex), 0);
};

// Evaluate a donor's standing for the year of a given gift date, on a slate.
export const checkCap = async (tx, { workspaceId, personId, date, jurisdiction, settings, slate }) => {
  const year = Number(String(date).slice(0, 4));
  const rule = await capFor(tx, jurisdiction, year, settings);
  if (!rule) return { checked: false, reason: `no cap rule known for ${jurisdiction} ${year}` };
  const totalCents = await donorYearTotal(tx, workspaceId, personId, year, slate);
  return {
    checked: true,
    year,
    slate: slate || DEFAULT_SLATE,
    totalCents,
    capCents: rule.capCents,
    source: rule.source,
    over: totalCents > rule.capCents,
  };
};
