// A survey's results (/surveys/:id/results), desk only. One big number
// (people who answered), then a card per question: a bar per choice with
// its count and % of the people who answered that question, "See people"
// for follow-up (each name opens the profile), short answers as a list.
// Each person counts once per question — their latest answer. The CSV (one
// row per person, one column per question) sits under More.
import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { plural } from './Surveys.jsx';
import './shifts.css';
import './surveys.css';

const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
};

function Bar({ o, from }) {
  const [open, setOpen] = useState(false);
  const listId = `sv-people-${String(o.label).replace(/\W+/g, '-')}-${o.count}`;
  return (
    <li className="sv-bar">
      <div className="sv-bar__top">
        <span className="sv-bar__label">{o.label}{o.old && <span className="muted"> · old choice</span>}</span>
        <span className="sv-bar__n mono"><strong>{o.count}</strong> · {o.pct}%</span>
      </div>
      <span className="sv-bar__track" aria-hidden="true"><span className="sv-bar__fill" style={{ width: `${o.pct}%` }} /></span>
      {o.count > 0 && (
        <>
          <button type="button" className="disclose disclose--inline sv-bar__see" aria-expanded={open} aria-controls={listId}
            onClick={() => setOpen((v) => !v)}>
            See people
          </button>
          {open && (
            <ul className="sv-people" id={listId}>
              {o.people.map((p) => (
                <li key={p.id}><Link to={`/people/${p.id}`} state={{ from }}>{p.name}</Link></li>
              ))}
              {o.more > 0 && <li className="muted sv-people__more">+{o.more} more in the download</li>}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

function QuestionResult({ q, from }) {
  return (
    <section className="card sv-res" aria-label={q.text}>
      <h2 className="sv-res__q">{q.text}</h2>
      {q.kind === 'scale' && <p className="sv-res__ends">1 low · 5 high</p>}
      <p className="sv-res__n mono">{q.answered} answered</p>
      {q.kind === 'text' ? (
        q.answers.length === 0 ? <p className="muted">No answers yet.</p> : (
          <ul className="sv-texts">
            {q.answers.map((a, i) => (
              <li key={`${a.person.id}-${i}`}>
                <span className="sv-texts__a">“{a.value}”</span>
                <span className="sv-texts__who">
                  <Link to={`/people/${a.person.id}`} state={{ from }}>{a.person.name}</Link>
                  <span className="mono muted"> · {day(a.at)}</span>
                </span>
              </li>
            ))}
            {q.more > 0 && <li className="muted">+{q.more} more in the download</li>}
          </ul>
        )
      ) : (
        <ul className="sv-bars">
          {q.options.map((o) => <Bar key={JSON.stringify(o.value)} o={o} from={from} />)}
        </ul>
      )}
    </section>
  );
}

export default function SurveysResults() {
  const { id } = useParams();
  const location = useLocation();
  const [more, setMore] = useState(false);
  const q = useQuery({ queryKey: ['survey', id, 'results'], queryFn: () => apiGet(`/surveys/${id}/results`) });
  // A profile opened from here comes back here ("← Results").
  const from = { to: `${location.pathname}${location.search}`, label: 'Results' };

  if (noSignal(q)) {
    return (
      <div className="ops-page sv-page">
        <Link to="/surveys" className="ops-back">← Surveys</Link>
        <NoSignal />
      </div>
    );
  }
  if (q.isPending) return <p className="muted">Loading…</p>;
  if (q.isError) {
    return (
      <div className="ops-page sv-page">
        <Link to="/surveys" className="ops-back">← Surveys</Link>
        <p className="error" role="alert">{q.error.status === 404 ? 'Survey not found' : q.error.message}</p>
      </div>
    );
  }
  const { survey, questions } = q.data;
  return (
    <div className="ops-page sv-page">
      <Link to={`/surveys/${id}`} className="ops-back">← {survey.name}</Link>
      <div className="ops-head"><h1>Results</h1></div>
      <p className="sv-big"><strong className="mono">{survey.people}</strong> {survey.people === 1 ? 'person' : 'people'} answered</p>

      {questions.length === 0 && <p className="ops-empty">No questions yet.</p>}
      {questions.map((question) => <QuestionResult key={question.id} q={question} from={from} />)}

      <div className="ops-foot">
        <button type="button" className="ops-more disclose" aria-expanded={more} aria-controls="sv-res-more" onClick={() => setMore((v) => !v)}>
          More
        </button>
        {more && (
          <div id="sv-res-more" className="ops-more-body ops-actions">
            <a className="btn ops-tap" href={`/api/surveys/${id}/results.csv`} download>Download for a spreadsheet</a>
            <span className="ops-meta">{plural(survey.people, 'row')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
