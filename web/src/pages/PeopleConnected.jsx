// Most connected (People → More → Most connected, desk only): the people who
// know the most people on the list — the connectors to ask first. Each row:
// the name, "knows 12 · 8 supporters" (supporters: rated 1 or 2) and their
// own rating chip; a tap opens the profile, whose Knows section lists them.
// App.jsx guards it; the server refuses volunteers the read too.
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { RatingChip } from '../components/RatingButtons.jsx';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import './shifts.css';
import './relationships.css';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const BACK = { from: { to: '/people/connected', label: 'Most connected' } };

export default function PeopleConnected() {
  const q = useQuery({ queryKey: ['persons', 'connected'], queryFn: () => apiGet('/relationships/connected') });
  const people = q.data?.people ?? [];
  return (
    <div className="ops-page rel-page">
      <Link className="ops-back" to="/people">← People</Link>
      <div className="ops-head">
        <h1>Most connected</h1>
      </div>
      {noSignal(q) ? <NoSignal /> : q.isPending ? <p className="muted">Loading…</p> : q.isError ? (
        <p className="error" role="alert">{q.error.message}</p>
      ) : people.length === 0 ? (
        <p className="ops-empty">No one is linked yet — open a profile, then Knows.</p>
      ) : (
        <ul className="ops-rows">
          {people.map((p) => (
            <li key={p.id} className="ops-item">
              <Link className="ops-row" to={`/people/${p.id}`} state={BACK}>
                <span className="ops-row__main">
                  <span className="ops-row__name">{p.name}</span>
                  <span className="ops-row__sub">knows {p.knows} · {plural(p.supporters, 'supporter')}</span>
                </span>
                <span className="ops-row__end"><RatingChip code={p.rating} who /></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
