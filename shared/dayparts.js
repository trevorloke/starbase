// Parts of the day for the Shifts week board — defined once, used by the
// web board and the server. A shift belongs to the part its start falls in,
// in the campaign's time zone (workspace settings.tz, Vancouver by default —
// the same zone shift emails are written in):
//   before noon → Morning, noon to 5pm → Afternoon, 5pm on → Evening.
// `start`/`end` are the hours a new shift made from an empty slot gets.
export const DAY_PARTS = [
  { code: 'morning', label: 'Morning', start: 9, end: 12 },
  { code: 'afternoon', label: 'Afternoon', start: 12, end: 17 },
  { code: 'evening', label: 'Evening', start: 17, end: 21 },
];
export const DAY_PART_CODES = DAY_PARTS.map((p) => p.code);
export const CAMPAIGN_TZ = 'America/Vancouver';

const pad = (n) => String(n).padStart(2, '0');

// A zone the runtime knows, else Vancouver.
export const safeZone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz || CAMPAIGN_TZ });
    return tz || CAMPAIGN_TZ;
  } catch {
    return CAMPAIGN_TZ;
  }
};

// The wall clock in `tz` at an instant: { day: 'YYYY-MM-DD', hour, minute }.
export const wallClock = (when, tz = CAMPAIGN_TZ) => {
  const d = when instanceof Date ? when : new Date(when);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: safeZone(tz), hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
};

export const dayOf = (when, tz) => wallClock(when, tz).day;

// 'morning' | 'afternoon' | 'evening' for a start time.
export const partOf = (when, tz) => {
  const { hour } = wallClock(when, tz);
  if (hour < DAY_PARTS[1].start) return 'morning';
  if (hour < DAY_PARTS[2].start) return 'afternoon';
  return 'evening';
};

// Calendar arithmetic on 'YYYY-MM-DD' (no time zone involved).
export const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
// 0 = Monday … 6 = Sunday
export const weekdayIndex = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
};
// The Monday of the week holding `day`.
export const weekStart = (day) => addDays(day, -weekdayIndex(day));

// '2026-10-27' 17:00 in `tz` → '2026-10-27T17:00:00-07:00' (the offset that
// zone has on that day, so DST is right on either side of the change).
export const zonedISO = (day, hour, tz = CAMPAIGN_TZ, minute = 0) => {
  const [y, m, d] = day.split('-').map(Number);
  const want = Date.UTC(y, m - 1, d, hour, minute);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const w = wallClock(new Date(guess), tz);
    const [wy, wm, wd] = w.day.split('-').map(Number);
    const seen = Date.UTC(wy, wm - 1, wd, w.hour, w.minute);
    if (seen === want) break;
    guess += want - seen;
  }
  const off = Math.round((want - guess) / 60000); // minutes east of UTC
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${day}T${pad(hour)}:${pad(minute)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};

// The times a new shift in that slot gets.
export const partRange = (day, code, tz) => {
  const p = DAY_PARTS.find((x) => x.code === code) || DAY_PARTS[0];
  return { starts_at: zonedISO(day, p.start, tz), ends_at: zonedISO(day, p.end, tz) };
};

// The instants a week (Monday 00:00 → next Monday 00:00) covers in `tz`.
export const weekBounds = (monday, tz) => ({
  from: zonedISO(monday, 0, tz),
  to: zonedISO(addDays(monday, 7), 0, tz),
});
