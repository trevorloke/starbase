// Runs the whole server suite through node-postgres against a real Postgres
// wire-protocol server (PGlite's socket server), proving the DATABASE_URL
// adapter end to end without a system Postgres install.
//   npm run test:pg
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = 55432 + Math.floor(Math.random() * 1000);
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();

const files = readdirSync('server/test').filter((f) => f.endsWith('.test.js')).map((f) => `server/test/${f}`);
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, PG_POOL_MAX: '1' },
});
const code = await new Promise((r) => child.on('exit', r));
await server.stop();
await db.close();
process.exit(code ?? 1);
