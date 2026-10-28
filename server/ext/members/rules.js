// The organization's membership rules, as the website applies them.
export const NEIGHBOURHOODS = ['Newton', 'Whalley', 'Fleetwood', 'Cloverdale', 'Guildford', 'South Surrey'];
export const OUTSIDE_SURREY = 'Outside Surrey';
export const CAMPUSES = ['Kwantlen Cloverdale', 'Kwantlen Newton', 'SFU Surrey', 'Another campus'];
export const CITIZENSHIP = ['Citizen', 'Permanent resident', 'Other'];
export const MIN_MEMBER_AGE = 14;
export const DEFAULT_FEE_CENTS = 1000;

export const POSTAL_RE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/i;
// BC postal codes all start with V.
export const BC_POSTAL_RE = /^V\d[A-Z] ?\d[A-Z]\d$/i;
// "v3t1a1" → "V3T 1A1"
export const normalizePostal = (postal) => {
  const raw = String(postal || '').toUpperCase().replace(/\s+/g, '');
  return raw.length === 6 ? `${raw.slice(0, 3)} ${raw.slice(3)}` : raw;
};
export const ageOn = (birthdate, today = new Date()) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthdate || ''));
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < mo || (today.getMonth() + 1 === mo && today.getDate() < d)) age -= 1;
  return age;
};
export const addYear = (date) => {
  const d = new Date(date);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
};
// Renewals open in the last two months of a membership.
export const RENEW_WINDOW_DAYS = 61;
// The status as it stands today: an active membership past its end has expired.
export const statusNow = (m, now = new Date()) => (m.status === 'active' && m.expires_at && new Date(m.expires_at) < now ? 'expired' : m.status);
