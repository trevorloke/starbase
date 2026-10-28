// The promise tracker — the governing party's promises scored in public,
// edited in the website admin (Website → Promise tracker) and read by the
// campaign's site as JSON.
//
//   sql.js      tracker_promises, tracker_updates, tracker_announcements
//   seed.js     the tracker as first published (tracker.seed)
//   actions.js  tracker.promise.save/delete, tracker.update.add/delete,
//               tracker.announcement.save/delete, tracker.seed (managers, staff)
//   reads.js    loadTracker, shared by the admin's GET /tracker and the public JSON
//   api.js      GET /tracker (managers, staff)
//   public.js   GET /api/public/:ws/site/tracker
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
export { publicRoutes } from './public.js';
export const exportTables = ['tracker_promises', 'tracker_updates', 'tracker_announcements'];
export const deskOnlyReads = [/^\/api\/tracker(\/|$)/];
