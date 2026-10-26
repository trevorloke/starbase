// Auth: scrypt password hashing (node:crypto — no native deps), hashed
// session tokens in the database, and a context loader that resolves the
// session to { user, workspace, role } via the memberships table. Tenancy is
// the membership row — a user's workspace is never a mutable column.
import { permsOf } from './perms.js';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export const hashPassword = async (password) => {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt:${N}:${R}:${P}:${salt.toString('base64')}:${key.toString('base64')}`;
};

export const verifyPassword = async (password, stored) => {
  try {
    const [algo, n, r, p, saltB64, keyB64] = stored.split(':');
    if (algo !== 'scrypt') return false;
    const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), KEYLEN,
      { N: Number(n), r: Number(r), p: Number(p) });
    return timingSafeEqual(key, Buffer.from(keyB64, 'base64'));
  } catch {
    return false;
  }
};

// Constant-cost dummy verify for unknown emails (anti user-enumeration).
const DUMMY = hashPassword('dummy-password-for-timing');
export const dummyVerify = async () => { await verifyPassword('x', await DUMMY); };

const hashToken = (t) => createHash('sha256').update(t).digest('hex');
export const SESSION_COOKIE = 'mv2_session';
const SESSION_DAYS = 30;

export const createSession = async (db, userId, workspaceId) => {
  const token = randomBytes(32).toString('hex');
  await db.query(
    `insert into sessions (token_hash, user_id, workspace_id, expires_at)
     values ($1, $2, $3, now() + interval '${SESSION_DAYS} days')`,
    [hashToken(token), userId, workspaceId],
  );
  return token;
};

export const destroySession = async (db, token) => {
  if (token) await db.query('delete from sessions where token_hash = $1', [hashToken(token)]);
};

// Resolve a session token to the full request context, or null.
export const loadContext = async (db, token) => {
  if (!token) return null;
  const { rows } = await db.query(
    `select u.id as user_id, u.email, u.name as user_name, m.role, m.permissions,
            w.id as workspace_id, w.name as ws_name, w.slug as ws_slug, w.candidate, w.jurisdiction, w.settings
     from sessions s
     join users u on u.id = s.user_id
     join memberships m on m.user_id = s.user_id and m.workspace_id = s.workspace_id
     join workspaces w on w.id = s.workspace_id
     where s.token_hash = $1 and s.expires_at > now()`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return null;
  const settings = typeof r.settings === 'string' ? JSON.parse(r.settings) : (r.settings || {});
  const own = typeof r.permissions === 'string' ? JSON.parse(r.permissions) : (r.permissions || {});
  return {
    user: { id: r.user_id, email: r.email, name: r.user_name },
    role: r.role,
    // Grants and denies on top of the role (lib/perms.js).
    perms: permsOf(r.role, settings, own),
    workspaceId: r.workspace_id,
    workspace: {
      id: r.workspace_id, name: r.ws_name, slug: r.ws_slug, candidate: r.candidate,
      jurisdiction: r.jurisdiction,
      settings,
    },
  };
};
