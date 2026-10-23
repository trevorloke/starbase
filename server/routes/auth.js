// /api/auth — signup creates user + workspace + manager membership in one
// transaction (every tenant is small and self-serve; there is no operator
// console). Login binds the session to the user's workspace membership.
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getDb } from '../db/client.js';
import { newId, runAction } from '../lib/events.js';
import {
  hashPassword, verifyPassword, dummyVerify,
  createSession, destroySession, loadContext, SESSION_COOKIE,
} from '../lib/auth.js';

const app = new Hono();

// Secure cookies behind TLS: on in production unless STARBASE_SECURE_COOKIES=0
// (e.g. a local container on plain http); force on anywhere with =1.
const secureFlag = process.env.STARBASE_SECURE_COOKIES;
const secure = secureFlag ? secureFlag === '1' : process.env.NODE_ENV === 'production';
const cookieOpts = { httpOnly: true, sameSite: 'Lax', path: '/', secure, maxAge: 30 * 86400 };

const signupInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
  workspaceName: z.string().trim().min(1).max(200),
  candidate: z.string().trim().max(200).optional(),
  jurisdiction: z.enum(['bc-municipal', 'bc-provincial', 'federal']).default('bc-municipal'),
});

// What the browser gets about the workspace: settings minus the sample
// bookkeeping (the ids of every sample row), which only the server needs.
const clientWorkspace = (ws) => {
  const { sample, ...settings } = ws.settings || {};
  return { ...ws, settings: sample ? { ...settings, sample: { loaded: true } } : settings };
};

// URL slug for the workspace's public pages (/p/:slug/…, /n/:slug, /v/:slug).
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'campaign';
const uniqueSlug = async (tx, base) => {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const taken = (await tx.query('select 1 from workspaces where slug = $1', [candidate])).rows[0];
    if (!taken) return candidate;
  }
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
};

app.post('/signup', async (c) => {
  const db = await getDb();
  const parsed = signupInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const input = parsed.data;

  const email = input.email.toLowerCase();
  const passwordHash = await hashPassword(input.password);
  const userId = newId();
  const workspaceId = newId();
  try {
    await db.transaction(async (tx) => {
      await tx.query(
        'insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)',
        [userId, email, input.name, passwordHash],
      );
      await tx.query(
        'insert into workspaces (id, name, slug, candidate, jurisdiction) values ($1, $2, $3, $4, $5)',
        [workspaceId, input.workspaceName, await uniqueSlug(tx, slugify(input.workspaceName)),
         input.candidate || null, input.jurisdiction],
      );
      await tx.query(
        'insert into memberships (user_id, workspace_id, role) values ($1, $2, $3)',
        [userId, workspaceId, 'manager'],
      );
    });
  } catch (e) {
    if (String(e.message).includes('users_email_key')) {
      return c.json({ error: 'an account with that email already exists' }, 409);
    }
    throw e;
  }
  // The campaign's first entries: who created it and who holds access.
  await runAction(db, { workspaceId, actorId: userId, action: 'workspace.create' }, async (tx, emit) => {
    emit('workspace', workspaceId, 'create', { name: input.workspaceName, jurisdiction: input.jurisdiction });
    emit('membership', userId, 'create', { email, role: 'manager' });
  });
  const token = await createSession(db, userId, workspaceId);
  setCookie(c, SESSION_COOKIE, token, cookieOpts);
  const ctx = await loadContext(db, token);
  return c.json({ user: ctx.user, workspace: clientWorkspace(ctx.workspace), role: ctx.role }, 201);
});

app.post('/login', async (c) => {
  const db = await getDb();
  const { email, password } = await c.req.json().catch(() => ({}));
  if (!email || !password) return c.json({ error: 'email and password required' }, 400);
  const user = (await db.query(
    'select id, password_hash from users where email = $1',
    [String(email).toLowerCase()],
  )).rows[0];
  if (!user) {
    await dummyVerify();
    return c.json({ error: 'invalid credentials' }, 401);
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: 'invalid credentials' }, 401);
  }
  const membership = (await db.query(
    'select workspace_id from memberships where user_id = $1 order by created_at limit 1',
    [user.id],
  )).rows[0];
  if (!membership) return c.json({ error: 'no workspace membership' }, 403);
  const token = await createSession(db, user.id, membership.workspace_id);
  setCookie(c, SESSION_COOKIE, token, cookieOpts);
  const ctx = await loadContext(db, token);
  return c.json({ user: ctx.user, workspace: clientWorkspace(ctx.workspace), role: ctx.role });
});

// ── Invites: look up, then join (new account, or an existing one by password) ──
const findInvite = async (db, token) => (await db.query(
  `select i.id, i.email, i.role, i.workspace_id, w.name as workspace_name
   from invites i join workspaces w on w.id = i.workspace_id
   where i.token_hash = $1 and i.accepted_at is null and i.expires_at > now()`,
  [createHash('sha256').update(String(token || '')).digest('hex')],
)).rows[0];

app.get('/invite/:token', async (c) => {
  const db = await getDb();
  const inv = await findInvite(db, c.req.param('token'));
  if (!inv) return c.json({ error: 'this invite link is invalid or has expired' }, 404);
  const existing = (await db.query('select 1 from users where email = $1', [inv.email])).rows[0];
  return c.json({ email: inv.email, role: inv.role, workspaceName: inv.workspace_name, hasAccount: !!existing });
});

const joinInput = z.object({
  token: z.string().min(10).max(200),
  name: z.string().trim().min(1).max(200).optional(),
  password: z.string().min(8).max(200),
});

app.post('/join', async (c) => {
  const db = await getDb();
  const parsed = joinInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const { token, name, password } = parsed.data;
  const inv = await findInvite(db, token);
  if (!inv) return c.json({ error: 'this invite link is invalid or has expired' }, 404);

  let user = (await db.query('select id, password_hash from users where email = $1', [inv.email])).rows[0];
  if (user && !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: 'that password does not match your existing Starbase account' }, 401);
  }
  if (!user && !name) return c.json({ error: 'name required' }, 400);
  const userId = user?.id || newId();
  const passwordHash = user ? null : await hashPassword(password);
  // On the hash chain: who now has access to the campaign, and in what role.
  await runAction(db, { workspaceId: inv.workspace_id, actorId: userId, action: 'member.join' }, async (tx, emit) => {
    if (!user) {
      await tx.query('insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)',
        [userId, inv.email, name, passwordHash]);
    }
    const m = await tx.query(
      `insert into memberships (user_id, workspace_id, role) values ($1, $2, $3)
       on conflict (user_id, workspace_id) do nothing`,
      [userId, inv.workspace_id, inv.role],
    );
    const n = await tx.query('update invites set accepted_at = now() where id = $1 and accepted_at is null', [inv.id]);
    if (n.affectedRows === 0) throw new Error('invite already used');
    emit('invite', inv.id, 'update', { accepted: true });
    if (m.affectedRows > 0) emit('membership', userId, 'create', { email: inv.email, role: inv.role, user_id: userId });
  });
  const sessionToken = await createSession(db, userId, inv.workspace_id);
  setCookie(c, SESSION_COOKIE, sessionToken, cookieOpts);
  const ctx = await loadContext(db, sessionToken);
  return c.json({ user: ctx.user, workspace: clientWorkspace(ctx.workspace), role: ctx.role });
});

app.post('/logout', async (c) => {
  const db = await getDb();
  await destroySession(db, getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

app.get('/me', async (c) => {
  const db = await getDb();
  const ctx = await loadContext(db, getCookie(c, SESSION_COOKIE));
  if (!ctx) return c.json({ error: 'not signed in' }, 401);
  return c.json({ user: ctx.user, workspace: clientWorkspace(ctx.workspace), role: ctx.role });
});

export default app;
