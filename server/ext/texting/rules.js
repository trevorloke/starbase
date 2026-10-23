// The texting rules, in one place so the server and the tests agree:
// phone numbers, opt-out keywords, the first text's footer, quiet hours.
// No database, no network.

export const NO_TEXT_TAG = 'do-not-text';
export const NO_CONTACT_TAG = 'do-not-contact';
export const FOOTER = 'Reply STOP to opt out';
export const DEFAULT_TEMPLATE = "Hi {{first_name}}, it's {{my_name}} with {{campaign}}. Can we count on your support?";
export const DEFAULT_FROM = 9;   // texts may go from 9 am …
export const DEFAULT_UNTIL = 21; // … until 9 pm, Monday to Friday, campaign time
// Saturdays and Sundays are narrower: 10 am–6 pm (the CRTC's telemarketing
// hours). Conservative defaults — the campaign should confirm them with counsel.
export const DEFAULT_WEEKEND_FROM = 10;
export const DEFAULT_WEEKEND_UNTIL = 18;
// One campaign conversation per number: while anyone's conversation with a
// number has had a text in or out in the last RECENT_DAYS, nobody else starts
// another (no second introduction), and replies stay in it.
export const RECENT_DAYS = 7;
// After you text someone, the text list leaves them out until they reply —
// or until a day has passed, when they come back with "No reply".
export const AWAIT_HOURS = 24;
export const MAX_BODY = 1000;
export const PER_MINUTE = 20;    // one person tapping Send never gets near this

// E.164 (+16045550101) from whatever was typed; null when it can't be a
// number. An extension ("ext 2", "x2", "#2") is dropped, never dialled.
export const e164 = (raw) => {
  const s = String(raw ?? '').replace(/\s*(?:ext\.?|x|#).*$/i, '').trim();
  const plus = s.startsWith('+');
  const d = s.replace(/\D/g, '');
  if (!plus && d.length === 10 && /^[2-9]/.test(d)) return `+1${d}`;
  if (!plus && d.length === 11 && d[0] === '1') return `+${d}`;
  if (plus && d.length >= 8 && d.length <= 15) return `+${d}`;
  return null;
};

// "604-555-0101" for screens; anything else as given.
export const showPhone = (p) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(p || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(p || '');
};

// SQL: the digits of a free-typed persons.phone, extension dropped, so a
// reply from +16045550101 finds "604-555-0101", "(604) 555 0101" or "+1 604…".
export const PHONE_DIGITS_SQL = (col) =>
  `right(regexp_replace(regexp_replace(coalesce(${col}, ''), '\\s*(ext\\.?|x|#).*$', '', 'i'), '\\D', '', 'g'), 10)`;
export const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

// Opt-out and opt-in words. A reply that is only one of these (any case,
// punctuation and emoji ignored: "Stop.", "STOP 🙏") changes the number's
// status at once.
const STOP_WORDS = new Set([
  'STOP', 'STOPALL', 'STOP ALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT',
  'OPTOUT', 'OPT OUT', 'REVOKE', 'STOP PLEASE', 'PLEASE STOP', 'STOP TEXTING', 'STOP TEXTING ME',
  'PLEASE STOP TEXTING ME', 'STOP TEXTING ME PLEASE', 'STOP IT', 'STOP MESSAGING ME', 'UNSUBSCRIBE ME',
  'REMOVE ME', 'DO NOT TEXT ME', "DON'T TEXT ME", 'DONT TEXT ME', 'NO MORE TEXTS',
]);
const START_WORDS = new Set(['START', 'UNSTOP']);
const plainWords = (body) => String(body ?? '').toUpperCase().replace(/[\u2018\u2019]/g, "'")
  .replace(/[^A-Z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
export const keywordOf = (body) => {
  const w = plainWords(body);
  if (STOP_WORDS.has(w)) return 'stop';
  if (START_WORDS.has(w)) return 'start';
  return null;
};
// A reply that isn't only a keyword but has a stop or unsubscribe word in it
// ("No thanks, stop", "Please stop texting me now") is flagged in the thread
// with a one-tap "Opt out this number" — a person decides, since "Stop by the
// office?" has the word too.
const ASKS_STOP = /\b(STOP|STOPALL|UNSUBSCRIBE|UNSUB|OPT ?OUT|REMOVE ME|TAKE ME OFF|(DON'?T|DO NOT|NEVER) (TEXT|MESSAGE|CONTACT|CALL)|NO MORE (TEXTS?|MESSAGES?))\b/;
export const asksToStop = (body) => keywordOf(body) == null && ASKS_STOP.test(plainWords(body));
export const ASKS_STOP_KEYWORD = 'asks_stop';

// The first text in a conversation names the campaign and ends with the
// opt-out line. The footer is added here (once); naming the campaign is up
// to the sender — a first text that doesn't is refused, never rewritten.
export const namesCampaign = (body, campaign) =>
  String(body || '').toLowerCase().includes(String(campaign || '').trim().toLowerCase());
export const endsWithFooter = (body) => /reply stop to opt out\.?\s*$/i.test(String(body || ''));
export const withFooter = (body) => (endsWithFooter(body) ? String(body).trim() : `${String(body).trim()}\n${FOOTER}`);
export const hasBlanks = (body) => /\{\{[^}]*\}\}/.test(String(body || ''));

// Quiet hours: texts and campaign calls go only inside [from, until), in
// the campaign's time zone — one window Monday to Friday, another on
// Saturdays and Sundays. Hours are whole (0–24).
const localParts = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value);
  const day = String(parts.find((p) => p.type === 'weekday')?.value || '').slice(0, 3).toLowerCase();
  return { minutes: h * 60 + m, weekend: day === 'sat' || day === 'sun', day };
};
export const localMinutes = (date, timeZone) => localParts(date, timeZone).minutes;
export const isQuiet = (date, timeZone, from, until) => {
  const m = localMinutes(date, timeZone);
  return !(m >= from * 60 && m < until * 60);
};
export const hourWord = (h) => (h === 0 || h === 24 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? `${h} am` : `${h - 12} pm`);
export const windowWord = (from, until) => (from === 0 && until === 24 ? 'any time' : `${hourWord(from)}–${hourWord(until)}`);
// Today's window for these settings ({ allow_from, allow_until,
// weekend_from, weekend_until }), whether now is outside it, and when
// sending opens next ("9 am", "10 am tomorrow").
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const windowOf = (settings, weekend) => (weekend
  ? { from: settings.weekend_from ?? DEFAULT_WEEKEND_FROM, until: settings.weekend_until ?? DEFAULT_WEEKEND_UNTIL }
  : { from: settings.allow_from ?? DEFAULT_FROM, until: settings.allow_until ?? DEFAULT_UNTIL });
export const quietNow = (settings, date, timeZone) => {
  const local = localParts(date, timeZone);
  const today = windowOf(settings, local.weekend);
  const quiet = !(local.minutes >= today.from * 60 && local.minutes < today.until * 60);
  let opens = null;
  if (quiet) {
    if (local.minutes < today.from * 60) opens = hourWord(today.from);
    else {
      const next = DAYS[(DAYS.indexOf(local.day) + 1) % 7];
      const tomorrow = windowOf(settings, next === 'sat' || next === 'sun');
      opens = `${hourWord(tomorrow.from)} tomorrow`;
    }
  }
  return { now: quiet, from: today.from, until: today.until, label: windowWord(today.from, today.until), opens, weekend: local.weekend };
};

// The clock, swappable in tests (quiet hours depend on it).
let clock = () => new Date();
export const now = () => clock();
export const _setClockForTest = (fn) => { clock = fn || (() => new Date()); };
