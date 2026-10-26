// Admin: teams and permissions. Managers only (the admin area).
//
//   team.create { name, note?, lead_user_id? } · team.update { id, … } · team.delete { id }
//   team.member.add { team_id, user_id } · team.member.remove { team_id, user_id }
//   permission.role.set { role, grant[], deny[] }     a whole role's areas
//   permission.member.set { user_id, grant[], deny[] }  one person's areas
import { z } from 'zod';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import { AREA_KEYS } from '../../lib/perms.js';

const MANAGER = ['manager'];
const uuid = () => z.uuid();
const areas = () => z.array(z.enum(AREA_KEYS)).max(AREA_KEYS.length).default([]);
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));

const loadTeam = async (tx, ws, id) => {
  const t = (await tx.query('select * from teams where id = $1 and workspace_id = $2 and deleted_at is null', [id, ws])).rows[0];
  if (!t) throw httpError(404, 'team not found');
  return t;
};
const isMember = async (tx, ws, userId) => (await tx.query(
  'select 1 from memberships where user_id = $1 and workspace_id = $2', [userId, ws],
)).rows.length > 0;

export const actions = {
  'team.create': {
    roles: MANAGER,
    input: z.object({ name: z.string().trim().min(1).max(80), note: z.string().trim().max(500).nullish(), lead_user_id: uuid().nullish() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      if (input.lead_user_id && !(await isMember(tx, ws, input.lead_user_id))) throw httpError(400, 'the lead must be a member');
      const dup = (await tx.query('select 1 from teams where workspace_id = $1 and lower(name) = lower($2) and deleted_at is null', [ws, input.name])).rows[0];
      if (dup) throw httpError(409, `there is already a team called “${input.name}”`);
      const id = newId();
      await tx.query('insert into teams (id, workspace_id, name, note, lead_user_id) values ($1, $2, $3, $4, $5)',
        [id, ws, input.name, input.note || null, input.lead_user_id || null]);
      if (input.lead_user_id) {
        await tx.query('insert into team_members (workspace_id, team_id, user_id) values ($1, $2, $3) on conflict do nothing', [ws, id, input.lead_user_id]);
      }
      emit('team', id, 'create', { name: input.name, note: input.note || null, lead_user_id: input.lead_user_id || null });
      return { team: { id, name: input.name, note: input.note || null, lead_user_id: input.lead_user_id || null } };
    },
  },
  'team.update': {
    roles: MANAGER,
    input: z.object({ id: uuid(), name: z.string().trim().min(1).max(80).optional(), note: z.string().trim().max(500).nullish(), lead_user_id: uuid().nullish() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const cur = await loadTeam(tx, ws, input.id);
      const name = input.name ?? cur.name;
      const note = input.note === undefined ? cur.note : (input.note || null);
      const lead = input.lead_user_id === undefined ? cur.lead_user_id : (input.lead_user_id || null);
      if (lead && !(await isMember(tx, ws, lead))) throw httpError(400, 'the lead must be a member');
      await tx.query('update teams set name = $3, note = $4, lead_user_id = $5, updated_at = now() where id = $1 and workspace_id = $2', [cur.id, ws, name, note, lead]);
      if (lead) await tx.query('insert into team_members (workspace_id, team_id, user_id) values ($1, $2, $3) on conflict do nothing', [ws, cur.id, lead]);
      emit('team', cur.id, 'update', { name, note, lead_user_id: lead });
      return { team: { id: cur.id, name, note, lead_user_id: lead } };
    },
  },
  'team.delete': {
    roles: MANAGER,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadTeam(tx, ctx.workspaceId, input.id);
      await tx.query('update teams set deleted_at = now() where id = $1', [cur.id]);
      await tx.query('delete from team_members where team_id = $1', [cur.id]);
      emit('team', cur.id, 'void', {});
      return { id: cur.id };
    },
  },
  'team.member.add': {
    roles: MANAGER,
    input: z.object({ team_id: uuid(), user_id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      await loadTeam(tx, ws, input.team_id);
      if (!(await isMember(tx, ws, input.user_id))) throw httpError(400, 'that person is not a member — invite them first');
      const n = await tx.query('insert into team_members (workspace_id, team_id, user_id) values ($1, $2, $3) on conflict do nothing', [ws, input.team_id, input.user_id]);
      if (n.affectedRows > 0) emit('team', input.team_id, 'update', { added: input.user_id });
      return { team_id: input.team_id, user_id: input.user_id, added: n.affectedRows > 0 };
    },
  },
  'team.member.remove': {
    roles: MANAGER,
    input: z.object({ team_id: uuid(), user_id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const t = await loadTeam(tx, ws, input.team_id);
      const n = await tx.query('delete from team_members where team_id = $1 and user_id = $2 and workspace_id = $3', [input.team_id, input.user_id, ws]);
      if (t.lead_user_id === input.user_id) await tx.query('update teams set lead_user_id = null where id = $1', [t.id]);
      if (n.affectedRows > 0) emit('team', input.team_id, 'update', { removed: input.user_id });
      return { team_id: input.team_id, user_id: input.user_id, removed: n.affectedRows > 0 };
    },
  },

  'permission.role.set': {
    roles: MANAGER,
    input: z.object({ role: z.enum(['treasurer', 'staff', 'volunteer']), grant: areas(), deny: areas() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const settings = parseJ((await tx.query('select settings from workspaces where id = $1 for update', [ws])).rows[0].settings, {});
      const grant = input.grant.filter((k) => !input.deny.includes(k));
      const roles = { ...(settings.permissions?.roles || {}), [input.role]: { grant, deny: input.deny } };
      const next = { ...settings, permissions: { ...(settings.permissions || {}), roles } };
      await tx.query('update workspaces set settings = $2 where id = $1', [ws, JSON.stringify(next)]);
      emit('workspace', ws, 'update', { permissions: { role: input.role, grant, deny: input.deny } });
      return { role: input.role, grant, deny: input.deny };
    },
  },
  'permission.member.set': {
    roles: MANAGER,
    input: z.object({ user_id: uuid(), grant: areas(), deny: areas() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const m = (await tx.query('select role from memberships where user_id = $1 and workspace_id = $2', [input.user_id, ws])).rows[0];
      if (!m) throw httpError(404, 'member not found');
      if (m.role === 'manager') throw httpError(400, 'a manager has every area; change their role instead');
      const grant = input.grant.filter((k) => !input.deny.includes(k));
      await tx.query('update memberships set permissions = $3 where user_id = $1 and workspace_id = $2', [input.user_id, ws, JSON.stringify({ grant, deny: input.deny })]);
      emit('membership', input.user_id, 'update', { permissions: { grant, deny: input.deny } });
      return { user_id: input.user_id, grant, deny: input.deny };
    },
  },
};
