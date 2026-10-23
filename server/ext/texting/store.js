// Texting reads and writes shared by the actions, the signed-in reads and
// the Twilio webhooks. Writes here take the caller's transaction and emit,
// so they always land on the event log with the action that caused them.
import { newId } from '../../lib/events.js';
import { textConfigured } from '../../lib/notify.js';
import {
  DEFAULT_TEMPLATE, DEFAULT_FROM, DEFAULT_UNTIL, DEFAULT_WEEKEND_FROM, DEFAULT_WEEKEND_UNTIL,
  NO_TEXT_TAG, NO_CONTACT_TAG, PHONE_DIGITS_SQL, last10, RECENT_DAYS, quietNow, windowWord, now, e164,
} from './rules.js';

const parseJ = (v, fb) => (typeof v === 'string' ? JSON.parse(v) : (v ?? fb));
export const tagsOf = (p) => parseJ(p?.tags, []);

export const settingsFor = async (q, workspaceId) => {
  const r = (await q.query(
    'select template, allow_from, allow_until, weekend_from, weekend_until from texting_settings where workspace_id = $1', [workspaceId],
  )).rows[0];
  return {
    template: r?.template || DEFAULT_TEMPLATE,
    allow_from: r?.allow_from ?? DEFAULT_FROM,
    allow_until: r?.allow_until ?? DEFAULT_UNTIL,
    weekend_from: r?.weekend_from ?? DEFAULT_WEEKEND_FROM,
    weekend_until: r?.weekend_until ?? DEFAULT_WEEKEND_UNTIL,
  };
};

export const tzOf = (workspace) => workspace?.settings?.tz || 'America/Vancouver';

// Today's window: { now: true|false, from, until, label: '9 am–9 pm',
// opens: '9 am' | '10 am tomorrow' (when quiet), weekend, weekdays, weekends }
export const quietState = (settings, workspace) => ({
  ...quietNow(settings, now(), tzOf(workspace)),
  weekdays: windowWord(settings.allow_from, settings.allow_until),
  weekends: windowWord(settings.weekend_from, settings.weekend_until),
});

export const isOptedOut = async (q, workspaceId, phone) => !!(await q.query(
  'select 1 from texting_optouts where workspace_id = $1 and phone = $2 and opted_out', [workspaceId, phone],
)).rows[0];

// STOP (out = true) or START (out = false) for one number in one workspace:
// the opt-out row, and the do-not-text tag on everyone with that number.
// The row remembers whom its STOP tagged (tagged), so START takes the tag off
// them only — a do-not-text the desk set by hand stays.
export const applyOptOut = async (tx, emit, workspaceId, phone, { out, keyword }) => {
  const prev = (await tx.query(
    'select id, opted_out, tagged from texting_optouts where workspace_id = $1 and phone = $2 for update', [workspaceId, phone],
  )).rows[0];
  const people = (await tx.query(
    `select id, tags from persons where workspace_id = $1 and deleted_at is null
       and ${PHONE_DIGITS_SQL('phone')} = $2`,
    [workspaceId, last10(phone)],
  )).rows;
  const before = new Set(parseJ(prev?.tagged, []));
  const tagged = new Set(out ? before : []);
  for (const p of people) {
    const tags = tagsOf(p);
    const has = tags.includes(NO_TEXT_TAG);
    if (out ? has : !has || !before.has(p.id)) continue;
    const next = out ? [...tags, NO_TEXT_TAG] : tags.filter((t) => t !== NO_TEXT_TAG);
    if (out) tagged.add(p.id);
    await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2',
      [p.id, workspaceId, JSON.stringify(next)]);
    emit('person', p.id, 'update', { tags: next, source: out ? 'text-stop' : 'text-start' });
  }
  const taggedJson = JSON.stringify([...tagged]);
  if (prev) {
    await tx.query(
      'update texting_optouts set opted_out = $3, keyword = $4, tagged = $5::jsonb, changed_at = now() where id = $1 and workspace_id = $2',
      [prev.id, workspaceId, out, keyword, taggedJson],
    );
    if (prev.opted_out !== out) emit('texting_optout', prev.id, 'update', { phone, opted_out: out, keyword });
  } else {
    const id = newId();
    await tx.query(
      'insert into texting_optouts (id, workspace_id, phone, opted_out, keyword, tagged) values ($1, $2, $3, $4, $5, $6::jsonb)',
      [id, workspaceId, phone, out, keyword, taggedJson],
    );
    emit('texting_optout', id, 'create', { phone, opted_out: out, keyword });
  }
  return { people: people.length };
};

// One campaign conversation per number: someone else's conversation with
// this number that had a text in or out in the last RECENT_DAYS (the newest
// one), or null. exceptUser: the member asking (their own doesn't count).
export const inTouch = async (q, workspaceId, phone, exceptUser) => (await q.query(
  `select id, started_by from texting_conversations
   where workspace_id = $1 and phone = $2 and started_by is distinct from $3
     and last_at > now() - interval '${RECENT_DAYS} days'
   order by last_at desc limit 1`,
  [workspaceId, phone, exceptUser || null],
)).rows[0] || null;

// Where a text from this number is filed (public.js): the conversation the
// voter last replied in (RECENT_DAYS), else the first of the conversations
// that texted them lately — never a newer duplicate — else the one that
// texted them last, else the newest. A conversation id, or null.
export const replyTarget = async (q, workspaceId, phone) => {
  const replied = (await q.query(
    `select conversation_id from texting_messages
     where workspace_id = $1 and phone = $2 and direction = 'in' and created_at > now() - interval '${RECENT_DAYS} days'
     order by created_at desc limit 1`, [workspaceId, phone],
  )).rows[0];
  if (replied) return replied.conversation_id;
  const original = (await q.query(
    `select c.id from texting_conversations c
     where c.workspace_id = $1 and c.phone = $2
       and exists (select 1 from texting_messages m where m.conversation_id = c.id and m.direction = 'out'
                     and m.created_at > now() - interval '${RECENT_DAYS} days')
     order by c.created_at limit 1`, [workspaceId, phone],
  )).rows[0];
  if (original) return original.id;
  const sent = (await q.query(
    `select conversation_id from texting_messages
     where workspace_id = $1 and phone = $2 and direction = 'out' order by created_at desc limit 1`, [workspaceId, phone],
  )).rows[0];
  if (sent) return sent.conversation_id;
  const conv = (await q.query(
    'select id from texting_conversations where workspace_id = $1 and phone = $2 order by last_at desc limit 1', [workspaceId, phone],
  )).rows[0];
  return conv?.id || null;
};

// One campaign conversation per number, for a reply in conv ({ id, phone,
// started_by }): someone else's conversation with the number is recent and
// the voter's texts are filed there, not on conv's side — so whatever they
// answer would reach someone other than who asked. That conversation
// ({ id, started_by }), or null when a reply in conv is fine. The same
// member's other conversations with the number (a shared household phone)
// never count.
export const answerElsewhere = async (q, workspaceId, conv) => {
  const other = await inTouch(q, workspaceId, conv.phone, conv.started_by);
  if (!other) return null;
  const target = await replyTarget(q, workspaceId, conv.phone);
  if (target === conv.id) return null;
  const t = target && (await q.query(
    'select id, started_by from texting_conversations where id = $1 and workspace_id = $2', [target, workspaceId],
  )).rows[0];
  if (!t) return other;
  return (t.started_by ?? null) === (conv.started_by ?? null) ? null : t;
};

// The Text list, for one member: who to leave out for now, and who replied.
//   away     someone else is texting their number (RECENT_DAYS), or you
//            texted them within awaitHours and they haven't answered yet
//   replied  they answered your text and you haven't logged a text contact
//            for them since — first in the list
// Person ids only: no message, no number, no other member.
export const textQueue = async (q, workspaceId, userId, { awaitHours }) => {
  // The recent conversations (few), then the people with those numbers (one
  // pass over the people), then your text contacts for them.
  const convs = (await q.query(
    `select c.id, right(c.phone, 10) as digits, c.started_by, l.direction, l.created_at,
            (l.created_at > now() - ($2 || ' hours')::interval) as fresh
     from texting_conversations c
     join lateral (
       select direction, created_at from texting_messages m
       where m.conversation_id = c.id order by m.created_at desc, m.id desc limit 1
     ) l on true
     where c.workspace_id = $1 and c.last_at > now() - interval '${RECENT_DAYS} days'
     order by c.last_at desc limit 5000`,
    [workspaceId, String(awaitHours)],
  )).rows;
  const away = new Set();
  const replied = new Set();
  if (!convs.length) return { away: [], replied: [] };
  const people = (await q.query(
    `select id, ${PHONE_DIGITS_SQL('phone')} as digits from persons
     where workspace_id = $1 and deleted_at is null and ${PHONE_DIGITS_SQL('phone')} = any($2::text[])`,
    [workspaceId, [...new Set(convs.map((c) => c.digits))]],
  )).rows;
  const logged = new Map((await q.query(
    `select person_id, max(created_at) as at from contacts
     where workspace_id = $1 and channel = 'text' and created_by = $2 and person_id = any($3::uuid[])
     group by person_id`,
    [workspaceId, userId, people.map((p) => p.id)],
  )).rows.map((r) => [r.person_id, new Date(r.at).getTime()]));
  const byDigits = new Map();
  for (const p of people) byDigits.set(p.digits, [...(byDigits.get(p.digits) || []), p.id]);
  for (const c of convs) {
    for (const personId of byDigits.get(c.digits) || []) {
      const loggedSince = (logged.get(personId) || 0) > new Date(c.created_at).getTime();
      if (c.started_by !== userId) away.add(personId);
      else if (c.direction === 'in' && !loggedSince) replied.add(personId);
      else if (c.direction === 'out' && c.fresh && !loggedSince) away.add(personId);
    }
  }
  for (const id of replied) away.delete(id);
  return { away: [...away], replied: [...replied] };
};

// The first person in the workspace with this number (oldest record first).
export const personByPhone = async (q, workspaceId, phone) => (await q.query(
  `select id, name, tags from persons where workspace_id = $1 and deleted_at is null
     and ${PHONE_DIGITS_SQL('phone')} = $2 order by created_at limit 1`,
  [workspaceId, last10(phone)],
)).rows[0] || null;

// A conversation is "first" until a text in it has gone out.
export const isFirstOut = async (q, conversationId) => !(await q.query(
  `select 1 from texting_messages where conversation_id = $1 and direction = 'out'
     and status in ('sent', 'delivered') limit 1`,
  [conversationId],
)).rows[0];

// Conversations, as the inbox lists them. viewer: the member reading (their
// unread state); mine: only conversations they started; personId: one
// person's conversations.
export const listConversations = async (q, { workspaceId, viewerId, mine = false, personId = null, limit = 200 }) => {
  const params = [workspaceId, viewerId, limit];
  let where = 'c.workspace_id = $1';
  if (mine) where += ' and c.started_by = $2';
  if (personId) { params.push(personId); where += ` and c.person_id = $${params.length}`; }
  const rows = (await q.query(
    `select c.id, c.person_id, p.name as person_name, c.phone, c.started_by, u.name as started_by_name,
            c.created_at, c.last_at,
            l.body as last_body, l.direction as last_direction, l.status as last_status, l.created_at as last_message_at,
            (select count(*)::int from texting_messages m where m.conversation_id = c.id) as messages,
            exists (select 1 from texting_messages m where m.conversation_id = c.id and m.direction = 'in'
                      and m.created_at > coalesce(r.read_at, '-infinity'::timestamptz)) as unread,
            exists (select 1 from texting_optouts o where o.workspace_id = c.workspace_id and o.phone = c.phone and o.opted_out) as opted_out
     from texting_conversations c
     left join persons p on p.id = c.person_id
     left join users u on u.id = c.started_by
     left join texting_reads r on r.conversation_id = c.id and r.user_id = $2
     left join lateral (
       select body, direction, status, created_at from texting_messages m
       where m.conversation_id = c.id order by m.created_at desc, m.id desc limit 1
     ) l on true
     where ${where}
     order by c.last_at desc limit $3`,
    params,
  )).rows;
  return rows.map((r) => ({ ...r, unread: !!r.unread, opted_out: !!r.opted_out }));
};

// New texts for you: replies in conversations you started — and, for the
// desk, texts from numbers nobody texted first (they wrote in).
export const unreadCount = async (q, workspaceId, userId, { desk = false } = {}) => (await q.query(
  `select count(*)::int as n from texting_conversations c
   left join texting_reads r on r.conversation_id = c.id and r.user_id = $2
   where c.workspace_id = $1 and (c.started_by = $2 or ($3 and c.started_by is null))
     and exists (select 1 from texting_messages m where m.conversation_id = c.id and m.direction = 'in'
                   and m.created_at > coalesce(r.read_at, '-infinity'::timestamptz))`,
  [workspaceId, userId, desk],
)).rows[0].n;

export const myConversationCount = async (q, workspaceId, userId) => (await q.query(
  'select count(*)::int as n from texting_conversations where workspace_id = $1 and started_by = $2',
  [workspaceId, userId],
)).rows[0].n;

// Today's "texts this week" (the brief hook). The core counts text contacts
// logged by hand; this adds every text that went out through the campaign's
// number in the same rolling 7 days (a failed send never went, so it doesn't
// count). A text contact logged by someone who also texted that person
// through the app this week is that conversation's rating, not another
// text, so it is taken back out. mine: the same, for the signed-in member.
export const briefTexts = async (db, ctx, brief) => {
  if (!brief?.field) return;
  const r = (await db.query(
    `with sent as (
       select m.sent_by, c.person_id
       from texting_messages m join texting_conversations c on c.id = m.conversation_id
       where m.workspace_id = $1 and m.direction = 'out' and m.status <> 'failed'
         and m.created_at >= now() - interval '7 days'
     ), logged as (
       select k.created_by from contacts k
       where k.workspace_id = $1 and k.channel = 'text' and k.created_at >= now() - interval '7 days'
         and exists (select 1 from sent s where s.sent_by = k.created_by and s.person_id = k.person_id)
     )
     select (select count(*) from sent)::int as sent,
            (select count(*) from sent where sent_by = $2)::int as my_sent,
            (select count(*) from logged)::int as logged,
            (select count(*) from logged where created_by = $2)::int as my_logged`,
    [ctx.workspaceId, ctx.user.id],
  )).rows[0];
  const f = brief.field;
  f.texts = Math.max(0, (Number(f.texts) || 0) + r.sent - r.logged);
  if (f.mine) f.mine.texts = Math.max(0, (Number(f.mine.texts) || 0) + r.my_sent - r.my_logged);
};

// The textOut hook: a text the core sends from the campaign's number (a
// shift notice) goes to the E.164 number, never to an opted-out or
// do-not-text one, and never in quiet hours. Without Twilio the core says
// "not sent" on its own.
export const textOutRules = async (tx, ctx, { phone, personId }, out) => {
  if (!textConfigured()) return;
  const to = e164(phone);
  if (!to) { out.status = 'failed'; out.detail = 'That number can’t be texted'; return; }
  out.to = to;
  const person = personId ? (await tx.query(
    'select tags from persons where id = $1 and workspace_id = $2', [personId, ctx.workspaceId],
  )).rows[0] : null;
  const tags = tagsOf(person);
  if (tags.includes(NO_TEXT_TAG) || tags.includes(NO_CONTACT_TAG) || await isOptedOut(tx, ctx.workspaceId, to)) {
    out.status = 'opted_out';
    out.detail = 'Opted out of texts';
    return;
  }
  const quiet = quietState(await settingsFor(tx, ctx.workspaceId), ctx.workspace);
  if (quiet.now) {
    out.status = 'quiet';
    out.detail = `Quiet hours — sending opens at ${quiet.opens}`;
  }
};
