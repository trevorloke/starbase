// Rating scale — the campaign's own words for the doorstep scale.
//
// The four steps (1 · 2 · 3 · 4: support · support · undecided · opposed)
// are fixed; a manager changes their words and the "Voting for?" list under
// 4 (add, rename, reorder, take off, put back). Codes never change meaning
// (shared/scale.js). The scale lives in workspace settings.scale.
//
//   GET  /api/scale    every signed-in role (volunteers' phones keep a copy
//                      for the field): { scale } — steps and every candidate
//                      ever, in list order, the ones off the list marked off.
//   scale.save         managers only. The scale is campaign-wide: it changes
//                      what every volunteer's buttons say and how support is
//                      counted on Today, the People filters and the map. Like
//                      the team and the texting settings, that's the
//                      manager's call — staff run the field day to day and
//                      a treasurer has nothing in it, so neither can change it.
//
// contact.log, the import and the sample check ratings with rules.js.
import { z } from 'zod';
import { Hono } from 'hono';
import { CANDIDATE_CODE_RE, LIMITS, normalizeScale } from '@starbase/shared/scale';
import { applyEdit, loadScale, settingsOf } from './rules.js';

const MANAGER_ONLY = ['manager'];
// Lengths are checked in rules.js with words a manager can act on.
const word = z.string().max(200);

export const actions = {
  'scale.save': {
    roles: MANAGER_ONLY,
    input: z.object({
      words: z.object({ 1: word, 2: word, 3: word, 4: word }).partial().nullish(),
      candidates: z.array(z.object({
        code: z.string().regex(CANDIDATE_CODE_RE).nullish(),
        name: z.string().max(200),
        off: z.boolean().nullish(),
      })).max(LIMITS.total).nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const row = (await tx.query('select settings from workspaces where id = $1', [ctx.workspaceId])).rows[0];
      const settings = settingsOf(row);
      const { stored, changes } = applyEdit(normalizeScale(settings.scale), {
        words: input.words || undefined,
        candidates: input.candidates?.map((c) => ({ code: c.code || null, name: c.name, off: c.off ?? undefined })),
      });
      settings.scale = stored;
      await tx.query('update workspaces set settings = $2 where id = $1', [ctx.workspaceId, JSON.stringify(settings)]);
      emit('scale', ctx.workspaceId, 'update', { ...stored, changes });
      return { scale: normalizeScale(stored), changes };
    },
  },
};

export const api = new Hono();
api.get('/scale', async (c) => c.json({ scale: await loadScale(c.get('db'), c.get('ctx').workspaceId) }));
