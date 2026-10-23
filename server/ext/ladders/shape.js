// What a ladder is made of: the triggers that start one, the steps it runs,
// the zod contracts for both, and the words the screens use for them.
import { z } from 'zod';

// What starts a ladder. `ref` narrows some of them: a petition (by its link
// name), an event (by id) or a tag (required). No ref = any petition / event.
export const TRIGGERS = {
  petition:   { label: 'Signed a petition', ref: 'petition' },
  newsletter: { label: 'Joined the newsletter' },
  volunteer:  { label: 'Signed up to volunteer' },
  rsvp:       { label: 'RSVPed to an event', ref: 'event' },
  donation:   { label: 'First donation' },
  tag:        { label: 'Got a tag', ref: 'tag', refRequired: true },
  rating:     { label: 'Rated 1 or 2' },
};
export const TRIGGER_KINDS = Object.keys(TRIGGERS);

// What a step does. Waits are in hours or days; emails carry {{first_name}}
// and {{campaign}}; a follow-up is a task for staff.
export const STEP_KINDS = ['wait', 'email', 'tag', 'untag', 'followup', 'stop'];
export const MAX_STEPS = 20;
export const WAIT_UNITS = { hours: 3600_000, days: 86_400_000 };

const tagName = z.string().trim().min(1).max(40);
export const stepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wait'), n: z.number().int().min(1).max(365), unit: z.enum(['hours', 'days']) }),
  z.object({
    kind: z.literal('email'),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20000),
  }),
  z.object({ kind: z.literal('tag'), tag: tagName }),
  z.object({ kind: z.literal('untag'), tag: tagName }),
  z.object({ kind: z.literal('followup'), text: z.string().trim().min(1).max(300) }),
  z.object({ kind: z.literal('stop') }),
]);
export const stepsSchema = z.array(stepSchema).max(MAX_STEPS);

export const triggerSchema = z.object({
  kind: z.enum(TRIGGER_KINDS),
  ref: z.string().trim().max(120).nullish(),
}).superRefine((t, ctx) => {
  if (TRIGGERS[t.kind].refRequired && !t.ref) ctx.addIssue({ code: 'custom', message: 'pick a tag', path: ['ref'] });
  if (t.kind === 'rsvp' && t.ref && !/^[0-9a-f-]{36}$/i.test(t.ref)) ctx.addIssue({ code: 'custom', message: 'pick an event', path: ['ref'] });
});

export const parseJson = (v, fallback) => {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};

export const tagsOf = (p) => {
  const t = parseJson(p?.tags, []);
  return Array.isArray(t) ? t.map(String) : [];
};
export const sameTag = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
export const DNC_TAG = 'do-not-contact';
export const isDnc = (p) => tagsOf(p).some((t) => sameTag(t, DNC_TAG));
// A ladder email's unsubscribe from someone who was never on the newsletter
// list: no list row is made for them, the person is flagged instead.
export const NO_EMAIL_TAG = 'do-not-email';
export const noEmail = (p) => tagsOf(p).some((t) => sameTag(t, NO_EMAIL_TAG));

export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

// {{first_name}} and {{campaign}}, spaces inside the braces allowed.
export const fillIn = (text, { person, campaign }) => String(text || '')
  .replace(/\{\{\s*first_name\s*\}\}/gi, firstName(person?.name))
  .replace(/\{\{\s*campaign\s*\}\}/gi, campaign || '');

export const waitMs = (s) => (Number(s.n) || 0) * (WAIT_UNITS[s.unit] || WAIT_UNITS.days);

// Hard rules for a ladder that is about to run: at least one step that does
// something (a ladder of nothing but waits would just hold people).
export const runnable = (steps) => steps.some((s) => s.kind !== 'wait' && s.kind !== 'stop');
