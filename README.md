# Starbase

The campaign OS built for **Imagine Surrey**. Field-first: a map with every
door on it, a one-tap rating scale at the door, phone, and by text — with
signs, volunteers, shifts, money, compliance, and outreach around it.

## The seven things a campaign does (the whole tab bar)

Every screen is built to [SIMPLE.md](SIMPLE.md): one job per screen, one yellow
button, no paragraphs, everything else one tap away.

| Screen | What it is |
|---|---|
| **Today** | Managers: the **dashboard** — every team's contacts, the chart over time, and the map of who is out where. Desk: three big numbers (doors · support · raised) and *Needs you*. Volunteers: one big *Start canvassing* and their next shift |
| **Map** | Field mode. Houses as clickable pins; tap a door → rate, log, request a sign, call/text. Turfs and walk lists |
| **People** | Everyone, filterable by rating / tag / role / the campaign's own fields; profiles with socials, roles, gifts, history, *More details* and who they know; **Calls** works a list one person at a time; **My people** is each volunteer's own circle |
| **Shifts** | Schedule volunteers, assign by role, notify by email + text with instructions and a link; volunteers tap *Count me in* |
| **Money** | Gifts (one-time / monthly) with the entity-keyed cap engine; donor tiers; filings |
| **Signs** | Billboards (4×8), large (4×4), lawn — requested → installed → removed |
| **Outreach** | Newsletter + press-release blasts, petitions, and the Imagine Surrey website bridge |
| **Website** | The public site and store, edited here: pages, news, events, team, merch, orders, settings (desk) |

Volunteers get four tabs — **Today · Map · Calls · Shifts** — plus *Signs to
put up* for sign crews; desk-only addresses send them back to Today.

**Setup is one-time.** Starbase runs for Imagine Surrey only: the first
person to open `/signup` sets it up (name, email, password) and becomes its
manager — the workspace is *Imagine Surrey*, `bc-municipal`
(`server/lib/org.js`). After that sign-up is closed (`POST /api/auth/signup`
→ 403) and Sign in hides the link; `GET /api/auth/setup` says which
(`{ open, organization }`). `STARBASE_OPEN_SIGNUP=1` keeps it open — the
test suite sets it, since tests make several workspaces to check they stay
apart.

Managers reach **Admin** from the account menu (their initials):
- **Members**: invite volunteers and staff by email (or copy the join link
  and text it), set roles, see pending invites, and remove someone who has
  left (they are signed out everywhere at once; what they did stays on the
  record; a new invite lets them back in). Invitees open `/join/:token`, set
  a password, and land on the map (volunteers) or Today.
- **Teams**: groups of members (a neighbourhood crew, the phone bank) with
  a lead; a whole team goes onto a turf in one go (Map → turf → Add a
  canvasser → Teams). Someone removed from the campaign leaves every team.
- **Permissions**: the app is nine areas — People, Map & turfs, Shifts,
  Money, Signs, Outreach, Website, Data, Admin. Each role has its usual ones
  (`server/lib/perms.js`); a manager can take an area from a whole role or
  give one to a single person on top of their role (a volunteer who runs
  Outreach, a staffer kept out of Money). The server decides on every action
  and read, and the app shows a person the tabs of the areas they have.
  Managers always have every area.
The same menu has **Rating scale** (below); People → More has **Profile
fields** (managers) and **Most connected** (desk).

### The rating scale (door, phone, text)

`1` strong support · `2` lean support · `3` undecided · `4` opposed (unknown) ·
`4D` McCallum · `4B` Surrey Connect / Locke · `4F` Surrey First / Annis ·
`4N` SurreyNow / van Vliet · `4C` Surrey Conservatives / Randhawa
(`shared/canvass.js` — one vocabulary for server validation and the UI).
On screen the buttons read *1 Strong yes · 2 Lean yes · 3 Undecided ·
4 Opposed*; tapping 4 asks *Voting for?* with the five surnames or *Not sure*.

These are the defaults. A manager changes the words on each step and the
*Voting for?* list under **Rating scale** (account menu) — add, rename,
reorder, take off, put back — with a preview of the buttons volunteers will
see. The four steps never change, so counts, filters, ladders and the map
read the same. A code keeps its meaning forever: someone taken off the list
keeps their old ratings ("4 · Locke (off the list)") and is never offered
again. A knock tapped on a phone while they were still offered still counts,
however late it arrives (the phone sends when it was tapped); one tapped more
than a week after they came off is refused. Contacts are door, phone, text or
**in person**.

### What's tracked

- **Signs**: billboard, large, lawn, with status and location.
- **Donors**: one-time, monthly, **star** ($1K+/yr or $100+/mo), **superstar**
  ($3K+/yr or $250+/mo) — derived from real gifts, never self-declared.
- **Volunteer roles** (15): driver, scrutineer, doorknocking, mainstreeting,
  phoning, data entry, event hosting, zone house captain, hi-rise building
  captain (+building), food, translation
  (+language), burmashave, community committee (+area), policy, administration.
- **Tags**: free-form, seeded with media, VIP, endorser, host, …
- **Socials**: per-person handles for Facebook, Instagram, X, TikTok, YouTube,
  LinkedIn, Bluesky.
- **Profile fields**: the campaign's own — Text · Yes/No · Pick one · Number ·
  Date (*Language at home*, *Strata council member*, …) — set up by a manager,
  filled in by the desk under *More details* (read-only with no signal),
  filtered, imported (column names in any script) and exported; volunteers
  see only the ones marked for them, read-only. Every campaign starts with
  Imagine Surrey's **standard fields**, named for the list's own columns so
  an import maps them by itself: Home phone, Province, House notes,
  Building notes, Access type, Dwelling type (those four shown to
  canvassers), Interaction status, Interaction date, Organizer, Email
  opt-in, SMS opt-in, Sign, Support (the list's 1–5, kept apart from the
  rating scale) and Voted. *Profile fields → Add the standard fields* puts
  them on a campaign set up before they existed. Every person has a
  **House number** of its own, apart from the street (the door card, the
  profile and *Add a person* ask for both; the address line reads 13450 104
  Ave, and a number typed into the street is split out). The import takes a
  **House number** column the same way, **Latitude
  / Longitude** (a pin, only where there is none), and **Volunteer / Donor**
  1/0 columns (the tags); yes/no fields and the flags read 1 and 0, yes and
  no, true and false, and a database export's t and f; dates come in as
  spreadsheets write them (10/21/2026, 21 Oct 2026).
- **The dashboard** (managers, at the top of Today): contacts today, in the
  last 7 or 30 days or in all — how many, doors, calls & texts, people
  reached, support, canvassers, who is out now; a bar per day (per week on
  *All time*) stacked by outcome, Grouped and Table views; **In the field**,
  a map of the period's contacts (a dot at the door, coloured by outcome)
  and everyone who has canvassed as their initials — a ring and *out now*
  while they share their location, grey at their last door otherwise — pick
  a person for their trail (today) and their numbers; **By team**, each
  team's contacts and outcomes and how many of its members are out; the
  latest twenty contacts. It refreshes itself every minute.
- **Share my location while I'm out** (the map's *Show* sheet, any role):
  off unless the person turns it on; while it's on, their phone tells the
  server where they are about once a minute or every 25 m (`field.ping`),
  and managers see them live. Off takes them off the map at once; a trail
  is kept for the day and a position only while they share it. Pings are
  not on the event log and not in the export.
- **Relationships**: who knows whom (Family · Friend · Neighbour · Work ·
  Community · Other), *brought in by*, and each volunteer's **My people** —
  add someone you know, call, text, or rate a talk in person. A profile's
  *Knows* nudges the desk ("Ask Priya Nair — they know each other"; never on
  a do-not-contact profile) and *Most connected* finds the connectors. A
  volunteer's add never matches on, or takes, an email the campaign holds, so
  a possible double is flagged to the desk (*May be the same person as …*).

## Coverage vs. the tools it replaces

| | Starbase today | Next |
|---|---|---|
| **Ecanvasser** | map canvass, door cards, household grouping, ratings, no-answer outcomes, signs at the door, place-on-map, call/text lists, turf cutting & assignment, walk lists, survey builder (door and calls), custom person fields, offline field mode, offline desk (each sign-in's last copy of every screen, money and donor lists in the tab only; ratings, notes and tags queued; one outbox across tabs) | — |
| **Action Builder** | assessments (= the rating scale, its words and Voting-for list edited per campaign), tags, roles, relational notes, relationship graph (My people, Knows with a nudge, Most connected, brought in by), event-logged every touch | — |
| **Action Network** | newsletter list + signup page + unsubscribe, press list + releases, petitions with public pages, volunteer signup page, event RSVP pages, donation pages (Stripe or pledges), website JSON bridge, ladders of engagement, A/B subject lines with open/click tracking | — |

## Website bridge (Imagine Surrey)

Public pages, no login, linkable from the site (workspace slug from setup: `imagine-surrey`):

- `/p/:slug/:petition` — petition signature page
- `/n/:slug` — newsletter signup · `/u/:subscriptionId` — unsubscribe (the link
  asks; one tap on *Unsubscribe* does it, so mail scanners never unsubscribe anyone)
- `/v/:slug` — volunteer signup with the 15 roles (a hi-rise captain is asked
  which building; translators, which language)

The site can also keep its own forms and post JSON here (CORS-open):

```http
POST /api/public/:slug/signup
{ "kind": "newsletter" | "volunteer" | "petition", "name", "email", "phone",
  "roles": ["highrise_captain"], "detail_highrise_captain": "<building>",
  "petition": "<petition-slug>", "subscribe": true, "note": "…" }
```

Every public submission lands in the directory as a Person (deduped by email),
tagged by source, and is appended to the event log under a system actor.

## Website (imaginesurrey.ca) and store

Starbase hosts the campaign's public website. It is edited in its own
small app, the **website admin** at `/website-admin` (the same accounts:
managers and staff edit, treasurers see Orders; the field app's account
menu has *Edit the website*): **Pages · News · Events · Team · Store ·
Orders · Settings** and *View site*. The website is apart from the field
app: `STARBASE_SERVE=site` runs it as its own service (the site at `/` on
every host, its admin, the public forms and the Stripe webhook, and only
the slice of the API its admin needs — never the campaign's people, money
or lists), `STARBASE_SERVE=app` runs the field app without it, and the
default `all` serves both from one process (`server/lib/serve.js`).
A saved page or post shows **View on site**, or **Preview draft** while unpublished:
the site's `?preview` shows a draft (marked, never cached or indexed) only to
managers and staff signed in on the staff host.

- **Where it answers.** `/site/…` on every host, and `/` on the hosts in
  `STARBASE_SITE_HOSTS` (e.g. `imaginesurrey.ca,www.imaginesurrey.ca`). On
  those hosts the site claims `/`, `/news`, `/events`, `/our-team`,
  `/store`, `/cart`, `/sitemap.xml`, `/robots.txt` and any one-word path that
  isn't the staff app's (`/about`, `/platform` …); `/api`, `/assets`, `/login`
  and the other app screens, and the public forms (`/e /d /n /v /p /u`) work
  unchanged on every host. The site belongs to the oldest workspace (or
  `STARBASE_SITE_WORKSPACE=<slug>`).
- **Content.** Pages and news are Markdown with a toolbar and Preview,
  rendered by one small safe renderer (`shared/markdown.js`: everything is
  escaped first; links only http(s), mailto or site paths). Drafts never
  show. Pictures upload from the admin (shrunk to 2000px / ~1.5 MB in the
  browser; JPG, PNG or WebP checked by their bytes; 2 MB at most), are kept
  in the database and served at `/media/:id`, cached a year. Events are the
  campaign's own events (the same list as Outreach), with a picture added.
  New sites start with draft pages full of placeholder words — the
  campaign writes the real ones. Settings holds the title, hero, the two
  brand colours (`--primary`, `--accent`), contact, social links, the menu
  order and the **Authorized by** line (election ads carry one), and the
  campaign's **logo** (the reversed version, for the navy header and footer)
  and **star device** (the browser tab). Until those are uploaded the site
  shows its name; nothing stands in for the logo.
- **Look.** Server-rendered HTML with per-page title, description and Open
  Graph tags, a sitemap and robots.txt; one stylesheet
  (`server/ext/website/assets/site.css`). The public forms (RSVP, donate,
  newsletter, volunteer, petition, unsubscribe) wear the same header and footer.
- **Store.** Products with photos, CAD prices, optional sizes with their own
  stock. The cart lives in the browser; prices and stock are always worked
  out on the server. Checkout is Stripe Checkout with inline prices (nothing
  to set up per product in Stripe), shipping (fee in Settings) or pick-up.
  The Stripe webhook (`checkout.session.completed`) marks the order paid
  once — retries change nothing — takes the items out of stock and puts the
  buyer in People tagged `store`; `checkout.session.expired` cancels an
  unpaid one; `charge.refunded` marks an order refunded in Starbase when
  the card is refunded in Stripe (items back on the shelf unless it had
  shipped; a partial refund is noted on the order). The same event voids a
  card donation refunded in full (`stripe.refund`: its pledge reopens, its
  receipt is voided, as a hand void does); a partial donation refund is only
  noted on the gift for the treasurer. A checkout holds its items while the buyer is on Stripe's
  page (the session expires after 30 minutes); backing out to the cart
  closes the session and frees them, so the last shirt can't sell twice.
  Without `STRIPE_SECRET_KEY` the store shows its items and
  says *Online store opens soon*. Ask your financial agent how merchandise
  sales are reported.

Code: `server/ext/website/` (site.js pages and host routing, store.js,
actions.js, api.js), admin screens `web/src/pages/Website*.jsx`.

## Placing people on the map (geocoding)

Addresses are looked up with the BC Address Geocoder (`server/lib/geocode.js`;
`GEOCODER=bc|google|nominatim|off`, `BC_GEOCODER_KEY`, `GEOCODE_MIN_SCORE`).
Google's Geocoding API is the other option (`GOOGLE_MAPS_SERVER_KEY`, a key
with only that API enabled and restricted to the server's IP; lookups are
biased to Surrey and limited to BC, and only a rooftop or street-number
match counts). `GEOCODER_FALLBACK=google` keeps the free BC service first
and asks Google only for addresses it can't place. **Place on
map** starts a background run (`server/ext/geocoding`, a job like ladder
emails): rounds of 120 people, one lookup per address (a household shares
it), pins already on file at the same address copied, `GEOCODE_CONCURRENCY`
lookups at once (default 6). A lookup that fails while others work is tried
3 times, then set aside for a pin by hand; a round where every lookup fails
counts as an outage (nobody's tries are spent), backs off
(`GEOCODE_BACKOFF_MS`, default 30 s × rounds in a row) and after 5 such
rounds pauses the run with the reason. `GET /api/geocode/status` reports
progress; the page shows it and works out the time left. With
`STARBASE_JOBS=off` the page falls back to looking up batches itself.

## Sending email and text

Set `STARBASE_PUBLIC_URL` (e.g. `https://starbase.imaginesurrey.ca`) so links
in outbound mail — newsletter unsubscribe footers, invite links — point at the
public host. Every newsletter and ladder email ends with "Sent by <campaign>"
and the reader's own unsubscribe link, and carries `List-Unsubscribe` /
`List-Unsubscribe-Post` headers so mail apps show their own Unsubscribe
button. Someone who unsubscribed can only rejoin from the signup page — the
desk can't add them back. Ladder emails go only to addresses on the list as
subscribed. Shift messages render in campaign time
(`America/Vancouver` unless `settings.tz` says otherwise).

Provider-pluggable, no SDKs: `RESEND_API_KEY` (+ `MAIL_FROM`) for email,
`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` for SMS. Without
them, blasts and shift notifications are recorded as **queued** per recipient
— nothing is lost; connect the provider and resend. A newsletter or press
send commits its list first and claims each email before it goes, outside
the campaign lock; the tap sends for a few seconds and a background send
job sends the rest ("Sending · 40 of 340"), so a big list never keeps the
person waiting and a crash mid-send leaves who got it, who might ("not
sure" — Try again, same key) and who hasn't yet (the job carries on by
itself); shift emails carry a key per
person and round, so Notify again after a crash isn't a second copy. Without Twilio, calling
and texting use `tel:` / `sms:` links (the phone's own dialer and messages)
with one-tap logging; with it, texts and calls go through the campaign's
number — from Calls, the profile and the door card alike, and shift notices
keep the same opt-outs and quiet hours (setup and the compliance notes are
in TESTING.md).

## Map tiles and offline field mode

The map draws OpenStreetMap tiles unless these say otherwise (read on each
request to the signed-in `GET /api/map/config`, so a restart applies them).
OpenStreetMap's volunteer-run servers are not for heavy use — a large team in
election week should switch to a paid provider.

| Variable | What for | Default |
|---|---|---|
| `STARBASE_TILE_URL` | tile template, `https://…/{z}/{x}/{y}.png` (`{s}` optional; an API key can ride in the query string) | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` |
| `STARBASE_TILE_ATTRIBUTION` | the provider's credit line (text and links) | the OpenStreetMap credit (none for another provider unless set) |
| `STARBASE_TILE_MAX_ZOOM` | deepest zoom the provider serves, 1–22 | `19` |

A bad value falls back to the default (and logs once); desk roles see which
tiles took on the map's filter sheet (*Map tiles: OpenStreetMap — custom
address ignored*).

**Google Maps** instead: `GOOGLE_MAPS_TILES=1` with a `GOOGLE_MAPS_SERVER_KEY`
that has the **Map Tiles API** enabled (`GOOGLE_MAPS_TILE_TYPE` roadmap |
satellite | terrain). Google hands tiles out against a session, so the map
draws `/tiles/{z}/{x}/{y}.png` from Starbase (signed in), which fetches
each tile from Google with a session it keeps for everyone and renews
(`server/lib/gtiles.js`, served by `server/ext/offline`), credited to
Google, up to zoom 22; the service worker keeps the ones a phone has drawn
as with any provider. Google bills per tile past its free allowance, and its
terms have their own rules on attribution and caching — check them before
election week. The service worker
keeps the tiles a phone has already looked at (about 1,500, oldest out), so a
turf viewed with signal still draws offline; it never fetches tiles ahead.

With no signal, field work saves on the phone and sends once, in order, when
the signal is back: knocks, new people and doors (staff), dropped pins, sign
requests and their Undo, and *Count me in* / *Can't make it*. The map's doors,
the Calls list, shifts and walk lists keep their last loaded copy on the
phone for a day ("Offline copy"). With signal a screen always asks the server
first, so a copy never hides a knock. Sign-out forgets them, and so does a
sign-in the server says is over. Anything the server
refuses on the way is kept and listed under the strip's "saved on this phone"
chip ("this device" on a computer) with the reason — *Try again* or
*Dismiss*.

Desk screens keep the last copy each sign-in loaded — Today, People and its
search, profiles opened, Shifts, Signs, Calls, Money (desk roles), the Inbox —
and the strip says when it's from (*No signal · from 2:14 pm*). On a profile,
a rating with its note and tags put on or taken off save on this device and
send once; every other write says it needs signal (*Adding people needs
signal*). Copies are keyed to the person, campaign and role. They are a day
old at most (older ones are dropped when the app opens) and are forgotten at
sign-out (in every open tab), when the session ends, and when the person's
role changes. On a desk sign-in, Today, profiles, Money and People lists (they
carry donor tags) are kept for that browser tab only; the map's doors and the
Calls list stay in the browser for a day. Wifi with no internet, or the server
restarting (502/503), reads as *No answer*: the app stays signed in on its kept
copies and asks again every 15 s. Two tabs share one outbox. Sign-out sends a
note still typed on an open card first; after sign-out nothing is saved on the
computer. A screen never loaded on this device says *No signal — this loads
when you're back online.*

## The brand

Imagine Surrey's brand guidelines (2.1) are applied in two places and nowhere
else: `web/src/app.css` (the staff app's tokens: Surrey Navy `#003979`,
Deep Navy `#00224d`, Marigold `#ffc72c`, the text-safe red `#c8151b`, Sky,
Paper, Rule, Ink and Slate) and `server/ext/website/assets/site.css` (the
public site; the two colours a manager can change default to navy and the
text-safe red). Barlow Condensed carries headlines and labels, Inter
everything people read; both are self-hosted under `web/public/fonts/`
(Latin and Latin Extended, SIL Open Font License) and served to the app and
the site alike. The rules the code keeps: marigold is never text on white or
cream; white on Signal Red only at 19px bold and up, so buttons use the
text-safe red; grounds are flat, and depth is the rise — a Deep Navy block
with an edge climbing at 24 degrees — never a gradient. The logo is the
supplied artwork only: the site shows it once uploaded under Website →
Settings and its name until then; the staff app's own tile (`web/public/icon.svg`)
is the rise and the marigold bar, no star.

## Architecture

**Five primitives** — Person (first-class table, real FKs) · Record
(schema-typed rows from one registry) · View · Action (the only write path) ·
Signal. **One event log underneath**: every mutation is one transaction —
typed table writes + event append + hash-chain advance commit together or not
at all (one exception: an email open or click is written on its recipient's
row without the campaign's write lock, and a job puts the first of each on
the log within a minute). The `events` table is the sync protocol (`GET /api/events?since=`),
the audit trail (`GET /api/audit/verify`), and the public API. `GET /api/export`
returns every campaign table (each feature's too), event log included — never
sign-ins or a link's secret token. Money is integer cents; donors are
foreign keys; the cap engine sums `SUM(amount_cents)` per `person_id` per
calendar year against `cap_rules(jurisdiction, year)` — Imagine Surrey
defaults to `bc-municipal` (LECFA).

Database: PGlite (embedded, real Postgres) — in-memory for tests, file-backed
via `STARBASE_DATA=./data`; hosted Postgres via `DATABASE_URL` in v0.3.
Tenancy is a membership (`user × workspace × role`: manager / treasurer /
staff / volunteer). **Volunteers** can rate doors, log calls and texts, drop
pins, request signs, add a new housemate (name and phone) at a door in
their turf, and keep *My people* (the people they know: add, call or text,
or rate a talk in person). The server never shows them money (profiles return no
gifts, totals, or donor tier; Today has no money), and refuses them the gift
ledger, exports, the raw event log, the audit replay, and the subscriber,
signature, and blast lists.

**What faces the internet** (`server/lib/guard.js`): request bodies are
capped (256 KB; 16 MB for a CSV import, 4 MB for a picture); the address
a request is from is the entry `STARBASE_TRUSTED_PROXIES` hops from the
right of `X-Forwarded-For` (default 1 — one proxy, as on Render), never
what the sender wrote; public writes are limited to 30 per 10 minutes per
address and sign-in to 30 tries per address and 10 failures per email per
15 minutes; a cookie-carrying write must be the app's own (JSON, same
origin — a form on another host, even under the campaign's domain, can't
post with it; the session cookie is `SameSite=Strict`); open store
checkouts are capped at 2 per address; and every answer carries
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and a
referrer policy. The event log keeps no sign-in, invite or Stripe secrets
and no image bytes.

## Run

Taking it live for the campaign, step by step: [GOING-LIVE.md](GOING-LIVE.md).

```sh
cd starbase
npm install
npm test                 # server suite, in-memory Postgres, no setup
node e2e.mjs             # browser journey against a running server (see header)
npm run build            # web → web/dist
STARBASE_DATA=./data node server/index.js   # API + web on :3200
```

```
shared/registry.js     schema registry (DDL + zod + UI hints from one source)
shared/canvass.js      ratings, channels, signs, roles, tags, tiers
server/lib/events.js   runAction: the transactional event-log spine
server/lib/cap.js      entity-keyed contribution-cap engine
server/lib/notify.js   email/SMS adapters (Resend/Twilio via fetch)
server/actions/        the Action registry (index.js core, field.js field+outreach)
server/routes/         auth · api (reads) · public (pages + website bridge)
web/                   Vite + React 19 + react-router + TanStack Query + Leaflet
```

⚠️ `cap_rules` is seeded with Elections BC's 2026 local-elections limit,
$1,429.70 per contributor for the calendar year (one limit for an elector
organization and its endorsed candidates together), and 2022's $1,250.
Confirm the figures with Elections BC before a filing relies on them.
