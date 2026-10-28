// GET /api/public/:ws/site/tracker — the tracker for the public site, CORS-open.
import { Hono } from 'hono';
import { etag } from 'hono/etag';
import { getDb } from '../../db/client.js';
import { loadTracker } from './reads.js';

export const publicRoutes = new Hono();
publicRoutes.use('/api/public/:ws/site/tracker', etag());
publicRoutes.options('/api/public/:ws/site/tracker', (c) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  return c.body(null, 204);
});
publicRoutes.get('/api/public/:ws/site/tracker', async (c) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Cache-Control', 'no-cache');
  const db = await getDb();
  const ws = (await db.query('select id from workspaces where slug = $1', [c.req.param('ws')])).rows[0];
  if (!ws) return c.json({ error: 'unknown campaign' }, 404);
  const t = await loadTracker(db, ws.id);
  // The public never sees row ids.
  return c.json({
    promises: t.promises.map(({ id, updates, ...p }) => ({ ...p, updates: updates.map(({ id: _u, ...u }) => u) })),
    announcements: t.announcements.map(({ id, ...a }) => a),
    counts: t.counts, total: t.total,
  });
});
