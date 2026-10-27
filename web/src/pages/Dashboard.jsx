// The managers' dashboard, at the top of Today (GET /api/dashboard):
//   Overview        contacts in the period — how many, doors, calls & texts,
//                   people reached, support, who is out now — each with
//                   today's and all-time figures underneath
//   Over time       a bar per day (per week on "All time"), stacked by
//                   outcome — Talked · No answer · Refused · Moved · No
//                   access — in that fixed order and colour; Grouped lays
//                   the outcomes side by side; Table shows the numbers
//   In the field    the map: every contact in the period as a dot (its
//                   outcome's colour; tap one for who, what, by whom, when,
//                   and the profile), everyone who has canvassed as their
//                   initials — a ring and "out now" while they share their
//                   location (the map's switch), grey at their last door
//                   otherwise; tap one for their day and "only theirs" —
//                   the turfs' outlines (tap for the turf on the map); pick
//                   a person to see their trail (today), their contacts
//                   and their numbers
//   By team         each team's contacts and outcomes, how many of its
//                   members are out; "No team" for the rest
//   Latest          the last twenty contacts, who logged what where
// Today · 7 days · 30 days · All time is one filter row for everything but
// Latest (always the last twenty). Refreshes itself every minute while open.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { apiGet, initials } from '../api.js';
import { DEFAULT_TILES, SURREY_BOUNDS, safeAttribution } from '../components/tiles.js';
import { OUTCOME_LABEL } from '../components/RatingButtons.jsx';
import './dashboard.css';

// The outcomes, in a fixed order with a fixed colour each (a filter never
// repaints a survivor). The five hues pass the colour-vision checks on both
// the light and the dark surface.
export const OUTCOME_SERIES = [
  { key: 'contacted', label: OUTCOME_LABEL.contacted, color: '#2a9d8f' },
  { key: 'no_answer', label: OUTCOME_LABEL.no_answer, color: '#7b61ff' },
  { key: 'refused', label: OUTCOME_LABEL.refused, color: '#b91c1c' },
  { key: 'moved', label: OUTCOME_LABEL.moved, color: '#b97a00' },
  { key: 'inaccessible', label: OUTCOME_LABEL.inaccessible, color: '#1f5fa8' },
];
const COLOR = Object.fromEntries(OUTCOME_SERIES.map((o) => [o.key, o.color]));
const PERIODS = [
  { key: 'today', label: 'Today' }, { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' }, { key: 'all', label: 'All time' },
];
const PERIOD_WORD = { today: 'today', '7d': 'in the last 7 days', '30d': 'in the last 30 days', all: 'in all' };
const PERIOD_PREF = 'starbase:dash:period';
const readPeriod = () => { try { return PERIODS.some((p) => p.key === localStorage.getItem(PERIOD_PREF)) ? localStorage.getItem(PERIOD_PREF) : '30d'; } catch { return '30d'; } };
const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
const plural = (n, w, many = `${w}s`) => (n === 1 ? w : many);

export const timeAgo = (iso, now = Date.now()) => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} ${plural(h, 'hour')} ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} ${plural(d, 'day')} ago`;
  const mo = Math.round(d / 30);
  return `${mo} ${plural(mo, 'month')} ago`;
};
const dayLabel = (ymd, long = false) => {
  const d = new Date(`${ymd}T12:00:00`);
  return d.toLocaleDateString('en-CA', long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
};
const clock = (iso) => new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });

export default function Dashboard() {
  const [period, setPeriodState] = useState(readPeriod);
  const setPeriod = (p) => { setPeriodState(p); try { localStorage.setItem(PERIOD_PREF, p); } catch { /* storage blocked */ } };
  const q = useQuery({
    queryKey: ['dashboard', period],
    queryFn: () => apiGet(`/dashboard?period=${period}`),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
  const tilesQ = useQuery({ queryKey: ['mapConfig'], queryFn: () => apiGet('/map/config'), staleTime: 10 * 60_000, retry: 1 });
  const tiles = tilesQ.data?.tiles || (tilesQ.isError ? DEFAULT_TILES : null);
  const d = q.data;
  const [sel, setSel] = useState(null); // user id picked in the field list
  const headId = useId();

  return (
    <section className="dash" aria-labelledby={headId} data-testid="dashboard">
      <header className="dash-head">
        <h2 className="today-h" id={headId}>Dashboard</h2>
        <div className="dash-periods" role="radiogroup" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p.key} type="button" role="radio" aria-checked={period === p.key}
              className={`dash-period${period === p.key ? ' is-on' : ''}`} onClick={() => setPeriod(p.key)}>{p.label}</button>
          ))}
        </div>
      </header>
      {q.isError && !d && <p className="error" role="alert">Couldn’t load the dashboard — {q.error.message}</p>}
      {!d && !q.isError && <p className="muted">Loading…</p>}
      {d && (
        <div className={q.isFetching && q.data?.period !== period ? 'dash-stale' : undefined}>
          <Overview d={d} period={period} />
          <OverTime d={d} period={period} />
          <Field d={d} tiles={tiles} sel={sel} onSel={setSel} period={period} />
          <Teams d={d} period={period} />
          <Latest d={d} />
        </div>
      )}
    </section>
  );
}

// ── Overview ──
function Overview({ d, period }) {
  const o = d.overview;
  const figs = [
    { key: 'contacts', label: 'Contacts', get: (x) => x.contacts },
    { key: 'doors', label: 'Doors', get: (x) => x.doors },
    { key: 'callstexts', label: 'Calls & texts', get: (x) => x.calls + x.texts },
    { key: 'people', label: 'People reached', get: (x) => x.people },
    { key: 'support', label: 'Support', get: (x) => x.support },
    { key: 'who', label: 'Canvassers', get: (x) => x.who },
  ];
  return (
    <div className="dash-figs" role="list" aria-label={`Interactions ${PERIOD_WORD[period]}`}>
      {figs.map((f) => (
        <div className="dash-fig" role="listitem" key={f.key}>
          <span className="dash-fig__n">{num(f.get(o.period))}</span>
          <span className="dash-fig__label">{f.label}</span>
          <span className="dash-fig__sub mono">
            {period !== 'today' && <>Today {num(f.get(o.today))} · </>}{period !== 'all' && <>All {num(f.get(o.all))}</>}
            {period === 'all' && <>Today {num(f.get(o.today))}</>}
          </span>
        </div>
      ))}
      <div className="dash-fig dash-fig--live" role="listitem">
        <span className="dash-fig__n">{num(d.out_now)}</span>
        <span className="dash-fig__label">Out now</span>
        <span className="dash-fig__sub mono">{d.out_now ? 'sharing location' : 'nobody sharing'}</span>
      </div>
    </div>
  );
}

// ── Over time: the stacked bar ──
function useWidth(ref) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => setW(el.getBoundingClientRect().width);
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
const niceMax = (n) => {
  if (n <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
};
// A bar with its top corners rounded (never the baseline end).
const topRounded = (x, y, w, h, r0) => {
  const r = Math.min(r0, w / 2, h);
  if (h <= 0) return '';
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
};

function OverTime({ d, period }) {
  const [mode, setMode] = useState('stacked');
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState(null); // index of the day under the pointer / focus
  const boxRef = useRef(null);
  const width = useWidth(boxRef);
  const series = d.series;
  const weekly = d.granularity === 'week';
  const totals = series.map((r) => OUTCOME_SERIES.reduce((a, o) => a + (r[o.key] || 0), 0));
  const sumBy = Object.fromEntries(OUTCOME_SERIES.map((o) => [o.key, series.reduce((a, r) => a + (r[o.key] || 0), 0)]));
  const grand = totals.reduce((a, b) => a + b, 0);
  const maxV = mode === 'stacked' ? Math.max(...totals, 0) : Math.max(...series.flatMap((r) => OUTCOME_SERIES.map((o) => r[o.key] || 0)), 0);
  const yMax = niceMax(maxV);
  const H = 180; const padL = 30; const padR = 6; const padT = 10; const padB = 24;
  const W = Math.max(width, 280);
  const innerW = W - padL - padR; const innerH = H - padT - padB;
  const n = series.length || 1;
  const slot = innerW / n;
  const y = (v) => padT + innerH - (v / yMax) * innerH;
  const ticks = [0, yMax / 2, yMax];
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 64))));
  const ttRef = useRef(null);
  const tipId = useId();

  return (
    <section className="dash-sec" aria-labelledby={`${tipId}-h`}>
      <header className="dash-sec__head">
        <h3 className="dash-sec__h" id={`${tipId}-h`}>Interactions over time <span className="muted">· {grand ? `${num(grand)} ${PERIOD_WORD[period]}` : `none ${PERIOD_WORD[period]}`}</span></h3>
        <div className="dash-seg" role="group" aria-label="Chart">
          <button type="button" className={`dash-seg__b${mode === 'stacked' && !table ? ' is-on' : ''}`} aria-pressed={mode === 'stacked' && !table} onClick={() => { setMode('stacked'); setTable(false); }}>Stacked</button>
          <button type="button" className={`dash-seg__b${mode === 'grouped' && !table ? ' is-on' : ''}`} aria-pressed={mode === 'grouped' && !table} onClick={() => { setMode('grouped'); setTable(false); }}>Grouped</button>
          <button type="button" className={`dash-seg__b${table ? ' is-on' : ''}`} aria-pressed={table} onClick={() => setTable(true)}>Table</button>
        </div>
      </header>
      <ul className="dash-legend" aria-label="Outcomes">
        {OUTCOME_SERIES.map((o) => (
          <li key={o.key} className="dash-legend__i"><span className="dash-swatch" style={{ background: o.color }} aria-hidden="true" />{o.label} <span className="mono muted">{num(sumBy[o.key])}</span></li>
        ))}
      </ul>
      {table ? (
        <div className="dash-tablewrap">
          <table className="dash-table">
            <thead><tr><th scope="col">{weekly ? 'Week of' : 'Day'}</th>{OUTCOME_SERIES.map((o) => <th scope="col" key={o.key}>{o.label}</th>)}<th scope="col">All</th></tr></thead>
            <tbody>
              {series.map((r, i) => (
                <tr key={r.day}><th scope="row">{dayLabel(r.day, !weekly)}</th>{OUTCOME_SERIES.map((o) => <td key={o.key} className="mono">{num(r[o.key])}</td>)}<td className="mono">{num(totals[i])}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="dash-chart" ref={boxRef}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Contacts per ${weekly ? 'week' : 'day'} by outcome; see the table for the numbers`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="dash-grid" />
                <text x={padL - 6} y={y(t) + 4} textAnchor="end" className="dash-axis">{num(t)}</text>
              </g>
            ))}
            {series.map((r, i) => {
              const x0 = padL + i * slot;
              const parts = [];
              if (mode === 'stacked') {
                const bw = Math.max(2, Math.min(slot - 2, 36));
                const bx = x0 + (slot - bw) / 2;
                let acc = 0; let topKey = null;
                for (const o of OUTCOME_SERIES) if (r[o.key] > 0) topKey = o.key;
                for (const o of OUTCOME_SERIES) {
                  const v = r[o.key] || 0;
                  if (!v) continue;
                  const y1 = y(acc + v); const h = y(acc) - y1;
                  parts.push(o.key === topKey
                    ? <path key={o.key} d={topRounded(bx, y1, bw, h, 4)} fill={o.color} className="dash-bar" />
                    : <rect key={o.key} x={bx} y={y1} width={bw} height={h} fill={o.color} className="dash-bar" />);
                  acc += v;
                }
              } else {
                const gw = Math.max(1, (Math.min(slot, 60) - 4) / OUTCOME_SERIES.length);
                const gx = x0 + (slot - gw * OUTCOME_SERIES.length) / 2;
                OUTCOME_SERIES.forEach((o, j) => {
                  const v = r[o.key] || 0;
                  if (!v) return;
                  const y1 = y(v); const h = y(0) - y1;
                  parts.push(<path key={o.key} d={topRounded(gx + j * gw, y1, Math.max(1, gw - 1), h, 3)} fill={o.color} className="dash-bar" />);
                });
              }
              const show = i % labelEvery === 0 || i === n - 1;
              return (
                <g key={r.day}>
                  {parts}
                  {show && <text x={x0 + slot / 2} y={H - 6} textAnchor="middle" className="dash-axis">{dayLabel(r.day)}</text>}
                  <rect
                    x={x0} y={padT} width={slot} height={innerH} className={`dash-hit${hover === i ? ' is-on' : ''}`}
                    tabIndex={0} aria-label={`${dayLabel(r.day, true)}: ${totals[i]} ${plural(totals[i], 'contact')}`}
                    aria-describedby={hover === i ? tipId : undefined}
                    onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                  />
                </g>
              );
            })}
            <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} className="dash-base" />
          </svg>
          {hover !== null && series[hover] && (
            <div className="dash-tip" id={tipId} role="tooltip" ref={ttRef}
              style={{ left: Math.min(Math.max(padL + hover * slot + slot / 2, 90), W - 90) }}>
              <strong>{weekly ? `Week of ${dayLabel(series[hover].day)}` : dayLabel(series[hover].day, true)}</strong>
              <span className="mono">{num(totals[hover])} {plural(totals[hover], 'contact')}</span>
              {OUTCOME_SERIES.filter((o) => series[hover][o.key] > 0).map((o) => (
                <span key={o.key}><span className="dash-swatch" style={{ background: o.color }} aria-hidden="true" />{o.label} <span className="mono">{num(series[hover][o.key])}</span></span>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ── In the field: the map and the people ──
const personIcon = (p, selected) => L.divIcon({
  className: 'dash-who-wrap',
  html: `<div class="dash-who${p.out_now ? ' is-out' : ''}${p.sharing ? '' : ' is-stale'}${selected ? ' is-sel' : ''}" title="${p.name.replace(/"/g, '&quot;')}">${initials(p.name)}</div>`,
  iconSize: [34, 34], iconAnchor: [17, 17],
});

function Field({ d, tiles, sel, onSel, period }) {
  const boxRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef(null);
  // The whole city, every time nobody is picked (the map stands portrait,
  // as Surrey does — dashboard.css); a resize refits it.
  const fitCity = (map) => map.fitBounds(SURREY_BOUNDS, { padding: [6, 6] });
  const selected = d.people.find((p) => p.id === sel) || null;
  const selRef = useRef(sel);
  const wasSelRef = useRef(false);
  const headId = useId();

  useEffect(() => {
    const el = boxRef.current;
    if (!el || mapRef.current) return undefined;
    const map = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: true, zoomSnap: 0.25 });
    fitCity(map);
    const layers = { turfs: L.layerGroup().addTo(map), pins: L.layerGroup().addTo(map), trail: L.layerGroup().addTo(map), people: L.layerGroup().addTo(map) };
    mapRef.current = map; layersRef.current = layers;
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => { map.invalidateSize(); if (!selRef.current) fitCity(map); });
      ro.observe(el);
    }
    return () => { ro?.disconnect(); map.remove(); mapRef.current = null; layersRef.current = null; };
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !tiles?.url) return undefined;
    const layer = L.tileLayer(tiles.url, { maxZoom: tiles.maxZoom || 19, attribution: safeAttribution(tiles.attribution) }).addTo(map);
    return () => { layer.remove(); };
  }, [tiles?.url, tiles?.maxZoom, tiles?.attribution]);

  useEffect(() => {
    const map = mapRef.current; const ly = layersRef.current;
    if (!map || !ly) return;
    ly.turfs.clearLayers(); ly.pins.clearLayers(); ly.trail.clearLayers(); ly.people.clearLayers();
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const nameOf = new Map(d.people.map((p) => [p.id, p.name]));
    for (const t of d.turfs) {
      if (!Array.isArray(t.polygon) || t.polygon.length < 3) continue;
      const poly = L.polygon(t.polygon.map(([a, b]) => [Number(a), Number(b)]), { color: t.color || '#003979', weight: 1.5, fillOpacity: 0.05 }).addTo(ly.turfs);
      poly.bindTooltip(t.name, { sticky: true, className: 'dash-tt' });
      poly.bindPopup(`<div class="dash-pop"><strong>${esc(t.name)}</strong><br><a href="/map?turf=${esc(t.id)}">Open on the map ›</a></div>`);
    }
    const pins = sel ? d.pins.filter((p) => p.user_id === sel) : d.pins;
    for (const p of pins) {
      const dot = L.circleMarker([p.lat, p.lng], { radius: 5, color: '#fff', weight: 1, fillColor: COLOR[p.outcome] || '#5b6472', fillOpacity: 0.9, bubblingMouseEvents: false }).addTo(ly.pins);
      const label = OUTCOME_LABEL[p.outcome] || p.outcome;
      dot.bindTooltip(`${p.name} · ${label}`, { direction: 'top', offset: [0, -6], className: 'dash-tt' });
      dot.bindPopup(`<div class="dash-pop">
        <strong>${esc(p.name)}</strong>${p.address ? `<br><span class="dash-pop__sub">${esc(p.address)}</span>` : ''}
        <br><span class="dash-pop__dot" style="background:${COLOR[p.outcome] || '#5b6472'}"></span> ${esc(label)}${p.rating ? ` · rated ${esc(p.rating)}` : ''}${p.channel !== 'door' ? ` · by ${esc(p.channel)}` : ''}
        <br><span class="dash-pop__sub">${esc(nameOf.get(p.user_id) || 'someone')} · ${esc(new Date(p.at).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span>
        <br><a href="/people/${esc(p.person_id)}">Profile ›</a> · <a href="/map?person=${esc(p.person_id)}">On the map ›</a>
      </div>`);
    }
    if (selected?.trail?.length > 1) {
      L.polyline(selected.trail.map(([a, b]) => [a, b]), { color: '#003979', weight: 3, opacity: 0.7, dashArray: '2 6', interactive: false }).addTo(ly.trail);
    }
    for (const p of d.people) {
      if (!p.where) continue;
      const ll = [p.where.lat, p.where.lng];
      if (p.out_now && p.where.accuracy) L.circle(ll, { radius: p.where.accuracy, className: 'dash-acc', interactive: false }).addTo(ly.people);
      const m = L.marker(ll, { icon: personIcon(p, p.id === sel), keyboard: false, zIndexOffset: p.out_now ? 2000 : 1000 }).addTo(ly.people);
      m.bindTooltip(`${p.name}${p.out_now ? ' · out now' : ''}`, { direction: 'top', offset: [0, -18], className: 'dash-tt' });
      m.bindPopup(`<div class="dash-pop">
        <strong>${esc(p.name)}</strong> <span class="dash-pop__sub">${esc(p.teams.length ? p.teams.join(', ') : p.role)}</span>
        <br>${p.out_now ? `<span class="dash-pop__live">Out now</span> · last fix ${esc(clock(p.where.at))}` : `Last ${esc(p.where.from === 'position' ? 'seen' : 'knocked')} ${esc(timeAgo(p.where.at))}`}
        <br>${num(p.contacts)} ${num(p.contacts) === '1' ? 'contact' : 'contacts'} ${esc(PERIOD_WORD[period])}
        <br><button type="button" class="dash-pop__btn" data-sel="${esc(p.id)}">${p.id === sel ? 'Show everyone' : 'Only their contacts'}</button>
      </div>`);
      m.on('popupopen', (e) => {
        const btn = e.popup.getElement()?.querySelector('[data-sel]');
        if (btn) btn.addEventListener('click', () => { onSel(p.id === sel ? null : p.id); map.closePopup(); });
      });
    }
    if (selected?.where) {
      map.setView([selected.where.lat, selected.where.lng], Math.max(map.getZoom(), 15));
    } else if (wasSelRef.current) {
      fitCity(map); // back from one person to the whole city
    }
    wasSelRef.current = !!selected;
    selRef.current = sel;
  }, [d, sel, selected, onSel, period]);

  const now = Date.now();
  return (
    <section className="dash-sec" aria-labelledby={headId}>
      <header className="dash-sec__head">
        <h3 className="dash-sec__h" id={headId}>In the field <span className="muted">· {d.out_now ? `${num(d.out_now)} out now` : 'nobody out now'}</span></h3>
        <span className="dash-sec__links">
          {sel && <button type="button" className="btn btn-quiet dash-sec__btn" onClick={() => onSel(null)}>Show everyone</button>}
          <Link className="dash-sec__link" to="/map">The map ›</Link>
        </span>
      </header>
      <div className="dash-field">
        <div className="dash-map" ref={boxRef} role="region" aria-label="Where everyone is" />
        <div className="dash-people">
          {d.people.length === 0 && <p className="today-empty">Nobody has logged a contact yet. Volunteers appear here as they canvass, and live while they share their location from the map.</p>}
          <ul className="dash-plist">
            {d.people.map((p) => (
              <li key={p.id}>
                <button type="button" className={`dash-prow${p.id === sel ? ' is-on' : ''}`} aria-pressed={p.id === sel} onClick={() => onSel(p.id === sel ? null : p.id)}>
                  <span className={`dash-who dash-prow__av${p.out_now ? ' is-out' : ''}${p.sharing ? '' : ' is-stale'}`} aria-hidden="true">{initials(p.name)}</span>
                  <span className="dash-prow__main">
                    <span className="dash-prow__name">{p.name}{p.out_now && <span className="chip chip-ok dash-live">out now</span>}</span>
                    <span className="dash-prow__sub">{p.teams.length ? p.teams.join(', ') : p.role}{p.contacts > 0 && <> · {num(p.contacts)} {PERIOD_WORD[period]}</>}</span>
                  </span>
                  <span className="dash-prow__when mono">{p.out_now ? clock(p.last_seen_at) : timeAgo(p.last_seen_at, now)}</span>
                  <span className="today-chev" aria-hidden="true">›</span>
                </button>
                {p.id === sel && (
                  <div className="dash-pdetail">
                    <p className="dash-pdetail__line">
                      {p.sharing ? (p.out_now ? `Sharing their location — last fix at ${clock(p.where.at)}, on the map.` : `Shared their location, last ${timeAgo(p.where.at, now)}.`)
                        : p.where ? `Not sharing their location; shown at their last door (${timeAgo(p.where.at, now)}).` : 'No location yet.'}
                      {p.trail.length > 1 && <> Today’s trail is on the map.</>}
                    </p>
                    <ul className="dash-legend dash-pdetail__by">
                      {OUTCOME_SERIES.filter((o) => p.by_outcome[o.key] > 0).map((o) => (
                        <li key={o.key} className="dash-legend__i"><span className="dash-swatch" style={{ background: o.color }} aria-hidden="true" />{o.label} <span className="mono">{num(p.by_outcome[o.key])}</span></li>
                      ))}
                      {p.contacts === 0 && <li className="dash-legend__i muted">No contacts {PERIOD_WORD[period]} · {num(p.contacts_all)} in all</li>}
                    </ul>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="dash-note">Dots are the period’s contacts at the person’s door — tap one for who, what and by whom. Volunteers share their location from the map (Show → Share my location while I’m out); a position is kept while they share it, a trail for the day.</p>
    </section>
  );
}

// ── By team ──
function Teams({ d, period }) {
  const headId = useId();
  if (!d.teams.length) {
    return (
      <section className="dash-sec" aria-labelledby={headId}>
        <h3 className="dash-sec__h" id={headId}>By team</h3>
        <p className="today-empty">No teams yet — <Link to="/settings/teams">make one under Settings</Link> and put people on it.</p>
      </section>
    );
  }
  return (
    <section className="dash-sec" aria-labelledby={headId}>
      <header className="dash-sec__head">
        <h3 className="dash-sec__h" id={headId}>By team <span className="muted">· {PERIOD_WORD[period]}</span></h3>
        <Link className="dash-sec__link" to="/settings/teams">Teams ›</Link>
      </header>
      <div className="dash-tablewrap">
        <table className="dash-table">
          <thead>
            <tr><th scope="col">Team</th><th scope="col">Members</th><th scope="col">Out now</th><th scope="col">Contacts</th>{OUTCOME_SERIES.map((o) => <th scope="col" key={o.key}>{o.label}</th>)}</tr>
          </thead>
          <tbody>
            {d.teams.map((t) => (
              <tr key={t.id || 'none'}>
                <th scope="row">{t.name}</th>
                <td className="mono">{num(t.members)}</td>
                <td className="mono">{t.out ? <span className="chip chip-ok">{num(t.out)}</span> : '—'}</td>
                <td className="mono">{num(t.contacts)}</td>
                {OUTCOME_SERIES.map((o) => <td className="mono" key={o.key}>{t[o.key] ? num(t[o.key]) : <span className="muted">·</span>}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Latest ──
function Latest({ d }) {
  const headId = useId();
  const now = Date.now();
  return (
    <section className="dash-sec" aria-labelledby={headId}>
      <h3 className="dash-sec__h" id={headId}>Latest</h3>
      {d.recent.length === 0 ? <p className="today-empty">No contacts logged yet.</p> : (
        <ul className="dash-recent">
          {d.recent.map((r) => (
            <li key={r.id} className="dash-recent__i">
              <span className="dash-swatch" style={{ background: COLOR[r.outcome] || '#5b6472' }} aria-hidden="true" />
              <span className="dash-recent__main">
                <Link to={`/people/${r.person_id}`}>{r.person}</Link>
                <span className="muted"> · {OUTCOME_LABEL[r.outcome] || r.outcome}{r.channel !== 'door' && ` by ${r.channel}`} · {r.who || 'someone'}</span>
              </span>
              <span className="dash-recent__when mono">{timeAgo(r.at, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
