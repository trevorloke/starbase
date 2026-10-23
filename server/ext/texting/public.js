// Twilio's webhooks (no sign-in; every request must be signed by Twilio).
//
//   POST /api/public/twilio/sms                      a text to the campaign number
//   POST /api/public/twilio/sms-status/:messageId    delivery report for one we sent
//   POST /api/public/twilio/voice/:token             the caller answered: "press 1"
//   POST /api/public/twilio/voice/:token/connect     they pressed it: dial the person
//   POST /api/public/twilio/voice-dial/:callId       how the person's leg ended
//   POST /api/public/twilio/voice-status/:callId     how the whole call ended
//
// Every write runs through runAction as the system (actor null), so the
// hash-chained event log covers it like any desk action:
//   twilio.sms_in  twilio.sms_status  twilio.voice_connect  twilio.call_dial  twilio.call_status
//
// A reply goes to the campaign that last texted that number, and there to the
// conversation the voter last replied in (within RECENT_DAYS), else the first
// of the conversations that texted them lately — never a newer duplicate —
// else the one that texted them last. A reply that is only STOP (STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT …) opts the number
// out at once in every campaign that texted it — tagged do-not-text, never
// texted again from the app — and START / UNSTOP opts it back in. Nothing is
// ever sent back automatically; Twilio itself confirms opt-outs. A reply with a
// stop or unsubscribe word in it that isn't only a keyword ("No thanks, stop")
// is flagged (keyword asks_stop) for a person to opt out with one tap.
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { runAction, newId } from '../../lib/events.js';
import { e164, keywordOf, asksToStop, ASKS_STOP_KEYWORD } from './rules.js';
import { verifyTwilio, twiml, xmlEsc, publicBase, campaignNumber } from './twilio.js';
import { applyOptOut, personByPhone, replyTarget } from './store.js';
import { hashToken } from './actions.js';

export const publicRoutes = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Read and verify the form Twilio posted; null (→ 403) when unsigned.
const signedForm = async (c) => {
  const params = new URLSearchParams(await c.req.text());
  return verifyTwilio(c, params) ? params : null;
};
const bad = (c) => c.json({ error: 'bad signature' }, 403);

// Which campaign a reply belongs to: the one that last texted that number,
// else the last conversation with it, else the only campaign on this server
// (or TWILIO_WORKSPACE, a slug, when several share one number). Then which
// conversation in it: replyTarget (store.js), as the top of this file says.
const routeInbound = async (db, phone) => {
  const sent = (await db.query(
    `select workspace_id from texting_messages
     where phone = $1 and direction = 'out' order by created_at desc limit 1`, [phone],
  )).rows[0];
  const conv = sent ? null : (await db.query(
    'select workspace_id from texting_conversations where phone = $1 order by last_at desc limit 1', [phone],
  )).rows[0];
  const known = sent?.workspace_id || conv?.workspace_id;
  if (known) return { workspaceId: known, conversationId: await replyTarget(db, known, phone) };
  const slug = String(process.env.TWILIO_WORKSPACE || '').trim();
  const ws = slug
    ? (await db.query('select id from workspaces where slug = $1', [slug])).rows
    : (await db.query('select id from workspaces limit 2')).rows;
  return ws.length === 1 ? { workspaceId: ws[0].id, conversationId: null } : null;
};

publicRoutes.post('/api/public/twilio/sms', async (c) => {
  const params = await signedForm(c);
  if (!params) return bad(c);
  const from = e164(params.get('From'));
  const body = String(params.get('Body') || '').slice(0, 4000);
  const sid = params.get('MessageSid') || params.get('SmsSid') || null;
  if (!from) return twiml(c);
  const db = await getDb();
  const route = await routeInbound(db, from);
  if (!route) return twiml(c); // no campaign has this number: nothing to file it under
  const keyword = keywordOf(body);
  const flag = keyword || (asksToStop(body) ? ASKS_STOP_KEYWORD : null);

  await runAction(db, { workspaceId: route.workspaceId, actorId: null, action: 'twilio.sms_in' }, async (tx, emit) => {
    if (sid && (await tx.query(
      'select 1 from texting_messages where workspace_id = $1 and provider_sid = $2', [route.workspaceId, sid],
    )).rows[0]) return { duplicate: true }; // Twilio retried a delivery we already have
    let convId = route.conversationId;
    if (!convId) {
      // They texted first: a conversation nobody started (the desk sees it).
      const existing = (await tx.query(
        `select id from texting_conversations where workspace_id = $1 and phone = $2 and started_by is null
         order by created_at limit 1`, [route.workspaceId, from],
      )).rows[0];
      if (existing) convId = existing.id;
      else {
        convId = newId();
        const person = await personByPhone(tx, route.workspaceId, from);
        await tx.query(
          'insert into texting_conversations (id, workspace_id, person_id, phone, started_by) values ($1, $2, $3, $4, null)',
          [convId, route.workspaceId, person?.id || null, from],
        );
        emit('texting_conversation', convId, 'create', { person_id: person?.id || null, phone: from, started_by: null });
      }
    }
    const id = newId();
    await tx.query(
      `insert into texting_messages (id, workspace_id, conversation_id, direction, phone, body, status, keyword, provider_sid)
       values ($1, $2, $3, 'in', $4, $5, 'received', $6, $7)`,
      [id, route.workspaceId, convId, from, body, flag, sid],
    );
    await tx.query('update texting_conversations set last_at = now() where id = $1', [convId]);
    emit('texting_message', id, 'create', { conversation_id: convId, direction: 'in', status: 'received', body, keyword: flag });
    if (keyword) await applyOptOut(tx, emit, route.workspaceId, from, { out: keyword === 'stop', keyword: body.trim().toUpperCase().slice(0, 40) });
    return { id };
  });

  // The same number in any other campaign on this server opts out (or back in) too.
  if (keyword) {
    const others = (await db.query(
      'select distinct workspace_id from texting_conversations where phone = $1 and workspace_id <> $2',
      [from, route.workspaceId],
    )).rows;
    for (const o of others) {
      await runAction(db, { workspaceId: o.workspace_id, actorId: null, action: 'twilio.sms_in' }, (tx, emit) =>
        applyOptOut(tx, emit, o.workspace_id, from, { out: keyword === 'stop', keyword: body.trim().toUpperCase().slice(0, 40) }));
    }
  }
  return twiml(c);
});

// Delivery reports: sent → delivered, or undelivered/failed with the code.
const DELIVERY = { delivered: 'delivered', undelivered: 'undelivered', failed: 'undelivered' };
publicRoutes.post('/api/public/twilio/sms-status/:id', async (c) => {
  const params = await signedForm(c);
  if (!params) return bad(c);
  const id = c.req.param('id');
  const next = DELIVERY[String(params.get('MessageStatus') || '').toLowerCase()];
  if (!UUID_RE.test(id) || !next) return c.body(null, 204);
  const db = await getDb();
  const msg = (await db.query(
    `select id, workspace_id, provider_sid, status from texting_messages where id = $1 and direction = 'out'`, [id],
  )).rows[0];
  if (!msg || (msg.provider_sid && params.get('MessageSid') && msg.provider_sid !== params.get('MessageSid'))) return c.body(null, 204);
  if (msg.status === next || msg.status === 'delivered' || msg.status === 'failed') return c.body(null, 204);
  await runAction(db, { workspaceId: msg.workspace_id, actorId: null, action: 'twilio.sms_status' }, async (tx, emit) => {
    const error = next === 'undelivered' ? `Not delivered${params.get('ErrorCode') ? ` (Twilio ${params.get('ErrorCode')})` : ''}` : null;
    await tx.query('update texting_messages set status = $2, error = coalesce($3, error) where id = $1', [msg.id, next, error]);
    emit('texting_message', msg.id, 'update', { status: next, error });
  });
  return c.body(null, 204);
});

// ── Calls through the campaign ──
const callByToken = async (db, token) => (await db.query(
  `select id, workspace_id, to_phone, provider_sid, status, token_used_at, (token_expires_at > now()) as live
   from texting_calls where token_hash = $1`, [hashToken(token)],
)).rows[0] || null;
const ended = (c) => twiml(c, '<Say>This call has ended. Goodbye.</Say><Hangup/>');
const sameCall = (call, params) => !call.provider_sid || !params.get('CallSid') || call.provider_sid === params.get('CallSid');

const pressOne = (token, words) => {
  const action = `${publicBase()}/api/public/twilio/voice/${encodeURIComponent(token)}/connect`;
  return `<Gather numDigits="1" timeout="10" action="${xmlEsc(action)}" method="POST">`
    + `<Say>${xmlEsc(words)}</Say></Gather><Say>No key pressed. Goodbye.</Say><Hangup/>`;
};

// The caller picked up. Ask for a key first, so a voicemail that answers
// never gets connected to the person.
publicRoutes.post('/api/public/twilio/voice/:token', async (c) => {
  const params = await signedForm(c);
  if (!params) return bad(c);
  const token = c.req.param('token');
  const call = await callByToken(await getDb(), token);
  if (!call || call.token_used_at || !call.live || !sameCall(call, params)) return ended(c);
  return twiml(c, pressOne(token, 'Campaign call. Press 1 to connect.'));
});

// They pressed 1: spend the token (single use) and dial the person with the
// campaign's number as caller ID — never the caller's own. Any other key
// asks again ("Press 1 to connect"); nobody is dialled.
publicRoutes.post('/api/public/twilio/voice/:token/connect', async (c) => {
  const params = await signedForm(c);
  if (!params) return bad(c);
  const db = await getDb();
  const token = c.req.param('token');
  const call = await callByToken(db, token);
  if (!call || !params.get('Digits') || !sameCall(call, params)) return ended(c);
  if (params.get('Digits') !== '1') {
    if (call.token_used_at || !call.live) return ended(c);
    return twiml(c, pressOne(token, 'Press 1 to connect.'));
  }
  const { result } = await runAction(db, { workspaceId: call.workspace_id, actorId: null, action: 'twilio.voice_connect' }, async (tx, emit) => {
    const spent = (await tx.query(
      `update texting_calls set token_used_at = now(), status = 'connecting'
       where id = $1 and token_used_at is null and token_expires_at > now() and status = 'calling_you'
       returning id, to_phone`, [call.id],
    )).rows[0];
    if (spent) emit('texting_call', call.id, 'update', { status: 'connecting' });
    return spent || null;
  });
  if (!result) return ended(c);
  const dialDone = `${publicBase()}/api/public/twilio/voice-dial/${call.id}`;
  return twiml(c, `<Dial callerId="${xmlEsc(campaignNumber())}" timeout="30" action="${xmlEsc(dialDone)}" method="POST">`
    + `<Number>${xmlEsc(result.to_phone)}</Number></Dial>`);
});

const DIAL_STATUS = { completed: 'talked', answered: 'talked', busy: 'no_answer', 'no-answer': 'no_answer', canceled: 'no_answer', failed: 'failed' };
publicRoutes.post('/api/public/twilio/voice-dial/:id', async (c) => {
  const params = await signedForm(c);
  if (!params) return bad(c);
  const id = c.req.param('id');
  const next = DIAL_STATUS[String(params.get('DialCallStatus') || '').toLowerCase()] || 'ended';
  const talk = Math.max(0, Math.floor(Number(params.get('DialCallDuration')) || 0));
  if (UUID_RE.test(id)) {
    const db = await getDb();
    const call = (await db.query('select id, workspace_id from texting_calls where id = $1', [id])).rows[0];
    if (call) {
      await runAction(db, { workspaceId: call.workspace_id, actorId: null, action: 'twilio.call_dial' }, async (tx, emit) => {
        const n = await tx.query(
          `update texting_calls set status = $2, talk_s = $3, ended_at = now() where id = $1 and status = 'connecting'`,
          [id, next, talk],
        );
        if (n.affectedRows) emit('texting_call', id, 'update', { status: next, talk_s: talk });
      });
    }
  }
  return twiml(c, '<Hangup/>');
});

// The caller's leg ended. A call still waiting on them was missed (no answer,
// busy, or they hung up without pressing a key); record the whole length.
const MISSED = new Set(['completed', 'no-answer', 'busy', 'canceled']);
publicRoutes.post('/api/public/twilio/voice-status/:id', async (c) => {
  const params = await signedForm(c);
  if (!params) return bad(c);
  const id = c.req.param('id');
  const status = String(params.get('CallStatus') || '').toLowerCase();
  if (!UUID_RE.test(id) || !['completed', 'no-answer', 'busy', 'canceled', 'failed'].includes(status)) return c.body(null, 204);
  const secs = Math.max(0, Math.floor(Number(params.get('CallDuration')) || 0));
  const db = await getDb();
  const call = (await db.query('select id, workspace_id, provider_sid from texting_calls where id = $1', [id])).rows[0];
  if (!call || !sameCall(call, params)) return c.body(null, 204);
  await runAction(db, { workspaceId: call.workspace_id, actorId: null, action: 'twilio.call_status' }, async (tx, emit) => {
    const cur = (await tx.query('select status from texting_calls where id = $1 for update', [id])).rows[0];
    const next = cur.status === 'calling_you' ? (MISSED.has(status) ? 'missed' : 'failed')
      : cur.status === 'connecting' ? 'ended' : cur.status;
    await tx.query(
      `update texting_calls set status = $2, call_s = $3, ended_at = coalesce(ended_at, now()) where id = $1`,
      [id, next, secs],
    );
    emit('texting_call', id, 'update', { status: next, call_s: secs });
  });
  return c.body(null, 204);
});
