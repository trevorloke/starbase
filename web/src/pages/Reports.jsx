// Reports — the campaign in numbers, each table downloadable as CSV, and
// the exports: any table as a spreadsheet, or everything as JSON.
import { useQuery } from '@tanstack/react-query';
import { apiGet, fmtMoney } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import './reports.css';

const TITLES = {
  rating: 'People by rating', tags: 'Tags', cities: 'Cities', 'people-by-week': 'People added, by week',
  contacts: 'Contacts by week', donations: 'Donations by month', members: 'Members', subscribers: 'Newsletter list, by month', sends: 'Sends',
};
const EXPORTS = [
  ['people', 'People'], ['contacts', 'Contacts (doors, calls, texts)'], ['gifts', 'Gifts'], ['pledges', 'Pledges'],
  ['members', 'Members'], ['subscribers', 'Newsletter subscribers'], ['signatures', 'Petition signatures'], ['rsvps', 'Event RSVPs'],
  ['orders', 'Store orders'], ['lists', 'Lists (hand-picked)'],
];
const cell = (v) => (v instanceof Date || /^\d{4}-\d{2}-\d{2}T/.test(String(v)) ? String(v).slice(0, 10) : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v ?? ''));

function Report({ name, r }) {
  return (
    <section className="rp-sec" aria-labelledby={`rp-${name}`}>
      <div className="rp-sec__head">
        <h2 id={`rp-${name}`}>{TITLES[name] || name}</h2>
        <a className="btn btn-quiet ops-tap" href={`/api/reports/${name}.csv`}>CSV</a>
      </div>
      {!r.rows.length ? <p className="ops-empty">Nothing yet.</p> : (
        <div className="rp-table-wrap">
          <table className="rp-table">
            <thead><tr>{r.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{r.rows.map((row, i) => <tr key={i}>{row.map((v, j) => <td key={j} className={typeof v === 'number' ? 'mono num' : ''}>{cell(v)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function Reports() {
  const q = useQuery({ queryKey: ['reports'], queryFn: () => apiGet('/reports') });
  const t = q.data?.totals;
  return (
    <div className="ops-page rp-page">
      <div className="ops-head"><h1>Reports</h1></div>
      {noSignal(q) && <NoSignal />}
      {q.isError && !noSignal(q) && <p className="error">{q.error.message}</p>}
      {t && (
        <div className="rp-totals" role="list">
          <span role="listitem"><strong className="mono">{t.people.total}</strong> people <span className="muted">· {t.people.rated} rated · {t.people.with_email} with email · {t.people.with_phone} with phone</span></span>
          <span role="listitem"><strong className="mono">{t.contacts.week}</strong> contacts this week <span className="muted">· {t.contacts.total} all time</span></span>
          <span role="listitem"><strong className="mono">{fmtMoney(t.donations.cents)}</strong> raised this year <span className="muted">· {t.donations.gifts} gifts from {t.donations.donors} donors</span></span>
          <span role="listitem"><strong className="mono">{t.members.active}</strong> members</span>
          <span role="listitem"><strong className="mono">{t.newsletter.subscribed}</strong> subscribers <span className="muted">· {t.newsletter.unsubscribed} left</span></span>
        </div>
      )}
      {q.data && Object.entries(q.data.reports).map(([name, r]) => <Report key={name} name={name} r={r} />)}
      <section className="rp-sec" aria-labelledby="rp-exports">
        <div className="rp-sec__head"><h2 id="rp-exports">Exports</h2></div>
        <p className="ops-meta">A whole table as a spreadsheet. The full export (everything, as JSON, for a backup or a move) is under Today → More.</p>
        <ul className="rp-exports">
          {EXPORTS.map(([k, label]) => <li key={k}><a className="btn ops-tap" href={`/api/export/${k}.csv`}>{label}</a></li>)}
          <li><a className="btn btn-quiet ops-tap" href="/api/export">Everything (JSON)</a></li>
        </ul>
      </section>
    </div>
  );
}
