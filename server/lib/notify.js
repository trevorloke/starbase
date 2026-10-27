// Outbound notifications — email + SMS behind provider-pluggable adapters.
// No SDKs: plain fetch against provider REST APIs, so there are zero new
// dependencies and a missing provider degrades to an honest 'queued' status:
// nothing was sent and nothing sends by itself. The message is kept, and once
// the provider is configured a person sends it — blast.resend ("Send now")
// for newsletters and press, shift.notify again ("Notify again") for shifts.
//
//   Email: set RESEND_API_KEY (+ optional MAIL_FROM, default onboarding@resend.dev)
//   SMS:   set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM

export const emailConfigured = () => !!process.env.RESEND_API_KEY;
export const textConfigured = () =>
  !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);

// `html` is optional: sent alongside the plain-text part when given.
// `idempotencyKey` is optional: the provider sends a key it has seen in the
// last day only once, so a retry after an unknown outcome never doubles up.
// A provider that hasn't answered in 15 s (STARBASE_EMAIL_TIMEOUT_MS) is given
// up on: 'failed' with unknown: true — it may or may not have sent it — so a
// hung connection never holds a send (or anything waiting on it) for long.
// unknown is set only when the provider never answered.
// `headers` is optional: extra mail headers (List-Unsubscribe and
// List-Unsubscribe-Post on newsletters and ladder emails). `attachments`:
// [{ filename, content (base64), content_type? }], as the service takes them.
const emailTimeoutMs = () => Number(process.env.STARBASE_EMAIL_TIMEOUT_MS) || 15_000;
export const sendEmail = async ({ to, subject, text, html, idempotencyKey, headers, attachments }) => {
  if (!emailConfigured()) {
    return { sent: false, status: 'queued', detail: 'no email provider configured (set RESEND_API_KEY)' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 256) } : {}),
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'onboarding@resend.dev',
        to: [to],
        subject,
        text,
        ...(html ? { html } : {}),
        ...(headers && Object.keys(headers).length ? { headers } : {}),
        ...(attachments?.length ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, ...(a.content_type ? { content_type: a.content_type } : {}) })) } : {}),
      }),
      signal: AbortSignal.timeout(emailTimeoutMs()),
    });
    if (!res.ok) {
      return { sent: false, status: 'failed', detail: `email provider ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` };
    }
    return { sent: true, status: 'sent' };
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return {
      sent: false, status: 'failed', unknown: true,
      detail: timedOut ? `email provider didn't answer in ${Math.round(emailTimeoutMs() / 1000)} s` : String(e?.message || e).slice(0, 200),
    };
  }
};

export const sendText = async ({ to, body }) => {
  if (!textConfigured()) {
    return { sent: false, status: 'queued', detail: 'no SMS provider configured (set TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM)' };
  }
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const form = new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: body });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    if (!res.ok) {
      return { sent: false, status: 'failed', detail: `sms provider ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { sent: true, status: 'sent' };
  } catch (e) {
    return { sent: false, status: 'failed', detail: String(e.message).slice(0, 200) };
  }
};

// Shift notification copy: time, place, instructions, link — one message,
// both channels.
// Times render in the campaign's zone, never the server's (a UTC host would
// otherwise tell Surrey volunteers the wrong hour).
export const shiftMessage = (shift, workspaceName, timeZone = 'America/Vancouver') => {
  const when = new Date(shift.starts_at).toLocaleString('en-CA', {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone,
  });
  const lines = [
    `You're scheduled: ${shift.title}`,
    when + (shift.ends_at ? ` – ${new Date(shift.ends_at).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone })}` : ''),
    shift.location ? `Where: ${shift.location}` : null,
    shift.instructions ? `Instructions: ${shift.instructions}` : null,
    shift.link ? `Details: ${shift.link}` : null,
    `— ${workspaceName}`,
  ].filter(Boolean);
  return lines.join('\n');
};

// The mail headers that give a mail app its own Unsubscribe button: one tap
// sends a POST to `url` (RFC 8058). Only for a full https/http address — a
// link without the campaign's address would go nowhere.
export const unsubscribeHeaders = (url) => (/^https?:\/\/[^/]/i.test(String(url || ''))
  ? { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
  : undefined);
