// Canvass + field constants — one shared vocabulary for server validation
// and web rendering.
//
// The rating scale is the campaign's own (shared/scale.js: the steps' words
// and the "Voting for?" list come from workspace settings.scale, edited on
// the manager's Rating scale screen). RATINGS here is the DEFAULT scale —
// what a campaign has until it changes anything, and what seeds and tests
// use. Validate and display through scale.js with the campaign's scale.
import { DEFAULT_SCALE } from './scale.js';

export const RATINGS = [
  ...DEFAULT_SCALE.steps.map((s) => ({ code: s.code, label: s.label, short: s.code, band: s.band })),
  ...DEFAULT_SCALE.candidates.map((c) => ({ code: c.code, label: c.label, short: c.code, band: 'opposed' })),
];
export const RATING_CODES = RATINGS.map((r) => r.code);
export const ratingByCode = (c) => RATINGS.find((r) => r.code === c) || null;

// in_person: a talk with someone you know, away from their door ("My people").
export const CHANNELS = ['door', 'phone', 'text', 'in_person'];
export const OUTCOMES = ['contacted', 'no_answer', 'refused', 'moved', 'inaccessible'];

export const SIGN_KINDS = [
  { code: 'billboard', label: 'Billboard (4×8)' },
  { code: 'large',     label: 'Large sign (4×4)' },
  { code: 'lawn',      label: 'Lawn sign' },
];
export const SIGN_KIND_CODES = SIGN_KINDS.map((s) => s.code);
export const SIGN_STATUSES = ['requested', 'installed', 'removed'];

export const VOLUNTEER_ROLES = [
  { code: 'driver',              label: 'Driver' },
  { code: 'scrutineer',          label: 'Scrutineer' },
  { code: 'doorknocking',        label: 'Doorknocking' },
  { code: 'mainstreeting',       label: 'Mainstreeting' },
  { code: 'phoning',             label: 'Phoning' },
  { code: 'data_entry',          label: 'Data entry' },
  { code: 'event_hosting',       label: 'Event hosting' },
  { code: 'zone_house_captain',  label: 'Zone house captain' },
  { code: 'highrise_captain',    label: 'Hi-rise building captain', detail: 'Building (name or address)' },
  { code: 'food',                label: 'Food' },
  { code: 'translation',         label: 'Translation', detail: 'Language' },
  { code: 'burmashave',          label: 'Burmashave' },
  { code: 'community_committee', label: 'Community committee', detail: 'Community (Newton, Whalley, …)' },
  { code: 'policy',              label: 'Policy' },
  { code: 'administration',      label: 'Administration' },
];
export const VOLUNTEER_ROLE_CODES = VOLUNTEER_ROLES.map((r) => r.code);

export const SOCIAL_PLATFORMS = ['facebook', 'instagram', 'x', 'tiktok', 'reddit', 'youtube', 'linkedin', 'bluesky', 'other'];

// Tags are free-form; these seed the picker so the vocabulary stays consistent.
export const SUGGESTED_TAGS = [
  'media', 'VIP', 'endorser', 'host', 'donor-prospect', 'lapsed',
  'newsletter', 'petition', 'youth', 'senior', 'business', 'faith',
  'union', 'do-not-contact',
];

// Donor tiers, derived from real gifts — never self-declared.
//   star:      $1,000+ in the calendar year, or $100+/mo recurring
//   superstar: $3,000+ in the calendar year, or $250+/mo recurring
export const DONOR_TIERS = {
  star:      { yearCents: 100000, monthlyCents: 10000, label: 'Star' },
  superstar: { yearCents: 300000, monthlyCents: 25000, label: 'Superstar' },
};

export const donorTier = ({ yearCents = 0, monthlyCents = 0 }) => {
  if (yearCents >= DONOR_TIERS.superstar.yearCents || monthlyCents >= DONOR_TIERS.superstar.monthlyCents) return 'superstar';
  if (yearCents >= DONOR_TIERS.star.yearCents || monthlyCents >= DONOR_TIERS.star.monthlyCents) return 'star';
  if (monthlyCents > 0) return 'monthly';
  if (yearCents > 0) return 'one-time';
  return null;
};

// The slates a contribution goes to. A contribution is to one slate; the
// annual limit is per contributor per slate (each slate is its own election —
// city council, school board — and LECFA's limit is per jurisdiction; verify
// with Elections BC). A gift that names no slate is to the first one.
export const SLATES = [
  { code: 'council', label: 'City council' },
  { code: 'school_board', label: 'School board' },
];
export const SLATE_CODES = SLATES.map((s) => s.code);
export const DEFAULT_SLATE = SLATES[0].code;
export const slateLabel = (code) => SLATES.find((s) => s.code === (code || DEFAULT_SLATE))?.label || String(code);

export const SHIFT_STATUSES = ['assigned', 'confirmed', 'declined', 'no_show', 'completed'];
