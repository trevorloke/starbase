// Import people — three steps, one button each: choose a CSV (or paste it),
// match its columns to Starbase fields and check it (a dry run: nothing is
// saved), then import it in chunks of 1,000 and place everyone on the map.
// The CSV is parsed here in the browser; the server validates, dedupes against
// people already on file (email → name+phone → name+address; a row with none
// of those matches a person of the same name who has none either) and merges
// by filling blanks only — so importing the same file again adds no one twice.
// Desk roles only — volunteers are sent back to People.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useOutletContext } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { matchRating, offeredCodes } from '@starbase/shared/scale';
import { apiPost } from '../api.js';
import GeocodeButton from '../components/GeocodeButton.jsx';
import { RatingChip, useScale } from '../components/RatingButtons.jsx';
import { invalidatePersonData, tagWord } from './People.jsx';
import { FIELD_KEY, fieldCell, useImportFields } from '../components/FieldsBits.jsx';
import './import.css';

const DESK = ['manager', 'treasurer', 'staff'];
const CHECK_CHUNK = 2000; // server max per call
const IMPORT_CHUNK = 1000;
// A whole voter file (~500,000 rows, 250 MB) fits; the cap keeps the text
// well under what a browser can hold as one string (~512 million characters).
const MAX_FILE_BYTES = 300 * 1024 * 1024;
const PARSE_SLICE = 20000; // rows parsed between breaths, so the page stays alive
const TAG_MAX = 40;

const fmtN = (n) => Number(n || 0).toLocaleString('en-CA');
const fmtMB = (bytes) => `${fmtN(Math.max(1, Math.round(bytes / (1024 * 1024))))} MB`;
// Let the browser paint (a progress line) before the next stretch of work.
const breathe = () => new Promise((resolve) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
  else setTimeout(resolve, 0);
});
const plural = (n, one, many) => `${fmtN(n)} ${n === 1 ? one : many}`;

// ─────────────────────────────────────────────────────────────────────────────
// CSV parsing
// ─────────────────────────────────────────────────────────────────────────────

const DELIMS = [',', ';', '\t'];
const DELIM_NAMES = { ',': 'comma', ';': 'semicolon', '\t': 'tab' };

// Count each candidate delimiter outside quotes on the first non-blank line.
export function detectDelimiter(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  let seen = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (inQuotes) continue;
    if (ch === '\n' || ch === '\r') { if (seen) break; continue; }
    if (ch in counts) counts[ch] += 1;
    if (ch.trim()) seen = true;
  }
  let best = ',';
  for (const d of DELIMS) if (counts[d] > counts[best]) best = d;
  return best;
}

// RFC 4180-ish, forgiving: quoted fields with "" escapes, delimiters and
// newlines inside quotes, CRLF / LF / CR line ends, a leading BOM, spaces
// before an opening quote, and stray text after a closing quote.
// → { delimiter, rows: string[][] } (blank lines kept as [''] so row numbers
// match the spreadsheet).
export function parseCSV(input, forced) {
  const p = csvParser(input, forced);
  p.step(Infinity);
  return { delimiter: p.delimiter, rows: p.rows };
}

// The same parse a slice at a time: step(max) reads up to max more rows and
// says whether it reached the end; at() is how far through the text it is (0–1).
function csvParser(input, forced) {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delim = forced || detectDelimiter(text);
  const rows = [];
  let row = [];
  const n = text.length;
  let i = 0;
  const endRow = () => { rows.push(row); row = []; };
  const step = (max) => {
    const stop = rows.length + max;
    while (i < n && rows.length < stop) {
      // Start of a field. Allow spaces before an opening quote.
      let j = i;
      while (j < n && (text[j] === ' ' || (text[j] === '\t' && delim !== '\t'))) j++;
      if (text[j] === '"') {
        let value = '';
        let k = j + 1;
        for (;;) {
          const q = text.indexOf('"', k);
          if (q === -1) { value += text.slice(k); k = n; break; } // unterminated: take the rest
          value += text.slice(k, q);
          if (text[q + 1] === '"') { value += '"'; k = q + 2; continue; }
          k = q + 1;
          break;
        }
        // Anything between the closing quote and the next delimiter/newline.
        let e = k;
        while (e < n && text[e] !== delim && text[e] !== '\n' && text[e] !== '\r') e++;
        value += text.slice(k, e).trim() ? text.slice(k, e) : '';
        row.push(value);
        i = e;
      } else {
        let e = i;
        while (e < n && text[e] !== delim && text[e] !== '\n' && text[e] !== '\r') e++;
        row.push(text.slice(i, e));
        i = e;
      }
      if (i >= n) { endRow(); break; }
      const ch = text[i];
      if (ch === delim) {
        i += 1;
        if (i >= n) { row.push(''); endRow(); }
      } else {
        // newline: \r\n, \n or \r
        i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
        endRow();
      }
    }
    return i >= n;
  };
  return { delimiter: delim, rows, step, at: () => (n ? i / n : 1) };
}

const isBlankRow = (cells) => cells.every((c) => !String(c).trim());

// Bytes → text. UTF-8 first; UTF-16 when it has a BOM (Excel "Unicode text");
// otherwise Windows-1252, which is what older Excel saves as "CSV".
function decodeBytes(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}

const isSpreadsheetBinary = (buf, name) => {
  const b = new Uint8Array(buf.slice(0, 4));
  const zip = b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; // .xlsx / .numbers
  const ole = b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0; // .xls
  return zip || ole || /\.(xlsx|xlsm|xls|numbers|ods)$/i.test(name || '');
};

// Does the first row hold a person rather than column names? People paste
// rows with no header line. Data: an email, a phone number, a postal code or
// a house number in it — and no cell that is a column name we know.
const HOUSE_RE = /^\d{1,6}[a-z]?\s+\S/i;
const isHeaderWord = (cell) => {
  const n = normHeader(cell);
  return Boolean(n) && EXACT.some(([, re]) => re.test(n));
};
export function looksLikeData(cells) {
  const vals = cells.map((c) => String(c ?? '').trim()).filter(Boolean);
  if (!vals.length || vals.some(isHeaderWord)) return false;
  return vals.some((v) => EMAIL_RE.test(v) || PHONE_RE.test(v) || POSTAL_RE.test(v) || HOUSE_RE.test(v));
}

// Text → { delimiter, all: [{ cells, row }], header } or { error }.
// header: whether the first non-blank row is column names (a guess).
// A big file is parsed a slice at a time; progress(share) hears how far (0–1).
async function readTable(text, progress) {
  if (!text || !/\S/.test(text)) return { error: 'That file is empty. Choose a CSV with at least one person in it.' };
  const parser = csvParser(text);
  while (!parser.step(PARSE_SLICE)) {
    progress?.(parser.at());
    await breathe();
  }
  const { delimiter, rows } = parser;
  const all = [];
  rows.forEach((cells, i) => { if (!isBlankRow(cells)) all.push({ cells, row: i + 1 }); }); // spreadsheet row numbers
  if (!all.length) return { error: 'That file is empty. Choose a CSV with at least one person in it.' };
  return { delimiter, all, header: !looksLikeData(all[0].cells) };
}

// The rows, with or without the first as column names → { headers, records } or { error }.
function shapeTable(all, header) {
  const head = header ? all[0].cells : [];
  const records = header ? all.slice(1) : all;
  if (records.length === 0) {
    return { error: 'There’s a header row but no people under it. Check you saved the whole sheet.' };
  }
  let width = Math.min(500, Math.max(head.length, ...records.slice(0, 500).map((r) => r.cells.length)));
  // Drop trailing columns with no header and nothing in them ("a,b," on every line).
  const emptyCol = (i) => !String(head[i] ?? '').trim() && records.every((r) => !String(r.cells[i] ?? '').trim());
  while (width > 1 && emptyCol(width - 1)) width -= 1;
  const headers = Array.from({ length: width }, (_, i) => String(head[i] ?? '').trim() || `Column ${i + 1}`);
  return { headers, records };
}

// ─────────────────────────────────────────────────────────────────────────────
// Column mapping
// ─────────────────────────────────────────────────────────────────────────────

const FIELDS = [
  { key: 'name', label: 'Full name' },
  { key: 'first', label: 'First name' },
  { key: 'last', label: 'Last name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'house_number', label: 'House number' },
  { key: 'address', label: 'Street address' },
  { key: 'unit', label: 'Unit / apt' },
  { key: 'city', label: 'City' },
  { key: 'postal', label: 'Postal code' },
  { key: 'tags', label: 'Tags' },
  { key: 'rating', label: 'Rating (the scale)' },
  { key: 'lat', label: 'Latitude' },
  { key: 'lng', label: 'Longitude' },
  { key: 'volunteer', label: 'Volunteer (1/0 → tag)' },
  { key: 'donor', label: 'Donor (1/0 → tag)' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'x', label: 'X (Twitter)' },
  { key: 'tiktok', label: 'TikTok' },
  { key: 'reddit', label: 'Reddit' },
];
const SKIP = '';
const fieldLabel = (key) => FIELDS.find((f) => f.key === key)?.label || key;
const FIELD_WORD = { socials: 'social handles', email: 'email', phone: 'phone', address: 'address', house_number: 'house number', unit: 'unit', city: 'city', postal: 'postal code', tags: 'tags', rating: 'rating', lat: 'latitude', lng: 'longitude', volunteer: 'volunteer tag', donor: 'donor tag', instagram: 'Instagram', x: 'X', tiktok: 'TikTok', reddit: 'Reddit' };
const MULTI = new Set(['tags']); // several columns can feed tags; every other field takes one column

const normHeader = (h) =>
  String(h || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// A profile field's name against a column's, in any script ("语言", "ਭਾਸ਼ਾ"):
// every language's letters, digits and vowel signs count, Latin accents
// fold as above; a name of only symbols is empty and matches nothing.
const fieldKey = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^\p{L}\p{M}\p{N}]+/gu, '');

// Exact header names first, then looser "contains" rules, then the values.
const EXACT = [
  ['email', /^(e?mail|emailaddress|emailaddr|primaryemail|personalemail|homeemail|email\d|courriel)$/],
  ['first', /^(first|firstname|fname|given|givenname|forename|firstnames)$/],
  ['last', /^(last|lastname|lname|surname|familyname)$/],
  ['name', /^(name|fullname|contactname|displayname|votername|membername|donorname|person|contact|names)$/],
  ['phone', /^(phone|phonenumber|phoneno|tel|telephone|mobile|mobilephone|mobilenumber|cell|cellphone|cellnumber|primaryphone|phone\d)$/],
  ['house_number', /^(housenumber|houseno|housenum|hsenum|civicnumber|civicno|streetnumber|streetno|stnum|number|no)$/],
  ['lat', /^(lat|latitude|ylat|y)$/],
  ['lng', /^(lng|lon|long|longitude|xlong|x)$/],
  ['volunteer', /^(volunteer|isvolunteer|volunteerflag|vol)$/],
  ['donor', /^(donor|isdonor|donorflag)$/],
  ['unit', /^(unit|unitnumber|unitno|apt|aptno|aptnumber|apartment|suite|suiteno|address2|addressline2|street2)$/],
  ['address', /^(address|streetaddress|streetaddress1|address1|addressline1|street|street1|streetname|civicaddress|homeaddress|residentialaddress|mailingaddress|addr)$/],
  ['city', /^(city|town|municipality|locality|cityname)$/],
  ['postal', /^(postal|postalcode|postcode|zip|zipcode|pc)$/],
  ['tags', /^(tags?|groups?|labels?|lists?|segments?|categories|category)$/],
  ['rating', /^(rating|supportlevel|supportid|id|idlevel|supportscore|canvassid|canvassrating|doorrating)$/],
  ['instagram', /^(instagram|insta|ig|instagramhandle|instagramusername)$/],
  ['x', /^(twitter|xhandle|twitterhandle|twitterusername|xtwitter|twitterx)$/],
  ['tiktok', /^(tiktok|tiktokhandle|tiktokusername)$/],
  ['reddit', /^(reddit|reddithandle|redditusername|redditname)$/],
];
const CONTAINS = [
  ['email', /e?mail/],
  ['first', /firstname|givenname|forename/],
  ['last', /lastname|surname|familyname/],
  ['phone', /^(?!home).*(phone|mobile|cellular)|^cell|^tel/],
  ['house_number', /housenumber|civicnumber|streetnumber/],
  ['lat', /latitude/],
  ['lng', /longitude/],
  ['postal', /postal|postcode|zip/],
  ['unit', /^(unit|apt|suite)/],
  ['address', /address|street/],
  ['city', /(^|home|mailing|mail|res|residential|billing)city|^town|municipal/],
  ['tags', /^tags?|tags?$|groups?$|labels?$|segments?$/],
  ['rating', /support|rating/],
  ['instagram', /instagram/],
  ['x', /twitter/],
  ['tiktok', /tiktok/],
  ['reddit', /reddit/],
  ['name', /^(?!.*(user|file|middle|nick)).*name/],
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// With no column names, a column of "Mira Chen"s is the name (2–4 words, letters only).
const NAME_RE = /^\p{L}[\p{L}'’.-]*(?:\s+\p{L}[\p{L}'’.-]*){1,3}$/u;
const POSTAL_RE = /^[a-z]\d[a-z][ -]?\d[a-z]\d$/i;
const PHONE_RE = /^\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(\s*(x|ext\.?)\s*\d+)?$/i;

// The campaign's scale (its codes and words, any case): "4d " → 4D, "4 D" →
// 4D, "1.0" → 1 (spreadsheets love a trailing .0), "Strong yes" → 1,
// "locke" → 4B. A new rating must be on the list (off it: comes in unrated).
const isRating = (scale, v) => { const m = matchRating(scale, v); return Boolean(m && !m.off); };
// share: a "Support" column may hold the odd typo; a bare "ID" column must be all ratings.
const looksLikeRatings = (scale, values, share = 1) =>
  values.length > 0 && values.filter((v) => matchRating(scale, v)).length / values.length >= share;
const mostly = (values, re, share = 0.8) => values.length > 0 && values.filter((v) => re.test(v)).length / values.length >= share;
// Loose header guesses must also look right ("Email opt-in" holding yes/no is not an email column).
const COORD_RE = /^-?\d{1,3}(\.\d+)?$/;
const VALUE_CHECK = { email: EMAIL_RE, phone: PHONE_RE, postal: POSTAL_RE, lat: COORD_RE, lng: COORD_RE };

const columnValues = (records, i, limit = 200) => {
  const out = [];
  for (const r of records) {
    const v = String(r.cells[i] ?? '').trim();
    if (v) out.push(v);
    if (out.length >= limit) break;
  }
  return out;
};

// custom: the campaign's profile fields ({ key, label }), matched by name.
function guessMapping(scale, headers, records, noHeader = false, custom = []) {
  const out = headers.map(() => SKIP);
  const taken = new Set();
  const values = headers.map((_, i) => columnValues(records, i));
  const claim = (i, key, loose = false) => {
    if (out[i] !== SKIP) return;
    if (!MULTI.has(key) && taken.has(key)) return;
    if (key === 'rating' && !looksLikeRatings(scale, values[i], /^(id|idlevel)$/.test(normHeader(headers[i])) ? 1 : 0.9)) return; // "ID" only if it holds 1/2/3/4/4D…
    if (loose && VALUE_CHECK[key] && values[i].length && !mostly(values[i], VALUE_CHECK[key], 0.6)) return;
    if (key === 'name' && mostly(values[i], EMAIL_RE)) return; // a "Contact" column of emails isn't a name
    out[i] = key;
    taken.add(key);
  };
  const pass = (rules, loose) => headers.forEach((h, i) => {
    if (out[i] !== SKIP) return;
    const n = normHeader(h);
    const hit = rules.find(([, re]) => re.test(n));
    if (hit) claim(i, hit[0], loose);
  });
  pass(EXACT, false);
  headers.forEach((h, i) => {
    const k = fieldKey(h);
    const hit = k ? custom.find((x) => fieldKey(x.label) === k) : null;
    if (hit) claim(i, hit.key);
  });
  pass(CONTAINS, true);
  headers.forEach((_, i) => {
    if (out[i] !== SKIP || !values[i].length) return;
    if (mostly(values[i], EMAIL_RE)) claim(i, 'email');
    else if (mostly(values[i], POSTAL_RE)) claim(i, 'postal');
    else if (mostly(values[i], PHONE_RE)) claim(i, 'phone');
  });
  // No column names at all: guess the name and street from the values too.
  if (noHeader) {
    headers.forEach((_, i) => {
      if (out[i] !== SKIP || !values[i].length) return;
      if (mostly(values[i], HOUSE_RE)) claim(i, 'address');
      else if (!taken.has('first') && !taken.has('last') && mostly(values[i], NAME_RE)) claim(i, 'name');
    });
  }
  return out;
}

// One CSV record → the server's row shape (only filled fields are sent).
// A rating that isn't on the scale is left off: the server rejects the whole
// row for it, and losing the person is worse than losing a bad rating.
function toRow(scale, cells, mapping) {
  const row = {};
  mapping.forEach((key, i) => {
    if (!key) return;
    const v = String(cells[i] ?? '').trim();
    if (!v) return;
    if (key.startsWith(FIELD_KEY)) { fieldCell(row, key, v); return; }
    if (key === 'tags') row.tags = row.tags ? `${row.tags};${v}` : v;
    else if (key === 'rating') { const m = matchRating(scale, v); if (m && !m.off) row.rating = m.code; }
    else row[key] = v;
  });
  return row;
}

// fetch/ApiError → one plain sentence that says what to do.
function errText(e) {
  if (!e?.status) return 'Couldn’t reach Starbase. Check your connection and try again.';
  if (e.status === 401) return 'You’ve been signed out. Sign in again in another tab, then try again.';
  if (e.status === 403) return 'Only campaign staff can import people.';
  const m = String(e.message || '').trim();
  return m ? `Starbase said: ${m}.` : `Something went wrong (${e.status}). Try again.`;
}

const displayName = (r) => r.name || [r.first, r.last].filter(Boolean).join(' ');
const displayAddress = (r) =>
  [[r.unit ? `${r.unit} –` : null, r.address].filter(Boolean).join(' '), r.city, r.postal].filter(Boolean).join(', ');
const splitTags = (s) => String(s || '').split(/[;,|]/).map((t) => t.trim()).filter(Boolean);

// Tag suggestion from the file name: "Voters List 2026.csv" → "voters-list-2026".
const slugTag = (fileName) => {
  const base = String(fileName || '').replace(/\.[a-z0-9]+$/i, '');
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug && slug.length <= TAG_MAX ? slug : '';
};

// ─────────────────────────────────────────────────────────────────────────────
// Server messages → spreadsheet row numbers and plain words
// ─────────────────────────────────────────────────────────────────────────────

// "1, 2, 3, 4, 4D, 4B, 4F, 4N, 4C" — what a rating column may hold (or the words).
const scaleCodes = (scale) => offeredCodes(scale).join(', ');

function friendly(text, scale) {
  const SCALE = scaleCodes(scale);
  const t = String(text || '').trim();
  if (t === 'no name') return 'No name. Fill in a full name, or a first and last name.';
  let m = /^invalid email “(.*)”$/.exec(t);
  if (m) return `“${m[1]}” doesn’t look like an email address.`;
  m = /^rating “(.*)” is not on the scale$/.exec(t);
  if (m) return `Rating “${m[1]}” isn’t on the scale (${SCALE}).`;
  m = /^rating “(.*)” is off the list$/.exec(t);
  if (m) return `Rating “${m[1]}” is off the list.`;
  m = /^([a-z]+)(?:\.\d+)?\s+(.*)$/.exec(t);
  if (m && FIELDS.some((f) => f.key === m[1])) {
    if (m[1] === 'rating') return `Rating isn’t on the scale (${SCALE}).`;
    const big = /Too big:.*?(\d+)\s*(characters|items)/i.exec(m[2]);
    if (big) return `${fieldLabel(m[1])} is too long (${big[1]} ${big[2]} max).`;
    return `${fieldLabel(m[1])}: ${m[2]}`;
  }
  return t ? t[0].toUpperCase() + t.slice(1) : 'Couldn’t read this row.';
}

// "row 3: no name" (3 = position in the chunk sent) → { row: 1042, text }.
function remapInvalid(msg, part, scale) {
  const m = /^row (\d+):\s*(.*)$/s.exec(String(msg));
  if (!m) return { row: null, text: friendly(msg, scale) };
  return { row: part[Number(m[1]) - 1]?.row ?? null, text: friendly(m[2], scale) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Small pieces
// ─────────────────────────────────────────────────────────────────────────────

function Step({ n, title, line, state, children }) {
  // state: 'todo' | 'now' | 'done'. A step that isn't reached yet is just its title.
  return (
    <section className={`imp-step is-${state}`} aria-labelledby={`imp-step-${n}`}>
      <div className="imp-step__num" aria-hidden="true">{state === 'done' ? '✓' : n}</div>
      <div className="imp-step__body">
        <h2 id={`imp-step-${n}`}><span className="imp-sr">Step {n}: </span>{title}</h2>
        {state === 'now' && line && <p className="imp-line">{line}</p>}
        {state !== 'todo' && children}
      </div>
    </section>
  );
}

function Bar({ value, max, label }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="imp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <div className="imp-bar__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function Counts({ items }) {
  return (
    <dl className="imp-counts">
      {items.map(([label, value, tone]) => (
        <div key={label} className={`imp-count${tone ? ` is-${tone}` : ''}`}>
          <dt className="eyebrow">{label}</dt>
          <dd><span className="imp-count__n mono">{fmtN(value)}</span></dd>
        </div>
      ))}
    </dl>
  );
}

// A quiet "Label +" toggle (the shared .disclose look); the body is only rendered when open.
function Reveal({ label, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="imp-reveal">
      <button type="button" className="imp-reveal__btn disclose disclose--inline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && <div className="imp-reveal__body">{children}</div>}
    </div>
  );
}

function InvalidList({ invalid, intro }) {
  const [all, setAll] = useState(false);
  if (!invalid.length) return null;
  const shown = all ? invalid : invalid.slice(0, 12);
  return (
    <div className="imp-invalid">
      <p className="imp-invalid__intro">{intro}</p>
      <ul className="imp-invalid__list">
        {shown.map((x, i) => (
          <li key={i}>
            {x.row != null && <span className="imp-invalid__row mono">Row {fmtN(x.row)}</span>}
            <span>{x.text}</span>
          </li>
        ))}
      </ul>
      {invalid.length > shown.length && (
        <button type="button" className="btn btn-quiet imp-tap" onClick={() => setAll(true)}>
          Show all {fmtN(invalid.length)}
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The screen: 1 Choose a file · 2 Match columns (then check) · 3 Import
// ─────────────────────────────────────────────────────────────────────────────

export default function ImportPeople() {
  const { me } = useOutletContext() ?? {};
  if (!DESK.includes(me?.role)) return <Navigate to="/people" replace />;
  return <ImportFlow />;
}

const ZERO = { created: 0, merged: 0, unchanged: 0 };

function ImportFlow() {
  const queryClient = useQueryClient();
  const scale = useScale();
  const custom = useImportFields(); // the campaign's profile fields, as columns
  const allFields = [...FIELDS, ...custom];

  // Step 1 — the source
  const [source, setSource] = useState(null); // { name, headers, records, delimiter }
  const [loadError, setLoadError] = useState(null);
  const [reading, setReading] = useState(null); // what it's doing, e.g. Reading 182 MB… 40%
  const [dragOver, setDragOver] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  // Step 2 — mapping, then the check (a dry run). Any mapping/tag change throws the check away.
  const [mapping, setMapping] = useState([]);
  const [bumped, setBumped] = useState(null); // { col, key } — a column switched off by a pick
  const [tag, setTag] = useState('');
  const [check, setCheck] = useState(null); // { phase, done, total, created, merged, unchanged, invalid, matches, parts, error }
  // Step 3 — import (then place on the map)
  const [imp, setImp] = useState(null); // { phase, sent, total, created, merged, unchanged, invalid, error, resumeAt }

  const busy = Boolean(reading) || check?.phase === 'running' || imp?.phase === 'running';
  const locked = busy || imp?.phase === 'done' || imp?.phase === 'error';

  // Don't lose a half-sent import to a stray tab close.
  useEffect(() => {
    if (imp?.phase !== 'running') return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [imp?.phase]);

  const resetAfterSource = () => { setCheck(null); setImp(null); setBumped(null); };

  const loadText = async (text, name, size = text.length) => {
    const what = `Reading ${fmtMB(size)}…`;
    let shown = -1;
    const t = await readTable(text, (share) => {
      const pct = Math.floor(share * 100);
      if (pct !== shown) { shown = pct; setReading(`${what} ${pct}%`); }
    });
    if (t.error) { setLoadError(t.error); return; }
    const shaped = shapeTable(t.all, t.header);
    if (shaped.error) { setLoadError(shaped.error); return; }
    setLoadError(null);
    setSource({ name, ...t, ...shaped });
    setMapping(guessMapping(scale, shaped.headers, shaped.records, !t.header, custom));
    setTag('');
    resetAfterSource();
  };
  // "First row is column names": on or off, then guess the columns again.
  const setHeader = (on) => {
    if (!source) return;
    const shaped = shapeTable(source.all, on);
    if (shaped.error) return;
    setSource({ ...source, header: on, ...shaped });
    setMapping(guessMapping(scale, shaped.headers, shaped.records, !on, custom));
    resetAfterSource();
  };

  const loadFile = async (file) => {
    if (!file) return;
    setLoadError(null);
    if (file.size > MAX_FILE_BYTES) {
      setLoadError(`That file is over ${fmtMB(MAX_FILE_BYTES)}. Split it into parts and import them one at a time.`);
      return;
    }
    // A big file takes a few seconds to read: say so before the work starts.
    setReading(`Reading ${fmtMB(file.size)}…`);
    await breathe();
    try {
      let buf = await file.arrayBuffer();
      if (isSpreadsheetBinary(buf, file.name)) {
        setLoadError('That’s a spreadsheet, not a CSV. Save it as CSV (File → Download → CSV), then choose that.');
        return;
      }
      const text = decodeBytes(buf);
      buf = null; // the bytes can go once they're text
      await loadText(text, file.name, file.size);
    } catch {
      setLoadError('Couldn’t read that file. Try saving it again as CSV.');
    } finally {
      setReading(null);
    }
  };

  const onPick = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // choosing the same file again still fires
    loadFile(file);
  };
  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (locked) return;
    loadFile(e.dataTransfer?.files?.[0]);
  };
  const usePaste = async () => {
    if (!pasteText.trim()) { setLoadError('Paste some rows first.'); return; }
    setReading('Reading…');
    try {
      await loadText(pasteText, 'Pasted text');
    } finally {
      setReading(null);
    }
    setPasteOpen(false);
  };
  const startOver = () => {
    setSource(null);
    setMapping([]);
    setTag('');
    setLoadError(null);
    setPasteText('');
    resetAfterSource();
  };

  const setField = (col, key) => {
    let bump = null;
    const next = mapping.map((k, j) => {
      if (j === col) return key;
      if (key && !MULTI.has(key) && k === key) { bump = { col: j, key }; return SKIP; }
      return k;
    });
    setMapping(next);
    setBumped(bump);
    setCheck(null);
  };
  const onTag = (v) => { setTag(v.slice(0, TAG_MAX)); setCheck(null); };

  // ── Derived ──
  // Rows take the server's shape a chunk at a time, as they're sent: a voter
  // file is never held twice. The preview shapes only its first few.
  const records = source?.records || [];
  const total = records.length;
  const partAt = (start, size) => records.slice(start, start + size)
    .map((r) => ({ data: toRow(scale, r.cells, mapping), row: r.row }));
  const preview = useMemo(
    () => (source ? source.records.slice(0, 5).map((r) => ({ data: toRow(scale, r.cells, mapping), row: r.row, cells: r.cells })) : []),
    [source, mapping, scale],
  );
  const ratingCol = mapping.indexOf('rating');
  const hasName = mapping.some((k) => k === 'name' || k === 'first' || k === 'last');
  const usedCount = mapping.filter(Boolean).length;
  const usedFields = allFields.filter((f) => mapping.includes(f.key)).map((f) => f.label);
  const tagClean = tag.trim();
  const fileTag = source && source.name !== 'Pasted text' ? slugTag(source.name) : '';

  const examples = useMemo(
    () => (source ? source.headers.map((_, i) => columnValues(source.records, i, 3)) : []),
    [source],
  );
  // A column mapped to Rating whose values aren't on the scale (or are off
  // the list): those people come in unrated. Which values, said once each.
  const { badRatings, badValues } = useMemo(() => {
    const col = ratingCol;
    const seen = new Map();
    let n = 0;
    if (source && col !== -1) {
      for (const r of source.records) {
        const v = String(r.cells[col] ?? '').trim();
        if (!v || isRating(scale, v)) continue;
        n += 1;
        if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), `“${v}”${matchRating(scale, v)?.off ? ' (off the list)' : ''}`);
      }
    }
    const vals = [...seen.values()];
    return { badRatings: n, badValues: vals.length > 3 ? `${vals.slice(0, 3).join(', ')}…` : vals.join(', ') };
  }, [source, ratingCol, scale]);

  const previewCols = [
    hasName && ['name', 'Name'],
    mapping.includes('email') && ['email', 'Email'],
    mapping.includes('phone') && ['phone', 'Phone'],
    mapping.some((k) => ['address', 'unit', 'city', 'postal'].includes(k)) && ['address', 'Address'],
    (mapping.includes('tags') || tagClean) && ['tags', 'Tags'],
    mapping.includes('rating') && ['rating', 'Rating'],
  ].filter(Boolean);

  // ── Check (dry run: nothing is saved) ──
  const runCheck = async () => {
    const acc = { ...ZERO, invalid: [], matches: [] };
    const parts = Math.ceil(total / CHECK_CHUNK);
    setCheck({ phase: 'running', done: 0, total, parts, ...acc });
    try {
      for (let start = 0; start < total; start += CHECK_CHUNK) {
        const part = partAt(start, CHECK_CHUNK);
        const r = await apiPost('/data/import', { rows: part.map((x) => x.data), tag: tagClean || undefined, dryRun: true });
        acc.created += r.created || 0;
        acc.merged += r.merged || 0;
        acc.unchanged += r.unchanged || 0;
        for (const msg of r.invalid || []) acc.invalid.push(remapInvalid(msg, part, scale));
        for (const d of r.decisions || []) {
          if (d.action === 'merged' && acc.matches.length < 50) {
            acc.matches.push({ ...d, row: part[d.row - 1]?.row ?? d.row });
          }
        }
        setCheck({ phase: 'running', done: start + part.length, total, parts, ...acc });
      }
      setCheck({ phase: 'done', done: total, total, parts, ...acc });
    } catch (e) {
      setCheck({ phase: 'error', done: 0, total, parts, ...acc, error: errText(e) });
    }
  };

  // ── Import, 1,000 rows a call; each call is its own transaction ──
  const accRef = useRef(null);
  const runImport = async (from = 0) => {
    if (from === 0) accRef.current = { ...ZERO, invalid: [] };
    const acc = accRef.current;
    setImp({ phase: 'running', sent: from, total, ...acc });
    let start = from;
    try {
      for (; start < total; start += IMPORT_CHUNK) {
        const part = partAt(start, IMPORT_CHUNK);
        const r = await apiPost('/data/import', { rows: part.map((x) => x.data), tag: tagClean || undefined });
        acc.created += r.created || 0;
        acc.merged += r.merged || 0;
        acc.unchanged += r.unchanged || 0;
        for (const msg of r.invalid || []) acc.invalid.push(remapInvalid(msg, part, scale));
        setImp({ phase: 'running', sent: start + part.length, total, ...acc });
      }
      setImp({ phase: 'done', sent: total, total, ...acc });
    } catch (e) {
      setImp({ phase: 'error', sent: start, total, ...acc, error: errText(e), resumeAt: start });
    } finally {
      invalidatePersonData(queryClient);
      // Merges can fill a rating or phone on people already inside a turf.
      queryClient.invalidateQueries({ queryKey: ['turfs'] });
      queryClient.invalidateQueries({ queryKey: ['turf'] });
    }
  };

  const checked = check?.phase === 'done';
  const willWrite = checked ? check.created + check.merged : 0;
  const nothingNew = checked && willWrite === 0;
  // Nothing to write because everyone is already on file (vs. every row failed).
  const nothingToDo = nothingNew && check.unchanged > 0;
  const nothingValid = nothingNew && check.unchanged === 0;
  const hasAddress = mapping.includes('address');
  const imported = imp?.phase === 'done';
  const peopleLink = tagClean ? `/people?tag=${encodeURIComponent(tagClean)}` : '/people';

  const at = !source ? 1 : !checked ? 2 : 3;
  const stepState = (n) => (n < at ? 'done' : n === at ? 'now' : 'todo');

  return (
    <div className="imp-page">
      <div className="page-head imp-head">
        <div>
          <Link to="/people" className="eyebrow imp-back">← People</Link>
          <h1>Import people</h1>
        </div>
      </div>

      {/* ── 1. Choose ── */}
      <Step n={1} title="Choose a file" line="A spreadsheet saved as CSV." state={stepState(1)}>
        {source ? (
          <div className="imp-source">
            <p>
              <strong>{source.name}</strong>
              <span className="muted"> · {plural(source.records.length, 'row', 'rows')}</span>
            </p>
            <button type="button" className="btn btn-quiet imp-tap" onClick={startOver} disabled={busy}
              title={`${plural(source.headers.length, 'column', 'columns')}, ${DELIM_NAMES[source.delimiter]}-separated`}>
              {imported ? 'Import another' : 'Change file'}
            </button>
          </div>
        ) : (
          <>
            <label
              htmlFor="imp-file"
              className={`imp-drop${dragOver ? ' is-over' : ''}${reading ? ' is-busy' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <input
                id="imp-file"
                className="imp-file-input"
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
                onChange={onPick}
                disabled={Boolean(reading)}
              />
              {/* The paste box's "Use this text" is the yellow button while it's open. */}
              <span className={`btn ${pasteOpen ? 'btn-quiet' : 'btn-primary'} imp-tap imp-drop__btn`}>
                {reading || 'Choose CSV file'}
              </span>
              <span className="imp-drop__or">or drop it here</span>
            </label>
            {!pasteOpen ? (
              <button type="button" className="btn btn-quiet imp-tap" onClick={() => setPasteOpen(true)}>
                Paste text
              </button>
            ) : (
              <div className="imp-paste">
                <div className="field">
                  <label htmlFor="imp-paste">One person per line</label>
                  <textarea
                    id="imp-paste"
                    className="input mono imp-paste__text"
                    rows={7}
                    spellCheck={false}
                    placeholder={'Jane Doe, jane@example.com, 604-555-0101\nSam Lee, sam@example.com, 604-555-0102'}
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                  />
                </div>
                <div className="imp-actions">
                  <button type="button" className="btn btn-primary imp-tap" onClick={usePaste} disabled={busy}>Use this text</button>
                  <button type="button" className="btn btn-quiet imp-tap" onClick={() => setPasteOpen(false)}>Cancel</button>
                </div>
              </div>
            )}
          </>
        )}
        {loadError && <p className="error" role="alert">{loadError}</p>}
      </Step>

      {/* ── 2. Match columns, then check ── */}
      <Step n={2} title="Match columns" line="Check where each column goes." state={stepState(2)}>
        {source && (checked ? (
          <div className="imp-source">
            <p className="imp-summary">
              {usedFields.join(' · ')}
              {tagClean ? <> · <span className="chip imp-chip">{tagWord(tagClean)}</span></> : null}
            </p>
            {!imp && (
              <button type="button" className="btn btn-quiet imp-tap" onClick={() => setCheck(null)}>Change</button>
            )}
          </div>
        ) : (
          <>
            <label className="imp-headrow">
              <input
                type="checkbox"
                checked={source.header}
                disabled={locked || (!source.header && source.all.length < 2)}
                onChange={(e) => setHeader(e.target.checked)}
              />
              First row is column names
            </label>
            <ul className="imp-map">
              {source.headers.map((h, i) => {
                const id = `imp-col-${i}`;
                const ex = examples[i] || [];
                return (
                  <li key={i} className={`imp-map__row${mapping[i] ? ' is-used' : ''}`}>
                    <div className="imp-map__src">
                      <label htmlFor={id} className="imp-map__head">{h}</label>
                      <span className="imp-map__ex">{ex.length ? ex.join(' · ') : 'empty'}</span>
                    </div>
                    <span className="imp-map__arrow" aria-hidden="true">→</span>
                    <select
                      id={id}
                      className="input imp-map__select"
                      value={mapping[i] || SKIP}
                      disabled={locked}
                      onChange={(e) => setField(i, e.target.value)}
                    >
                      <option value={SKIP}>Don’t import</option>
                      {FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      {custom.length > 0 && (
                        <optgroup label="Profile fields">
                          {custom.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                        </optgroup>
                      )}
                    </select>
                    {bumped?.col === i && (
                      <p className="imp-map__note" role="status">
                        Now “Don’t import” — {allFields.find((f) => f.key === bumped.key)?.label} comes from one column.
                      </p>
                    )}
                    {mapping[i] === 'rating' && badRatings > 0 && (
                      <p className="imp-map__note is-warn">
                        {plural(badRatings, 'rating isn’t', 'ratings aren’t')} on the scale ({badValues}) — {badRatings === 1 ? 'comes' : 'they come'} in unrated.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
            {!hasName && (
              <p className="imp-need" role="alert">
                Match a column to <strong>Full name</strong>, or <strong>First</strong> + <strong>Last name</strong>.
              </p>
            )}

            <Reveal label={tagClean ? `Tag: ${tagWord(tagClean)}` : 'Tag everyone'} defaultOpen={Boolean(tagClean)}>
              <div className="field imp-tagfield">
                <label htmlFor="imp-tag">Tag (optional)</label>
                <div className="imp-tagrow">
                  <input
                    id="imp-tag"
                    className="input"
                    maxLength={TAG_MAX}
                    placeholder="e.g. Voters list"
                    value={tag}
                    disabled={locked}
                    onChange={(e) => onTag(e.target.value)}
                  />
                  {fileTag && tagClean !== fileTag && !locked && (
                    <button type="button" className="btn btn-quiet imp-tap" onClick={() => onTag(fileTag)}>
                      Use “{tagWord(fileTag)}”
                    </button>
                  )}
                </div>
              </div>
            </Reveal>

            {hasName && preview.length > 0 && (
              <Reveal label="Preview">
                <div className="imp-preview__scroll">
                  <table className="table imp-preview__table">
                    <thead>
                      <tr>
                        <th className="mono">Row</th>
                        {previewCols.map(([k, label]) => <th key={k}>{label}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map(({ data, row, cells }) => {
                        const tags = [...new Set([...splitTags(data.tags), ...(tagClean ? [tagClean] : [])])];
                        const rawRating = ratingCol === -1 ? '' : String(cells[ratingCol] ?? '').trim();
                        return (
                          <tr key={row}>
                            <td className="mono muted">{row}</td>
                            {previewCols.map(([k]) => (
                              <td key={k}>
                                {k === 'name' ? (displayName(data) || <span className="danger-text">no name</span>)
                                  : k === 'address' ? (displayAddress(data) || <span className="muted">—</span>)
                                  : k === 'tags' ? (tags.length
                                    ? <span className="imp-tags">{tags.map((t) => <span key={t} className="chip">{tagWord(t)}</span>)}</span>
                                    : <span className="muted">—</span>)
                                  : k === 'rating' ? (data.rating
                                    ? <RatingChip code={data.rating} who />
                                    : rawRating
                                      ? <span className="muted" title="Not on the scale — comes in without a rating"><s>{rawRating}</s> unrated</span>
                                      : <span className="muted">—</span>)
                                  : (data[k] || <span className="muted">—</span>)}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Reveal>
            )}

            {check?.phase === 'running' ? (
              <div className="imp-running" role="status" aria-live="polite">
                <Bar value={check.done} max={check.total} label="Checking" />
                <p className="imp-line mono">Checking {fmtN(check.done)} of {fmtN(check.total)}…</p>
              </div>
            ) : (
              <div className="imp-actions">
                <button type="button" className="btn btn-primary imp-tap" onClick={runCheck} disabled={!hasName || busy || locked}>
                  Check {plural(total, 'row', 'rows')}
                </button>
                <span className="imp-line imp-line--inline">{fmtN(usedCount)} of {fmtN(source.headers.length)} columns</span>
              </div>
            )}
            {check?.phase === 'error' && <p className="error" role="alert">The check didn’t finish. {check.error}</p>}
          </>
        ))}
      </Step>

      {/* ── 3. Import, then place on the map ── */}
      <Step n={3} title={imported ? 'Done' : 'Import'} line={!imp && !nothingNew ? 'Nothing is saved until you tap Import.' : null} state={imported ? 'done' : stepState(3)}>
        {checked && (
          <>
            {!imp && (
              <div className="imp-result" role="status">
                <Counts
                  items={[
                    ['New', check.created, 'ok'],
                    ['Update', check.merged],
                    ['Same', check.unchanged],
                    ['Can’t import', check.invalid.length, check.invalid.length ? 'danger' : null],
                  ]}
                />
                {check.parts > 1 && <p className="imp-hint imp-hint--sm">Checked in parts — a few far-apart repeats may count as new.</p>}
                {check.matches.length > 0 && (
                  <Reveal label="See matches">
                    <p className="imp-hint imp-hint--sm">Blanks get filled. Nothing is overwritten.</p>
                    {check.merged > check.matches.length && (
                      <p className="imp-hint imp-hint--sm">First {fmtN(check.matches.length)} of {fmtN(check.merged)}.</p>
                    )}
                    <ul className="imp-matches__list">
                      {check.matches.map((d) => (
                        <li key={`${d.row}-${d.id}`}>
                          <span className="mono muted">Row {fmtN(d.row)}</span> {d.name}
                          {d.fields?.length ? <span className="muted"> — adds {d.fields.map((f) => FIELD_WORD[f] || f).join(', ')}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </Reveal>
                )}
                <InvalidList
                  invalid={check.invalid}
                  intro={`${plural(check.invalid.length, 'row', 'rows')} can’t be imported. Fix ${check.invalid.length === 1 ? 'it' : 'them'} in the spreadsheet.`}
                />
                {nothingToDo && <p className="imp-line">Everyone is already up to date.</p>}
                {nothingValid && <p className="imp-line">Nothing to import yet. Fix the rows above, or change a column.</p>}
                {!nothingNew && (
                  <div className="imp-actions">
                    <button type="button" className="btn btn-primary imp-tap" onClick={() => runImport(0)}>
                      Import {plural(willWrite, 'person', 'people')}
                    </button>
                  </div>
                )}
              </div>
            )}

            {imp && (
              <div className="imp-running" role="status" aria-live="polite">
                {imp.phase !== 'done' && <Bar value={imp.sent} max={imp.total} label="Importing" />}
                {imp.phase === 'running' && (
                  <p className="imp-line mono">{fmtN(imp.sent)} of {fmtN(imp.total)} · keep this page open</p>
                )}
                {imp.phase === 'error' && (
                  <>
                    <p className="error" role="alert">
                      Stopped at row {fmtN(source.records[imp.resumeAt]?.row ?? imp.resumeAt + 1)}. {imp.error}
                      {imp.sent > 0 ? (imp.invalid.length
                        ? ` Rows before it are saved, except ${plural(imp.invalid.length, 'bad row', 'bad rows')}.`
                        : ' Rows before it are saved.') : ''}
                    </p>
                    <div className="imp-actions">
                      <button type="button" className="btn btn-primary imp-tap" onClick={() => runImport(imp.resumeAt)}>
                        Try the rest again
                      </button>
                    </div>
                  </>
                )}
                {imp.phase === 'done' && (
                  <>
                    <Counts
                      items={[
                        ['Added', imp.created, 'ok'],
                        ['Updated', imp.merged],
                        ['Same', imp.unchanged],
                      ]}
                    />
                    <InvalidList
                      invalid={imp.invalid}
                      intro={`${plural(imp.invalid.length, 'row', 'rows')} skipped. Fix ${imp.invalid.length === 1 ? 'it' : 'them'} and import the file again — no one is added twice.`}
                    />
                  </>
                )}
              </div>
            )}

            {(imported || (nothingToDo && !imp)) && (
              <div className="imp-place">
                <h3 className="imp-place__title">Place them on the map</h3>
                {hasAddress
                  ? <GeocodeButton />
                  : <p className="imp-line">No street addresses in this file.</p>}
              </div>
            )}

            {/* Two ways on: place them (above) and see them. Map and Turfs are in the nav. */}
            {(imported || imp?.phase === 'error') && (imp?.created || 0) + (imp?.merged || 0) > 0 && (
              <div className="imp-actions imp-next">
                <Link className="btn imp-tap" to={peopleLink}>{tagClean ? `See “${tagWord(tagClean)}”` : 'See them'}</Link>
              </div>
            )}
          </>
        )}
      </Step>
    </div>
  );
}
