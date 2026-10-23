// Shifts → Week (desk only): the week's shifts as slots — days across
// (Mon–Sun), Morning / Afternoon / Evening down (shared/dayparts.js, in the
// campaign's time zone). Each slot holds its shifts: title, time, "3 / 5",
// and a chip per person on it.
//
// Volunteers sit in a tray beside the board (search, role filter). Put
// someone on a shift by:
//   - dragging (mouse, pen, or touch: press and hold, then drag) a name onto
//     a shift — or onto a slot, which takes the first shift there with room;
//   - tapping (or Enter on) a name, then tapping a shift or a slot.
// Dragging a chip to another slot moves them (assign there, then off the
// old one); dragging it back to the tray, or its ×, takes them off.
//
// An empty slot: dropping a name there (or "+ Add shift") opens a short
// "New shift" form above the board — What (filled in, "Canvass —
// Evening"), Where, How many — with that day and part's hours; Create puts
// the person on it. Shifts can't be edited once made, so the board never
// makes one without the organizer seeing its name and place first.
//
// Writes are the same as the shift screen's: shift.create / shift.assign /
// shift.unassign — capacity, duplicates and permissions are the server's;
// nothing is emailed or texted until someone presses Notify on the shift.
// Someone already on an overlapping shift this week gets
// "Sam is already on … Add anyway? Yes · No". The board changes at once and
// goes back if the server says no. Needs signal: offline it shows the last
// copy and nothing moves.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { VOLUNTEER_ROLES } from '@starbase/shared/canvass';
import {
  DAY_PARTS, addDays, dayOf, partOf, partRange, safeZone, wallClock, weekBounds, weekStart,
} from '@starbase/shared/dayparts';
import { apiGet, action } from '../api.js';
import { NeedsSignalLine, useOnline } from '../components/NoSignal.jsx';
import './shifts-board.css';

const roleLabel = (code) => VOLUNTEER_ROLES.find((r) => r.code === code)?.label ?? code;
const partLabel = (code) => DAY_PARTS.find((p) => p.code === code)?.label ?? code;
const firstName = (name) => String(name || '').split(' ')[0];
// "Sam O." — chips are small; the full name is in the label.
const shortName = (name) => {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
};
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// "5pm", "9:30am" on the campaign's clock
const clockIn = (iso, tz) => {
  const { hour, minute } = wallClock(iso, tz);
  return `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, '0')}` : ''}${hour < 12 ? 'am' : 'pm'}`;
};
const timeIn = (s, tz) => (s.ends_at ? `${clockIn(s.starts_at, tz)}–${clockIn(s.ends_at, tz)}` : clockIn(s.starts_at, tz));
// '2026-10-27' → { wd: 'Tue', md: 'Oct 27', long: 'Tuesday, October 27' } (a calendar day, no zone)
const dayWords = (day) => {
  const d = new Date(`${day}T12:00:00Z`);
  const f = (o) => d.toLocaleDateString('en-CA', { timeZone: 'UTC', ...o });
  return { wd: f({ weekday: 'short' }), md: f({ month: 'short', day: 'numeric' }), num: f({ day: 'numeric' }), long: f({ weekday: 'long', month: 'long', day: 'numeric' }) };
};
const hourWord = (h) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;

// For "already on a shift then": a shift with no end counts as an hour.
const span = (s) => {
  const a = new Date(s.starts_at).getTime();
  const b = s.ends_at ? new Date(s.ends_at).getTime() : a + 3600e3;
  return [a, Math.max(b, a + 1)];
};
const overlaps = (x, y) => { const [a1, b1] = span(x); const [a2, b2] = span(y); return a1 < b2 && a2 < b1; };
const hasRoom = (s) => !s.capacity || (Number(s.filled) || 0) < s.capacity;

function useNarrow(query = '(max-width: 720px)') {
  const get = () => typeof window !== 'undefined' && window.matchMedia?.(query).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return undefined;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

// What a drop landed on, read off the element under the pointer.
const targetAt = (x, y) => {
  const el = document.elementFromPoint(x, y)?.closest?.('[data-drop]');
  if (!el) return null;
  const kind = el.dataset.drop;
  if (kind === 'shift') return { kind, shiftId: el.dataset.shift, key: `shift:${el.dataset.shift}` };
  if (kind === 'cell') return { kind, day: el.dataset.day, part: el.dataset.part, key: `cell:${el.dataset.day}|${el.dataset.part}` };
  if (kind === 'tray') return { kind, key: 'tray' };
  return null;
};

export default function ShiftsBoard({ me }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const online = useOnline();
  const narrow = useNarrow();
  const [params, setParams] = useSearchParams();
  const tz = safeZone(me?.workspace?.settings?.tz);
  const today = dayOf(new Date(), tz);
  const thisWeek = weekStart(today);
  const monday = isDay(params.get('week')) ? weekStart(params.get('week')) : thisWeek;
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const { from, to } = weekBounds(monday, tz);
  const boardKey = ['shifts', 'board', monday, tz];
  const board = useQuery({
    queryKey: boardKey,
    queryFn: () => apiGet(`/shifts/board?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    placeholderData: keepPreviousData,
  });

  const goWeek = (m) => setParams((cur) => {
    const next = new URLSearchParams(cur);
    if (m === thisWeek) next.delete('week'); else next.set('week', m);
    return next;
  }, { replace: true });

  // Phone: one day at a time — today when it's in this week, else Monday.
  const [phoneDay, setPhoneDay] = useState(null);
  const shownDay = phoneDay && days.includes(phoneDay) ? phoneDay : (days.includes(today) ? today : monday);
  const shownDays = narrow ? [shownDay] : days;

  // ── What's on the board ──
  const data = board.data;
  const shifts = data?.shifts ?? [];
  const assignments = data?.assignments ?? [];
  const peopleAll = data?.people ?? [];
  const { byCell, byId, onShift, weekCount } = useMemo(() => {
    const cells = new Map();
    const ids = new Map();
    for (const s of shifts) {
      ids.set(s.id, s);
      const k = `${dayOf(s.starts_at, tz)}|${partOf(s.starts_at, tz)}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(s);
    }
    const on = new Map();
    const count = new Map();
    for (const a of assignments) {
      if (!on.has(a.shift_id)) on.set(a.shift_id, []);
      on.get(a.shift_id).push(a);
      count.set(a.person_id, (count.get(a.person_id) || 0) + 1);
    }
    return { byCell: cells, byId: ids, onShift: on, weekCount: count };
  }, [shifts, assignments, tz]);

  // ── Tray: search + role ──
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const rolesHere = useMemo(() => {
    const set = new Set(peopleAll.flatMap((p) => p.roles || []));
    return VOLUNTEER_ROLES.filter((r) => set.has(r.code));
  }, [peopleAll]);
  const needle = q.trim().toLowerCase();
  const tray = peopleAll.filter((p) => (!role || (p.roles || []).includes(role))
    && (!needle || p.name.toLowerCase().includes(needle)));
  // Typing a name that isn't a volunteer yet: anyone on the list, like the
  // shift screen's "+ Add volunteer".
  const others = useQuery({
    queryKey: ['persons', 'search', needle],
    queryFn: () => apiGet(`/persons?q=${encodeURIComponent(needle)}&limit=8`),
    enabled: needle.length >= 2,
    placeholderData: keepPreviousData,
  });
  const trayIds = new Set(peopleAll.map((p) => p.id));
  const extra = needle.length >= 2 ? (others.data?.persons ?? []).filter((p) => !trayIds.has(p.id)).slice(0, 8) : [];

  // ── Picking up a person: a drag, or a tap / Enter then a tap on a slot ──
  // item: { person: { id, name }, from?: { assignmentId, shiftId } }
  const [picked, setPicked] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [overKey, setOverKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(null);   // { kind: 'clash' | 'new', … }
  const [note, setNote] = useState(null); // { text, undo? }
  const [error, setError] = useState(null);
  const noteTimer = useRef(null);
  const say = (n) => {
    clearTimeout(noteTimer.current);
    setNote(n);
    if (n) noteTimer.current = setTimeout(() => setNote(null), 6000);
  };
  useEffect(() => () => clearTimeout(noteTimer.current), []);

  const refresh = (shiftIds = []) => {
    queryClient.invalidateQueries({ queryKey: ['shifts'] });
    for (const id of shiftIds) queryClient.invalidateQueries({ queryKey: ['shift', id] });
    queryClient.invalidateQueries({ queryKey: ['brief'] });
    queryClient.invalidateQueries({ queryKey: ['person'] });
  };

  // Optimistic: the chip moves now; on a "no" the board goes back.
  const patch = (fn) => {
    const prev = queryClient.getQueryData(boardKey);
    queryClient.setQueryData(boardKey, (cur) => (cur ? fn(cur) : cur));
    return () => queryClient.setQueryData(boardKey, prev);
  };
  const withChip = (cur, shiftId, person, id) => ({
    ...cur,
    shifts: cur.shifts.map((s) => (s.id === shiftId ? { ...s, filled: (Number(s.filled) || 0) + 1 } : s)),
    assignments: [...cur.assignments, { id, shift_id: shiftId, person_id: person.id, name: person.name, status: 'assigned' }],
  });
  const withoutChip = (cur, assignmentId) => {
    const a = cur.assignments.find((x) => x.id === assignmentId);
    if (!a) return cur;
    return {
      ...cur,
      shifts: cur.shifts.map((s) => (s.id === a.shift_id ? { ...s, filled: Math.max(0, (Number(s.filled) || 0) - 1) } : s)),
      assignments: cur.assignments.filter((x) => x.id !== assignmentId),
    };
  };

  const assign = async (item, shift) => {
    const { person, from: src } = item;
    setError(null);
    setAsk(null);
    setPicked(null);
    setBusy(true);
    await queryClient.cancelQueries({ queryKey: boardKey });
    const undo = patch((cur) => {
      const next = withChip(cur, shift.id, person, `tmp-${Date.now()}`);
      return src ? withoutChip(next, src.assignmentId) : next;
    });
    const touched = [shift.id, src?.shiftId].filter(Boolean);
    try {
      // A move is "on the new one, then off the old one": a full or
      // refused new shift leaves them where they were.
      await action('shift.assign', { shift_id: shift.id, person_id: person.id });
      if (src) {
        try {
          await action('shift.unassign', { id: src.assignmentId });
        } catch (e) {
          setError(`${person.name} is on ${shift.title} — and still on ${byId.get(src.shiftId)?.title ?? 'the other shift'}: ${e.message}`);
          return;
        }
      }
      say({ text: src ? `${firstName(person.name)} moved to ${shift.title}` : `${firstName(person.name)} added to ${shift.title}` });
    } catch (e) {
      undo();
      setError(e.status === 409 ? `${person.name}: ${e.message}` : e.message);
    } finally {
      setBusy(false);
      refresh(touched);
    }
  };

  const remove = async (item, { undoable = true } = {}) => {
    const { person, from: src } = item;
    if (!src) return;
    setError(null);
    setAsk(null);
    setPicked(null);
    setBusy(true);
    await queryClient.cancelQueries({ queryKey: boardKey });
    const shift = byId.get(src.shiftId);
    const undo = patch((cur) => withoutChip(cur, src.assignmentId));
    try {
      await action('shift.unassign', { id: src.assignmentId });
      say({
        text: `${firstName(person.name)} off ${shift?.title ?? 'the shift'}`,
        undo: undoable && shift ? () => assign({ person }, shift) : null,
      });
    } catch (e) {
      undo();
      setError(`${person.name}: ${e.message}`);
    } finally {
      setBusy(false);
      refresh([src.shiftId]);
    }
  };

  // Someone already on a shift that overlaps this one (not the one they're
  // moving off) — asked about before it's saved.
  const clashFor = (personId, shift, skipShiftId) => assignments
    .filter((a) => a.person_id === personId && a.shift_id !== shift.id && a.shift_id !== skipShiftId)
    .map((a) => byId.get(a.shift_id))
    .find((s) => s && overlaps(s, shift)) || null;

  const putOn = (item, shift) => {
    const name = firstName(item.person.name);
    if (item.from?.shiftId === shift.id) { setPicked(null); return; }
    if ((onShift.get(shift.id) ?? []).some((a) => a.person_id === item.person.id)) {
      setPicked(null);
      say({ text: `${name} is already on ${shift.title}` });
      return;
    }
    if (!hasRoom(shift)) { setPicked(null); say({ text: `${shift.title} is full` }); return; }
    const clash = clashFor(item.person.id, shift, item.from?.shiftId);
    if (clash) { setPicked(null); setAsk({ kind: 'clash', item, shift, clash }); return; }
    assign(item, shift);
  };

  const dropOn = (item, target) => {
    if (!item || !target || busy) return;
    if (!online) { say({ text: 'Needs signal — nothing changed' }); return; }
    if (target.kind === 'tray') { if (item.from) remove(item); else setPicked(null); return; }
    if (target.kind === 'shift') { const s = byId.get(target.shiftId); if (s) putOn(item, s); return; }
    // A slot: the first shift there that this person isn't on and has room.
    const list = byCell.get(`${target.day}|${target.part}`) ?? [];
    if (list.length === 0) { setPicked(null); openNew(target.day, target.part, item); return; }
    const pick = list.find((s) => s.id !== item.from?.shiftId && hasRoom(s)
      && !(onShift.get(s.id) ?? []).some((a) => a.person_id === item.person.id));
    if (pick) { putOn(item, pick); return; }
    setPicked(null);
    say({ text: list.every((s) => (onShift.get(s.id) ?? []).some((a) => a.person_id === item.person.id))
      ? `${firstName(item.person.name)} is already on it`
      : `${partLabel(target.part)} is full` });
  };

  // ── New shift from an empty slot ──
  const newRef = useRef(null);
  const openNew = (day, part, item = null) => {
    setError(null);
    setAsk({ kind: 'new', day, part, item, title: `Canvass — ${partLabel(part)}`, location: '', capacity: '' });
  };
  useEffect(() => {
    if (ask?.kind === 'new') newRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [ask?.kind, ask?.day, ask?.part]);
  const createShift = async (e) => {
    e.preventDefault();
    const f = ask;
    const title = f.title.trim();
    if (!title) { setError('Give the shift a name'); return; }
    let capacity;
    if (String(f.capacity).trim()) {
      capacity = Number(f.capacity);
      if (!Number.isInteger(capacity) || capacity < 1) { setError('How many: a whole number, 1 or more'); return; }
    }
    setError(null);
    setBusy(true);
    let shift = null;
    try {
      const res = await action('shift.create', {
        title, location: f.location.trim() || undefined, capacity, ...partRange(f.day, f.part, tz),
      });
      shift = { ...res.shift, filled: 0 };
      queryClient.setQueryData(boardKey, (cur) => (cur ? { ...cur, shifts: [...cur.shifts, shift] } : cur));
      setAsk(null);
    } catch (err) {
      setError(err.message);
      setBusy(false);
      return;
    }
    setBusy(false);
    if (f.item) await assign(f.item, shift);
    else { say({ text: `${title} added` }); refresh(); }
  };

  // ── Drag: pointer events (mouse, pen, touch). Mouse and pen pick up after
  // a few pixels; touch after a short press, so a swipe still scrolls. ──
  const drag = useRef(null);
  const ghost = useRef(null);
  const swallowClick = useRef(false);
  const dropRef = useRef(dropOn);
  dropRef.current = dropOn;
  const place = (x, y) => {
    if (ghost.current) ghost.current.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
  };
  // Picked up: the ghost follows the pointer; near the top or bottom of the
  // screen the page scrolls so a slot further down can be reached.
  const begin = (d) => {
    d.active = true;
    setDragging(d.item);
    setPicked(null);
    place(d.x, d.y);
    d.scroll = setInterval(() => {
      if (d.y < 56) window.scrollBy(0, -12);
      else if (d.y > window.innerHeight - 56) window.scrollBy(0, 12);
    }, 16);
    navigator.vibrate?.(10);
  };
  const beginRef = useRef(begin);
  beginRef.current = begin;

  useEffect(() => {
    const end = () => {
      const d = drag.current;
      if (!d) return;
      clearTimeout(d.timer);
      clearInterval(d.scroll);
      drag.current = null;
      setDragging(null);
      setOverKey(null);
    };
    const onMove = (e) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      const moved = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
      d.x = e.clientX;
      d.y = e.clientY;
      if (!d.active) {
        if (moved < 6) return;
        if (d.touch) { end(); return; } // moved before the press finished: a scroll
        beginRef.current(d);
      }
      if (ghost.current) ghost.current.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
      const t = targetAt(e.clientX, e.clientY);
      setOverKey(t?.key ?? null);
    };
    const onUp = (e) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (d.active) {
        swallowClick.current = true;
        setTimeout(() => { swallowClick.current = false; }, 0);
        const t = targetAt(e.clientX, e.clientY);
        const { item } = d;
        end();
        dropRef.current(item, t);
      } else end();
    };
    const onCancel = (e) => { if (drag.current && e.pointerId === drag.current.pointerId) end(); };
    // While a touch drag is on, the page must not scroll under the finger.
    const onTouchMove = (e) => { if (drag.current?.active) e.preventDefault(); };
    const onKey = (e) => { if (e.key === 'Escape') { end(); setPicked(null); } };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      end();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const grab = (item) => (e) => {
    if (!online || busy || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const d = {
      item, pointerId: e.pointerId, touch: e.pointerType === 'touch',
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false,
    };
    clearTimeout(drag.current?.timer);
    drag.current = d;
    if (d.touch) {
      d.timer = setTimeout(() => { if (drag.current === d) begin(d); }, 280);
    }
  };
  // Tap / Enter: pick up, or put down if it's already in hand.
  const tapPerson = (item) => {
    if (swallowClick.current) return;
    setError(null);
    setPicked((cur) => (cur && cur.person.id === item.person.id && cur.from?.assignmentId === item.from?.assignmentId ? null : item));
  };
  const tapTarget = (target) => {
    if (swallowClick.current || !picked) return false;
    dropOn(picked, target);
    return true;
  };
  const dragProps = (item) => ({
    onPointerDown: grab(item),
    onContextMenu: (e) => e.preventDefault(),
    onClick: () => tapPerson(item),
    'aria-pressed': !!picked && picked.person.id === item.person.id && picked.from?.assignmentId === item.from?.assignmentId,
    disabled: !online,
  });
  const hot = (key) => (dragging && overKey === key ? '' : undefined);

  // ── Render ──
  const weekLabel = `${dayWords(days[0]).md} – ${dayWords(days[6]).md}`;
  const personBtn = (p, isExtra = false) => {
    const item = { person: { id: p.id, name: p.name } };
    const n = weekCount.get(p.id) || 0;
    return (
      <li key={p.id}>
        <button type="button" className="sb-person" data-extra={isExtra ? '' : undefined} {...dragProps(item)}
          title={(p.roles || []).map(roleLabel).join(', ') || undefined}>
          <span className="sb-person__name">{p.name}</span>
          {n > 0 && <span className="sb-person__n" aria-label={`${n} this week`}>{n}</span>}
        </button>
      </li>
    );
  };

  const shiftBlock = (s, day, part) => {
    const chips = onShift.get(s.id) ?? [];
    const filled = Number(s.filled) || 0;
    const full = !!s.capacity && filled >= s.capacity;
    const label = `${s.title}, ${timeIn(s, tz)}, ${s.capacity ? `${filled} of ${s.capacity}` : `${filled} on it`}`;
    return (
      <div key={s.id} className="sb-shift" data-drop="shift" data-shift={s.id} data-hot={hot(`shift:${s.id}`)} data-full={full ? '' : undefined}>
        <button type="button" className="sb-shift__head" aria-label={picked ? `Put ${picked.person.name} on ${label}` : `Open ${label}`}
          onClick={() => { if (!tapTarget({ kind: 'shift', shiftId: s.id })) navigate(`/shifts/${s.id}`); }}>
          <span className="sb-shift__title">{s.title}</span>
          <span className="sb-shift__meta">
            <span>{timeIn(s, tz)}</span>
            <span className="sb-cap" data-full={full ? '' : undefined}>{s.capacity ? `${filled} / ${s.capacity}` : `${filled} on`}</span>
          </span>
        </button>
        {chips.length > 0 && (
          <ul className="sb-chips" aria-label={`On ${s.title}`}>
            {chips.map((a) => {
              const item = { person: { id: a.person_id, name: a.name }, from: { assignmentId: a.id, shiftId: s.id } };
              const temp = String(a.id).startsWith('tmp-');
              return (
                <li key={a.id} className="sb-chip" data-temp={temp ? '' : undefined}>
                  <button type="button" className="sb-chip__name" {...dragProps(item)} disabled={!online || temp}
                    aria-label={`${a.name} — move`} title={a.name}>
                    {shortName(a.name)}
                  </button>
                  <button type="button" className="sb-chip__x" aria-label={`Take ${a.name} off ${s.title}`}
                    disabled={!online || busy || temp} onClick={() => remove(item)}>×</button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  };

  const cell = (day, part) => {
    const list = byCell.get(`${day}|${part.code}`) ?? [];
    const key = `cell:${day}|${part.code}`;
    const past = day < today;
    return (
      <div key={key} className="sb-cell" role="group" aria-label={`${dayWords(day).long}, ${part.label}`}
        data-drop="cell" data-day={day} data-part={part.code} data-hot={hot(key)} data-past={past ? '' : undefined}
        data-empty={list.length ? undefined : ''}>
        {narrow && <span className="sb-cell__part">{part.label} <small>{hourWord(part.start)}–{hourWord(part.end)}</small></span>}
        {list.map((s) => shiftBlock(s, day, part.code))}
        {list.length === 0 && (
          <button type="button" className="sb-add" disabled={!online || busy}
            onClick={() => { if (!tapTarget({ kind: 'cell', day, part: part.code })) openNew(day, part.code); }}>
            {picked ? `+ New shift for ${firstName(picked.person.name)}` : '+ Add shift'}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="sb" data-dragging={dragging ? '' : undefined}>
      <div className="sb-week" role="group" aria-label="Week">
        <button type="button" className="btn btn-quiet sb-nav" aria-label="Last week" onClick={() => goWeek(addDays(monday, -7))}>‹</button>
        <span className="sb-week__label">{weekLabel}</span>
        <button type="button" className="btn btn-quiet sb-nav" aria-label="Next week" onClick={() => goWeek(addDays(monday, 7))}>›</button>
        {monday !== thisWeek && (
          <button type="button" className="btn btn-quiet sb-today" onClick={() => { setPhoneDay(null); goWeek(thisWeek); }}>This week</button>
        )}
      </div>

      {!online && <NeedsSignalLine>Moving people needs signal</NeedsSignalLine>}
      {board.isError && <p className="error">{board.error.message}</p>}
      {board.isPending && <p className="muted">{board.fetchStatus === 'paused' ? 'Offline — loads with signal' : 'Loading…'}</p>}

      {ask?.kind === 'clash' && (
        <div className="ops-confirm sb-ask" role="group" aria-label="Already on a shift then">
          <span>{firstName(ask.item.person.name)} is already on {ask.clash.title} ({timeIn(ask.clash, tz)}). Add anyway?</span>
          <button type="button" className="btn ops-solid ops-tap" disabled={busy} onClick={() => assign(ask.item, ask.shift)}>Yes</button>
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsk(null)}>No</button>
        </div>
      )}

      {ask?.kind === 'new' && (
        <form className="card ops-form sb-new" ref={newRef} onSubmit={createShift} aria-label="New shift">
          <span className="eyebrow">
            New shift · {dayWords(ask.day).wd} {dayWords(ask.day).md} · {partLabel(ask.part)}{' '}
            {(() => { const p = DAY_PARTS.find((x) => x.code === ask.part); return `${hourWord(p.start)}–${hourWord(p.end)}`; })()}
          </span>
          <div className="sb-new__fields">
            <div className="field">
              <label htmlFor="sb-new-title">What</label>
              <input id="sb-new-title" className="input" autoFocus value={ask.title}
                onChange={(e) => setAsk((a) => ({ ...a, title: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="sb-new-where">Where</label>
              <input id="sb-new-where" className="input" placeholder="Campaign office" value={ask.location}
                onChange={(e) => setAsk((a) => ({ ...a, location: e.target.value }))} />
            </div>
            <div className="field sb-new__n">
              <label htmlFor="sb-new-n">How many</label>
              <input id="sb-new-n" className="input mono" type="number" min="1" step="1" inputMode="numeric" placeholder="No limit"
                value={ask.capacity} onChange={(e) => setAsk((a) => ({ ...a, capacity: e.target.value }))} />
            </div>
          </div>
          <div className="ops-actions">
            <button type="submit" className="btn ops-solid ops-tap" disabled={busy || !online}>
              {ask.item ? `Create + add ${firstName(ask.item.person.name)}` : 'Create shift'}
            </button>
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsk(null)}>Cancel</button>
          </div>
        </form>
      )}

      {error && <p className="error" role="alert">{error}</p>}

      <div className="sb-layout">
        <aside className="sb-tray" data-drop="tray" data-hot={hot('tray')} aria-label="Volunteers">
          <div className="sb-tray__find">
            <input className="input sb-search" type="search" placeholder="Find a volunteer" aria-label="Find a volunteer"
              value={q} onChange={(e) => setQ(e.target.value)} />
            {rolesHere.length > 0 && (
              <select className="input sb-role" aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">Any role</option>
                {rolesHere.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
              </select>
            )}
          </div>
          {dragging?.from && <p className="sb-tray__drop">Drop here to take off the shift</p>}
          {board.isSuccess && tray.length === 0 && extra.length === 0 && (
            <p className="ops-meta sb-tray__none">
              {peopleAll.length === 0 && !needle ? <>No volunteers yet. <Link to="/people">Add roles in People</Link></> : 'No one matches.'}
            </p>
          )}
          <ul className="sb-people">
            {tray.map((p) => personBtn(p))}
            {extra.map((p) => personBtn(p, true))}
          </ul>
        </aside>

        <div className="sb-board">
          {picked && (
            <div className="sb-hand" role="status">
              <span><b>{picked.person.name}</b> — tap a shift or a slot</span>
              {picked.from && (
                <button type="button" className="btn btn-quiet sb-hand__btn" disabled={busy}
                  onClick={() => remove(picked)}>Take off</button>
              )}
              <button type="button" className="btn btn-quiet sb-hand__btn" onClick={() => setPicked(null)}>Cancel</button>
            </div>
          )}

          {narrow && (
            <div className="sb-days" role="group" aria-label="Day">
              {days.map((d) => {
                const w = dayWords(d);
                const n = DAY_PARTS.reduce((t, p) => t + (byCell.get(`${d}|${p.code}`)?.length ?? 0), 0);
                return (
                  <button key={d} type="button" className="sb-day" aria-pressed={d === shownDay} data-today={d === today ? '' : undefined}
                    aria-label={`${w.long}${n ? `, ${n} ${n === 1 ? 'shift' : 'shifts'}` : ''}`} onClick={() => setPhoneDay(d)}>
                    <span className="sb-day__wd">{w.wd}</span>
                    <span className="sb-day__n">{w.num}</span>
                    {n > 0 && <span className="sb-day__dot" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          )}

          <div className="sb-grid" style={{ '--sb-cols': shownDays.length }} data-narrow={narrow ? '' : undefined}>
            {!narrow && <span className="sb-corner" aria-hidden="true" />}
            {!narrow && shownDays.map((d) => {
              const w = dayWords(d);
              return (
                <span key={d} className="sb-colhead" data-today={d === today ? '' : undefined}>
                  <span className="sb-colhead__wd">{w.wd}</span> <span className="sb-colhead__md">{w.md}</span>
                </span>
              );
            })}
            {DAY_PARTS.map((part) => (
              <div key={part.code} className="sb-row" role="presentation">
                {!narrow && (
                  <span className="sb-rowhead">
                    {part.label}
                    <small>{hourWord(part.start)}–{hourWord(part.end)}</small>
                  </span>
                )}
                {shownDays.map((d) => cell(d, part))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Always in the page (hidden when idle) so it can be placed the moment a drag starts. */}
      <div className="sb-ghost" ref={ghost} aria-hidden="true" hidden={!dragging}>{dragging?.person.name}</div>

      {note && (
        <div className="toast ops-toast sb-toast" data-plain={note.undo ? undefined : ''} role="status">
          <span>{note.text}</span>
          {note.undo && <button type="button" className="btn" disabled={busy} onClick={() => { const u = note.undo; say(null); u(); }}>Undo</button>}
        </div>
      )}
    </div>
  );
}
