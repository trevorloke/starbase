// Dashboard — Today for managers: every team's contacts, and where everyone
// in the field is (field.ping from the map, while they share it).
//
//   sql.js      field_positions (latest, one per person), field_tracks (a day)
//   actions.js  field.ping (any role) — here I am / stop sharing
//   api.js      GET /dashboard (managers) — the numbers, the series, the map
// A member removed from the campaign leaves the map (events hook). Positions
// are not exported: they are a day's whereabouts, not a campaign record.
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';

const dropPositions = async (tx, meta, events) => {
  for (const e of events) {
    if (e.entityType === 'membership' && e.op === 'void') {
      await tx.query('delete from field_positions where workspace_id = $1 and user_id = $2', [meta.workspaceId, e.entityId]);
      await tx.query('delete from field_tracks where workspace_id = $1 and user_id = $2', [meta.workspaceId, e.entityId]);
    }
  }
};
export const hooks = { events: dropPositions };
export const deskOnlyReads = ['/dashboard'];
