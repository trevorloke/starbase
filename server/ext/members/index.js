// Members — the organization's membership roll, fed by the website's join
// form (POST /api/public/:ws/join) and kept on Donations' books where there
// is a fee.
//
//   sql.js      members
//   rules.js    the website's membership rules (age, BC, neighbourhoods)
//   public.js   the join form as JSON; markMember (the member / member-pending tag)
//   hooks.js    a pending membership turns active when its fee's pledge is paid or received
//   actions.js  member.set (desk)
//   api.js      GET /membership (desk; /members is the campaign's own team)
export { sql } from './sql.js';
export { publicRoutes } from './public.js';
export { actions } from './actions.js';
export { api } from './api.js';
import { onEvents } from './hooks.js';
export const hooks = { events: onEvents };
export const exportTables = ['members'];
export const deskOnlyReads = [/^\/api\/membership(\/|$)/];
