// Database client — one tiny interface over two backends:
//   db.query(sql, params) → { rows, affectedRows }
//   db.exec(sql)          → run a multi-statement script (DDL)
//   db.transaction(async (tx) => ...) → tx.query; commits, or rolls back on throw
//
// DATABASE_URL set → node-postgres pool (hosted Postgres: Render, Fly, Neon …).
// Otherwise PGlite (embedded, real Postgres): file-backed at STARBASE_DATA
// (default ./data/starbase), or in-memory under the test runner / =memory.
// Type parsing is pinned so both backends return identical shapes:
// date → Date at UTC midnight, int8 → number, json → object.
import { bootstrap } from './schema.js';

let dbPromise = null;

const createPg = async (url) => {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(1082, (v) => new Date(`${v}T00:00:00Z`)); // date
  pg.types.setTypeParser(20, (v) => Number(v));                     // int8
  const ssl = /sslmode=(require|verify)/.test(url) || process.env.PGSSL === '1'
    ? { rejectUnauthorized: process.env.PGSSL_STRICT === '1' }
    : undefined;
  const pool = new pg.Pool({ connectionString: url, ssl, max: Number(process.env.PG_POOL_MAX) || 10 });
  const wrap = (client) => ({
    query: async (sql, params = []) => {
      const r = await client.query(sql, params);
      return { rows: r.rows, affectedRows: r.rowCount ?? 0 };
    },
  });
  return {
    kind: 'postgres',
    ...wrap(pool),
    exec: async (sql) => { await pool.query(sql); },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn(wrap(client));
        await client.query('commit');
        return out;
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
};

const createPglite = async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  // Real runs persist by default (./data/starbase) so a restart never wipes a
  // campaign; the test runner and STARBASE_DATA=memory use an in-memory DB.
  const testing = !!process.env.NODE_TEST_CONTEXT;
  const dataDir = process.env.STARBASE_DATA || (testing ? 'memory' : './data/starbase');
  if (dataDir !== 'memory') {
    // PGlite won't create parent folders; a first run must not crash.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dataDir, { recursive: true });
  }
  const db = dataDir === 'memory' ? new PGlite() : new PGlite(dataDir);
  return {
    kind: 'pglite',
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
};

const create = async () => {
  const db = process.env.DATABASE_URL ? await createPg(process.env.DATABASE_URL) : await createPglite();
  await bootstrap(db);
  return db;
};

export const getDb = () => {
  if (!dbPromise) dbPromise = create();
  return dbPromise;
};

// Tests only: swap in a fresh database.
export const _resetDbForTest = () => { dbPromise = null; };
