# Miles Tracker

Credit card spend, limits, minimum-spend progress, and sign-up promo tracking.
Runs entirely on Cloudflare's free tier. No domain, no email, no API key.

- **Telegram bot** — logging spend, alerts, and login, all in one channel
- **Cloudflare Worker + D1** — the API, the database, and two nightly cron jobs
- **PWA on Cloudflare Pages** — the dashboard, installable to your home screen
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

**[SETUP.md](SETUP.md) is the full walkthrough** — Cloudflare account through
first logged transaction, with troubleshooting. The short version:

### 1. Create the bot

Message [@BotFather](https://t.me/botfather) → `/newbot` → keep the token.

### 2. Create the database

```bash
npm install
npx wrangler login
npx wrangler d1 create miles
```

Copy the printed `database_id` into `wrangler.toml`, then:

```bash
npm run db:init      # create tables
npm run db:seed      # load the default RSS feeds
```

### 3. Set secrets

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN   # from BotFather
npx wrangler secret put TELEGRAM_SECRET      # any long random string
npx wrangler secret put APP_SECRET           # another long random string
npx wrangler secret put OWNER_CHAT_ID        # see step 5
```

Generate the random ones with `openssl rand -hex 32`.

### 4. Deploy and register the webhook

```bash
npm run deploy       # prints https://miles-tracker.<you>.workers.dev
```

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://miles-tracker.<you>.workers.dev/tg",
       "secret_token":"<TELEGRAM_SECRET>"}'
```

### 5. Claim the bot

Send `/start`. Because `OWNER_CHAT_ID` isn't set yet, it replies with your chat
id. Set it as the secret, redeploy, and every other chat is locked out.

### 6. Deploy the dashboard

Set `API_BASE` in `web/src/api.ts` to your Worker URL, and the Pages URL in
`src/telegram.ts` (the `/app` command). Then:

```bash
cd web && npm install && npm run build
npx wrangler pages deploy dist --project-name miles
```

Send `/app` to the bot, open the link on your phone, and Add to Home Screen.

---

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
web/                  React + Vite PWA
```

## Adding feeds

`/addfeed https://example.com/feed/|Label`, or edit `seed.sql`. Any RSS or Atom
feed works. The keyword gate in `src/rss.ts` requires a promo term *and* a card
term, and always matches your own cards' product names.
