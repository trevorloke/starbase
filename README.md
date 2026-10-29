# Starbase

The campaign OS built for **Imagine Surrey**. Field-first: a map with every
door on it, a one-tap rating scale at the door, phone, and by text — with
signs, volunteers, shifts, money, compliance, and outreach around it.

## Two apps: the field app and the admin

One build, two apps, told apart by the address:

| | Address | Who | What |
|---|---|---|---|
| **Field app** | `/` | everyone — it is what a volunteer sees and uses | Today · Map · Calls · Shifts · ImagineU, the door card, walk lists, your call lists, your people, your texts. A manager who opens it gets exactly a volunteer's screens (and *Admin ↗* in the account menu). |
| **Admin** | `/admin/` | managers, staff, treasurers — and a volunteer given an area under Permissions | everything: the dashboard, the map with turfs, People and imports, Shifts, Donations, Signs, Outreach, ImagineU's editor and Progress, phone banks, **Settings** (members, teams, permissions), the rating scale. A plain volunteer who opens it is told it isn't theirs. |

Signing in sends each person to their app: a desk role to the admin, a
volunteer to the field app. A desk address typed into the field app
(`/people`, `/money`, an old bookmark) goes to the admin.

## The seven things a campaign does (the whole tab bar)

Every screen is built to [SIMPLE.md](SIMPLE.md): one job per screen, one yellow
button, no paragraphs, everything else one tap away.

| Screen | What it is |
|---|---|
| **Today** | Managers: the **dashboard** — every team's contacts, the chart over time, and the map of who is out where. Desk: three big numbers (doors · support · raised) and *Needs you*. Volunteers: one big *Start canvassing* and their next shift |
| **Map** | Field mode. Houses as clickable pins; tap a door → rate, log, request a sign, call/text. Turfs and walk lists |
| **People** | Everyone, filterable by rating / tag / role / the campaign's own fields; profiles with socials, roles, gifts, history, *More details* and who they know; **Calls** works a list one person at a time; **My people** is each volunteer's own circle |
| **Shifts** | Schedule volunteers, assign by role, notify by email + text with instructions and a link; volunteers tap *Count me in* |
| **Donations** | Gifts (one-time / monthly), each to one slate — city council or school board — with the entity-keyed cap engine (the annual limit is per contributor per slate); receipts; donor tiers — the only money Starbase tracks |
| **Signs** | Billboards (4×8), large (4×4), lawn — requested → installed → removed |
| **Lists** | Saved filters (a tag, a rating band, a role, has an email…) and hand-picked lists of people: an audience for an email or text blast, a CSV, a report; People's *Save as a list* starts one |
| **Reports** | The campaign in numbers (people by rating, tags, cities, people added by week, contacts by week, donations by month, the newsletter list, sends), each downloadable as CSV; any table as a spreadsheet; the full JSON export |
| **Outreach** | Newsletter + press-release blasts written in Markdown (headings, bold, lists, links, pictures; files attached; *Send me a test*); **email blasts** and **texts** to any list, with the same rules as one-to-one texts (quiet hours, STOP, do-not-contact); petitions; events with RSVP pages; the public links and the JSON bridge for the campaign's website |
| **ImagineU** | Training for every role: sections of lessons — notes, documents, videos, audio, pictures, contacts, procedures — each ticked *Done*; the desk edits in place and sees who has done what; a lesson marked public has a page anyone can open at `/learn/<slug>` |

Volunteers get five tabs — **Today · Map · Calls · Shifts · ImagineU** — plus
*Signs to put up* for sign crews; desk-only addresses send them back to Today.

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
  Donations, Signs, Outreach, Data, Admin, ImagineU. Each role has its usual ones
  (`server/lib/perms.js`); a manager can take an area from a whole role or
  give one to a single person on top of their role (a volunteer who runs
  Outreach, a staffer kept out of Donations). The server decides on every action
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
  no, true and false, and a database export's t and f; a rating column
  rated some other way (a 1–5) is mapped value by value under *What each
  rating means on your scale* (a 5 there can be a 1 here); dates come in as
  spreadsheets write them (10/21/2026, 21 Oct 2026).
- **Fix details** wherever you meet someone — under the phone on the door
  card, on the Calls card and on the profile: a name, a phone, an email,
  saved through the offline outbox like a knock. Any role; a volunteer may
  add an email only where there is none (they never see one on file — the
  card says *On file*), the desk may change any.
- **Phone banks** (People → More, or Calls → Phone banks): a named list of
  numbers to call, made from the people list (a rating, a tag, a search —
  everyone with a phone who matches, never do-not-contact), with a script.
  The desk hands numbers to a caller, or splits them across a team, takes
  unfinished ones back, closes the bank. A caller's *Your call lists* (on
  Calls) opens each bank on the Calls card, script and all; a phone call
  they log crosses the number off, *Skip* crosses one off without a call.
- **ImagineU** (a tab for every role): the campaign's training. Sections of
  lessons; each lesson is a note, a document (PDF, Word, PowerPoint, Excel),
  a video (a YouTube or Vimeo link, or a short MP4), audio (MP3, M4A, WAV),
  a picture, contacts, or a procedure, with words in Markdown and a file
  (12 MB at most) or a link behind it. Everyone ticks *Done*; the desk edits
  in place, chooses who sees each lesson (everyone signed in · the desk ·
  public — a page of its own at `/learn/<slug>`) and reads *Progress*: who has
  done which. Files are served to those who may see the lesson and are not
  in the export.
- **The dashboard** (managers, at the top of Today): contacts today, in the
  last 7 or 30 days or in all — how many, doors, calls & texts, people
  reached, support, canvassers, who is out now; a bar per day (per week on
  *All time*) stacked by outcome, Grouped and Table views; **In the field**,
  a map that stands portrait, as Surrey does, and opens on the whole city
  (the Fraser to the border, Delta to Langley) — the period's contacts (a dot at the door, coloured by outcome;
  tap one for who, the outcome, who logged it and when, with the profile
  and the map a tap away; tap a turf for its name and the map) and everyone
  who has canvassed as their initials (tap one for their day and *Only
  their contacts*) — a ring and *out now*
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
| **Action Network** | newsletter list + signup page + unsubscribe, press list + releases, petitions with public pages, volunteer signup page, event RSVP pages, donation pages (Stripe or pledges), JSON bridge for the campaign's own website, ladders of engagement, A/B subject lines with open/click tracking | — |

## Public pages and the JSON bridge

The campaign's website lives elsewhere; Starbase gives it public pages to
link to and a JSON endpoint to post to. Public pages, no login (workspace
slug from setup: `imagine-surrey`):

- `/p/:slug/:petition` — petition signature page
- `/n/:slug` — newsletter signup · `/u/:subscriptionId` — unsubscribe (the link
  asks; one tap on *Unsubscribe* does it, so mail scanners never unsubscribe anyone)
- `/v/:slug` — volunteer signup with the 15 roles (a hi-rise captain is asked
  which building; translators, which language)
- `/e/:slug/:event` — event page with RSVP · `/d/:slug` — donate

The website can also keep its own forms and post JSON here (CORS-open):

```http
POST /api/public/:slug/signup
{ "kind": "newsletter" | "volunteer" | "petition" | "rsvp", "name", "email", "phone",
  "roles": ["highrise_captain"], "detail_highrise_captain": "<building>",
  "petition": "<petition-slug>", "answer": "<to the petition's question>",
  "event": "<event-slug>", "guests": 2, "subscribe": true, "note": "…" }

```

The donate page (`/d/:slug`) takes a contribution to one slate — city
council or school board (`shared/canvass.js` SLATES) — and the annual limit
is checked per slate: what the person has given that slate this year, plus
what their monthly pledges to it will still take (a monthly gift counts
every month left in the calendar year, and must fit a full year on its
own). Paid by card, Stripe's webhook books the gift; a monthly gift
cancelled in Stripe (`customer.subscription.deleted`) closes its pledge
here, and a charge refunded in full voids its gift. A petition may ask
each signer one question (Outreach → Petitions); the answer stays with
the signature, in the list and the CSV.

Every public submission lands in the directory as a Person (deduped by email),
tagged by source, and is appended to the event log under a system actor.

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

A newsletter or press release is written in Markdown: the message field
has the editor's toolbar (bold, italic, heading, link, list, picture, and
*Link to…* for the donate, volunteer and newsletter-signup pages) and a
*Preview* that is the email's layout. A picture is kept in the database and
served at `/media/:id`, cached a year. Up to five files (PDF, pictures, Word, Excel, PowerPoint, .ics,
.txt, .csv; 5 MB each) go with every copy; *Send me a test* emails the
writer a copy first, untracked and off the record. Each email carries a
plain-text part alongside the HTML.

**Email blasts and texts to a list.** Outreach → Email blast sends to a
list (Lists: a saved filter or a hand-picked list): everyone on it with an
address who may be emailed — never do-not-email, do-not-contact or an
address that unsubscribed — each copy with its own unsubscribe link
(`/bu/<recipient>`, which tags the address do-not-email). Outreach →
Texts sends one text to everyone on a list with a number that can be
texted, through the campaign's Twilio number, by the one-to-one rules:
never a number that replied STOP, do-not-text or do-not-contact; the
campaign named in the text; "Reply STOP to opt out" on each; inside quiet
hours (a text sent at night waits, and the send job sends it when texting
opens); each filed in the Inbox as the sender's conversation, so replies
and STOP land where the desk reads them. Managers, staff and treasurers
(the outreach area) send; volunteers never. Confirm bulk texting with
counsel before the first send: the texting module was built for
one-to-one texts, and election texting rules are the campaign's to meet.

Set `STARBASE_PUBLIC_URL` (e.g. `https://starbase.imaginesurrey.ca`) so links
in outbound mail — newsletter unsubscribe footers, invite links, the
pictures in a message — point at the public host. Every newsletter and ladder email ends with "Sent by <campaign>"
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
search, profiles opened, Shifts, Signs, Calls, Donations (desk roles), the Inbox —
and the strip says when it's from (*No signal · from 2:14 pm*). On a profile,
a rating with its note and tags put on or taken off save on this device and
send once; every other write says it needs signal (*Adding people needs
signal*). Copies are keyed to the person, campaign and role. They are a day
old at most (older ones are dropped when the app opens) and are forgotten at
sign-out (in every open tab), when the session ends, and when the person's
role changes. On a desk sign-in, Today, profiles, Donations and People lists (they
carry donor tags) are kept for that browser tab only; the map's doors and the
Calls list stay in the browser for a day. Wifi with no internet, or the server
restarting (502/503), reads as *No answer*: the app stays signed in on its kept
copies and asks again every 15 s. Two tabs share one outbox. Sign-out sends a
note still typed on an open card first; after sign-out nothing is saved on the
computer. A screen never loaded on this device says *No signal — this loads
when you're back online.*

## The brand

Imagine Surrey's brand guidelines (2.1) are applied in one place and nowhere
else: `web/src/app.css` (the staff app's tokens: Surrey Navy `#003979`,
Deep Navy `#00224d`, Marigold `#ffc72c`, the text-safe red `#c8151b`, Sky,
Paper, Rule, Ink and Slate). Barlow Condensed carries headlines and labels,
Inter everything people read; both are self-hosted under `web/public/fonts/`
(Latin and Latin Extended, SIL Open Font License). The rules the code keeps: marigold is never text on white or
cream; white on Signal Red only at 19px bold and up, so buttons use the
text-safe red; grounds are flat, and depth is the rise — a Deep Navy block
with an edge climbing at 24 degrees — never a gradient. The logo is the
supplied artwork only; the staff app's own tile (`web/public/icon.svg`)
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
calendar year per slate against `cap_rules(jurisdiction, year)` — Imagine
Surrey defaults to `bc-municipal` (LECFA); the slates (city council, school
board) are `SLATES` in `shared/canvass.js`.

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
post with it; the session cookie is `SameSite=Strict`); and every answer carries
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
server/routes/         auth · api (reads) · public (pages + JSON bridge)
web/                   Vite + React 19 + react-router + TanStack Query + Leaflet
```

⚠️ `cap_rules` is seeded with Elections BC's 2026 local-elections limit,
$1,429.70 per contributor for the calendar year (one limit for an elector
organization and its endorsed candidates together), and 2022's $1,250.
Confirm the figures with Elections BC before a filing relies on them.
