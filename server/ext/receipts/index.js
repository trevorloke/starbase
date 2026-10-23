// Contribution receipts and the financial agent's disclosure export
// (BC municipal, LECFA).
//
// Every contribution at or over the campaign's threshold (default: every
// one) gets a receipt in the same transaction as the gift: numbered without
// gaps per campaign per year ("2026-0001"), voided with its gift (the number
// stays, marked VOID) and back with a restore. It is emailed once, a minute
// after the gift (its Undo first), when email is connected and the donor has
// an email and a home address — without the address it waits ("Needs
// address"); otherwise it says so and prints. A voided receipt the donor
// already got can be called back with a void notice. The donor gets their
// own link (/r/<token>). The desk downloads the disclosure (contributors over
// $100, for one period, sample gifts left out) and the full register.
//
//   sql.js      tables
//   core.js     settings, numbering, the receipt itself, status, sending
//   engine.js   the events hook (issue / void / restore) and the email job
//   actions.js  receipt.send · receipt.sendAll · receipt.sendVoid · receipt.settings
//   api.js      desk reads + the two spreadsheet exports
//   public.js   /r/:token — the donor's own receipt
//
// Volunteers see none of it: every read is desk-only, and nothing about
// receipts rides on any read they can make.
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
export { publicRoutes } from './public.js';
import { onEvents, runEmailJob } from './engine.js';
import { JOB } from './core.js';

export const hooks = { events: onEvents };
export const jobs = { [JOB]: runEmailJob };
export const deskOnlyReads = [/^\/api\/receipts(\/.*)?$/];

// In the full export: every receipt as issued — never the donor's link token.
export const exportTables = ['receipt_settings', 'receipt_counters', { table: 'receipts', omit: ['token'] }];
