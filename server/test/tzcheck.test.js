// The time-zone guard: B.C. stays on UTC-7 from March 2026, and an older
// Node's rules would put every time after Nov 1, 2026 an hour off. Managers
// see the warning on Today; others don't; /api/health reports it.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { staleTimeZoneData } from '../lib/tzcheck.js';

let mgr;
before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal' });
});

const runtimeSaysUtc7 = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', hour: 'numeric', hourCycle: 'h23' })
  .format(new Date('2026-11-15T20:00:00Z')) === '13';

test('the guard agrees with this runtime, and says what to do when the rules are old', () => {
  const w = staleTimeZoneData();
  assert.equal(w === null, runtimeSaysUtc7());
  if (w) assert.match(w, /newer Node 22/);
});

test('health and the manager\'s Today carry it; a volunteer never sees it', async () => {
  const health = (await mgr.get('/api/health')).json;
  assert.equal(health.tzdataCurrent, runtimeSaysUtc7());
  const brief = (await mgr.get('/api/brief')).json;
  if (runtimeSaysUtc7()) assert.equal(brief.serverWarnings, undefined);
  else assert.equal(brief.serverWarnings.length, 1);
  const inv = await mgr.action('member.invite', { email: 'v-tz@example.org', role: 'volunteer' });
  const vol = new Client();
  await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'V', password: 'v-tz-pass-1' });
  assert.equal((await vol.get('/api/brief')).json.serverWarnings, undefined);
});
