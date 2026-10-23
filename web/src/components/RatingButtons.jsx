// RatingButtons — the doorstep scale as big tappable buttons.
// One row: 1 · 2 · 3 · 4, each with its meaning printed small under the
// number (the campaign's words: by default "Strong yes", "Lean yes",
// "Undecided", "Opposed"), so the buttons are their own legend on every
// surface (door card, walk list, calls, profile). Tapping 4 asks one more
// thing — "Voting for?" — with the campaign's list (by default McCallum ·
// Locke · Annis · van Vliet · Randhawa) and "Not sure" (= plain 4). Nothing
// is logged until that second tap, so an opposed rating is still one
// contact. Codes ("4B") never show: the picked 4 reads "4 / Locke", like its
// chip "4 · Locke" and the toast "Rated 4 · Locke" (ratingText).
// The words and the list are the campaign's scale (components/scale.js,
// shared/scale.js); a candidate taken off the list is no longer offered, and
// an old rating of theirs reads "4 · Locke (off the list)".
// Band-tinted (support = green, undecided = ochre, opposed = red); the
// current rating gets a dark ring and a check mark, never a solid fill, so
// nothing here looks like the screen's one yellow button.
// Reusable: <RatingButtons value={person.rating} onPick={(code) => …} compact />
// (scale= shows another scale — the Rating scale screen's preview.)
// Every button is at least 48px tall (field rule). Class names are rb-* so
// they never collide with other pages' rating styles; styles ship with the
// field map stylesheet so the component works anywhere.
import { useEffect, useId, useRef, useState } from 'react';
import { offeredCandidates, offTail, ratingByCode, ratingWho } from '@starbase/shared/scale';
import { useScale } from './scale.js';
import '../pages/map.css';
import './rating-words.css';

// The words every screen uses, all taking the campaign's scale first:
// ratingWho(scale, '4B') → "Locke" ('4' → "Not sure"); ratingSay → the
// button's words ("Strong yes", "Locke"); ratingText → "1 · Strong yes",
// "4 · Locke", "4 · Opposed" — toasts: `Rated ${ratingText(scale, code)}`.
export { ratingWho, ratingSay, ratingText } from '@starbase/shared/scale';
export { useScale };

// Small filled chip for a person's current rating — same band colors as the buttons.
// who: an opposed variant reads "4 · Locke" (the words on the button that
// was tapped), not the code "4B"; one off the list says so.
// brief: where a name and an address share the line (the walk list's
// doors, the door card's tabs), "(off the list)" is left to the chip's
// title and aria-label — the profile and People still say it. A long name
// gives way with "…" there (rating-words.css), never the person's name.
export function RatingChip({ code, className = '', who = false, brief = false }) {
  const scale = useScale();
  const r = ratingByCode(scale, code);
  const named = who && r?.band === 'opposed' && r.code !== '4';
  const label = r ? `${r.label}${offTail(r)}` : '';
  return (
    <span
      className={`rb-chip${named ? ' rb-chip--who' : ''} ${className}`.trim()}
      data-band={r ? r.band : 'none'}
      title={r ? label : 'Not yet rated'}
      aria-label={r ? `Rating ${r.short}: ${label}` : 'Not yet rated'}
    >
      {r ? (named ? `4 · ${r.name}${brief ? '' : offTail(r)}` : r.short) : 'unrated'}
    </span>
  );
}

// The no-conversation outcomes, as one row of smaller quiet buttons.
// One name per outcome everywhere (map, walk list, calls, profile).
export const OUTCOMES = [
  { code: 'no_answer', label: 'No answer' },
  { code: 'refused', label: 'Refused' },
  { code: 'moved', label: 'Moved' },
  { code: 'inaccessible', label: 'No access' },
];
export const OUTCOME_LABEL = { contacted: 'Talked', ...Object.fromEntries(OUTCOMES.map((o) => [o.code, o.label])) };

export function OutcomeButtons({ items = OUTCOMES, onPick, disabled = false }) {
  return (
    <div className="fk-outcomes" role="group" aria-label="No conversation">
      {items.map((o) => (
        <button key={o.code} type="button" className="fk-out" disabled={disabled} onClick={() => onPick(o.code)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Who at this door: simple tabs (name + current rating). Only for 2+ people.
export function PersonTabs({ persons, value, onPick, ratingOf = (p) => p.rating, label = 'Who you are talking to' }) {
  if (persons.length < 2) return null;
  return (
    <div className="fk-tabs" role="group" aria-label={label}>
      {persons.map((p) => {
        const on = p.id === value;
        const code = ratingOf(p);
        return (
          <button key={p.id} type="button" className={`fk-tab${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => onPick(p.id)}>
            <span className="fk-tab__name">{p.name}</span>
            {code && <RatingChip code={code} who brief />}
          </button>
        );
      })}
    </div>
  );
}

// "More" disclosure: everything that isn't the rating sits in here.
export function More({ open, onToggle, id, label = 'More', children }) {
  return (
    <div className={`fk-more${open ? ' is-open' : ''}`}>
      <button type="button" className="fk-more__btn disclose" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        {label}
      </button>
      {open && <div className="fk-more__body" id={id}>{children}</div>}
    </div>
  );
}

// Scroll something into view, clear of fixed bars at the bottom (its CSS
// scroll-margin-bottom says how much room they take). Chrome's "nearest"
// ignores scroll-margin while the element itself is on screen, so an
// element sitting under a docked bar would never move — use "end" then.
export function reveal(el) {
  if (!el?.scrollIntoView) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const below = el.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(el).scrollMarginBottom) || 0) > window.innerHeight;
  el.scrollIntoView({ block: below ? 'end' : 'nearest', behavior: reduce ? 'auto' : 'smooth' });
}

// Put focus back on the rating row (the toast's "Change").
export function focusRating(root) {
  const el = root?.querySelector('.rb-btn.is-active') || root?.querySelector('.rb-btn');
  if (!el) return;
  el.scrollIntoView?.({ block: 'nearest' });
  el.focus({ preventScroll: true });
}

export default function RatingButtons({ value = null, onPick, compact = false, disabled = false, scale: shown = null, askFirst = false }) {
  const live = useScale();
  const scale = shown || live;
  const [askWho, setAskWho] = useState(askFirst);
  const whoId = useId();
  const cur = ratingByCode(scale, value);
  const opposed = cur?.band === 'opposed';
  const four = scale.steps[3];
  // "Voting for?": the candidates on the list, then Not sure (plain 4).
  const who = [...offeredCandidates(scale).map((c) => c.code), '4'];
  const pick = (code) => { setAskWho(false); onPick?.(code); };
  // "Voting for?" opens under the row: bring it into view, so on the last
  // door of a list it never opens hidden under a docked bar or the tab bar.
  const whoRef = useRef(null);
  useEffect(() => { if (askWho && !askFirst) reveal(whoRef.current); }, [askWho, askFirst]);

  return (
    <div className={`rb${compact ? ' rb--compact' : ''}`} role="group" aria-label="Rating">
      <div className="rb-row">
        {scale.steps.slice(0, 3).map((step) => {
          const active = value === step.code;
          return (
            <button
              key={step.code}
              type="button"
              className={`rb-btn rb-btn--${step.band}${active ? ' is-active' : ''}`}
              title={step.label}
              aria-label={`${step.code}: ${step.label}`}
              aria-pressed={active}
              disabled={disabled}
              onClick={() => pick(step.code)}
            >
              <span className="rb-btn__code">{step.code}</span>
              <span className="rb-btn__sub">{step.word}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={`rb-btn rb-btn--opposed${opposed ? ' is-active' : ''}${askWho ? ' is-asking' : ''}`}
          title={`${four.word} — tap, then pick who they vote for`}
          aria-label={opposed
            ? `4: ${four.word}, ${cur.code === '4' ? 'not sure who' : `voting ${cur.name}`} — change who they vote for`
            : `4: ${four.word} — pick who they vote for`}
          aria-expanded={askWho}
          aria-controls={whoId}
          disabled={disabled}
          onClick={() => setAskWho((o) => !o)}
        >
          {/* Picked: "4" over the name — the same words as the chip ("4 · Locke"). */}
          <span className="rb-btn__code">4</span>
          <span className="rb-btn__sub">{opposed && cur.code !== '4' ? cur.name : four.word}</span>
        </button>
      </div>

      {askWho && (
        <div className="rb-who" id={whoId} ref={whoRef} role="group" aria-label="Voting for?">
          <span className="rb-who__q">Voting for?</span>
          <div className="rb-who__grid">
            {who.map((code) => {
              const r = ratingByCode(scale, code);
              const active = value === code;
              return (
                <button
                  key={code}
                  type="button"
                  className={`rb-who__btn${active ? ' is-active' : ''}${code === '4' ? ' rb-who__btn--unsure' : ''}`}
                  title={r.label}
                  aria-label={`${r.short}: ${r.label}`}
                  aria-pressed={active}
                  disabled={disabled}
                  onClick={() => pick(code)}
                >
                  <span className="rb-who__name">{ratingWho(scale, code)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
