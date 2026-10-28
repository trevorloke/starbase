// What the tracker is, for the admin and the public site alike: promises
// in number order with their updates (newest first), the announcements
// (newest first), and the scoreboard.
import { STATUSES } from './actions.js';

const j = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));

export const loadTracker = async (db, wsId) => {
  const promises = (await db.query('select * from tracker_promises where workspace_id = $1 order by number', [wsId])).rows;
  const updates = (await db.query('select * from tracker_updates where workspace_id = $1 order by date desc, created_at desc', [wsId])).rows;
  const announcements = (await db.query('select * from tracker_announcements where workspace_id = $1 order by date desc, created_at desc', [wsId])).rows;
  const byPromise = {};
  for (const u of updates) (byPromise[u.promise_id] ||= []).push({ id: u.id, date: day(u.date), status: u.status, note: u.note, url: u.url });
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const out = promises.map((p) => {
    counts[p.status] += 1;
    return {
      id: p.id, number: p.number, title: p.title, specifics: p.specifics, area: p.area, sources: j(p.sources, []),
      status: p.status, status_changed_at: p.status_changed_at,
      test: { kept: p.test_kept, partly: p.test_partly, broken: p.test_broken, record: p.test_record },
      updates: byPromise[p.id] || [],
    };
  });
  return {
    promises: out,
    announcements: announcements.map((a) => ({ id: a.id, date: day(a.date), date_label: a.date_label, title: a.title, commitments: a.commitments, sources: j(a.sources, []) })),
    counts, total: out.length, statuses: STATUSES,
  };
};
