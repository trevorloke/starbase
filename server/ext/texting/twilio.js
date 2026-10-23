// Twilio over plain REST (no SDK), and webhook signature checks.
//
//   Texting from the app: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
//     (the campaign's number) — the same variables lib/notify.js reads.
//   Calls through the campaign: the same, plus STARBASE_PUBLIC_URL (Twilio
//     must reach this server to ask what to do when the caller answers).
//     TWILIO_VOICE=off turns calling off while keeping texting.
//   TWILIO_API_BASE: where the REST API lives (default https://api.twilio.com);
//     only the test scripts point it elsewhere.
//
// Every inbound request (replies, delivery reports, the call's answer and
// status) must carry a valid X-Twilio-Signature made with TWILIO_AUTH_TOKEN;
// anything unsigned is refused.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { textConfigured } from '../../lib/notify.js';

export const smsReady = () => textConfigured();
export const publicBase = () => String(process.env.STARBASE_PUBLIC_URL || '').trim().replace(/\/$/, '');
export const voiceReady = () => smsReady() && !!publicBase() && process.env.TWILIO_VOICE !== 'off';
export const campaignNumber = () => String(process.env.TWILIO_FROM || '').trim();
const apiBase = () => String(process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');

// POST a form to /2010-04-01/Accounts/{sid}/{resource}.json →
// { ok, sid, code, detail }. Never throws: a network failure is { ok: false }.
const twilioPost = async (resource, params) => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
  try {
    const res = await fetch(`${apiBase()}/2010-04-01/Accounts/${encodeURIComponent(sid)}/${resource}.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, code: json?.code ?? null, detail: `Twilio ${res.status}${json?.message ? `: ${String(json.message).slice(0, 200)}` : ''}` };
    }
    return { ok: true, sid: json?.sid || null };
  } catch (e) {
    return { ok: false, code: null, detail: `Twilio unreachable: ${String(e?.message || e).slice(0, 160)}` };
  }
};

export const sendSms = ({ to, body, statusCallback }) =>
  twilioPost('Messages', { To: to, From: campaignNumber(), Body: body, StatusCallback: statusCallback });

// Ring the caller's own phone from the campaign number; when they answer,
// Twilio fetches `url` for what to do next.
export const ringCaller = ({ to, url, statusCallback }) =>
  twilioPost('Calls', {
    To: to, From: campaignNumber(), Url: url, Method: 'POST', Timeout: 30,
    StatusCallback: statusCallback, StatusCallbackMethod: 'POST',
  });

// Twilio's signature: HMAC-SHA1 (auth token) over the full URL it called
// followed by every POST parameter, sorted by name, as name + value; base64.
export const twilioSignature = (token, url, params) => {
  const pairs = [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const data = url + pairs.map(([k, v]) => k + v).join('');
  return createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
};

// Behind a proxy the URL Twilio called (the public one) is not the URL this
// process sees, so each likely spelling is tried; every one needs the token.
export const verifyTwilio = (c, params) => {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const got = String(c.req.header('x-twilio-signature') || '');
  if (!token || !got) return false;
  const u = new URL(c.req.url);
  const tail = `${u.pathname}${u.search}`;
  const urls = new Set([c.req.url]);
  if (publicBase()) urls.add(publicBase() + tail);
  const host = c.req.header('x-forwarded-host') || c.req.header('host');
  if (host) urls.add(`${c.req.header('x-forwarded-proto') || u.protocol.replace(':', '')}://${host}${tail}`);
  const gotBuf = Buffer.from(got);
  for (const url of urls) {
    const want = Buffer.from(twilioSignature(token, url, params));
    if (want.length === gotBuf.length && timingSafeEqual(want, gotBuf)) return true;
  }
  return false;
};

const xmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
export const twiml = (c, inner = '') =>
  c.body(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, 200, { 'Content-Type': 'text/xml; charset=utf-8' });
export { xmlEsc };
