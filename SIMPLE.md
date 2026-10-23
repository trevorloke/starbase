# Simple — the Starbase interface rules

Starbase is used at a door, on a phone, by a volunteer who has never seen it
before and has thirty seconds. Every screen follows these rules. When a rule
and a feature disagree, the feature moves behind a tap — it is never deleted
and never crowds the screen.

## The rules

1. **One screen, one job.** Each screen opens on the thing people come to do
   most. The title says it in plain words ("Doors", "Calls", "Shifts").

2. **One yellow button.** Each screen has at most one primary (yellow)
   action. Everything else is quiet. No more than three buttons in a header.

3. **No paragraphs.** Helper text is one short line (≈ 12 words) and only
   where a first-timer would otherwise be stuck. Never explain how the
   system works. Empty states: one line + one button.

4. **Show less, reveal more.** Optional form fields sit under "More
   details". Advanced filters, history, settings, exports, and audit tools
   sit under "More" or on a second level. A first look shows the common
   path only.

5. **Their words, not ours.** Doors, calls, texts, supporters, signs,
   volunteers, donations, turf, walk list. Never: IDs, slugs, cursors,
   workspace, record, action, event log, JSON, payload. Link slugs are made
   automatically and only shown under "Link".

6. **The field is sacred.** On the map, the door card, the walk list, and
   the call list, the rating buttons are the hero: big (≥ 48 px), in thumb
   reach, nothing competing. One tap logs; a toast confirms; undo is right
   there.

7. **Numbers, not sentences.** Status is a big number with a short label
   ("124 doors this week"), a bar, or a coloured chip — not a sentence.

8. **Lists, not tables, on phones.** On a phone every list is a stack of
   rows with the name first and at most two facts. Tables are for desks.

9. **Same shape everywhere.** Title on the left, the one primary action on
   the right, filter chips under it, then the list. Detail opens in place.

10. **Short confirmations, in place.** "Delete this turf? Yes · No" — never a
    browser pop-up, never a paragraph of warning.

## What each role sees first

- **Volunteer** — Today is one big "Start canvassing" (their walk list, or
  the map) plus their next shift. Tabs: Today · Map · Calls · Shifts.
- **Staff / treasurer / manager** — Today is the campaign at a glance in
  numbers; tabs: Today · Map · People · Shifts · Money · Signs · Outreach.

## How we check

For every screen, at phone (390 px) and desktop (1360 px), as a manager and as
a volunteer, on the Imagine Surrey sample campaign:

- **Visible words** (in the page, excluding the nav) — a simpler screen has
  far fewer. Recorded before and after every change.
- **Yellow buttons** — at most one.
- **Sideways scroll at 390 px** — none.
- **Tap targets on field screens** — at least 48 px.
