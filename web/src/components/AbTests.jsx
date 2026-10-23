// A/B subject lines + open and click stats for Outreach's newsletters and
// press releases (server: server/ext/abtests). Used by pages/Outreach.jsx:
//   AbFields        the quiet "Try two subject lines" reveal in Write
//   useBlastStat    one send's counts from GET /api/blasts/stats
//   abState         a test's state as one line ("Testing · A 12% vs B 18%
//                   opened · winner at 3:00 p.m.", "Winner B · A 17% vs
//                   B 50% opened · sent to everyone", "Tie — sent A · …") —
//                   only what the server counted
//   abPlanLine      a test's plan, before anyone taps ("Two subject
//                   lines · A to 13, B to 13, winner to 39 after 4 hours") —
//                   under the settings while writing, and on the saved card
//   SendStats       "Opened 42% · Clicked 8%" (of delivered); after a test,
//                   the whole list's: "All 66: opened 15% · clicked 3%"
//   TestingList     tests running now, on the tab's first look
//   OpensNote       the one line on Apple Mail under More
//   hasLinks        whether a message has a link to click (Winner by clicks)
import { useId } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import './abtests.css';

export const AB_MIN = 50;
const PCTS = [10, 20, 30];
const WAITS = [1, 2, 4, 12, 24];
export const AB_DEFAULT = { subject_b: '', pct: 20, wait_hours: 4, metric: 'opens' };

const plural = (n, one, many) => (n === 1 ? one : many);
const hours = (h) => `${h} ${plural(h, 'hour', 'hours')}`;
const pctOf = (n, of) => (of > 0 ? Math.round((100 * n) / of) : 0);

// Shares GET /api/blasts/stats under the 'blasts' key, so every send
// (which invalidates ['blasts']) refreshes it too. While a test runs, or its
// winner is still going out, it is read again every 30 s (opens arrive, the
// winner goes out); when that ends, the send list is read again so its
// counts match the winner line.
const STATS_KEY = ['blasts', 'stats'];
const testingIds = (d) => (d?.stats || []).filter((s) => s.ab?.status === 'testing' || s.ab?.rest?.going > 0)
  .map((s) => s.id).join(',');
export const useBlastStats = () => {
  const qc = useQueryClient();
  return useQuery({
    queryKey: STATS_KEY,
    queryFn: async () => {
      const prev = qc.getQueryData(STATS_KEY);
      const next = await apiGet('/blasts/stats');
      if (prev && testingIds(prev) !== testingIds(next)) qc.invalidateQueries({ queryKey: ['blasts'], exact: true });
      return next;
    },
    refetchInterval: (q) => (testingIds(q.state.data) ? 30_000 : false),
  });
};
export const useBlastStat = (id) => {
  const q = useBlastStats();
  return id ? q.data?.stats?.find((s) => s.id === id) || null : null;
};

// The same split the server makes: pct% each to A and B, the rest wait.
export const abPlan = (total, pct) => {
  const size = Math.floor(((total || 0) * pct) / 100);
  return { a: size, b: size, rest: Math.max(0, (total || 0) - 2 * size) };
};
export const abAsk = (plan, waitHours) =>
  `A to ${plan.a}, B to ${plan.b} now · the winner to ${plan.rest} after ${hours(waitHours)}?`;
export const abPlanLine = (plan, waitHours) =>
  `Two subject lines · A to ${plan.a}, B to ${plan.b}, winner to ${plan.rest} after ${hours(waitHours)}`;

// The same test the server makes (ext/abtests/send.js findLinks): an
// http(s) address somewhere in the message.
export const hasLinks = (body) => /https?:\/\/[a-z0-9]/i.test(String(body || ''));

// "3:00 p.m.", "tomorrow 3:00 p.m.", "Oct 24, 3:00 p.m." — the app's own
// time format (en-CA), like every other time on screen.
export const fmtTime = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const t = d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return t;
  const next = new Date(now);
  next.setDate(now.getDate() + 1);
  if (d.toDateString() === next.toDateString()) return `tomorrow ${t}`;
  return `${d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}, ${t}`;
};

// One line for a test that has started. `stat` (from useBlastStat) carries
// the per-group counts; `counts` the send's { total, sent, failed, queued,
// sending }. Answers null for a send with no test, or one that hasn't started.
// A decided test shows the rates it was decided on (the server's result),
// and a tie says so — A went out because neither did better.
const ratesOf = (groups, metric) => {
  if (!groups?.a || !groups?.b) return '';
  const verb = metric === 'clicks' ? 'clicked' : 'opened';
  const rate = (g) => pctOf(metric === 'clicks' ? g.clicked : g.opened, g.delivered);
  return ` · A ${rate(groups.a)}% vs B ${rate(groups.b)}% ${verb}`;
};
export const abState = (ab, stat, counts) => {
  if (!ab || ab.status === 'saved') return null;
  if (ab.status === 'testing') {
    return { tone: 'queued', line: `Testing${ratesOf(stat?.ab, ab.metric)} · winner at ${fmtTime(ab.decide_at)}` };
  }
  const result = ab.result || stat?.ab?.result || null;
  const w = (result?.tie ? 'Tie — sent A' : `Winner ${String(ab.winner || 'a').toUpperCase()}`)
    + ratesOf(result, result?.metric || ab.metric);
  const going = stat?.ab?.rest?.going || 0;
  if (going > 0) return { tone: 'queued', line: `${w} · sending to ${going}` };
  const c = counts;
  if (!c || c.sent == null) return { tone: 'queued', line: w };
  if (c.total > 0 && c.sent === c.total) return { tone: 'sent', line: `${w} · sent to everyone` };
  const rest = [
    c.failed ? `${c.failed} failed` : null, c.queued ? `${c.queued} not sent` : null, c.sending ? `${c.sending} not sure` : null,
  ].filter(Boolean);
  return { tone: c.sent > 0 ? 'queued' : 'failed', line: `${w} · sent to ${c.sent} of ${c.total}${rest.length ? ` — ${rest.join(' · ')}` : ''}` };
};

// "Opened 42% · Clicked 8%" — of the emails the service delivered. A send
// with two subject lines already says how A and B did, so this one says it
// is everyone's ("All 66: opened 15% · clicked 3%"; "64 sent: …" when some
// didn't go); while the test runs, its own line is the only one.
export function SendStats({ stat }) {
  if (!stat || !(stat.delivered > 0)) return null;
  const rates = (o, c) => `${o} ${pctOf(stat.opened, stat.delivered)}% · ${c} ${pctOf(stat.clicked, stat.delivered)}%`;
  if (stat.ab) {
    if (stat.ab.status !== 'decided') return null;
    const total = (stat.ab.a?.total || 0) + (stat.ab.b?.total || 0) + (stat.ab.rest?.total || 0);
    const who = stat.delivered === total ? `All ${total}` : `${stat.delivered} sent`;
    return <span className="ab-stats" data-testid="send-stats">{who}: {rates('opened', 'clicked')}</span>;
  }
  return <span className="ab-stats" data-testid="send-stats">{rates('Opened', 'Clicked')}</span>;
}

// Under More: why opens run high. Shown once anything has been delivered.
export function OpensNote() {
  const q = useBlastStats();
  if (!q.data?.stats?.some((s) => s.delivered > 0)) return null;
  return <p className="ot-note ab-note">Apple Mail can open emails by itself, so opens run high.</p>;
}

// In Write: a quiet reveal for Subject B and the test's three settings.
// value null = one subject line. A list under 50 sends normally. Clicks
// can't pick a winner in a message with nothing to click (`links` false).
export function AbFields({ idPrefix, audienceCount, noun, value, onChange, links = true }) {
  const uid = useId();
  const open = value != null;
  const small = audienceCount != null && audienceCount < AB_MIN;
  const id = (k) => `${idPrefix}-ab-${k}`;
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="ab-fields">
      <button type="button" className="disclose disclose--inline ab-toggle" aria-expanded={open} aria-controls={uid}
        onClick={() => onChange(open ? null : { ...AB_DEFAULT })}>
        Try two subject lines
      </button>
      {open && (
        <div id={uid} className="ab-body">
          {small ? (
            <p className="ot-note" data-testid="ab-small">
              Two subject lines need {AB_MIN}+ {noun(AB_MIN)} — this sends with one.
            </p>
          ) : (
            <>
              <div className="field">
                <label htmlFor={id('subject')}>Subject B</label>
                <input id={id('subject')} className="input" value={value.subject_b} maxLength={300} autoFocus
                  onChange={(e) => set({ subject_b: e.target.value })} />
              </div>
              <div className="ab-opts">
                <div className="field">
                  <label htmlFor={id('pct')}>Test group</label>
                  <select id={id('pct')} className="input" value={value.pct} onChange={(e) => set({ pct: Number(e.target.value) })}>
                    {PCTS.map((p) => <option key={p} value={p}>{p}% each</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={id('wait')}>Wait</label>
                  <select id={id('wait')} className="input" value={value.wait_hours} onChange={(e) => set({ wait_hours: Number(e.target.value) })}>
                    {WAITS.map((h) => <option key={h} value={h}>{hours(h)}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={id('metric')}>Winner by</label>
                  <select id={id('metric')} className="input" value={links ? value.metric : 'opens'} onChange={(e) => set({ metric: e.target.value })}>
                    <option value="opens">Opens</option>
                    <option value="clicks" disabled={!links}>{links ? 'Clicks' : 'Clicks — add a link'}</option>
                  </select>
                </div>
              </div>
              {/* What these mean, in numbers, as they change. */}
              {audienceCount != null && (
                <p className="ot-note ab-plan-now" data-testid="ab-plan-now" aria-live="polite">
                  {abPlanLine(abPlan(audienceCount, value.pct), value.wait_hours)}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Tests running now, on the tab's first look: subject A, subject B, and
// where the test stands. Nothing while no test runs. `skip`: the send whose
// result is already on screen (said once, not twice).
export function TestingList({ blasts, kind, skip }) {
  const stats = useBlastStats();
  const rows = (stats.data?.stats || []).filter((s) => s.ab?.status === 'testing' && s.id !== skip)
    .map((s) => ({ s, b: (blasts || []).find((b) => b.id === s.id) }))
    .filter(({ b }) => b && b.kind === kind);
  if (rows.length === 0) return null;
  return (
    <section className="ot-sec" aria-label="Testing">
      <h2 className="ot-sec-h">Testing two subject lines <span className="ot-count">{rows.length}</span></h2>
      <ul className="ot-list">
        {rows.map(({ s, b }) => (
          <li key={b.id} className="ot-item" data-testid="ab-testing-row">
            <div className="ot-row ot-row--static ot-row--wrap">
              <span className="ot-row__main">
                <span className="ot-row__name">{b.subject}</span>
                <span className="ab-b">B · {s.ab.subject_b}</span>
                <span className="ab-line" data-tone="queued">{abState(s.ab, s, null).line}</span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
