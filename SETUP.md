# Full setup walkthrough

End to end, roughly 30–40 minutes. Everything below is free tier: no domain,
no credit card, no API key.

Verified against **Wrangler 4.131.0** / **Node 22**.

---

## What you're building

| Piece | Where it runs | What it costs |
|---|---|---|
| Worker (bot + API + cron) | `miles-tracker.<you>.workers.dev` | Free — 100k req/day |
| D1 database | Cloudflare, attached to the Worker | Free — 5 GB, 5M row reads/day |
| PWA dashboard | `<project>.pages.dev` | Free — unlimited bandwidth |
| Telegram bot | Telegram's servers | Free |

You will use maybe 200 requests a day against a 100,000/day allowance.

---

## Step 0 — Prerequisites

- **Node 18+** — `node -v`
- **A Cloudflare account** — [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
  Free plan, no card required. You do **not** need to add a domain.
- **A Telegram account.**

```bash
git clone https://github.com/jwee97/miles-tracker.git
cd miles-tracker
npm install
npm test          # should print "all passed" twice, no config needed
```

If `npm test` passes, the code is sound and everything from here is wiring.

---

## Step 1 — Log in to Cloudflare

```bash
npx wrangler login
```

Opens a browser for OAuth. On a headless box it prints a URL to open elsewhere.

Alternative (CI, or if the browser flow won't work): create an API token at
**dash.cloudflare.com → My Profile → API Tokens → Create Token**, using the
*Edit Cloudflare Workers* template, then:

```bash
export CLOUDFLARE_API_TOKEN=<token>
```

Confirm you're in:

```bash
npx wrangler whoami
```

---

## Step 2 — Create the database

```bash
npx wrangler d1 create miles
```

It prints a config block. Copy **only** the `database_id` value into
`wrangler.toml`, replacing `PUT_YOUR_D1_DATABASE_ID_HERE`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "miles"
database_id = "a1b2c3d4-...."
```

Now create the tables and load the default RSS feeds:

```bash
npm run db:init     # wrangler d1 execute miles --remote --file=./schema.sql
npm run db:seed
```

> **The `--remote` flag matters.** Without it, Wrangler writes to a local
> SQLite file used by `wrangler dev` and your deployed Worker sees an empty
> database. The npm scripts already pass it; if you run `d1 execute` by hand,
> don't drop it. `npm run db:init:local` is the local-only variant, for `wrangler dev`.

Verify:

```bash
npx wrangler d1 execute miles --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

You should see `cards`, `transactions`, `requirements`, `offers`,
`offer_rules`, `feeds`, `feed_items`, `alerts_sent`, `settings`.

---

## Step 3 — Create the Telegram bot

1. Open [@BotFather](https://t.me/botfather) in Telegram.
2. `/newbot`
3. Display name: anything (`Miles`).
4. Username: must be globally unique and end in `bot` (`jw_miles_bot`).
5. Copy the token it gives you — `123456789:AAF...`. Treat it like a password:
   anyone with it controls the bot.

Optional, purely cosmetic: `/setcommands` on BotFather, then paste:

```
status - Full digest
cards - List cards
offers - Tracked offers and eligibility
reqs - List minimum-spend requirements
scan - Scan RSS feeds now
app - Open the dashboard
help - All commands
```

---

## Step 4 — Deploy the Worker

```bash
npm run deploy
```

First deploy asks to register a `workers.dev` subdomain — accept it. Note the
URL it prints:

```
https://miles-tracker.<your-subdomain>.workers.dev
```

Sanity check:

```bash
curl https://miles-tracker.<your-subdomain>.workers.dev/health   # -> ok
```

It's live but inert: no secrets yet, so the bot can't talk to anything.

---

## Step 5 — Set the secrets

Generate two random strings:

```bash
openssl rand -hex 32     # use for TELEGRAM_SECRET
openssl rand -hex 32     # use for APP_SECRET
```

Then set three of the four (the fourth needs a value you don't have yet):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN    # paste the BotFather token
npx wrangler secret put TELEGRAM_SECRET       # paste the first random string
npx wrangler secret put APP_SECRET            # paste the second random string
```

Each `secret put` redeploys the Worker automatically — no manual redeploy needed.

> **Never put these in `wrangler.toml`.** Anything under `[vars]` is committed
> to git in plain text. `wrangler secret put` stores them encrypted, and they
> arrive on the same `env` object at runtime.

Keep `TELEGRAM_SECRET` on your clipboard — the next step needs it.

---

## Step 6 — Point Telegram at the Worker

Telegram pushes updates to your Worker. Register the webhook, substituting both
values:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://miles-tracker.<your-subdomain>.workers.dev/tg",
    "secret_token": "<TELEGRAM_SECRET>"
  }'
```

Expect `{"ok":true,"result":true,"description":"Webhook was set"}`.

The `secret_token` is echoed by Telegram on every request as the
`X-Telegram-Bot-Api-Secret-Token` header, and the Worker rejects anything where
it doesn't match. It must be **byte-identical** to the `TELEGRAM_SECRET` you
set in Step 5 — a trailing newline from a sloppy copy is the usual culprit
behind a silent bot.

Check it took:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

`pending_update_count` should be 0 and `last_error_message` absent.

---

## Step 7 — Claim the bot

Message your bot `/start`. Because `OWNER_CHAT_ID` isn't set yet, it replies
with your numeric chat id. Set it:

```bash
npx wrangler secret put OWNER_CHAT_ID     # paste the number
```

Send `/start` again — you should now get the help text. **Every other Telegram
account is now locked out.** That's the entire access-control model, and it's
sufficient because there's exactly one user.

---

## Step 8 — Deploy the dashboard

Point the PWA at your Worker. In `web/src/api.ts`:

```ts
export const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://miles-tracker.<your-subdomain>.workers.dev';
```

Build and deploy:

```bash
cd web
npm install
npm run build
npx wrangler pages deploy dist --project-name miles
```

First run creates the Pages project and asks for a production branch name —
`main` is fine. It prints `https://miles.pages.dev` (or
`https://<hash>.miles.pages.dev` for the preview; the bare one is production).

Now tell the Worker where the dashboard lives. In `wrangler.toml`:

```toml
APP_URL = "https://miles.pages.dev"
```

```bash
cd .. && npm run deploy
```

Send `/app` to the bot, open the link on your phone, and **Add to Home Screen**.
The link carries a 30-day token; `/app` mints a fresh one whenever it expires.

---

## Step 9 — Set your timezone

Default is SGT. If you're elsewhere, two things must change together in
`wrangler.toml`:

```toml
[triggers]
crons = ["0 0 * * *", "30 1 * * *"]   # UTC — feed scan, then digest

[vars]
TZ_OFFSET_MINUTES = "480"             # minutes east of UTC
```

`TZ_OFFSET_MINUTES` controls date boundaries — which statement cycle a
transaction lands in, what "today" means. The crons control *when* the two jobs
fire, and **cron expressions are always UTC**; Cloudflare does not convert them.

| Zone | `TZ_OFFSET_MINUTES` | Scan 08:00 local | Digest 09:30 local |
|---|---|---|---|
| SGT / HKT (UTC+8) | `480` | `0 0 * * *` | `30 1 * * *` |
| UK (UTC+1, BST) | `60` | `0 7 * * *` | `30 8 * * *` |
| US Eastern (UTC−4, EDT) | `-240` | `0 12 * * *` | `30 13 * * *` |
| US Pacific (UTC−7, PDT) | `-420` | `0 15 * * *` | `30 16 * * *` |

Zones with daylight saving drift by an hour twice a year. The digest arriving
at 08:30 instead of 09:30 is harmless; fix it when it annoys you.

Redeploy after changing either: `npm run deploy`.

---

## Step 10 — Load your cards

```
/newcard DBS|Altitude Visa|alt|8000|18|2025-03-04
```

Fields: `issuer | product | nickname | credit limit | statement day | opened date`.

The **opened date matters** — it's what eligibility cooldowns are computed from.
Add cards you've closed too, with `/closecard alt|2026-09-01`, because "no card
with this issuer in the past 12 months" is judged against exactly that history.
A missing closed card is how you get a confident, wrong "eligible".

Then the minimum-spend rules:

```
/req alt|signup_min|1000|fixed_window|2026-11-14||30k miles
/req wwmc|monthly_min|800|calendar_month||1000|4 mpd on first $1k
```

Fields: `nickname | kind | amount | window | deadline | bonus cap | note`.
Window is `calendar_month`, `statement_cycle`, or `fixed_window`.

The 6th field, **bonus cap**, is the one people skip and shouldn't: past that
amount the elevated rate stops and further spend belongs on another card. It's
where miles actually get lost, so it gets its own alert.

---

## Step 11 — Verify end to end

```
/status          → your cards with utilization bars
/scan            → forces a feed scan instead of waiting for 08:00
25.40 alt lunch  → logs spend, replies with the minimum-spend gap
/status          → confirm the amount moved
```

Confirm the crons registered:

```bash
npx wrangler deployments list
```

Or **dash.cloudflare.com → Workers & Pages → miles-tracker → Settings →
Triggers**, where both cron entries should appear.

---

## Troubleshooting

**Bot doesn't respond at all.** Watch live logs in one terminal and message the
bot in another:

```bash
npm run tail
```

No output at all means Telegram isn't reaching you — re-check `getWebhookInfo`
for `last_error_message`. A 403 in the logs means `TELEGRAM_SECRET` and the
`secret_token` you registered don't match; redo Steps 5 and 6, carefully.

**Bot responds to `/start` but ignores everything else.** `OWNER_CHAT_ID`
doesn't match your chat id. Re-run Step 7.

**`/status` says "No cards yet" after adding one.** You initialized the local
database instead of the remote one. Re-run `npm run db:init` and check the
`--remote` flag.

**Dashboard shows "Link expired".** Tokens last 30 days. Send `/app` again.

**Dashboard shows a network or CORS error.** `API_BASE` in `web/src/api.ts`
doesn't match your Worker URL. Fix, rebuild, redeploy Pages.

**`/scan` returns nothing.** Either there's genuinely nothing new — items are
only shown once, tracked in `feed_items` — or the seeded feed URLs are stale.
Check with `/feeds`, and verify one by hand:

```bash
curl -sI https://milelion.com/feed/ | head -1
```

Replace dead ones with `/addfeed https://example.com/feed/|Label`.

**Nothing arrives at 09:30.** Cron triggers only run on deployed Workers, never
under `wrangler dev`. Confirm they're listed under Settings → Triggers, and
remember the expressions are UTC (Step 9).

---

## Free tier limits

| Resource | Limit | Your usage |
|---|---|---|
| Worker requests | 100,000/day | ~200 |
| Worker CPU | 10 ms/invocation | ~2 ms |
| Cron triggers | Included | 2/day |
| D1 storage | 5 GB | a few MB after years |
| D1 row reads | 5,000,000/day | a few thousand |
| D1 row writes | 100,000/day | a few dozen |
| Pages bandwidth | Unlimited | — |
| Pages builds | 500/month | one per UI change |

Nothing here has a path to a bill. D1's free tier does not sleep or pause on
inactivity, which is why the nightly cron is reliable.

---

## Ongoing

```bash
npm run deploy                    # after changing Worker code or wrangler.toml
cd web && npm run build && npx wrangler pages deploy dist --project-name miles
npm test                          # before deploying anything
npm run tail                      # live logs
```

Back up the database any time:

```bash
npx wrangler d1 export miles --remote --output backup.sql
```
