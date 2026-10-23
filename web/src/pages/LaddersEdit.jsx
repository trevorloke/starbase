// One ladder: what starts it, its steps as cards, and who's on it.
//   Header: the name and the one yellow "Turn on" (while it's off). On, a
//     quiet "Turn off" — everyone holds their place until it's back on.
//   Starts when: one line; Change opens the picker in place.
//   Steps: numbered cards (Wait · Email · Tag · Follow-up; Remove a tag and
//     Stop under "Other steps"). A card opens in place to edit, move or
//     remove it. An email card says who it goes to: only people who said yes
//     to email ("· 67 people said yes"). "+ First name" / "+ Campaign" put
//     in [first name] / [campaign] — the fields and lines show those words,
//     {{first_name}} / {{campaign}} are stored underneath (LaddersWords.js);
//     a {…} that wouldn't fill in is flagged before saving.
//   People: each person and where they are ("Waiting until Fri, Oct 24",
//     "Waiting — email isn't connected"); a row opens on what each step did,
//     with Take off. Finished people fold away.
//   More: rename, "Let people go through again", Delete.
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import {
  CONNECT_TO, LadBack, OTHER_STEPS, STEP_KINDS, TriggerPicker, countsLine, fmtWhen, logLine, stepLine, triggerLine, whereLine,
} from '../components/LaddersBits.jsx';
import { FILLS, emailWho, toCodes, toWords, unfilled } from '../components/LaddersWords.js';
import './shifts.css';
import './ladders.css';

const BLANK = {
  wait: { kind: 'wait', n: 1, unit: 'days' },
  email: { kind: 'email', subject: '', body: '' },
  tag: { kind: 'tag', tag: '' },
  untag: { kind: 'untag', tag: '' },
  followup: { kind: 'followup', text: '' },
  stop: { kind: 'stop' },
};
const doesSomething = (steps) => steps.some((s) => s.kind !== 'wait' && s.kind !== 'stop');

// What a step needs before it can be saved.
const missing = (s) => {
  if (s.kind === 'wait' && !(Number(s.n) >= 1)) return 'How long?';
  if (s.kind === 'email' && !s.subject.trim()) return 'Add a subject';
  if (s.kind === 'email' && !s.body.trim()) return 'Add a message';
  if (s.kind === 'email') { const u = unfilled(s.subject) || unfilled(s.body); if (u) return u; }
  // The codes stored are a little longer than the words in the field.
  if (s.kind === 'email' && s.subject.trim().length > 200) return 'Shorten the subject';
  if (s.kind === 'email' && s.body.trim().length > 20000) return 'Shorten the message';
  if ((s.kind === 'tag' || s.kind === 'untag') && !s.tag.trim()) return 'Add a tag';
  if (s.kind === 'followup' && !s.text.trim()) return 'Say what to do';
  if (s.kind === 'followup' && s.text.trim().length > 300) return 'Shorten the follow-up';
  return null;
};
const clean = (s) => {
  if (s.kind === 'wait') return { kind: 'wait', n: Math.max(1, Math.round(Number(s.n))), unit: s.unit };
  if (s.kind === 'email') return { kind: 'email', subject: s.subject.trim(), body: s.body.trim() };
  if (s.kind === 'tag' || s.kind === 'untag') return { kind: s.kind, tag: s.tag.trim() };
  if (s.kind === 'followup') return { kind: 'followup', text: s.text.trim() };
  return { kind: 'stop' };
};

// Subject and message, and the two fill-in buttons: a tap puts the fill-in
// ("[first name]") where the cursor was (in whichever of the two was last
// touched). The fields show the words; the step keeps the codes.
function EmailFields({ s, set, idp }) {
  const subject = useRef(null);
  const body = useRef(null);
  const last = useRef('body');
  const insert = (word) => {
    const key = last.current;
    const el = (key === 'subject' ? subject : body).current;
    const val = toWords(s[key]);
    const at = typeof el?.selectionStart === 'number' ? el.selectionStart : val.length;
    const end = typeof el?.selectionEnd === 'number' ? el.selectionEnd : at;
    set({ ...s, [key]: toCodes(val.slice(0, at) + word + val.slice(end)) });
    const caret = at + word.length;
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange?.(caret, caret); });
  };
  return (
    <>
      <div className="field">
        <label htmlFor={`${idp}-subj`}>Subject</label>
        <input id={`${idp}-subj`} ref={subject} className="input lad-input" maxLength={200} autoComplete="off"
          placeholder="Thanks for signing" value={toWords(s.subject)}
          onFocus={() => { last.current = 'subject'; }} onChange={(e) => set({ ...s, subject: toCodes(e.target.value) })} />
      </div>
      <div className="field">
        <label htmlFor={`${idp}-body`}>Message</label>
        <textarea id={`${idp}-body`} ref={body} className="input lad-input lad-body" rows={6} maxLength={20000}
          placeholder="Thank you for signing." value={toWords(s.body)}
          onFocus={() => { last.current = 'body'; }} onChange={(e) => set({ ...s, body: toCodes(e.target.value) })} />
      </div>
      <div className="lad-tokens" role="group" aria-label="Fill in">
        {FILLS.map((f) => (
          <button key={f.code} type="button" className="btn btn-quiet ops-tap lad-token"
            onMouseDown={(e) => e.preventDefault()} onClick={() => insert(f.word)}>{f.button}</button>
        ))}
      </div>
      <p className="lad-hint">An unsubscribe link is added.</p>
    </>
  );
}

function StepFields({ s, set, idp, tags }) {
  if (s.kind === 'wait') {
    return (
      <div className="lad-wait">
        <div className="field">
          <label htmlFor={`${idp}-n`}>Wait</label>
          <input id={`${idp}-n`} className="input lad-input lad-num" type="number" inputMode="numeric" min={1} max={365}
            value={s.n} onChange={(e) => set({ ...s, n: e.target.value })} />
        </div>
        <div className="ops-seg lad-seg" role="group" aria-label="Hours or days">
          {['hours', 'days'].map((u) => (
            <button key={u} type="button" aria-pressed={s.unit === u} onClick={() => set({ ...s, unit: u })}>{u === 'hours' ? 'Hours' : 'Days'}</button>
          ))}
        </div>
      </div>
    );
  }
  if (s.kind === 'email') return <EmailFields s={s} set={set} idp={idp} />;
  if (s.kind === 'tag' || s.kind === 'untag') {
    return (
      <div className="field">
        <label htmlFor={`${idp}-tag`}>{s.kind === 'tag' ? 'Add tag' : 'Remove tag'}</label>
        <input id={`${idp}-tag`} className="input lad-input" list={`${idp}-tags`} maxLength={40} autoComplete="off"
          placeholder="thanked" value={s.tag} onChange={(e) => set({ ...s, tag: e.target.value })} />
        <datalist id={`${idp}-tags`}>{(tags || []).map((t) => <option key={t} value={t} />)}</datalist>
      </div>
    );
  }
  if (s.kind === 'followup') {
    return (
      <div className="field">
        <label htmlFor={`${idp}-fu`}>Follow-up for staff</label>
        <input id={`${idp}-fu`} className="input lad-input" maxLength={300} autoComplete="off"
          placeholder="Call [first name] to say thanks" value={toWords(s.text)}
          onChange={(e) => set({ ...s, text: toCodes(e.target.value) })} />
      </div>
    );
  }
  return <p className="lad-hint">The ladder ends here for them.</p>;
}

function StepEditor({ initial, saveLabel, onSave, onCancel, busy, tags, extra }) {
  const [s, setS] = useState(initial);
  const [error, setError] = useState(null);
  const idp = useId();
  const submit = async (e) => {
    e.preventDefault();
    const why = missing(s);
    if (why) { setError(why); return; }
    setError(null);
    await onSave(clean(s));
  };
  return (
    <form className="lad-step-form" onSubmit={submit}>
      <StepFields s={s} set={setS} idp={idp} tags={tags} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn ops-solid ops-tap" disabled={busy}>{saveLabel}</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={onCancel}>Cancel</button>
        {extra}
      </div>
    </form>
  );
}

function StepCard({ step, index, count, open, onToggle, onSave, onRemove, onMove, busy, tags, emailYes }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="ops-item lad-step" data-open={open || undefined}>
      <button type="button" className="ops-row" aria-expanded={open} onClick={onToggle}>
        <span className="lad-step__n" aria-hidden="true">{index + 1}</span>
        <span className="ops-row__main">
          <span className="ops-row__name lad-step__line">{stepLine(step)}</span>
          {step.kind === 'email' && (
            <span className="ops-row__sub lad-step__who">{emailWho(emailYes)}</span>
          )}
        </span>
      </button>
      {open && (
        <div className="ops-body">
          <StepEditor initial={step} saveLabel="Save step" onSave={onSave} onCancel={onToggle} busy={busy} tags={tags}
            extra={<>
              {index > 0 && <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => onMove(-1)} aria-label="Move up">↑</button>}
              {index < count - 1 && <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => onMove(1)} aria-label="Move down">↓</button>}
            </>} />
          {confirm ? (
            <div className="ops-confirm">
              <span>Remove this step?</span>
              <button type="button" className="btn ops-danger ops-tap" disabled={busy} onClick={onRemove}>Yes</button>
              <button type="button" className="btn btn-quiet ops-tap" onClick={() => setConfirm(false)}>No</button>
            </div>
          ) : (
            <button type="button" className="btn btn-quiet ops-tap lad-remove" onClick={() => setConfirm(true)}>Remove step</button>
          )}
        </div>
      )}
    </li>
  );
}

function AddStep({ onAdd, busy, tags }) {
  const [kind, setKind] = useState(null);
  const [more, setMore] = useState(false);
  if (kind) {
    return (
      <div className="card lad-new-step">
        <span className="eyebrow">New step · {STEP_KINDS.find((k) => k.kind === kind).label}</span>
        <StepEditor initial={BLANK[kind]} saveLabel="Add step" busy={busy} tags={tags}
          onSave={async (s) => { if (await onAdd(s)) setKind(null); }} onCancel={() => setKind(null)} />
      </div>
    );
  }
  const shown = STEP_KINDS.filter((k) => !k.more || more);
  return (
    <div className="lad-add" role="group" aria-label="Add a step">
      {shown.map((k) => (
        <button key={k.kind} type="button" className="btn ops-tap lad-add__btn" disabled={busy} onClick={() => setKind(k.kind)}>
          + {k.label}
        </button>
      ))}
      {!more && <button type="button" className="btn btn-quiet ops-tap" onClick={() => setMore(true)}>{OTHER_STEPS}</button>}
    </div>
  );
}

function TriggerLine({ ladder, options, onSave, busy }) {
  const [editing, setEditing] = useState(false);
  const [t, setT] = useState({ kind: ladder.trigger.kind, ref: ladder.trigger.ref || '' });
  const [error, setError] = useState(null);
  useEffect(() => { if (!editing) setT({ kind: ladder.trigger.kind, ref: ladder.trigger.ref || '' }); }, [editing, ladder.trigger.kind, ladder.trigger.ref]);
  if (!editing) {
    return (
      <div className="lad-trigger">
        <span className="ops-row__main">
          <span className="lad-label">Starts when</span>
          <span className="lad-trigger__line">{triggerLine(ladder.trigger)}</span>
        </span>
        <button type="button" className="btn btn-quiet ops-tap" onClick={() => setEditing(true)}>Change</button>
      </div>
    );
  }
  const submit = async (e) => {
    e.preventDefault();
    if (t.kind === 'tag' && !t.ref.trim()) { setError('Pick a tag'); return; }
    const ok = await onSave({ kind: t.kind, ref: t.ref.trim() || null });
    if (ok) setEditing(false);
  };
  return (
    <form className="card lad-form" onSubmit={submit} aria-label="Starts when">
      <TriggerPicker value={t} onChange={setT} options={options} idp="lad-trig" disabled={busy} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn ops-solid ops-tap" disabled={busy}>Save</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={() => setEditing(false)}>Cancel</button>
      </div>
    </form>
  );
}

function PersonRow({ r, open, onToggle, emailConfigured, onTakeOff, busy }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="ops-item" data-open={open || undefined}>
      <button type="button" className="ops-row" aria-expanded={open} onClick={onToggle}>
        <span className="ops-row__main">
          <span className="ops-row__name">{r.person.name}</span>
          <span className="ops-row__sub">{whereLine(r, emailConfigured)}</span>
        </span>
      </button>
      {open && (
        <div className="ops-body">
          {r.log.length > 0 ? (
            <ol className="lad-log">
              {r.log.map((e, i) => (
                <li key={i}><span>{logLine(e)}</span> <span className="lad-log__when mono">{fmtWhen(e.at)}</span></li>
              ))}
            </ol>
          ) : <p className="lad-hint">Starting — the first step runs shortly.</p>}
          <div className="ops-actions">
            <Link className="btn ops-tap" to={`/people/${r.person.id}`}>Profile</Link>
            {r.status !== 'done' && (confirm ? (
              <span className="ops-confirm">
                <span>Take {r.person.name.split(/\s+/)[0]} off?</span>
                <button type="button" className="btn ops-danger ops-tap" disabled={busy} onClick={() => onTakeOff(r)}>Yes</button>
                <button type="button" className="btn btn-quiet ops-tap" onClick={() => setConfirm(false)}>No</button>
              </span>
            ) : (
              <button type="button" className="btn btn-quiet ops-tap" onClick={() => setConfirm(true)}>Take off</button>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

function People({ people, emailConfigured, onTakeOff, busy }) {
  const [openId, setOpenId] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const live = people.filter((p) => p.status !== 'done');
  const done = people.filter((p) => p.status === 'done');
  const row = (r) => (
    <PersonRow key={r.id} r={r} open={openId === r.id} onToggle={() => setOpenId(openId === r.id ? null : r.id)}
      emailConfigured={emailConfigured} onTakeOff={onTakeOff} busy={busy} />
  );
  return (
    <section className="lad-sec" aria-labelledby="lad-people-h">
      <h2 className="lad-h" id="lad-people-h">People <span className="lad-count mono">{people.length}</span></h2>
      {people.length === 0 && <p className="ops-empty">No one yet.</p>}
      {live.length > 0 && <ul className="ops-rows">{live.map(row)}</ul>}
      {done.length > 0 && (
        <>
          <button type="button" className="ops-more disclose" aria-expanded={showDone} aria-controls="lad-done"
            onClick={() => setShowDone((v) => !v)}>
            Finished · {done.length}
          </button>
          {showDone && <ul id="lad-done" className="ops-rows ops-more-body">{done.map(row)}</ul>}
        </>
      )}
    </section>
  );
}

function LadderMore({ ladder, run, busy }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(ladder.name);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setName(ladder.name); }, [ladder.name]);
  const rename = async (e) => {
    e.preventDefault();
    if (name.trim() && name.trim() !== ladder.name) await run('ladder.update', { id: ladder.id, name: name.trim() });
  };
  const remove = async () => {
    if (await run('ladder.delete', { id: ladder.id })) navigate('/ladders');
  };
  return (
    <div className="ops-foot">
      <button type="button" className="ops-more disclose" aria-expanded={open} aria-controls="lad-more" onClick={() => setOpen((v) => !v)}>
        More
      </button>
      {open && (
        <div id="lad-more" className="ops-more-body lad-more">
          <form className="lad-rename" onSubmit={rename}>
            <div className="field">
              <label htmlFor="lad-name">Name</label>
              <input id="lad-name" className="input lad-input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <button type="submit" className="btn ops-tap" disabled={busy || !name.trim() || name.trim() === ladder.name}>Rename</button>
          </form>
          <label className="lad-check">
            <input type="checkbox" checked={ladder.reentry} disabled={busy}
              onChange={(e) => run('ladder.update', { id: ladder.id, reentry: e.target.checked })} />
            <span>Let people go through again</span>
          </label>
          {confirm ? (
            <div className="ops-confirm">
              <span>Delete this ladder?</span>
              <button type="button" className="btn ops-danger ops-tap" disabled={busy} onClick={remove}>Yes</button>
              <button type="button" className="btn btn-quiet ops-tap" onClick={() => setConfirm(false)}>No</button>
            </div>
          ) : (
            <button type="button" className="btn ops-danger ops-tap" onClick={() => setConfirm(true)}>Delete ladder</button>
          )}
        </div>
      )}
    </div>
  );
}

export default function LaddersEdit() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['ladders', id], queryFn: () => apiGet(`/ladders/${id}`) });
  const [openStep, setOpenStep] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [said, setSaid] = useState(null);

  const run = async (name, input, words) => {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const res = await action(name, input);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ladders'] }),
        queryClient.invalidateQueries({ queryKey: ['person'] }),
      ]);
      if (words) setSaid(words(res));
      return res || true;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (noSignal(q)) {
    return (
      <div className="ops-page lad-page">
        <LadBack />
        <NoSignal />
      </div>
    );
  }
  if (q.isPending) return <p className="muted">Loading…</p>;
  if (q.isError) {
    return (
      <div className="ops-page lad-page">
        <LadBack />
        <p className="error" role="alert">{q.error.status === 404 ? 'This ladder isn’t here — it may have been deleted.' : q.error.message}</p>
      </div>
    );
  }
  const { ladder: l, people, emailConfigured, emailYes, options } = q.data;
  const steps = l.steps;
  const saveSteps = (next) => run('ladder.update', { id: l.id, steps: next });
  const hasEmail = steps.some((s) => s.kind === 'email');
  const ready = doesSomething(steps);

  // The chip says On / Off; a line only when people were picked up or paused.
  const turnOn = () => run('ladder.setActive', { id: l.id, active: true },
    (r) => (r.resumed ? `On · ${r.resumed} picked up where they were` : null));
  const turnOff = () => run('ladder.setActive', { id: l.id, active: false },
    (r) => (r.paused ? `Off · ${r.paused} paused in place` : null));

  return (
    <div className="ops-page lad-page">
      <LadBack />
      <div className="ops-head">
        <h1>{l.name}</h1>
        {!l.active && (
          <button type="button" className="btn btn-primary ops-tap" disabled={busy || !ready} onClick={turnOn}>Turn on</button>
        )}
      </div>

      <div className="lad-status">
        <span className={`chip ${l.active ? 'chip-ok' : 'ops-chip-muted'}`}>{l.active ? 'On' : 'Off'}</span>
        <span className="mono lad-status__n">{countsLine(l)}</span>
        {l.active && <button type="button" className="btn btn-quiet ops-tap lad-off" disabled={busy} onClick={turnOff}>Turn off</button>}
      </div>
      {!l.active && <p className="lad-hint">{ready ? 'Only people who start it from now on.' : 'Add a step, then turn it on.'}</p>}
      {said && <p className="ops-done" role="status">{said}</p>}
      {hasEmail && !emailConfigured && (
        <p className="lad-note" role="status">Email isn’t connected — email steps wait. <Link to={CONNECT_TO}>Connect</Link></p>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      <TriggerLine ladder={l} options={options} busy={busy}
        onSave={(trigger) => run('ladder.update', { id: l.id, trigger })} />

      <section className="lad-sec" aria-labelledby="lad-steps-h">
        <h2 className="lad-h" id="lad-steps-h">Steps</h2>
        {steps.length === 0 && <p className="ops-empty">No steps yet.</p>}
        {steps.length > 0 && (
          <ol className="ops-rows lad-steps">
            {steps.map((s, i) => (
              <StepCard key={`${i}-${s.kind}-${stepLine(s)}`} step={s} index={i} count={steps.length} busy={busy} tags={options.tags}
                emailYes={emailYes}
                open={openStep === i} onToggle={() => setOpenStep(openStep === i ? null : i)}
                onSave={async (next) => { if (await saveSteps(steps.map((x, j) => (j === i ? next : x)))) setOpenStep(null); }}
                onRemove={async () => { if (await saveSteps(steps.filter((_, j) => j !== i))) setOpenStep(null); }}
                onMove={async (d) => {
                  const next = [...steps];
                  [next[i], next[i + d]] = [next[i + d], next[i]];
                  if (await saveSteps(next)) setOpenStep(i + d);
                }} />
            ))}
          </ol>
        )}
        <AddStep busy={busy} tags={options.tags} onAdd={(s) => saveSteps([...steps, s])} />
      </section>

      <People people={people} emailConfigured={emailConfigured} busy={busy}
        onTakeOff={(r) => run('ladder.stopRun', { id: r.id }, () => `${r.person.name} taken off`)} />

      <LadderMore ladder={l} run={run} busy={busy} />
    </div>
  );
}
