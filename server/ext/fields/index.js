// Profile fields — the campaign's own things to track about people
// ("Strata council member", "Language at home", "Union local"), no code.
//
// A manager defines them (People → More → Profile fields): a name; a kind —
// Text · Yes/No · Pick one · Number · Date; rename, reorder, add choices,
// take one off (its values stay, in the export too) and bring it back; and
// "Volunteers can see this", off unless turned on. The desk fills them in on
// a profile under "More details"; a volunteer sees only the filled-in ones
// marked for volunteers, read-only. People filters by one (Filter → More
// filters), the CSV import fills them by column name, and the export carries
// both tables.
//
//   sql.js      tables: person_fields, person_field_values (why a table: sql.js)
//   kinds.js    the five kinds: checking, storing and showing a value
//   actions.js  field.* (managers) and field.values.set (desk)
//   api.js      GET /fields (desk) · GET /fields/:id and /persons/:id/fields (any role, filtered)
//   people.js   the People filter, the import, the sample campaign, and the
//               standard fields a new campaign starts with (lib/hooks.js)
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
import { personsWhere, importRows, sampleLoaded, sampleCleared, workspaceCreated } from './people.js';

export const hooks = { personsWhere, importRows, sampleLoaded, sampleCleared, workspaceCreated };

// In the full export: every field (taken off too) and every value.
export const exportTables = ['person_fields', 'person_field_values'];

// Volunteers read a profile's fields through /persons/:id/fields only (the
// ones marked for them), and one such field's name through /fields/:id. The
// list of every field, with counts and the most common values, is the desk's.
export const deskOnlyReads = ['/fields'];
