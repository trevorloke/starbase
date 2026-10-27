// Phone banks — a list of numbers to call, handed out to callers, crossed
// off as calls are logged.
//
//   sql.js      call_banks, call_bank_numbers
//   actions.js  bank.create/update/remove/add/assign/release (desk), bank.done (anyone)
//   api.js      GET /banks, /banks/:id (desk); /banks/mine, /banks/:id/mine (anyone)
// A phone call logged by the caller a number was handed to crosses it off
// (contactLogged hook); the Calls screen works a bank like any list.
export { sql } from './sql.js';
import { crossOff } from './actions.js';
export { actions } from './actions.js';
export { api } from './api.js';
export const hooks = { contactLogged: crossOff };
export const exportTables = ['call_banks', 'call_bank_numbers'];
export const deskOnlyReads = [/^\/api\/banks$/, /^\/api\/banks\/[0-9a-f-]{36}$/];
