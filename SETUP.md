# Full setup walkthrough

Everything below is free tier: no domain, no credit card, no API key.

**Two paths.** Pick the one that matches your machine — the difference is only
*where the commands run*, and the end result is identical.

| | Path A — no terminal | Path B — local terminal |
|---|---|---|
| For | StackBlitz, Chromebook, iPad, any browser-only setup | macOS, Linux, WSL |
| Setup done in | Cloudflare dashboard + browser | Wrangler CLI |
| Deploys triggered by | `git push` | `npm run deploy` |
| Time | ~30 min | ~25 min |

**Wrangler cannot run in a StackBlitz WebContainer** — it needs native binaries
(`workerd`, esbuild) and a local socket for the OAuth callback, none of which
exist in browser-based Node. There is no flag that fixes this. Path A avoids
Wrangler on your machine entirely: Cloudflare runs it in their own build
container on every push.

Verified against **Wrangler 4.131.0** / **Node 22**.

---

## What you're building

One Worker serves everything from a single origin:

```
miles-tracker.<you>.workers.dev
├── /                 the dashboard (React PWA, static assets)
├── /api/*            JSON API, token-authenticated
├── /tg               Telegram webhook
└── cron ×2           nightly feed scan + morning digest
```

| Resource | Free allowance | You'll use |
|---|---|---|
| Worker requests | 100,000/day | ~200 |
| Worker CPU | 10 ms/invocation | ~2 ms |
| D1 storage | 5 GB | a few MB |
| D1 row reads | 5,000,000/day | a few thousand |
| D1 row writes | 100,000/day | a few dozen |
| Static assets | Unlimited | 6 files, 150 KB |

Nothing here has a path to a bill. D1's free tier does not sleep or pause on
inactivity, which is why the nightly cron is dependable.

---

# Path A — no terminal

## A1. Create the database

1. [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) — free plan, no card, no domain needed.
2. **Storage & Databases → D1 SQL Database → Create**. Name it `miles`.
3. Open the new database, go to the **Console** tab.
4. Paste the entire contents of `schema.sql` and run it.
5. Paste the entire contents of `seed.sql` and run it.

Confirm with:

```sql
SELECT name FROM sqlite_master WHERE type='table';
```

You should get `cards`, `transactions`, `requirements`, `offers`,
`offer_rules`, `feeds`, `feed_items`, `alerts_sent`, `settings`.

Copy the **Database ID** shown on the database's overview page.

## A2. Put the database ID in the repo

In StackBlitz (or the GitHub web editor), edit `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "miles"
database_id = "paste-the-id-here"
```

Commit and push to `main`.

## A3. Connect the repo to Cloudflare

1. **Workers & Pages → Create application → Import a repository**.
2. Authorize GitHub if prompted, then pick `miles-tracker`.
3. Set the build configuration:

| Field | Value |
|---|---|
| Worker name | `miles-tracker` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Branch | `main` |

> **The Worker name must be exactly `miles-tracker`** — it has to match the
> `name` field in `wrangler.toml` or the build fails with a name-mismatch error.

4. **Save and Deploy.**

The first build takes a couple of minutes: it installs dependencies, builds the
dashboard into `web/dist`, then uploads the Worker and its static assets
together. Note the `workers.dev` URL it gives you.

The Worker is live but inert — no secrets yet.

**From here on, every `git push` to `main` rebuilds and redeploys automatically.**
That is your whole deployment workflow; you never run Wrangler.

## A4. Create the Telegram bot

Open [@BotFather](https://t.me/botfather), send `/newbot`, give it any display
name, and a username ending in `bot`. Copy the token.

## A5. Set the secrets in the dashboard

**Workers & Pages → miles-tracker → Settings → Variables and Secrets.**
Add each of these with type **Secret** (not Text):

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the BotFather token |
| `TELEGRAM_SECRET` | any long random string |
| `APP_SECRET` | a different long random string |

Need random strings without a terminal? Open your browser's devtools console:

```js
crypto.randomUUID() + crypto.randomUUID()
```

Saving a secret creates a new version of the Worker, so it applies immediately.

> Secrets are encrypted and separate from **Variables**, which are plain text.
> Never put a token in `[vars]` in `wrangler.toml` — that file is in git.

## A6. Point Telegram at the Worker

`setWebhook` accepts GET, so a browser address bar is enough. Substitute all
three values and visit:

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://miles-tracker.<you>.workers.dev/tg&secret_token=<TELEGRAM_SECRET>
```

Expect `{"ok":true,"result":true,"description":"Webhook was set"}`.

Telegram echoes `secret_token` on every request as the
`X-Telegram-Bot-Api-Secret-Token` header, and the Worker rejects anything that
doesn't match. It must be **byte-identical** to the `TELEGRAM_SECRET` from A5 —
a stray space from a sloppy copy is the usual cause of a silent bot.

Check it took by visiting:

```
https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

`pending_update_count` should be 0 with no `last_error_message`.

## A7. Claim the bot

Message your bot `/start`. Since `OWNER_CHAT_ID` isn't set, it replies with your
numeric chat id. Add that as one more **Secret** named `OWNER_CHAT_ID`.

Send `/start` again — you should get the help text, and every other Telegram
account is now locked out. That is the entire access-control model, and it's
sufficient because there is exactly one user.

## A8. Open the dashboard

Send `/app`. The bot replies with a link to its own `workers.dev` URL carrying a
30-day token. Open it on your phone and **Add to Home Screen**.

Skip to [Shared setup](#shared-setup) below.

---

# Path B — local terminal

```bash
git clone https://github.com/jwee97/miles-tracker.git
cd miles-tracker && npm install && npm test

npx wrangler login
npx wrangler d1 create miles          # paste database_id into wrangler.toml
npm run db:init                       # applies schema.sql
npm run db:seed                       # loads the RSS feeds

npm run deploy                        # builds the PWA, then deploys both
```

> **`--remote` matters.** The npm scripts pass it. Without it Wrangler writes to
> a local SQLite file only `wrangler dev` reads, and your deployed Worker sees
> an empty database — which surfaces later as "No cards yet" right after you
> clearly added a card. `npm run db:init:local` is the local-only variant.

Then create the bot (A4 above) and set secrets from the CLI:

```bash
openssl rand -hex 32                  # → TELEGRAM_SECRET
openssl rand -hex 32                  # → APP_SECRET

npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_SECRET
npx wrangler secret put APP_SECRET
```

Register the webhook:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://miles-tracker.<you>.workers.dev/tg","secret_token":"<TELEGRAM_SECRET>"}'
```

Then `/start` the bot, and `npx wrangler secret put OWNER_CHAT_ID` with the id
it returns.

You can still connect the repo (A3) on top of this — the two coexist, and it's
worth doing so pushes from anywhere deploy themselves.

---

# Shared setup

## Set your timezone

Default is SGT. Two settings must move together, and they mean different things.
`TZ_OFFSET_MINUTES` decides date boundaries — which statement cycle a
transaction lands in, what "today" means. The crons decide *when* jobs fire, and
**cron expressions are always UTC**; Cloudflare does not convert them.

| Zone | `TZ_OFFSET_MINUTES` | Scan 06:00 local | Digest 09:30 local |
|---|---|---|---|
| SGT / HKT (UTC+8) | `480` | `0 22 * * *` | `30 1 * * *` |
| UK (UTC+1, BST) | `60` | `0 5 * * *` | `30 8 * * *` |
| US Eastern (UTC−4, EDT) | `-240` | `0 10 * * *` | `30 13 * * *` |
| US Pacific (UTC−7, PDT) | `-420` | `0 13 * * *` | `30 16 * * *` |

Both live in `wrangler.toml`. Edit, commit, push (Path A) or `npm run deploy`
(Path B). Daylight-saving zones drift an hour twice a year; a digest arriving at
08:30 instead of 09:30 is harmless.

If you change the morning cron, change `MORNING_SCAN_CRON` in `src/index.ts` to
match — the handler branches on the exact string to decide which report to send.

## Load your cards

```
/newcard DBS|Altitude Visa|alt|8000|18|2025-03-04
```

`issuer | product | nickname | credit limit | statement day | opened date`

The **opened date matters** — eligibility cooldowns are computed from it. Add
cards you've closed too, with `/closecard alt|2026-09-01`, because "no card with
this issuer in the past 12 months" is judged against exactly that history. A
missing closed card is how you get a confident, wrong "eligible", and a hard
pull you didn't need.

```
/req alt|signup_min|1000|fixed_window|2026-11-14|||30k miles
/req wwmc|monthly_min|800|calendar_month||1000||4 mpd on first $1k
/req uobone|monthly_min|1000|calendar_quarter|||5|$100 quarterly rebate
```

`nickname | kind | amount | window | deadline | bonus cap | min txns | note`

Window is `calendar_month`, `calendar_quarter`, `statement_cycle`, or
`fixed_window`. Leave a field empty to skip it.

**Bonus cap** is the one people skip and shouldn't. Past that amount the
elevated rate stops and further spend belongs on another card. It's where miles
actually get lost, so it gets its own alert.

**Min txns** covers cards that also require a number of transactions, not just
a dollar total — UOB One is the common example. A requirement is only reported
as met when *both* halves clear, and the digest tells you which one is short.

## Earn rules — telling it what your cards pay

There is no API for this. Every card's earning structure lives in its terms,
so the app has to be told once per card. Three ways, easiest first.

**1. Let Claude read the card's page.**

```
/cardrules citirw
```

The bot replies with a prompt. Paste it into Claude along with the card's
rewards page, and Claude returns ready-to-send `/addearn` lines. Same pattern
as the T&C flow, no API key.

**2. Type them yourself.**

```
/addearn citirw shopping 4              4 miles per dollar
/addearn uobone groceries 5%            5% cashback (the % matters)
/addearn citirw shopping 4 cap 1000     bonus stops after $1,000
/addearn citirw * 0.4                   the fallback for everything else
```

Extras go after the rate in any order: `cap <amount>`,
`window <statement_cycle|calendar_month|calendar_quarter>`, `group <name>`,
`note <text>`.

**Always add a `*` rule.** It is the rate for anything not otherwise matched,
and without it the app has no idea what a card does off-category.

**`group` is the one that catches people.** Citi Rewards' $1,000 cap covers
*all* its 10X categories together — spend it on groceries and nothing is left
for shopping. Give those rules the same group name and the app measures them
as one pool:

```
/addearn citirw shopping 4 cap 1000 group tenx
/addearn citirw online 4 cap 1000 group tenx
```

Omit `group` when each category has its own separate cap. Getting this wrong
makes the app think you have more bonus headroom than you do.

For a card where you **choose** the bonus category, like UOB Lady's, just add
a rule for the category you picked and swap it with `/delearn` + `/addearn`
when you change.

## Which card to use

```
/which                    the best card for every category
/which groceries 120      ranked, with what each actually returns
/which NTUC 120           a merchant works too
```

Ranking is by **value in dollars**, not by rate — which is the only way a
cashback card and a miles card can be compared at all:

```
groceries · $100.00

👉 Citi Rewards — 4 mpd · 400 miles (≈$6.00)
   UOB One Card — 5% back · $5.00 back (≈$5.00)

Compared at 1.5¢ per mile.
```

`MILE_VALUE_CENTS` in `wrangler.toml` is what a mile is worth to you. It is a
real lever: at 1.5¢ the miles card above wins, at 1.0¢ the cashback card does.
Set it to what you actually get on redemption.

Ranking also accounts for caps already spent this window, and puts a card whose
minimum spend is about to lapse above everything else — missing a sign-up bonus
costs far more than a few miles per dollar.

## Categories, learned once

Tag a merchant the first time:

```
25.40 citirw #groceries NTUC
```

After that, `25.40 citirw NTUC` categorises itself, and `/which NTUC` works.
`/merchants` lists what it has learned. Re-tagging corrects it.

Untagged spend counts as `*`, so caps only track properly for spend you tag.

## Trends

The dashboard's **Trends** tab reads a month back to you: the headline total
against the same point last month, a running-total line, day-by-day bars, where
the money went by category and by card, which days of the week you spend on,
your top merchants, and an estimate of what you earned.

The one worth opening it for is **Left on the table** — spend that a card you
already hold would have rewarded better, priced in dollars:

```
dining                                        $2.30
$191.50 on Citi Rewards (0.4 mpd) → DBS Altitude would give 1.2 mpd
```

That only works for spend that is categorised, so tag merchants as you go.
Uncategorised spend is called out in the insights when it gets large enough to
distort the figures.

Reward totals are estimates: caps are applied to monthly aggregates rather than
transaction by transaction, which is close but not exact around a cap boundary.

## Points and transfers

The dashboard's **Points** tab holds everything you have: a table of balances
across banks and airlines, with what expires in the next 90 days and the
nearest expiry date. Add a balance there, or from the bot:

```
/addbal citi_ty|50000|2027-06-30|statement balance
/bal
/convert 50000 citi_ty krisflyer
```

**Record each batch separately when they expire on different dates.** A single
total hides the batch about to lapse, which is the only number worth acting on.
Omit the expiry and the programme's own rule fills it in where one is known
(KrisFlyer's 36 months, say); where none is known, none is invented.

Twenty programmes are seeded — the Singapore bank currencies plus KrisFlyer,
Asia Miles, HeyMax, EVA, ANA, Qatar, BA, Emirates, Qantas, United and Turkish.
Anything missing can be added from the tab under *Programme not listed?*

Transfers move in whole blocks with a per-transaction fee, so the planner
compares routes rather than multiplying by a ratio — 40,000 Citi points is
16,000 miles via Kris+ but only 10,000 direct, with 15,000 stranded.

## Keeping the database in step with the code

After any deploy that changes the schema, send the bot:

```
/migrate      creates missing tables, adds missing columns, reports what it did
/seed         loads the default feeds, programmes and transfer routes
```

Both are idempotent — safe to run any time, and a no-op when nothing is
needed. The Worker bundles `schema.sql` and `seed.sql` as text, so it can
bring its own database up to date without a CLI.

`migrations/*.sql` are still there for reference, but you should not need to
paste them by hand. If a command fails with `no such table` or
`no such column`, run `/migrate`.

## Transfer routes and the weekly review

`seed.sql` loads eleven Singapore programmes and thirteen transfer routes. The
**ratios** are corroborated across several public summaries; the **fees and
minimums are not** — sources disagree, and they move (UOB raised its fee in
Dec 2025, HSBC reworked its ratio in Jan 2025).

So every seeded route starts with `verified_at` unset, and the weekly review
reports it as unverified until you check it yourself:

```
/routes                      every route, with when it was last checked
/verified 4                  mark one checked against the bank today
/setrate 4|5000|10000|27.25|5000|5000    correct it and mark verified
/setbonus 2|8|2026-12-31     record a promo bonus and its end date
/rates                       run the weekly review now
```

At **06:00 local, every day**, the same job scans the feeds for new sign-up
offers and then checks the transfer routes. It covers:

- promo bonuses ending within 14 days
- points expiring within 90 days
- routes never verified, or older than `RATE_RECHECK_DAYS` (90)
- anything in the feeds in the last 36 hours about transfer bonuses, ratio
  changes or fee increases

**The daily check is quiet.** Routes that are merely unverified or stale say
the same thing every morning, so each is reported at most once a week; urgent
items — a bonus about to end, points about to expire, fresh rate news — go out
every run until dealt with. When there is nothing to say it sends nothing at
all. `/rates` always gives you the full picture on demand, suppression aside.

The feed scan classifies each item as `promo` or `rates` as it arrives, so
sign-up offers arrive with Track/Ignore buttons while rate news folds into the
check.

Both reports ride on two cron triggers rather than three, which the free plan
limits.

## Verify end to end

```
/status                     full digest with utilization bars
/scan                       force a feed scan instead of waiting for 08:00
25.40 alt lunch             logs spend today
25.40 alt yesterday lunch   backdate it
25.40 alt 5/9 lunch         day/month, or 2026-09-05, or -3 for 3 days ago
/recent                     last 15 entries with their ids
/del 12                     remove one · /undo removes the last
/status                     confirm the amount moved
```

A date can go anywhere in the message — the bot picks it out and treats the
rest as the note. Undated entries are today's. The dashboard has the same
entry form with a date picker, plus a recent list you can delete from.

### Transaction date vs posting date

Banks judge statement cycles, minimum spend and bonus caps on the date a
transaction **posts**, not the date you made it. A purchase a day or two before
your statement closes can post after it and count toward the *next* cycle — and
the mirror happens too, where spend from just before a cycle posts into it.

So each entry has two dates. `occurred_at` is what you type; `posted_at` is null
until you know it. Windows use `posted_at` when set and fall back to
`occurred_at` otherwise.

Anything unconfirmed within `POSTING_LAG_DAYS` (default 3) of a window's end is
reported as **at risk**, and a minimum met only by counting at-risk spend is
never shown as met:

```
⏳ Monthly min $1,000.00 met only if $150.00 posts in time
↳ confirmed $900.00 — spend $100.00 more to be safe
```

Confirm a real posting date with `/posted <id> <date>`, or tap the dashed date
box on that row in the dashboard. `/recent` marks unconfirmed entries with ⏳.

The dashboard's **Log spend** form has a **Posted** field too. Leave it blank
while a purchase is still pending; fill it in when you are entering an older
purchase you have already seen on a statement. The form warns when you
backdate without one, since the entry will count from the purchase date until
you say otherwise.

Then confirm both cron triggers registered under
**Workers & Pages → miles-tracker → Settings → Triggers**.

---

## Troubleshooting

**The build fails with a name mismatch.** The Worker name in the dashboard must
equal `name` in `wrangler.toml` — both must be `miles-tracker`.

**The build fails on `npm run build`.** That script runs `npm --prefix web ci`,
which needs `web/package-lock.json` committed. It is, unless you deleted it.

**The bot doesn't respond at all.** Check **Workers & Pages → miles-tracker →
Logs** (or `npm run tail` on Path B) while messaging it. Nothing at all means
Telegram isn't reaching you — check `getWebhookInfo` for `last_error_message`. A
403 means `TELEGRAM_SECRET` and the registered `secret_token` don't match.

**It answers `/start` but ignores everything else.** `OWNER_CHAT_ID` doesn't
match your chat id. Redo A7.

**"No cards yet" right after adding a card.** Path B only — you initialized the
local database instead of the remote one. Re-run `npm run db:init`.

**The dashboard loads but every request 401s.** The token expired. Send `/app`
for a fresh link.

**Visiting `/health` in a browser returns the dashboard HTML.** Expected. With
`not_found_handling = "single-page-application"`, browser *navigation* requests
are served `index.html` without invoking the Worker, to save billable
invocations. `run_worker_first` forces `/tg`, `/api/*` and `/health` through the
script for real (non-navigation) callers like Telegram, `curl` and the PWA's own
`fetch`. Use `curl` if you want to see the plain `ok`.

**`/scan` returns nothing.** Either there's genuinely nothing new — items are
shown once and remembered in `feed_items` — or a seeded feed URL is stale. Check
`/feeds` and replace dead ones with `/addfeed <url>|<label>`.

**Nothing arrives in the morning.** Cron triggers only run on deployed Workers,
never under `wrangler dev`. Confirm they're listed under Settings → Triggers,
and remember the expressions are UTC.

---

## Ongoing

**Path A.** Edit, commit, push. Cloudflare builds and deploys. GitHub Actions
runs the typecheck, both test suites, and the dashboard build on every push, so
you get test feedback without a local runtime — check the Actions tab before
trusting a deploy.

**Path B.**

```bash
npm test           # before deploying anything
npm run deploy     # builds the PWA, then deploys
npm run tail       # live logs
npx wrangler d1 export miles --remote --output backup.sql
```

On Path A, back up from the dashboard's D1 **Console** tab, or add
`wrangler d1 export` to a scheduled GitHub Action.
