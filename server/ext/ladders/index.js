// Ladders of engagement — Action Network / Action Builder style.
//
// A ladder is a trigger (signed a petition, joined the newsletter, signed up
// to volunteer, RSVPed, first donation, got a tag, rated 1 or 2) and a list
// of steps (Wait · Email · Tag · Remove a tag · Follow-up for staff · Stop).
// Email steps go only to people who said yes to email (subscribed).
// When someone does the trigger they are put on every ladder that is on,
// once, and the steps run one job at a time. Each person also has an
// engagement level (Contact → Supporter → Signer → Donor or volunteer →
// Leader), computed from what they did.
//
//   sql.js      tables + the persons trigger that notes tags just got
//   shape.js    triggers, steps, contracts, {{first_name}} / {{campaign}}
//   engine.js   the events hook (enrolling) and the 'ladder.step' job
//   actions.js  ladder.* actions (desk roles)
//   levels.js   engagement levels
//   api.js      desk-only reads
//   public.js   /lu/:runId — unsubscribe from a ladder email (GET asks, POST does it)
//
// Volunteers see none of it: every read is desk-only, and nothing about
// ladders rides on any read they can make.
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
export { publicRoutes } from './public.js';
import { onEvents, runStepJob, JOB } from './engine.js';

export const hooks = { events: onEvents };
export const jobs = { [JOB]: runStepJob };

// In the full export: the ladders, who is on which step, and the follow-ups.
export const exportTables = ['ladders', 'ladder_runs', 'ladder_followups'];

export const deskOnlyReads = [
  /^\/api\/ladders(\/.*)?$/,
  '/persons/:id/ladders',
];
