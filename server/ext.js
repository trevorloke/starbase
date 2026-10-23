// Feature modules. Each folder in server/ext/ is one feature, loaded in name
// order, and may export any of:
//
//   sql            idempotent DDL run at boot after the core schema
//   actions        { 'name.verb': { roles, input, handler, after? } } — merged into
//                  the action registry (a name clash is a boot error)
//   api            a Hono app mounted under /api (signed-in; c.get('ctx'))
//   publicRoutes   a Hono app mounted at / before /api (no sign-in)
//   jobs           { kind: async (db, job) => {} } — see lib/jobs.js
//   hooks          { events, contactLogged, brief } — see lib/hooks.js
//   deskOnlyReads  ['/surveys/results', …] — GET paths volunteers may not read
//   exportTables   ['surveys', { table: 'receipts', omit: ['token'] }, …] —
//                  the feature's tables in GET /api/export (rows of this
//                  workspace; omit drops secrets such as a link's token)
//
// Feature modules import from lib/* and actions/util.js only — never from
// actions/index.js or routes/* (that would be an import cycle).
import { readdirSync, existsSync } from 'node:fs';
import { onHook } from './lib/hooks.js';
import { registerJob } from './lib/jobs.js';

const dir = new URL('./ext/', import.meta.url);
const names = existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  : [];

export const EXTENSIONS = [];
for (const name of names) {
  const mod = await import(new URL(`./ext/${name}/index.js`, import.meta.url).href);
  EXTENSIONS.push({ name, ...mod });
  for (const [hook, fn] of Object.entries(mod.hooks || {})) onHook(hook, fn);
  for (const [kind, fn] of Object.entries(mod.jobs || {})) registerJob(kind, fn);
}

export const extActions = () => {
  const out = {};
  for (const e of EXTENSIONS) {
    for (const [k, v] of Object.entries(e.actions || {})) {
      if (out[k]) throw new Error(`action ${k} defined by two features`);
      out[k] = v;
    }
  }
  return out;
};
