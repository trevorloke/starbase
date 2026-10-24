# Testing Starbase

Everything below works from a fresh install. Start with **Run it on your
computer** — five minutes, no accounts needed — then deploy when you want your
team on it.

---

## 1 · Run it on your computer

Needs [Node.js 22](https://nodejs.org).

```sh
git clone https://github.com/trevorloke/starbase.git
cd starbase
npm install
npm run build
npm start                 # → http://localhost:3200
```

1. Open **http://localhost:3200/signup** and set up Starbase for Imagine
   Surrey: your name, email and password. You become its manager (the
   workspace is *Imagine Surrey*, **BC — Municipal**). Setup works once:
   after that `/signup` says it's already set up, and everyone else joins
   by invite from **Team**. (To start over, delete `data/`.)
2. On **Today**, press **Load sample data**: 52 Surrey voters across Newton,
   Whalley, Guildford, Fleetwood, Cloverdale, and South Surrey — with ratings,
   signs, donors, a shift, an event, a petition, and a Newton turf.
   **Clear sample data** removes it all later (your own records stay).

Your data lives in `data/`. Stop with Ctrl-C; it's still there next
time. Delete the folder to start over.

> Testing on your phone on the same Wi-Fi: open `http://<your-computer's-IP>:3200`.
> Location ("Locate me") and "Add to Home Screen" need **https** — use the
> deployed version for those.

---

## 2 · Deploy for the team (Render)

The repo's `render.yaml` includes a **starbase** service with a managed
Postgres database (backups included).

1. Render → **New → Blueprint** → pick this repo (`main` branch)
   → it creates `starbase` + `starbase-db` (both on paid plans — check
   Render’s current pricing).
2. In the `starbase` service → **Environment**, set:

| Variable | What for | Needed to test? |
|---|---|---|
| `STARBASE_PUBLIC_URL` | your address, e.g. `https://starbase.imaginesurrey.ca` — used in invite, unsubscribe, and payment links | **yes** |
| `RESEND_API_KEY`, `MAIL_FROM` | real email (invites, newsletters, press, shift alerts) | optional — without it, sends are saved as *queued* and invite links are shown to copy |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | SMS shift alerts; texting and calling from the app through the campaign's number | optional — without it, Calls opens the phone's own Messages and dialer |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | card donations | optional — without it the donate page takes **pledges** |

| `STARBASE_SITE_HOSTS` | the public website's own domain(s), e.g. `imaginesurrey.ca,www.imaginesurrey.ca` — those hosts get the site at `/` | optional — without it the site is at `/site/` |

For Stripe, add a webhook in the Stripe dashboard pointing at
`https://<your address>/api/public/stripe/webhook` with events
`checkout.session.completed`, `invoice.paid` (donations) and
`checkout.session.expired` (the store: abandoned checkouts). The store uses
the same key and webhook as donations. Use **test mode** keys
(`sk_test_…`) and card `4242 4242 4242 4242` while testing.

For Twilio, set the number's incoming messages webhook to
`https://<your address>/api/public/twilio/sms` (HTTP POST). Calls through the
campaign also need `STARBASE_PUBLIC_URL`; `TWILIO_VOICE=off` keeps texting
and turns calling off.

Any Docker host works too: `docker build -t starbase .` then run with
either `DATABASE_URL=postgres://…` or a volume at `/data`.

### The public website (imaginesurrey.ca)

Starbase serves the campaign's whole public site from the same service.

1. Render → `starbase` service → **Settings → Custom Domains** → add
   `imaginesurrey.ca` and `www.imaginesurrey.ca` (keep
   `starbase.imaginesurrey.ca` for the staff app). At the domain registrar,
   add the DNS records Render shows (an `A`/`ALIAS` record for the bare
   domain, a `CNAME` for `www`). Render issues the certificates.
2. Set `STARBASE_SITE_HOSTS=imaginesurrey.ca,www.imaginesurrey.ca`. Those
   hosts now show the site at `/`; the staff app stays on its own host.
   `/api`, `/e`, `/d`, `/n`, `/v`, `/p`, `/u` and the app's own screens
   keep working on every host. Before DNS is ready, the site is at
   `https://starbase.imaginesurrey.ca/site/`.
3. Edit everything in the staff app → **Website** (managers and staff):
   Pages · News · Events · Team · Store · Orders · Settings. Fill
   **Settings → Authorized by** before the site goes public.

What to try: publish a page (drafts never show), post news with a cover
picture, add an event with a picture (it's the same event list as
Outreach → Events), add a team member, add a product with sizes and stock,
then open the site on a phone. Without Stripe keys the store shows its
items and the cart says *Online store opens soon*; with test keys, check
out with card `4242 4242 4242 4242` and watch the order arrive under
Website → Orders as *Paid*, its stock go down, and the buyer appear in
People tagged `store`.

---

## 3 · What to test, by role

Invite real people from **Team** (tap your initials, top right — managers
only). Each invite is a one-time link — emailed if email is connected,
otherwise copy and text it.

Every screen has one yellow button: that's the main job. Everything else is
one tap away under **More**.

### Manager (you)
- **Today** — three big numbers (doors this week · support · raised); tap
  *Support* for the breakdown by candidate. **Needs you** lists what's waiting:
  gifts over the limit, open pledges, filings due, shifts short of people,
  signs to put up.
- **Outreach → Newsletter** — without email connected, a newsletter is
  *Saved — not sent*; connect email (Resend) and tap *Send now*. A send
  that partly fails says *Sent to 1 of 2 — 1 failed* with *Try again*. A
  big list says *Sending · 40 of 340* and counts up while it goes out in the
  background (door knocks aren't kept waiting). If the server stops
  mid-send, the send is still listed and the rest go out by themselves
  within a few minutes of the restart; the few it isn't sure about say *We
  don't know if 3 got it*, and *Try again* sends those with the same keys
  (Resend drops a repeat).
- **Two subject lines** (50+ subscribers) — Write newsletter → *Try two
  subject lines*: A and B each go to a small group; after the wait the better
  one (by opens, or by clicks when the message has a link) goes to everyone
  else by itself, and *Last sent* shows the whole list's *All 60: opened ·
  clicked*. While writing, the plan sits under the settings (*A to 12, B to
  12, winner to 36 after 1 hour*). A tie sends A and
  says *Tie — sent A*. Opens run high (Apple Mail opens by itself); clicks
  from mail scanners aren't counted.
- **Outreach → Ladders** (automatic emails & follow-ups) — email steps go
  only to people who said yes to email (the newsletter, or *Email me updates*
  on a petition); everyone else shows *Email skipped — didn't ask for email*.
  *+ First name* / *+ Campaign* fill in. The email's unsubscribe link asks
  first; once someone unsubscribes, **Newsletter → More → Subscribers** can't
  add them back — only they can, from the signup page.
- **Outreach → Website** — set the Imagine Surrey website address; copy the
  public volunteer page (`/v/imagine-surrey`), newsletter page
  (`/n/imagine-surrey`), petition, event, and donate (`/d/imagine-surrey`)
  links; *For your web developer* has the embed code for the site.
- **Team** — invite a volunteer and a staff member; change a role.
- **Rating scale** (your initials → *Rating scale*) — change the words on 1
  (e.g. *Definitely*), rename a candidate, **Add** one, move it with ↑ ↓,
  **Take off** one (*Take Locke off the list? Yes · No*). The preview shows
  the buttons as volunteers will see them; **Save**. Locke now sits under
  *Off the list* with how many people have that rating and *Put back*;
  people already rated Locke read *4 · Locke (off the list)* on People,
  profiles and the *Voting for…* filter, and still count on Today. Staff,
  treasurers and volunteers have no Rating scale (typing `/rating-scale`
  lands on Today). Type a new name over a candidate people were rated for:
  the row says *3 people rated McCallum will read Bains — someone new?*;
  **Add them instead** keeps McCallum and adds Bains. A row renamed to
  someone off the list, to a step's words (*Undecided*) or to a name already
  on the list says why under it, and Save refuses it. With 12 on the list
  *Put back* is off (*12 at most on the list — take one off first*). Filter
  People → *Opposed*, add a candidate, rate someone for them, reload: the
  same Opposed link (and the Call list carried from it) still finds them.
- **People → More → Profile fields** → **Add a field**: a name, a type (Text ·
  Yes/No · Pick one · Number · Date), its choices, and *Volunteers can see
  this* (off by default). Tap a field to rename it, add a choice or *Move
  up*; once something is filled in its type can only become Text — a Text
  field's stays Text (the screen says so). A new choice can always be fixed
  or removed with ✕. **Take off** keeps everything filled in (still in *Export all
  data*); *Taken off → Bring back* restores it. The sample adds *Language at
  home*, *Strata council member* and *Union local*.

### Volunteer (on a phone)
- Open the invite link → set a password → lands on the **Map**. Tabs:
  **Today · Map · Calls · Shifts**.
- **Today → Start canvassing** opens your walk list (doors in walking order:
  odd side up, even side back). Tap a door → **1 · 2 · 3 · 4** (each says what
  it means). **4** asks *Voting for?* — McCallum · Locke · Annis · van Vliet ·
  Randhawa · Not sure (or the list your manager set; *Not sure* is always
  last). A toast confirms; *Change* fixes a mis-tap.
- **My people** (a quiet row on Today, *My people · 6*, and on Calls) — the
  people you know. **Add someone**: a name, a phone or an email, how you know
  them, and an optional note under *More details* (it shows on the row:
  *Neighbour · Book club*). Someone already on the list with that name and
  phone is linked, not added twice, and so is someone you added before with
  that name and email. Anyone else is new and *Brought in by* you. An email
  never links you to someone, so you can't tell whose email it is; if
  someone already has that email (or name), the desk sees *May be the same
  person as …* on both profiles. With no signal an add or a rating is saved
  on the phone (the row says *Offline*; the line turns to *✓ Added …* once
  sent); *Remove* needs signal. Tap a person → *Phone · Text · In
  person* (Phone and Text are the Calls card; In person is a talk away from
  their door) → one tap on 1–4 logs it (*✓ In person · Rated 1 · Strong
  yes*). The sample volunteer *Priya Nair* (invite `priya.nair@example.org`)
  already knows six people, and still does after *Clear sample data* →
  *Load sample data* (her own record is used again, never doubled).
- A long candidate name, or one off the list, never pushes the address or
  names aside: on the walk list and the door card's tabs the chip ends in …
  (its full words on long-press), and two people at a door who don't fit
  side by side go on two lines.
- **More** on a door: note, Call / Text (the phone's own dialer; with Twilio
  connected, the person's card on Calls), request a lawn / large sign or
  billboard (with Undo), add a person at the door.
- **Calls** — one person at a time: Call or Text, then rate; *No answer*,
  *Refused*, *Skip*.
- **Texts** (Twilio connected) — Calls → Text: the message is filled in; edit
  it, *Send*, then *Next →*. Whoever you texted leaves the list until they
  reply; then they come back first, with their reply on the card and a blank
  reply box. Someone another volunteer (or the desk) is texting says
  *Already texting with the campaign*. New replies show as *New replies · N*
  (a count on the Calls tab, a row on Today) → **Inbox**; answer from there.
  A reply like "No thanks, stop" is flagged with *Opt out this number*.
  With no signal Send stays off (*Texts send with signal*). A profile's Call
  and Text open the same card. **Call** rings your own phone first (enter it
  once): answer, press 1, and you're connected — they see the campaign's
  number. With no signal, Call is your phone's own dialler (*No signal —
  this calls from your own number*).
- **Shifts** — *Count me in* on an open shift; *Can't make it* to drop out.
- **Signs** (from Today when there are signs to put up) — *Put up ✓*.
- **Offline**: turn on airplane mode, rate three doors (they say *Saved
  offline*), *Count me in* on a shift (*Take back* undoes it before it
  sends), add someone to *My people*, turn it off — they send once, never
  twice, and the strip says *5 sent*. The strip's *saved on this phone* chip
  lists what's waiting. Reload with no signal: the campaign's own rating
  buttons still show, and Today, Calls, Shifts and any profile you opened
  read from the phone (never with money or anyone else's email).
- Confirm a volunteer **never sees money or the supporter list**: no Money,
  People or Outreach; typing those addresses lands back on Today. (The
  server enforces this too: their browser never receives other people's
  emails or donor tags.)

### Staff
- **People** — search; **Filter** by rating, tag (media, VIP…), or volunteer
  role (incl. *Hi-rise building captain*); open a profile; add tags, roles,
  social handles. **More → Call list / Text list** opens Calls with the same
  filter; **More → Inbox** has every text conversation.
- **Shifts** — **New shift** (what, when, where, how many; role,
  instructions and link under *More details*), **Add volunteer**, then
  **Notify everyone** (email + text). Without email/text connected the
  button says *Save — nothing sends*; once connected, *Notify again* reaches
  them. Nothing on any screen claims to be sent unless it was.
- **Signs** — tap *To put up* / *Up* / *Taken down* to filter; **Add a sign**
  (it needs an address); a request that never went up can be *Cancelled*.
- **Map → filter button → Draw turf** — tap the corners, name it, assign a
  canvasser.
- **A profile → More details** — tap Yes/No or a choice, type the rest,
  **Save** → *✓ Saved*. **People → Filter → More filters** → e.g. *Language
  at home: Punjabi*; *More → Call list* keeps it. Volunteers see only the
  fields marked for them, read-only. Follow *Same address* to the next
  person: nothing you typed or saved goes with you.
- **Who knows whom** — **People → More → Most connected**: the sample's
  *Priya Nair* is first (*knows 6 · 1 supporter*). Open *Jasmine Wong*
  (undecided): under the rating, *Ask Priya Nair — they know each other*.
  **Knows** lists who someone knows; **+ Someone they know** → search → *how
  do they know each other?* links them both ways; *Remove? Yes · No* takes
  it off. *Sofia Petrova → Knows* says *Brought in by Priya Nair*. Someone
  tagged *do-not-contact* gets no nudge and is never the one suggested. A
  long note (a link) wraps in Knows.
- **Desk with no signal** — with wifi, open Today, People, a profile,
  Shifts, Signs, Money and the Inbox. Turn wifi off and reload: each shows
  what it had and the strip says *No signal · from 2:14 pm*. Search People —
  it searches what this tab kept. A profile never opened says *No signal —
  this profile loads when you're back online*. On a profile, add a note and
  tap a rating, add a tag, remove one: *Saved on this device — sends when
  you're back online*, and History shows *Not sent yet*; a note typed on its
  own goes out when you leave the profile. *More details* shows what it had,
  read-only (*Changing these needs signal*); Knows and its nudge show from the
  kept copy, with *+ Someone they know* and *Remove* off (*Adding and removing
  need signal*). *Add person*, *Log a gift*, *Add a sign*, *New shift*, *Edit
  details*, *Get invite link*, *Add filing*, *Clear sample data* and Profile
  fields changes say they need signal. Rating scale, Team and a shift never
  opened say *No signal — this loads…* with no time in the strip. A People or
  Calls filter on a profile field never opened with signal says *No signal —
  the list loads when you're back online*, never the whole list. Wifi back:
  each is sent once.
  - **Two tabs**: with no signal, rate someone in one tab and tag someone in
    another, close the first, reconnect: both are sent once.
  - **Wifi with no internet** (router up, uplink down): reload and you're
    still signed in, the strip saying *No answer · from 2:14 pm*; it clears
    by itself. **Server down** (502 during a deploy) in a new tab: People says
    *No answer — check your signal*, never *0 people*.
  - **Sign out**: a note still typed on a profile or door card is sent first,
    as yours; nothing stays, the next person on that computer sees none of
    it, and another open tab goes to Sign in.

### Treasurer
- **Money** — **Log a gift**; log enough to one donor to cross the annual
  limit (sample: *Arjun Mehta* is already over). Donor tiers on profiles:
  star ($1K+/yr or $100+/mo), superstar ($3K+/yr or $250+/mo).
- **Donate page** (`/d/imagine-surrey`, in a private window): try without the
  eligibility boxes (refused), more than the annual limit (refused), then a
  real pledge → it appears under **Money → Needs you** → *Mark paid* turns it
  into a gift (cap-checked). Voiding that gift reopens the pledge; a monthly
  pledge stays open and is marked paid month by month.
- **Money → More → Receipts** — every gift gets a numbered receipt
  (`2026-0001`, no gaps) the moment it's logged, marked paid, or paid by card;
  open a gift on Money to see *Receipt 2026-0007 · Sent*. Without email
  connected each one says *Not sent — email isn't connected* (or *No email on
  file*) — tap it, then **Print**. With email connected it goes to the donor
  once by itself a minute after the gift (the toast says *receipt emails in a
  minute*; Undo before then and nothing is sent); *Send again* resends;
  **Email 3 receipts** (the yellow button) sends the *Not sent* ones with an
  email, never one already *Sending*. A donor with no street address: Log
  a gift asks for it under *More details*; left blank, the receipt says
  **Needs address**, shows under **Money → Needs you** (type it right there)
  and its email waits until the address is saved. Voiding a gift marks its
  receipt **VOID** (the number is kept); if the receipt was already emailed,
  Money asks *Receipt already emailed — send a void notice?* Set the
  financial agent, the minimum gift and the footer under **More →
  Settings** (the campaign's dates under *More details*); **More →
  Disclosure** picks a period (this campaign, or a calendar year) and
  downloads contributors over $100 for a spreadsheet, with an *Over limit*
  column. Sample gifts are never in it.
- **Today → More → Verify my books** replays the tamper-evident log;
  **Export all data** downloads everything.
- **Money and People with no signal** read only in the same browser tab
  (money and donor lists are never kept past the tab): close the tab, reopen
  with no signal, and Money says *No signal*. Make a volunteer a treasurer
  while their app is open: Today's money stays in their tab; make them a
  volunteer again and, after a reload, nothing a treasurer saw is kept.

### Public volunteer page
- `/v/imagine-surrey` in a private window: tick *Hi-rise building captain* —
  it asks which building; *Translation* asks the language. Each ticked role is
  saved with its own detail, and the note lands once on the person's profile.

### Import your own lists
**People → More → Import.** Try `samples/surrey-import-test.csv` first —
fictional people at *public building* addresses (City Hall, rec centres). The
check step should report **9 new, 1 merged** (Jordan Lee appears twice with
the same email) and **1 refused** (the row with no name); Robin Kaur's rating
"7" isn't on the scale, so she comes in unrated and the check step says so.
Ratings import as codes, words or candidate names in any case (*definitely*,
*Locke*, *4b*). A column named like a profile field (any case, any script —
*语言*, *ਭਾਸ਼ਾ*) fills it; a bad cell (e.g. *Klingon* for *Language at home*, or
*1 2 3* for a Number) is refused by row number. A field taken off before you
tap Import is skipped; the row still comes in.
Then **Place on map** looks the addresses up with the BC Address
Geocoder (needs internet). It runs on the server: you can close the page and
it keeps going (come back to Import or the map to see how far it's got, or
**Stop** it). Everyone at one address is one lookup, and an address already
on the map is copied without a lookup. If the geocoder stops answering, the
run pauses with the reason; **Carry on** resumes it. Addresses it can't find
end up under **Not on map** for a pin by hand.

A full voter list (hundreds of thousands of people) takes a few hours. Set
`BC_GEOCODER_KEY` (a free key from the BC government's API gateway) for
higher limits, and `GEOCODE_CONCURRENCY` (default 6) to ask more at once.

For your real voters list: map its columns on the second step; re-importing
the same file never creates duplicates.

---

## 4 · Known limits in this build

- Map tiles come from OpenStreetMap; very large teams should switch to a paid
  tile provider before election week (`STARBASE_TILE_URL`, see the README).
- Offline covers **field work** (knocks, new people and doors, pins, sign
  requests, shift sign-ups, *My people*) and **reading the desk**; on a
  profile, ratings, notes and tags save offline. Gifts, imports, outreach
  and other edits need signal. Receipts and Filings aren't kept offline
  (Filings says *No signal* and its buttons are off).
- The BC municipal contribution limit is seeded at Elections BC's 2026
  figure, **$1,429.70** per contributor for the calendar year — one limit
  shared by an elector organization and its endorsed candidates (2022:
  $1,250; 2023–2025 gifts are checked against $1,250, the lower, until
  those years' figures are added). Confirm with Elections BC before filing.
- Without Twilio, calls and texts use the phone's own dialer and messages
  (no auto-dialer).
- Contribution receipts: the wording (including the *not tax-deductible*
  line), what a receipt must show, the minimum gift that gets one and the
  $100 disclosure amount are all settings — **the financial agent must
  confirm receipt contents and thresholds with Elections BC** before
  receipts go to donors or the disclosure is filed. The same goes for the
  disclosure's **period**: unset, *This campaign* is the current calendar
  year — confirm the election period with Elections BC and set it under
  Receipts → Settings → More details.
- Card gifts are dated by the campaign's day (Pacific). Card receipts issued
  before this fix used the UTC day, so a card gift paid after 4–5 pm
  Pacific may show the next day: compare card receipts with the Stripe
  dashboard before filing.

### Texting and calls — confirm with counsel

Built conservatively; the campaign should confirm these rules with counsel
(CRTC rules, the Voter Contact Registry) before texting or calling voters:

- Every text is one person tapping *Send* for one person — no bulk or
  scheduled sends, no auto-dialer.
- The first text to someone names the campaign and ends "Reply STOP to opt
  out".
- STOP, STOPALL, UNSUBSCRIBE, CANCEL, END or QUIT (punctuation and emoji
  ignored — "STOP 🙏"; clear requests such as "Please stop texting me" too)
  opts that number out at once and for good (tagged *do-not-text*); START or
  UNSTOP opts it back in, and takes off only the tag its STOP put on — a
  *do-not-text* the desk set by hand stays. A reply that only has a stop
  word in it ("No thanks, stop") is flagged in the thread; *Opt out this
  number* (any role in the thread) is the same opt-out.
- One campaign conversation per number: while someone's conversation with a
  number had a text in the last 7 days, nobody else sends another
  introduction, and replies stay in the conversation the voter last replied
  in.
- Quiet hours: texts and calls go out only 9 am–9 pm Monday to Friday and
  10 am–6 pm on weekends (the CRTC's telemarketing hours), Surrey time, by
  default — **confirm both with counsel**; managers change them under
  **Inbox → More → Texting settings**. The server refuses anything outside
  them, shift notices included (*Text not sent — quiet hours*). Shift
  notices are never texted to an opted-out or do-not-text number.
- Calls show the campaign's number, never the caller's own.
