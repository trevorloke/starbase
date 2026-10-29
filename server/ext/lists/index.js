// Lists — saved filters and hand-picked lists of people: an audience for an
// email or text blast, a report, or a CSV.
//
//   sql.js       lists, list_members
//   audience.js  who a list (or a filter) names, and who of them can be reached
//   actions.js   list.create/update/delete/add/remove (desk)
//   api.js       GET /lists, /lists/preview, /lists/tags, /lists/:id, /lists/:id/export.csv (desk)
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
export const exportTables = ['lists', 'list_members'];
export const deskOnlyReads = [/^\/api\/lists(\/|$)/];
