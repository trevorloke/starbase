// Texting reads, mounted under /api (signed in).
//
//   GET /texting/status              any role: is Twilio connected (texts,
//                                    calls), quiet hours now, the template,
//                                    your own phone, your unread replies
//   GET /texting/mine                any role: the conversations you started
//   GET /texting/all[?person=]       desk: every conversation
//   GET /texting/conversations/:id   a thread (volunteers: their own only);
//                                    in_touch: the voter's answers go to
//                                    someone else's thread now (desk: its id)
//   GET /texting/people/:id          the Calls card: opted out? your own
//                                    conversation with them (first text yet?
//                                    its last texts), and in_touch: someone
//                                    else is texting this number (no content;
//                                    the desk also gets that thread's id)
//   GET /texting/queue               any role: the Text list's person ids —
//                                    away (leave out for now), replied (first)
//   GET /texting/people/:id/conversations   desk: a profile's conversations
//   GET /texting/calls/:id           a call you placed (desk: any)
//   GET /texting/settings            desk: settings, Twilio set-up addresses;
//                                    callers' phones for managers only
//
// A volunteer's browser only ever receives conversations they started, and
// never an email address: rows carry names and phone numbers only.
import { Hono } from 'hono';
import { NO_TEXT_TAG, NO_CONTACT_TAG, AWAIT_HOURS, e164, showPhone } from './rules.js';
import { smsReady, voiceReady, publicBase, campaignNumber } from './twilio.js';
import {
  settingsFor, quietState, isOptedOut, isFirstOut, listConversations, unreadCount, myConversationCount, tagsOf,
  inTouch, textQueue, answerElsewhere,
} from './store.js';
import { visibleConversation } from './actions.js';

export const api = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isDesk = (c) => c.get('ctx').role !== 'volunteer';
const refuse = (c) => c.json({ error: 'volunteers cannot view this' }, 403);
const notFound = (c) => c.json({ error: 'not found' }, 404);

const convRow = (r) => ({
  id: r.id,
  person_id: r.person_id,
  person_name: r.person_name || null,
  phone: showPhone(r.phone),
  started_by_name: r.started_by_name || null,
  last_at: r.last_at,
  last: r.last_body == null ? null : {
    body: String(r.last_body).slice(0, 160), direction: r.last_direction, status: r.last_status, at: r.last_message_at,
  },
  messages: r.messages,
  unread: r.unread,
  opted_out: r.opted_out,
});

api.get('/texting/status', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const settings = await settingsFor(db, ctx.workspaceId);
  const myPhone = (await db.query(
    'select phone from texting_member_phones where workspace_id = $1 and user_id = $2',
    [ctx.workspaceId, ctx.user.id],
  )).rows[0]?.phone || null;
  return c.json({
    sms: smsReady(),
    voice: voiceReady(),
    quiet: quietState(settings, ctx.workspace),
    template: settings.template,
    campaign: ctx.workspace.name,
    myPhone: myPhone ? showPhone(myPhone) : null,
    unread: await unreadCount(db, ctx.workspaceId, ctx.user.id, { desk: isDesk(c) }),
    conversations: await myConversationCount(db, ctx.workspaceId, ctx.user.id),
  });
});

api.get('/texting/mine', async (c) => {
  const ctx = c.get('ctx');
  const rows = await listConversations(c.get('db'), { workspaceId: ctx.workspaceId, viewerId: ctx.user.id, mine: true });
  return c.json({ conversations: rows.map(convRow), sms: smsReady() });
});

api.get('/texting/all', async (c) => {
  if (!isDesk(c)) return refuse(c);
  const ctx = c.get('ctx');
  const person = c.req.query('person') || null;
  if (person && !UUID_RE.test(person)) return notFound(c);
  const rows = await listConversations(c.get('db'), { workspaceId: ctx.workspaceId, viewerId: ctx.user.id, personId: person });
  return c.json({ conversations: rows.map(convRow), sms: smsReady() });
});

api.get('/texting/conversations/:id', async (c) => {
  if (!UUID_RE.test(c.req.param('id'))) return notFound(c);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const conv = await visibleConversation(db, ctx, c.req.param('id'));
  if (!conv) return notFound(c);
  const messages = (await db.query(
    `select m.id, m.direction, m.body, m.status, m.first, m.keyword, m.error, m.created_at, u.name as sent_by_name
     from texting_messages m left join users u on u.id = m.sent_by
     where m.conversation_id = $1 and m.workspace_id = $2 order by m.created_at, m.id limit 1000`,
    [conv.id, ctx.workspaceId],
  )).rows;
  const tags = tagsOf({ tags: conv.person_tags });
  const settings = await settingsFor(db, ctx.workspaceId);
  const startedBy = conv.started_by ? (await db.query('select name from users where id = $1', [conv.started_by])).rows[0]?.name : null;
  const elsewhere = await answerElsewhere(db, ctx.workspaceId, conv);
  return c.json({
    conversation: {
      id: conv.id,
      person_id: conv.person_id,
      person_name: conv.person_name || null,
      phone: showPhone(conv.phone),
      started_by_name: startedBy || null,
      mine: conv.started_by === ctx.user.id,
      opted_out: await isOptedOut(db, ctx.workspaceId, conv.phone),
      no_texts: tags.includes(NO_TEXT_TAG) || tags.includes(NO_CONTACT_TAG),
      first: await isFirstOut(db, conv.id),
      // Someone else's conversation with this number is the live one: no
      // reply here (text.reply refuses). Only the desk gets that thread.
      in_touch: !!elsewhere,
      in_touch_id: elsewhere && isDesk(c) ? elsewhere.id : null,
    },
    messages,
    sms: smsReady(),
    quiet: quietState(settings, ctx.workspace),
    campaign: ctx.workspace.name,
  });
});

api.get('/texting/people/:id', async (c) => {
  if (!UUID_RE.test(c.req.param('id'))) return notFound(c);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const person = (await db.query(
    'select id, phone, tags from persons where id = $1 and workspace_id = $2 and deleted_at is null',
    [c.req.param('id'), ctx.workspaceId],
  )).rows[0];
  if (!person) return notFound(c);
  const phone = e164(person.phone);
  const tags = tagsOf(person);
  const conv = phone ? (await db.query(
    `select id from texting_conversations
     where workspace_id = $1 and person_id = $2 and started_by = $3 and phone = $4 order by created_at limit 1`,
    [ctx.workspaceId, person.id, ctx.user.id, phone],
  )).rows[0] : null;
  // Your own conversation's last two texts (yours to read): the card shows
  // where it stands — and a reply box, not a second introduction.
  const recent = conv ? (await db.query(
    `select direction, body, status, created_at from texting_messages where conversation_id = $1
     order by created_at desc, id desc limit 2`,
    [conv.id],
  )).rows.reverse().map((m) => ({ ...m, body: String(m.body).slice(0, 400) })) : [];
  const other = phone ? await inTouch(db, ctx.workspaceId, phone, ctx.user.id) : null;
  const last = recent.at(-1);
  return c.json({
    textable: !!phone,
    opted_out: (phone ? await isOptedOut(db, ctx.workspaceId, phone) : false) || tags.includes(NO_TEXT_TAG),
    no_contact: tags.includes(NO_CONTACT_TAG),
    conversation: conv ? {
      id: conv.id,
      last: last ? { direction: last.direction, status: last.status, created_at: last.created_at } : null,
      recent,
    } : null,
    first: conv ? await isFirstOut(db, conv.id) : true,
    in_touch: !!other,
    // Only the desk may open someone else's thread.
    in_touch_id: other && isDesk(c) ? other.id : null,
  });
});

api.get('/texting/queue', async (c) => {
  const ctx = c.get('ctx');
  return c.json(await textQueue(c.get('db'), ctx.workspaceId, ctx.user.id, { awaitHours: AWAIT_HOURS }));
});

api.get('/texting/people/:id/conversations', async (c) => {
  if (!isDesk(c)) return refuse(c);
  if (!UUID_RE.test(c.req.param('id'))) return notFound(c);
  const ctx = c.get('ctx');
  const rows = await listConversations(c.get('db'), {
    workspaceId: ctx.workspaceId, viewerId: ctx.user.id, personId: c.req.param('id'),
  });
  return c.json({ conversations: rows.map(convRow) });
});

api.get('/texting/calls/:id', async (c) => {
  if (!UUID_RE.test(c.req.param('id'))) return notFound(c);
  const ctx = c.get('ctx');
  const call = (await c.get('db').query(
    `select id, person_id, user_id, status, talk_s, call_s, error, created_at, ended_at from texting_calls
     where id = $1 and workspace_id = $2`,
    [c.req.param('id'), ctx.workspaceId],
  )).rows[0];
  if (!call || (!isDesk(c) && call.user_id !== ctx.user.id)) return notFound(c);
  const { user_id: _u, ...out } = call;
  return c.json({ call: out });
});

api.get('/texting/settings', async (c) => {
  if (!isDesk(c)) return refuse(c);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const settings = await settingsFor(db, ctx.workspaceId);
  const base = publicBase() || new URL(c.req.url).origin;
  const manager = ctx.role === 'manager';
  const phones = manager ? (await db.query(
    `select u.id as user_id, u.name, p.phone, p.updated_at from texting_member_phones p
     join users u on u.id = p.user_id
     join memberships m on m.user_id = p.user_id and m.workspace_id = p.workspace_id
     where p.workspace_id = $1 order by lower(u.name)`,
    [ctx.workspaceId],
  )).rows.map((r) => ({ ...r, phone: showPhone(r.phone) })) : null;
  return c.json({
    settings,
    quiet: quietState(settings, ctx.workspace),
    campaign: ctx.workspace.name,
    canEdit: manager,
    sms: smsReady(),
    voice: voiceReady(),
    publicUrl: !!publicBase(),
    number: smsReady() ? showPhone(campaignNumber()) : null,
    webhooks: { sms: `${base}/api/public/twilio/sms` },
    memberPhones: phones,
  });
});
