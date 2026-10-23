// GET /api/blasts/stats — desk only. For each recent send (the same 200 as
// GET /api/blasts), counted per recipient:
//   delivered  rows the email service accepted ('sent')
//   opened     delivered rows that loaded the pixel or clicked a link
//   clicked    delivered rows that clicked a link
//   ab         null, or the test: settings, state, winner, result (the
//              numbers the winner was picked on: { metric, tie, a, b }), and
//              per group { total, delivered, opened, clicked } for a and b,
//              plus rest { total, sent, failed, held, going } (held: waiting
//              for the winner; going: on its way — the winner is picked and
//              its job is still sending)
// Percentages are the screen's job (of delivered). No emails, no tokens.
import { Hono } from 'hono';
import { AB_MIN, AB_PCTS, AB_WAITS, WINNER_JOB, abOf } from './send.js';

export const api = new Hono();

const group = (r, g) => ({
  total: r[`${g}_total`], delivered: r[`${g}_delivered`], opened: r[`${g}_opened`], clicked: r[`${g}_clicked`],
});

const groupCols = (g) => `
  (count(r.id) filter (where r.ab_group = '${g}'))::int as ${g}_total,
  (count(r.id) filter (where r.ab_group = '${g}' and r.status = 'sent'))::int as ${g}_delivered,
  (count(r.id) filter (where r.ab_group = '${g}' and r.status = 'sent' and (r.first_open_at is not null or r.first_click_at is not null)))::int as ${g}_opened,
  (count(r.id) filter (where r.ab_group = '${g}' and r.status = 'sent' and r.first_click_at is not null))::int as ${g}_clicked`;

api.get('/blasts/stats', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role === 'volunteer') return c.json({ error: 'volunteers cannot view this' }, 403);
  const { rows } = await c.get('db').query(
    `select b.id, b.ab_status, b.ab_subject_b, b.ab_pct, b.ab_wait_hours, b.ab_metric,
            b.ab_decide_at, b.ab_winner, b.ab_decided_at, b.ab_result,
            exists (select 1 from jobs j where j.workspace_id = b.workspace_id and j.kind = '${WINNER_JOB}'
                      and j.status in ('pending', 'running') and j.payload->>'blast_id' = b.id::text) as winner_job_on,
            (count(r.id) filter (where r.status = 'sent'))::int as delivered,
            (count(r.id) filter (where r.status = 'sent' and (r.first_open_at is not null or r.first_click_at is not null)))::int as opened,
            (count(r.id) filter (where r.status = 'sent' and r.first_click_at is not null))::int as clicked,
            ${groupCols('a')}, ${groupCols('b')},
            (count(r.id) filter (where r.ab_group = 'rest'))::int as rest_total,
            (count(r.id) filter (where r.ab_group = 'rest' and r.status = 'sent'))::int as rest_sent,
            (count(r.id) filter (where r.ab_group = 'rest' and r.status = 'failed'))::int as rest_failed,
            (count(r.id) filter (where r.ab_group = 'rest' and r.status = 'queued' and b.ab_winner is null))::int as rest_held,
            (count(r.id) filter (where r.ab_group = 'rest' and r.status in ('queued', 'sending') and b.ab_winner is not null))::int as rest_left
     from blasts b
     left join blast_recipients r on r.blast_id = b.id and r.workspace_id = b.workspace_id
     where b.workspace_id = $1
     group by b.id
     order by b.created_at desc limit 200`,
    [ctx.workspaceId],
  );
  const stats = rows.map((r) => {
    const ab = abOf(r);
    return {
      id: r.id,
      delivered: r.delivered,
      opened: r.opened,
      clicked: r.clicked,
      ab: ab && {
        ...ab,
        a: group(r, 'a'),
        b: group(r, 'b'),
        rest: {
          total: r.rest_total, sent: r.rest_sent, failed: r.rest_failed, held: r.rest_held,
          going: ab.status === 'decided' && r.winner_job_on ? r.rest_left : 0,
        },
      },
    };
  });
  return c.json({ stats, ab: { min: AB_MIN, pcts: AB_PCTS, waits: AB_WAITS } });
});
