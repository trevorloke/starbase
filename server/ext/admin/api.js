// Reads: GET /teams (desk: the teams and who is on them, for the turf
// picker) · GET /admin/permissions (managers: the areas, each role's and
// each member's grants and denies, and what each member ends up with).
import { Hono } from 'hono';
import { AREAS, BASE, permsOf, decide, AREA_KEYS } from '../../lib/perms.js';

export const api = new Hono();
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));

export const listTeams = async (db, ws) => {
  const teams = (await db.query(
    'select id, name, note, lead_user_id, created_at from teams where workspace_id = $1 and deleted_at is null order by lower(name)', [ws],
  )).rows;
  const members = (await db.query(
    `select tm.team_id, u.id, u.name, m.role from team_members tm
       join users u on u.id = tm.user_id join memberships m on m.user_id = tm.user_id and m.workspace_id = tm.workspace_id
     where tm.workspace_id = $1 order by lower(u.name)`, [ws],
  )).rows;
  return teams.map((t) => ({ ...t, members: members.filter((m) => m.team_id === t.id).map(({ team_id, ...m }) => m) }));
};

api.get('/teams', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role === 'volunteer') return c.json({ error: 'volunteers cannot view this' }, 403);
  return c.json({ teams: await listTeams(c.get('db'), ctx.workspaceId) });
});

api.get('/admin/permissions', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role !== 'manager') return c.json({ error: 'managers only' }, 403);
  const db = c.get('db');
  const settings = parseJ((await db.query('select settings from workspaces where id = $1', [ctx.workspaceId])).rows[0].settings, {});
  const roles = {};
  for (const role of ['treasurer', 'staff', 'volunteer']) {
    const r = settings.permissions?.roles?.[role] || {};
    roles[role] = { grant: r.grant || [], deny: r.deny || [], base: BASE[role] };
  }
  const members = (await db.query(
    `select u.id, u.name, u.email, m.role, m.permissions from memberships m join users u on u.id = m.user_id
     where m.workspace_id = $1 order by lower(u.name)`, [ctx.workspaceId],
  )).rows.map((m) => {
    const own = parseJ(m.permissions, {});
    const perms = permsOf(m.role, settings, own);
    const areas = AREA_KEYS.filter((k) => { const d = decide(perms, k); return d === null ? BASE[m.role].includes(k) : d; });
    return { id: m.id, name: m.name, email: m.email, role: m.role, grant: own.grant || [], deny: own.deny || [], areas };
  });
  return c.json({ areas: AREAS, base: BASE, roles, members });
});
