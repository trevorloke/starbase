// Texting — peer-to-peer texts and click-to-call through the campaign's
// Twilio number, from the Calls card and the Inbox.
//
// Built conservatively (the campaign should confirm the rules with counsel):
//   · every text is one person tapping Send for one person — no bulk, no
//     scheduled or automated sends, no auto-dialer;
//   · the first text in a conversation names the campaign and ends
//     "Reply STOP to opt out";
//   · STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / QUIT opt the number out
//     at once and for good (tag do-not-text; the server refuses every later
//     text to it) until that number sends START / UNSTOP;
//   · quiet hours (default 9 am–9 pm Monday to Friday, 10 am–6 pm on
//     weekends, campaign time; managers change them — confirm with counsel)
//     are enforced on the server for texts, calls and shift notices;
//   · one campaign conversation per number: nobody sends a second
//     introduction while someone else's conversation with it is recent;
//   · calls ring the caller's own phone first and show the person the
//     campaign's number, never the caller's.
//
//   sql.js      tables (conversations, messages, opt-outs, reads, settings,
//               member phones, calls)
//   rules.js    phone numbers, keywords, footer, quiet hours
//   twilio.js   Twilio REST + webhook signatures
//   store.js    shared reads/writes (opt-outs, inbox lists)
//   actions.js  text.send · text.reply · text.read · text.optout · call.start ·
//               texting.settings
//   api.js      signed-in reads under /api/texting/*
//   public.js   Twilio webhooks under /api/public/twilio/*
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
export { publicRoutes } from './public.js';
import { briefTexts, textOutRules } from './store.js';

// Today's "texts this week" counts texts sent through the app too; a shift
// notice texted from the campaign's number follows the same rules as a text
// from the Calls card (no opted-out number, no quiet hours, E.164).
export const hooks = { brief: briefTexts, textOut: textOutRules };

// In the full export: conversations, every text, opt-outs and the settings.
// Never a caller's own phone or a call's token (texting_member_phones and
// texting_calls stay out).
export const exportTables = ['texting_settings', 'texting_optouts', 'texting_conversations', 'texting_messages'];

// Volunteers read their own conversations (/texting/mine, a thread they
// started, their Calls card); every conversation, a profile's conversations
// and the settings (callers' phones) are desk reads.
export const deskOnlyReads = [
  '/texting/all',
  '/texting/people/:id/conversations',
  '/texting/settings',
];
