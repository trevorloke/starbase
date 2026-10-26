// field.ping { lat, lng, accuracy? }  any role: "I'm here" from the map,
//   every minute or so while the person shares their location. Keeps their
//   latest position, and a trail point when they have moved (25 m) or a few
//   minutes have passed; the trail keeps a day. Not on the event log: a
//   position is not a campaign record, and a knock a minute is noise there.
// field.ping { off: true }             stop sharing: the position goes, the
//   day's trail stays until it ages out.
import { z } from 'zod';
import { newId } from '../../lib/events.js';

const ALL_ROLES = ['manager', 'treasurer', 'staff', 'volunteer'];
const TRAIL_MIN_M = 25;
const TRAIL_MIN_MS = 3 * 60_000;
const TRAIL_KEEP = '1 day';
const metres = (a, b) => {
  const dLat = (b.lat - a.lat) * 111_320;
  const dLng = (b.lng - a.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
};

export const actions = {
  'field.ping': {
    roles: ALL_ROLES,
    input: z.object({
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      accuracy: z.number().min(0).max(100_000).nullish(),
      off: z.boolean().optional(),
    }).refine((v) => v.off || (v.lat !== undefined && v.lng !== undefined), 'lat and lng, or off'),
    quiet: true, // no event (lib/events.js skips the log when nothing is emitted)
    handler: async (tx, ctx, input) => {
      const ws = ctx.workspaceId; const uid = ctx.user.id;
      if (input.off) {
        await tx.query('delete from field_positions where workspace_id = $1 and user_id = $2', [ws, uid]);
        return { sharing: false };
      }
      const last = (await tx.query(
        'select lat, lng, at from field_tracks where workspace_id = $1 and user_id = $2 order by at desc limit 1', [ws, uid],
      )).rows[0];
      await tx.query(
        `insert into field_positions (workspace_id, user_id, lat, lng, accuracy, at) values ($1, $2, $3, $4, $5, now())
         on conflict (workspace_id, user_id) do update set lat = $3, lng = $4, accuracy = $5, at = now()`,
        [ws, uid, input.lat, input.lng, input.accuracy ?? null],
      );
      const moved = !last || metres(last, input) >= TRAIL_MIN_M || Date.now() - new Date(last.at).getTime() >= TRAIL_MIN_MS;
      if (moved) {
        await tx.query('insert into field_tracks (id, workspace_id, user_id, lat, lng) values ($1, $2, $3, $4, $5)', [newId(), ws, uid, input.lat, input.lng]);
        await tx.query(`delete from field_tracks where workspace_id = $1 and user_id = $2 and at < now() - interval '${TRAIL_KEEP}'`, [ws, uid]);
      }
      return { sharing: true, trail: moved };
    },
  },
};
