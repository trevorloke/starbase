// Admin — teams (groups of members) and permissions (lib/perms.js), set
// under Admin in the staff app: Members · Teams · Permissions.
//
//   sql.js      teams, team_members; memberships.permissions
//   actions.js  team.* and permission.* (managers)
//   api.js      GET /teams (desk) · GET /admin/permissions (managers)
// A member removed from the campaign leaves every team (events hook).
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';

const leaveTeams = async (tx, meta, events) => {
  for (const e of events) {
    if (e.entityType === 'membership' && e.op === 'void') {
      await tx.query('delete from team_members where workspace_id = $1 and user_id = $2', [meta.workspaceId, e.entityId]);
      await tx.query('update teams set lead_user_id = null where workspace_id = $1 and lead_user_id = $2', [meta.workspaceId, e.entityId]);
    }
  }
};
export const hooks = { events: leaveTeams };
export const exportTables = ['teams', 'team_members'];
export const deskOnlyReads = ['/teams', /^\/api\/admin\//];
