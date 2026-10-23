// Runs the whole server suite through node-postgres against a real Postgres
// wire-protocol server (PGlite's socket server), proving the DATABASE_URL
// adapter end to end without a system Postgres install.
//   npm run test:pg
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

// Each test file gets its own fresh database, as it does under the in-memory
// runner (helpers.freshDb) — files may assume they start from nothing (the
// first-run setup) or that their campaign is the only one (the website).
const files = readdirSync('server/test').filter((f) => f.endsWith('.test.js')).sort().map((f) => `server/test/${f}`);
let failed = 0;
for (const file of files) {
  const port = 55432 + Math.floor(Math.random() * 1000);
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  const child = spawn(process.execPath, ['--test', file], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, PG_POOL_MAX: '1' },
  });
  const code = await new Promise((r) => child.on('exit', r));
  await server.stop();
  await db.close();
  if (code !== 0) { failed += 1; console.error(`✗ ${file} failed over Postgres`); }
}
console.log(failed ? `\n${failed} of ${files.length} test files failed over Postgres` : `\nAll ${files.length} test files passed over Postgres`);
process.exit(failed ? 1 : 0);
