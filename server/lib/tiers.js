// Donor tiers, from real gifts only.
//   star      — $1,000+ this calendar year, or a live $100+/mo recurring gift
//   superstar — $3,000+ this calendar year, or a live $250+/mo recurring gift
// "Live recurring" = the largest monthly-cadence gift in the last 62 days.
import { donorTier } from '@starbase/shared/canvass';

export const tierFor = async (tx, workspaceId, personId) => {
  const r = (await tx.query(
    `select
       coalesce(sum(amount_cents) filter (where date >= date_trunc('year', current_date)), 0)::bigint as year_cents,
       coalesce(max(amount_cents) filter (where cadence = 'monthly' and date >= current_date - 62), 0)::bigint as monthly_cents
     from gifts
     where workspace_id = $1 and person_id = $2 and deleted_at is null`,
    [workspaceId, personId],
  )).rows[0];
  const yearCents = Number(r.year_cents);
  const monthlyCents = Number(r.monthly_cents);
  return { tier: donorTier({ yearCents, monthlyCents }), yearCents, monthlyCents };
};
