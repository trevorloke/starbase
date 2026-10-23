// Texting and calling actions. Each is one person's tap — one text to one
// person, one call — never a list: there is no bulk or scheduled send.
//
//   text.send         Send on the Calls card: one text to one person, in the
//                     sender's own conversation with them
//   text.reply        Send in the inbox: a reply in a conversation (volunteers:
//                     only conversations they started)
//   text.read         opening a conversation marks its replies read (for you)
//   text.optout       "Opt out this number" in a thread (any role who can
//                     see it): the same opt-out as a STOP reply
//   call.start        "Call through the campaign": ring the caller's own phone,
//                     then connect them to the person from the campaign number
//   texting.settings  managers: the first-text template and the hours texts go
//
// One campaign conversation per number: while someone else's conversation
// with a number is recent, text.send refuses ("Already texting with the
// campaign") — the desk answers in that thread instead — and so does
// text.reply in an older thread whose answer would be filed in that one.
//
// Every send checks, on the server: Twilio connected, the number not opted
// out (STOP) and the person not tagged do-not-text / do-not-contact, inside
// the allowed hours (campaign time), and a sane pace. The first text in a
// conversation must name the campaign and gets "Reply STOP to opt out".
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import {
  e164, NO_TEXT_TAG, NO_CONTACT_TAG, MAX_BODY, PER_MINUTE,
  namesCampaign, withFooter, hasBlanks,
} from './rules.js';
import { smsReady, voiceReady, publicBase, sendSms, ringCaller } from './twilio.js';
import {
  settingsFor, quietState, isOptedOut, applyOptOut, isFirstOut, tagsOf, inTouch, answerElsewhere,
} from './store.js';

const ALL_ROLES = ['manager', 'treasurer', 'staff', 'volunteer'];
// The desk can open the other thread; a volunteer can't.
export const ALREADY_TEXTING = (ctx) => (ctx.role === 'volunteer'
  ? 'Already texting with the campaign' : 'Already texting with the campaign — answer in that thread');
const MANAGER_ONLY = ['manager'];
const CALL_TOKEN_MINUTES = 2;
// What the Calls card fills into the first text (web/src/components/TextingWords.js).
const FILL_CODES = /\{\{\s*(first_name|my_name|campaign)\s*\}\}/gi;

export const firstWord = (name) => String(name || '').trim().split(/\s+/)[0] || 'They';
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');

const requirePerson = async (tx, workspaceId, id) => {
  const p = (await tx.query(
    'select id, name, phone, tags from persons where id = $1 and workspace_id = $2 and deleted_at is null',
    [id, workspaceId],
  )).rows[0];
  if (!p) throw httpError(404, 'person not found');
  return p;
};

// A conversation the caller may see: their own, or any for the desk.
export const visibleConversation = async (q, ctx, id) => {
  const conv = (await q.query(
    `select c.id, c.person_id, c.phone, c.started_by, p.name as person_name, p.tags as person_tags
     from texting_conversations c left join persons p on p.id = c.person_id and p.deleted_at is null
     where c.id = $1 and c.workspace_id = $2`,
    [id, ctx.workspaceId],
  )).rows[0];
  if (!conv) return null;
  if (ctx.role === 'volunteer' && conv.started_by !== ctx.user.id) return null;
  return conv;
};

const checkTextable = async (tx, ctx, { phone, person }) => {
  if (!smsReady()) throw httpError(409, 'Texting isn’t connected');
  if (person) {
    const tags = tagsOf(person);
    if (tags.includes(NO_CONTACT_TAG)) throw httpError(409, `${firstWord(person.name)} is marked do not contact`);
    if (tags.includes(NO_TEXT_TAG)) throw httpError(409, `${firstWord(person.name)} opted out of texts`);
  }
  if (await isOptedOut(tx, ctx.workspaceId, phone)) throw httpError(409, 'Opted out of texts — they replied STOP');
  const quiet = quietState(await settingsFor(tx, ctx.workspaceId), ctx.workspace);
  if (quiet.now) throw httpError(409, `Quiet hours — sending opens at ${quiet.opens}`);
  const recent = (await tx.query(
    `select count(*)::int as n from texting_messages
     where workspace_id = $1 and sent_by = $2 and direction = 'out' and created_at > now() - interval '1 minute'`,
    [ctx.workspaceId, ctx.user.id],
  )).rows[0].n;
  if (recent >= PER_MINUTE) throw httpError(429, 'One text at a time — wait a minute');
};

// Send one text in a conversation and record exactly what Twilio said.
const sendIn = async (tx, ctx, emit, conv, rawBody) => {
  let body = String(rawBody || '').trim();
  if (!body) throw httpError(400, 'Write a message first');
  if (hasBlanks(body)) throw httpError(400, 'Fill in the {{…}} parts first');
  const first = await isFirstOut(tx, conv.id);
  if (first) {
    if (!namesCampaign(body, ctx.workspace.name)) throw httpError(400, `Say it's ${ctx.workspace.name} in the first text`);
    body = withFooter(body);
  }
  const id = newId();
  const base = publicBase();
  const r = await sendSms({
    to: conv.phone, body, statusCallback: base ? `${base}/api/public/twilio/sms-status/${id}` : undefined,
  });
  const status = r.ok ? 'sent' : 'failed';
  const error = r.ok ? null : r.detail;
  const row = (await tx.query(
    `insert into texting_messages (id, workspace_id, conversation_id, direction, phone, body, status, first, provider_sid, error, sent_by)
     values ($1, $2, $3, 'out', $4, $5, $6, $7, $8, $9, $10) returning created_at`,
    [id, ctx.workspaceId, conv.id, conv.phone, body, status, first, r.sid || null, error, ctx.user.id],
  )).rows[0];
  await tx.query('update texting_conversations set last_at = now() where id = $1 and workspace_id = $2', [conv.id, ctx.workspaceId]);
  emit('texting_message', id, 'create', { conversation_id: conv.id, direction: 'out', status, first, body, error });
  // Twilio 21610: the carrier has this number opted out — record it here too.
  if (!r.ok && r.code === 21610) await applyOptOut(tx, emit, ctx.workspaceId, conv.phone, { out: true, keyword: 'carrier' });
  return { id, direction: 'out', status, first, body, error, created_at: row.created_at, sent_by_name: ctx.user.name };
};

const markRead = async (tx, ctx, emit, convId) => {
  const unread = (await tx.query(
    `select 1 from texting_messages m
     left join texting_reads r on r.conversation_id = m.conversation_id and r.user_id = $2
     where m.conversation_id = $1 and m.direction = 'in' and m.created_at > coalesce(r.read_at, '-infinity'::timestamptz)
     limit 1`,
    [convId, ctx.user.id],
  )).rows[0];
  if (!unread) return false;
  await tx.query(
    `insert into texting_reads (conversation_id, user_id, read_at) values ($1, $2, now())
     on conflict (conversation_id, user_id) do update set read_at = now()`,
    [convId, ctx.user.id],
  );
  emit('texting_conversation', convId, 'update', { read_by: ctx.user.id });
  return true;
};

export const actions = {
  'text.send': {
    roles: ALL_ROLES,
    input: z.object({ person_id: z.uuid(), body: z.string().max(MAX_BODY) }),
    handler: async (tx, ctx, input, emit) => {
      const person = await requirePerson(tx, ctx.workspaceId, input.person_id);
      const phone = e164(person.phone);
      if (!phone) throw httpError(400, `No number to text for ${firstWord(person.name)}`);
      await checkTextable(tx, ctx, { phone, person });
      if (await inTouch(tx, ctx.workspaceId, phone, ctx.user.id)) throw httpError(409, ALREADY_TEXTING(ctx));
      let conv = (await tx.query(
        `select id, phone from texting_conversations
         where workspace_id = $1 and person_id = $2 and started_by = $3 and phone = $4 order by created_at limit 1`,
        [ctx.workspaceId, person.id, ctx.user.id, phone],
      )).rows[0];
      if (!conv) {
        conv = { id: newId(), phone };
        await tx.query(
          `insert into texting_conversations (id, workspace_id, person_id, phone, started_by) values ($1, $2, $3, $4, $5)`,
          [conv.id, ctx.workspaceId, person.id, phone, ctx.user.id],
        );
        emit('texting_conversation', conv.id, 'create', { person_id: person.id, phone, started_by: ctx.user.id });
      }
      const message = await sendIn(tx, ctx, emit, conv, input.body);
      return { conversation_id: conv.id, message, sent: message.status === 'sent' };
    },
  },

  'text.reply': {
    roles: ALL_ROLES,
    input: z.object({ conversation_id: z.uuid(), body: z.string().max(MAX_BODY) }),
    handler: async (tx, ctx, input, emit) => {
      const conv = await visibleConversation(tx, ctx, input.conversation_id);
      if (!conv) throw httpError(404, 'conversation not found');
      const person = conv.person_id ? { name: conv.person_name, tags: conv.person_tags } : null;
      await checkTextable(tx, ctx, { phone: conv.phone, person });
      // Their answer would be filed in someone else's conversation: refused,
      // so what they say reaches whoever asked (the desk answers there).
      if (await answerElsewhere(tx, ctx.workspaceId, conv)) throw httpError(409, ALREADY_TEXTING(ctx));
      const message = await sendIn(tx, ctx, emit, conv, input.body);
      await markRead(tx, ctx, emit, conv.id);
      return { conversation_id: conv.id, message, sent: message.status === 'sent' };
    },
  },

  'text.read': {
    roles: ALL_ROLES,
    input: z.object({ conversation_id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const conv = await visibleConversation(tx, ctx, input.conversation_id);
      if (!conv) throw httpError(404, 'conversation not found');
      return { conversation_id: conv.id, read: await markRead(tx, ctx, emit, conv.id) };
    },
  },

  'text.optout': {
    roles: ALL_ROLES,
    input: z.object({ conversation_id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const conv = await visibleConversation(tx, ctx, input.conversation_id);
      if (!conv) throw httpError(404, 'conversation not found');
      const already = await isOptedOut(tx, ctx.workspaceId, conv.phone);
      if (!already) await applyOptOut(tx, emit, ctx.workspaceId, conv.phone, { out: true, keyword: 'ASKED TO STOP' });
      return { conversation_id: conv.id, opted_out: true, already };
    },
  },

  'call.start': {
    roles: ALL_ROLES,
    input: z.object({ person_id: z.uuid(), my_phone: z.string().max(40).nullish() }),
    handler: async (tx, ctx, input, emit) => {
      if (!voiceReady()) throw httpError(409, 'Calling through the campaign isn’t connected');
      const person = await requirePerson(tx, ctx.workspaceId, input.person_id);
      const to = e164(person.phone);
      if (!to) throw httpError(400, `No number to call for ${firstWord(person.name)}`);
      if (tagsOf(person).includes(NO_CONTACT_TAG)) throw httpError(409, `${firstWord(person.name)} is marked do not contact`);
      const quiet = quietState(await settingsFor(tx, ctx.workspaceId), ctx.workspace);
      if (quiet.now) throw httpError(409, `Quiet hours — calls open at ${quiet.opens}`);

      let mine;
      if (input.my_phone) {
        mine = e164(input.my_phone);
        if (!mine) throw httpError(400, 'That phone number doesn’t look right');
        if (mine === to) throw httpError(400, 'That’s their number — add yours');
        await tx.query(
          `insert into texting_member_phones (workspace_id, user_id, phone) values ($1, $2, $3)
           on conflict (workspace_id, user_id) do update set phone = excluded.phone, updated_at = now()`,
          [ctx.workspaceId, ctx.user.id, mine],
        );
        // Who changed it, never the number: the log is readable by more
        // people than may see a caller's own phone.
        emit('texting_member_phone', ctx.user.id, 'update', { user_id: ctx.user.id, changed: true });
      } else {
        mine = (await tx.query(
          'select phone from texting_member_phones where workspace_id = $1 and user_id = $2',
          [ctx.workspaceId, ctx.user.id],
        )).rows[0]?.phone;
        if (!mine) throw httpError(400, 'Add your phone number first');
      }
      if (mine === to) throw httpError(400, 'That’s their number — add yours');
      const busy = (await tx.query(
        `select 1 from texting_calls where workspace_id = $1 and user_id = $2
           and status in ('calling_you', 'connecting') and created_at > now() - interval '3 minutes' limit 1`,
        [ctx.workspaceId, ctx.user.id],
      )).rows[0];
      if (busy) throw httpError(409, 'You’re already on a call');

      const token = randomBytes(24).toString('hex');
      const id = newId();
      await tx.query(
        `insert into texting_calls (id, workspace_id, person_id, user_id, to_phone, caller_phone, token_hash, token_expires_at, status)
         values ($1, $2, $3, $4, $5, $6, $7, now() + interval '${CALL_TOKEN_MINUTES} minutes', 'calling_you')`,
        [id, ctx.workspaceId, person.id, ctx.user.id, to, mine, hashToken(token)],
      );
      const base = publicBase();
      const r = await ringCaller({
        to: mine,
        url: `${base}/api/public/twilio/voice/${token}`,
        statusCallback: `${base}/api/public/twilio/voice-status/${id}`,
      });
      const status = r.ok ? 'calling_you' : 'failed';
      await tx.query(
        `update texting_calls set provider_sid = $3, status = $4, error = $5,
           ended_at = case when $4 = 'failed' then now() else null end
         where id = $1 and workspace_id = $2`,
        [id, ctx.workspaceId, r.sid || null, status, r.ok ? null : r.detail],
      );
      // The token never enters the log — only that a call was placed, to whom.
      emit('texting_call', id, 'create', { person_id: person.id, status, error: r.ok ? null : r.detail });
      return { call: { id, status, error: r.ok ? null : r.detail } };
    },
  },

  'texting.settings': {
    roles: MANAGER_ONLY,
    input: z.object({
      template: z.string().trim().min(1).max(600).nullish(),
      allow_from: z.number().int().min(0).max(23).nullish(),
      allow_until: z.number().int().min(1).max(24).nullish(),
      weekend_from: z.number().int().min(0).max(23).nullish(),
      weekend_until: z.number().int().min(1).max(24).nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await settingsFor(tx, ctx.workspaceId);
      const next = {
        template: input.template ?? cur.template,
        allow_from: input.allow_from ?? cur.allow_from,
        allow_until: input.allow_until ?? cur.allow_until,
        weekend_from: input.weekend_from ?? cur.weekend_from,
        weekend_until: input.weekend_until ?? cur.weekend_until,
      };
      if (next.allow_from >= next.allow_until || next.weekend_from >= next.weekend_until) {
        throw httpError(400, 'The first hour must come before the last');
      }
      if (!next.template.includes('{{campaign}}') && !namesCampaign(next.template, ctx.workspace.name)) {
        throw httpError(400, `Name the campaign — use + Campaign or write “${ctx.workspace.name}”`);
      }
      // A code the card can't fill in would make every first text refused.
      const rest = next.template.replace(FILL_CODES, '');
      const stray = rest.match(/\{+[^{}\n]{0,40}\}*/) || rest.match(/[^\s{}]{0,40}\}+/);
      if (stray) throw httpError(400, `${stray[0].trim()} won’t fill in — use + First name, + Your name or + Campaign`);
      await tx.query(
        `insert into texting_settings (workspace_id, template, allow_from, allow_until, weekend_from, weekend_until)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (workspace_id) do update set template = excluded.template, allow_from = excluded.allow_from,
           allow_until = excluded.allow_until, weekend_from = excluded.weekend_from,
           weekend_until = excluded.weekend_until, updated_at = now()`,
        [ctx.workspaceId, next.template, next.allow_from, next.allow_until, next.weekend_from, next.weekend_until],
      );
      emit('texting_settings', ctx.workspaceId, 'update', next);
      return { settings: next };
    },
  },
};
