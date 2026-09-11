# Miles Tracker

Credit card spend, limits, minimum-spend progress, and sign-up promo tracking.
Runs entirely on Cloudflare's free tier. No domain, no email, no API key.

- **Telegram bot** — logging spend, alerts, and login, all in one channel
- **One Cloudflare Worker** — API, database, two nightly crons, and the dashboard
  itself as static assets, all on a single origin
- **Cloudflare D1** — SQLite that doesn't sleep on inactivity
- **Claude Pro, by hand** — turns T&C prose into eligibility rules; no API key needed

Running cost: zero.

---

## What it tracks

**Limit monitoring.** Per-card utilization against the current statement cycle,
with alerts at 50 / 80 / 90%. It also reports *total* utilization across all
cards, which is what a credit score actually reads — one card at 85% matters
less than every card sitting at 60%.

**Minimum spend**, in both forms, because they behave differently:

- *Monthly minimum* — the recurring floor that unlocks an elevated earn rate.
  `DBS WWMC — $340 / $800 this month, $460 to go, 12 days left.`
- *Sign-up minimum* — one-shot, tied to your approval date.
  `UOB PRVI — $620 of $1,000 left, deadline 14 Nov, ~$35/day.`

And `bonus_cap`, the mirror of a minimum: once you pass the cap, the elevated
rate is gone and further spend belongs on another card. That's where miles
actually get lost, so it gets its own alert.

**Promotions.** A nightly RSS scan across miles blogs. Matches arrive in
Telegram with Track / Ignore buttons.

**Eligibility.** Tracked offers get their T&C turned into typed predicates —
`{"type":"no_issuer_card_within_months","issuer":"DBS","months":12}` — which a
deterministic evaluator runs against your own card history. The LLM only does
extraction; the verdict is computed from your data, and every clause keeps the
verbatim sentence it came from. Anything the rules can't decide returns
`needs_review` rather than a guess, because a wrong "eligible" costs a hard
pull and a 12-month cooldown.

---

## Setup

**[SETUP.md](SETUP.md) is the full walkthrough**, with two paths:

- **Path A — no terminal.** Cloudflare dashboard plus a git connection; every
  push builds and deploys. Use this on StackBlitz, a Chromebook, an iPad, or
  anywhere Wrangler won't run. *(Wrangler cannot run in a StackBlitz
  WebContainer — it needs native binaries and a local OAuth socket.)*
- **Path B — local terminal.** The Wrangler CLI, if you have a normal shell.

Both end up in the same place, and you can use both.

## Daily use

```
25.40 wwmc lunch          log spend — amount, nickname, note
/status                   full digest
/cards  /offers  /reqs    listings
/help                     everything else
```

Two crons fire daily: 08:00 local scans the feeds, 09:30 local sends the
digest. Threshold alerts also fire the moment a transaction crosses one.

### Adding a card and its minimums

```
/newcard DBS|Altitude Visa|alt|8000|18|2025-03-04
/req alt|signup_min|1000|fixed_window|2026-11-14||30k miles
/req wwmc|monthly_min|800|calendar_month||1000|4 mpd on first $1k
```

`/req` fields are `nickname|kind|amount|window|deadline|cap|note`.
Window is `calendar_month`, `statement_cycle`, or `fixed_window`.

When you close a card, use `/closecard alt|2026-09-01` — eligibility cooldowns
run from the closure date, so this is what keeps future verdicts honest.

### Working an offer

1. The nightly scan posts a match → tap **Track** → it becomes offer #N.
2. `/extract N` → the bot sends a prompt with the JSON schema baked in.
3. Open the T&C, paste the prompt plus the terms into Claude Pro.
4. Paste the reply back: `/save N {…}`.
5. The bot evaluates it against your card history and answers immediately.

About two minutes per offer, a handful of offers a month. There is no way to
automate step 3 on a Pro subscription — Pro and the API are separate products
and Pro has no programmatic access — but you're reading the clauses at the
moment you're deciding whether to apply anyway.

---

## Automatic transaction logging

**Android.** Your bank's SMS alerts can be forwarded straight in. Install any
SMS-to-webhook forwarder, point it at:

```
POST https://miles-tracker.<you>.workers.dev/api/tx?t=<token>
{"nickname":"wwmc","amount":"25.40","note":"merchant"}
```

Use the token from `/app`. Most forwarders let you regex out the amount from
the SMS body; one rule per card, matched on the last four digits.

**iOS.** Apple doesn't expose incoming SMS to automations, so there's no way to
do this automatically — it's manual entry. The fastest version is a Shortcut
that hits the same endpoint: *Ask for Input* (Number) → *Choose from Menu* for
the card → *Get Contents of URL* (POST, JSON body as above). Pin it to the Lock
Screen or the Action Button and it's about five seconds per transaction.
Telegram works too: `25.40 wwmc lunch`.

---

## Layout

```
schema.sql            tables; money in cents, dates as ISO text
src/index.ts          Worker entry: webhook, JSON API, cron
src/telegram.ts       bot commands and inline buttons
src/spend.ts          statement cycles, utilization, requirement progress
src/digest.ts         the daily report and threshold alerts
src/rss.ts            feed fetch, parse, keyword gate
src/eligibility.ts    predicate evaluator — the deterministic half
src/extraction.ts     the prompt handed to you for Claude — the LLM half
src/auth.ts           HMAC magic-link tokens
migrations/           ALTER statements for databases created before a change
web/                  React + Vite PWA, served by the Worker as assets
.github/workflows/    CI: typecheck, both test suites, dashboard build
```

## Adding feeds

`/addfeed https://example.com/feed/|Label`, or edit `seed.sql`. Any RSS or Atom
feed works. The keyword gate in `src/rss.ts` requires a promo term *and* a card
term, and always matches your own cards' product names.
