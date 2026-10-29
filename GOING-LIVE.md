# Going live — Imagine Surrey

The order to do things in, once, before the team signs in. Each step says
where it happens and how to tell it worked. The longer explanations are in
[TESTING.md](TESTING.md) (deploying, what to test by role) and
[README.md](README.md) (how each part works).

## 1 · Deploy

1. Render → **New → Blueprint** → this repo, `main`. `render.yaml` creates
   the `starbase` web service and the `starbase-db` Postgres database.
2. Wait for the first deploy, then open
   `https://<service>.onrender.com/api/health`. It answers
   `{"ok":true,"service":"starbase","tzdataCurrent":true}`.
   `tzdataCurrent: false` means the server's time-zone rules predate B.C.'s
   permanent UTC-7 (every time after 1 Nov 2026 would show an hour off):
   redeploy on a newer Node image before going further.

## 2 · Domains

| Host | What it serves | Where |
|---|---|---|
| `starbase.imaginesurrey.ca` | the staff and volunteer app, and the public forms | Render → Settings → Custom Domains |

Add the DNS records Render shows; it issues the certificates. The
campaign's website (`imaginesurrey.ca`) is its own thing, hosted apart; it
links to Starbase's public pages and posts its forms to the JSON bridge.

## 3 · Settings (Render → starbase → Environment)

Set these before the first sign-in; the rest can wait.

| Variable | Set it to | Needed for |
|---|---|---|
| `STARBASE_PUBLIC_URL` | `https://starbase.imaginesurrey.ca` | every link in an email: invites, unsubscribe, receipts, Stripe return pages |
| `RESEND_API_KEY`, `MAIL_FROM` | from Resend; `Imagine Surrey <team@imaginesurrey.ca>` on a domain verified there | email; without it invites are shown to copy and sends wait as *queued* |

Then, as each one is ready:

| Variable | Set it to | Needed for |
|---|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | the **live** keys (test keys and card `4242…` until the donate page is checked) | card donations; without them donations are pledges |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | from Twilio | texting and calling through the campaign's number, SMS shift alerts; without them the phone's own apps are used |
| `GEOCODER` | leave unset (`bc`, the free BC Address Geocoder); `GEOCODER_FALLBACK=google` to ask Google only for addresses BC can't place | placing people on the map |
| `GOOGLE_MAPS_SERVER_KEY` | a Google Cloud key restricted to the server's IP with only the APIs used enabled (Geocoding; Map Tiles for `GOOGLE_MAPS_TILES=1`) | Google geocoding and Google Maps tiles |
| `GOOGLE_MAPS_TILES` | `1` to draw the field map on Google's tiles (`GOOGLE_MAPS_TILE_TYPE` roadmap, satellite or terrain); otherwise OpenStreetMap, which is not for a large team in election week | the map's background |
| `STARBASE_TRUSTED_PROXIES` | leave unset on Render (one proxy). Set to the number of proxies in front if there is a CDN before Render | rate limits reading the right address |

Stripe: in the Stripe dashboard add a webhook at
`https://starbase.imaginesurrey.ca/api/public/stripe/webhook` with the
events `checkout.session.completed`, `charge.refunded`, `invoice.paid` and
`customer.subscription.deleted`, and copy its signing secret into
`STRIPE_WEBHOOK_SECRET`. A refund made in Stripe shows here by itself: a
donation refunded in full leaves the books as a void does (its receipt is
voided too). A monthly gift cancelled in Stripe closes its pledge here;
cancelling a pledge here does not stop Stripe — cancel the subscription in
the Stripe dashboard.

Twilio: set the number's incoming-message webhook to
`https://starbase.imaginesurrey.ca/api/public/twilio/sms` (HTTP POST).

## 4 · First sign-in

The first sign-in lands in the **admin** (`/admin/`); the field app at `/` is
what volunteers get, and what you see under *Field app ↗* in your account menu.

1. Open `https://starbase.imaginesurrey.ca/login` → **Set up Starbase for
   Imagine Surrey**. The first account is the manager; this creates the
   Imagine Surrey workspace (BC municipal rules, the 2026 contribution
   limit seeded) and closes sign-up. Everyone else joins by invite.
2. **Today** shows a banner if the server's time-zone data is stale (step 1)
   so a manager can't miss it.
3. **Admin** (from the account menu, your initials): under **Members**
   invite the staff and treasurer first, volunteers later once the lists
   are in; under **Teams** group them (a crew per neighbourhood, the phone
   bank); under **Permissions** decide which areas each role, or one person,
   may use.
4. **Outreach → More → Donations**: the donation instructions (for pledges
   and e-transfer) and the campaign's website link the public pages use.

## 5 · The lists and the map

1. **People → Import**: a CSV or spreadsheet, up to 300 MB in the browser.
   Map the columns, run a dry run first (it reports matches, new people and
   anything it couldn't read), then import. The list's own columns map by
   themselves (house number and street, latitude and longitude, the 1/0
   flags, and the standard fields named after them); social handles
   (Instagram, X, TikTok, Reddit) fill blank ones only.
2. **Place on map** starts a background run; the import page and the map
   show progress and the time left, and it carries on with the page closed.
   Addresses the geocoder can't place are set aside for a pin by hand (drag
   on the map).
3. Open the map on a phone as a volunteer: tap a house, rate the door, see
   it save; turn on airplane mode, do it again, turn it off, watch it send.
4. Tell volunteers about **Show → Share my location while I'm out** on the
   map: it's off until they turn it on, and while it's on the managers'
   dashboard (Today) shows where they are. Location needs the site on
   `https` (every host in section 2 is). A position is kept only while they
   share it, a trail for the day; neither is in the export.

## 6 · Before the public link goes out

- `https://imaginesurrey.ca/` and `/d/imagine-surrey` (donate), `/n/imagine-surrey`,
  `/v/imagine-surrey` load over https with the campaign's header and footer.
- A test newsletter reaches a real inbox with a working unsubscribe link.
- A test donation (live key, a real card, refunded in Stripe afterwards)
  lands under **Donations** with a receipt emailed.
- Backups: Render's managed Postgres keeps daily backups; **Today → Export
  all data** (managers) downloads everything (message pictures are not in it).
- Keys: every key above is in Render only, never in the repo or a chat.
  Anyone who leaves the campaign is removed under **Admin → Members**, which ends their
  sign-in everywhere at once.

## What Starbase does on its own

- Sign-in: 30 tries per address and 10 failures per email in 15 minutes,
  then a wait. Sessions last 30 days and end at sign-out or removal.
- Public forms: rate-limited per address; a request's body is capped.
- Email: every newsletter carries the reader's own unsubscribe link and the
  headers mail apps use for their Unsubscribe button; an unsubscribed
  address cannot be added back by the desk.
- Donations: contributions are checked against the Elections BC limit per
  contributor (confirm the seeded figure with Elections BC before filing).
