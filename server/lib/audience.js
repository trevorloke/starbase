// Who a People query names — the one WHERE clause behind GET /persons, a
// saved list (ext/lists) and a send's audience (an email or text blast).
//   personsWhere(db, ctx, query) → { where, params }  (alias p)
//     query: { q, tag, rating, role, has, …a feature's own (?field=) }
// A volunteer's search, tag and has=email never match on what they may not
// see (viewer.js); the desk's does. Features add their own filters by the
// personsWhere hook, on the same params.
import { SOCIAL_PLATFORMS } from '@starbase/shared/canvass';
import { runHooks } from './hooks.js';
import { isMoneyTag, loginEmail } from './viewer.js';

const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);

export const personsWhere = async (db, ctx, query = {}) => {
  const vol = ctx.role === 'volunteer';
  const q = str(query.q);
  const tag = str(query.tag, 80);
  const rating = str(query.rating, 400);
  const role = str(query.role, 80);
  const has = str(query.has, 40);
  const like = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
  // $1 workspace · $2 q · $3 like · $4 the caller's own (limit) · $5 their email
  const params = [ctx.workspaceId, q, like, null, vol ? loginEmail(ctx) : ''];
  const ownEmail = `($5::text <> '' and lower(p.email) = $5::text)`;
  params.push(`%${q.replace(/^@|^\/?u\//i, '').replace(/[%_\\]/g, (m) => '\\' + m)}%`);
  const handleLike = `$${params.length}`;
  // $5 is typed here even when nothing else reads it (a desk query), or
  // the database can't tell what it is.
  let where = `p.workspace_id = $1 and p.deleted_at is null and $4::int is not null and $5::text is not null
       and ($2 = '' or p.name ilike $3 or p.address ilike $3 or p.phone ilike $3
            or (p.email ilike $3${vol ? ` and ${ownEmail}` : ''})
            or exists (select 1 from jsonb_each_text(p.socials) s
                       where regexp_replace(s.value, '^@|^/?u/', '', 'i') ilike ${handleLike}))`;
  if (tag && vol && isMoneyTag(tag)) where += ' and false';
  else if (tag) {
    // One tag, or several with commas: any of them.
    const tags = [...new Set(tag.split(',').map((t) => t.trim()).filter(Boolean))].slice(0, 20);
    const ors = tags.map((t) => { params.push(JSON.stringify(t)); return `p.tags @> $${params.length}::jsonb`; });
    where += ` and (${ors.join(' or ')})`;
  }
  // rating: one code (4B), a comma list for a band (1,2 · 4,4D,4B,4F,4N,4C),
  // and/or "unrated" (no rating yet). A band reaches every code on the
  // campaign's scale, those off the list too (ext/scale: up to 64).
  if (rating) {
    const codes = [...new Set(rating.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 80);
    const ors = [];
    for (const code of codes) {
      if (code === 'unrated') { ors.push('p.rating is null'); continue; }
      params.push(code);
      ors.push(`p.rating = $${params.length}`);
    }
    where += ors.length ? ` and (${ors.join(' or ')})` : ' and false';
  }
  if (role) {
    params.push(role);
    where += ` and exists (select 1 from volunteer_roles v where v.person_id = p.id and v.role = $${params.length})`;
  }
  if (has === 'phone') where += ' and p.phone is not null';
  if (has === 'email') where += vol ? ` and ${ownEmail}` : ' and p.email is not null';
  if (has === 'location') where += ' and p.lat is not null and p.lng is not null';
  if (SOCIAL_PLATFORMS.includes(has)) {
    params.push(has);
    where += ` and coalesce(trim(p.socials ->> $${params.length}), '') <> ''`;
  }
  // Features' own filters (?field= — ext/fields), on the same params.
  const more = { params, where: '' };
  await runHooks('personsWhere', db, ctx, query, more);
  where += more.where;
  return { where, params };
};

// The filter a saved list or a send keeps: only the keys the query knows.
export const FILTER_KEYS = ['q', 'tag', 'rating', 'role', 'has', 'field'];
export const cleanFilter = (f) => {
  const out = {};
  for (const k of FILTER_KEYS) if (f && typeof f[k] === 'string' && f[k].trim()) out[k] = f[k].trim().slice(0, 400);
  return out;
};
