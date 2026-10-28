// GET /tracker   managers and staff: the whole tracker, for the website admin
import { Hono } from 'hono';
import { loadTracker } from './reads.js';

export const api = new Hono();
const EDIT = ['manager', 'staff'];
api.get('/tracker', async (c) => {
  const ctx = c.get('ctx');
  if (!EDIT.includes(ctx.role)) return c.json({ error: 'not for your role' }, 403);
  return c.json(await loadTracker(c.get('db'), ctx.workspaceId));
});
