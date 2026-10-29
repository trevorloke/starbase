// Reports and CSV exports for the desk: the campaign in numbers (people by
// rating, tags, cities, contacts by week, donations by month, members, the
// newsletter list, sends), each downloadable, and whole tables as
// spreadsheets. The full JSON export stays at GET /export.
export { api } from './api.js';
export const deskOnlyReads = [/^\/api\/reports(\/|$)/, /^\/api\/export\/[a-z]+(\.csv)?$/];
