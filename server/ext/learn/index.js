// ImagineU — training for volunteers and supporters: sections of lessons,
// each a note, a document, a video, audio, a picture, contacts or a
// procedure, with a file or a link behind it, and a "done" per person.
//
//   sql.js      learn_sections, learn_lessons, learn_assets, learn_done
//   actions.js  learn.section.*, learn.lesson.*, learn.asset.upload (desk);
//               learn.done (anyone)
//   api.js      GET /learn, /learn/lessons/:id, /learn/assets/:id;
//               /learn/progress (desk)
//   public.js   /learn/<slug>[/<id>] for lessons marked public; /learn-files
// The files themselves are not in the export (they are documents, not
// records); the lessons and who has done what are.
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
export { publicRoutes } from './public.js';
export const deskOnlyReads = ['/learn/progress'];
export const exportTables = ['learn_sections', 'learn_lessons', 'learn_done'];
