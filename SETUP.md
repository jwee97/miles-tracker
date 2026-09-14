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
└── cron ×3           two daily offer scans + morning digest
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

| Zone | `TZ_OFFSET_MINUTES` | Scan 06:00 local | Digest 09:30 local | Scan 14:00 local |
|---|---|---|---|---|
| SGT / HKT (UTC+8) | `480` | `0 22 * * *` | `30 1 * * *` | `0 6 * * *` |
| UK (UTC+1, BST) | `60` | `0 5 * * *` | `30 8 * * *` | `0 13 * * *` |
| US Eastern (UTC−4, EDT) | `-240` | `0 10 * * *` | `30 13 * * *` | `0 18 * * *` |
| US Pacific (UTC−7, PDT) | `-420` | `0 13 * * *` | `30 16 * * *` | `0 21 * * *` |

Both live in `wrangler.toml`. Edit, commit, push (Path A) or `npm run deploy`
(Path B). Daylight-saving zones drift an hour twice a year; a digest arriving at
08:30 instead of 09:30 is harmless.

If you change either scan cron, change `SCAN_CRONS` in `src/index.ts` to match —
the handler branches on the exact strings to decide which report to send, and a
cron that is not listed there runs the digest instead.

### If /migrate reports a problem

`/migrate` is idempotent: run it again. It applies the schema in the order an
existing database needs — tables, then the columns older tables are missing,
then the indexes — so an index over a newly added column is created on the same
run that adds the column. Anything it could not apply is listed under
*Problems*, with the SQLite message, and a later run retries it.

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

The **Use** tab is the front door: type a merchant, optionally an amount, and
it ranks your cards for that purchase.

```
Din Tai Fung
Likely MCC 5812 — Eating places and restaurants   [guess]

🥇 UOB Lady's            620 mi
   3.1 mpd · $150.00 bonus allowance left
   $150.00 at the bonus rate · $50.00 at the base rate
   Why?

🥈 Citi PremierMiles     280 mi
   1.4 mpd
```

Tap **Why?** on any card and it shows the reasoning step by step — exclusions
checked, which rule matched, how much cap is left, where the purchase was split.
A number you cannot interrogate is a number you cannot act on.

When the bonus runs out part-way it says what to do with the rest: put the
first $150 on one card and the remaining $50 on another that beats its base
rate.

**MCC handling.** A merchant's code is set by the acquirer, differs between
outlets of one brand and changes without notice, so every lookup says whether
it is a *guess* or *confirmed*. Read the real code off a posted transaction,
enter it once, and it is used everywhere after that.

**Exclusions** are MCCs that earn nothing — insurance, tax, government,
education, quasi-cash and the rest are seeded as a starting point, globally and
per card. Check your own terms: exclusion lists differ by card and change.

**Objectives** change the ranking: balanced compares everything in dollars,
miles refuses to hand you a cashback card, cashback the reverse, and *hit
minimums* puts a card with an unmet minimum first — which is often worth more
than a better rate.

## Portfolio check

`/optimise`, and a panel on the Trends tab, replay your own spending through
the rules engine to find where the same money would earn more:

```
dining — $400.00/mo on Citi PremierMiles (1.4 mpd)
       → UOB Lady's (4 mpd) = +$187.20/yr · 12,480 extra miles a year
```

And allowances going to waste, which is the case for a card whose bonus
category you choose:

```
UOB Lady's · dining — 8% used
$80.00 of a $1,000.00 allowance each month
You spend $900.00/mo on groceries. Pointing this card's bonus there is
worth about $324.00 a year.
```

Three constraints keep the advice honest. It never suggests moving more than
the target card's cap can hold, and says what limited it. Uncategorised spend
is excluded, because without a category there is no rate to compare. And the
figure quoted is the **gain**, not the target card's total — a distinction that
would otherwise overstate every suggestion by whatever the current card already
earns.

## Reward audit

The **Audit** tab answers the question nothing else does: *did the bank
actually pay what the rules said?* Every transaction records what the engine
expected at the time; type in what was credited and the audit reconciles them.

```
Reward audit · 2026-08-01 → 2026-08-31
460 short

⚠ $115.00 at Agoda — expected 460 miles, received 0
  No bonus credited. MCC 4722 may be excluded on this card, or the cap
  was already used.
```

Expected figures are recorded at entry rather than recomputed later, because a
cap means the rate that applied then is not the rate that applies now.

## Which card to use (category form)

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

## The ledger

The **Ledger** tab is the spreadsheet view: every transaction, every cell
editable in place — date, posting date, card, merchant, category, amount —
with a form at the top for adding a row. Click a cell, type, press Enter.

## When you don't know the category

An MCC is assigned by the payment chain, not by you, and it is **only reliable
once a purchase posts** — a pending transaction may not carry its final
details. So the app never guesses:

- Leave the category blank, or tag `#?` in the bot, to say "I don't know yet".
- Uncategorised spend lands in a **review queue**, split in two: *ready*
  (posted, so your bank can tell you the merchant category) and *waiting to
  post* (not knowable yet — leave it alone).
- `/review` lists both, `/cat <id> <category>` sets one.
- Setting a category teaches the merchant, so the next purchase there
  classifies itself. Inferred categories show with a dotted underline in the
  ledger; confirmed ones don't.

**Uncategorised spend is excluded from the wrong-card analysis.** Comparing it
on base rates alone would invent a loss that a real category might erase — the
card used could well be the right one once the MCC is known. It still counts
toward totals, and the insights say how much of the month is unclassified.

To find an MCC: pay, wait for the transaction to post, then ask your bank for
the MCC on that specific posted transaction.

## Points expiry and transfers

The **Expiry** tab lists every batch you hold, soonest first, with a chip
showing how long is left — and a running record of transfers you have made.

**Transferring now moves the points.** `/convert` compares routes and changes
nothing; `/transfer 50000 citi_ty krisflyer` executes one:

- it consumes the **soonest-expiring batch first**, which is the whole reason
  to track batches rather than one total
- a partly used batch keeps its remainder
- the miles land as a new batch, carrying the target programme's expiry rule
- points below a whole block stay put, and the reply says how many
- the transfer is recorded, so a balance always reflects what actually moved

## Settings

The **Settings** tab edits the tunable values without a redeploy — they are
stored in the database and overlay the deployed config: timezone offset, what a
mile is worth, utilization thresholds, the minimum-spend warning window, the
posting lag, and the rate re-check interval. Each shows its deployed default and
can be reset to it.

**Secrets are not listed and cannot be written.** The bot token, your chat id
and the signing keys live in Cloudflare's encrypted store and never pass through
the app. Cron times are also absent: they are UTC and set in `wrangler.toml`.

The same tab reports **database size and row counts against D1's 5 GB
allowance**, plus what the free tier gives you. Per-request counts and CPU time
would need a Cloudflare API token, so the page says so and points at
**Workers & Pages → miles-tracker → Metrics** rather than pretending to know.

## Trends

The dashboard's **Trends** tab reads a month back to you: the headline total
against the same point last month, a running-total line, day-by-day bars, where
the money went by category and by card, which days of the week you spend on,
your top merchants, and an estimate of what you earned.

Beyond the month itself it looks for patterns across your history:

- **Against the usual** — each category against its own recent baseline rather
  than last month alone, so one unusual previous month does not read as a
  trend. A spike has to clear both a meaningful absolute change and the
  category's own variability.
- **Recurring charges** — subscriptions detected from steady intervals at
  steady amounts, annualised, with ones that have stopped appearing flagged.
  Nothing to maintain; it reads the pattern.
- **Possible duplicates** — same merchant and amount within two days.

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

At **06:00 and 14:00 local, every day**, the same job scans every source for new
sign-up offers and then checks the transfer routes. It covers:

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

### Scanning on demand

```
/scan                       scan every source now, opening articles
/scan quick                 headlines only — faster, finds less
/scan https://…             read one page you found yourself
/feeds                      list sources and their kind
/addfeed <url>|<label>|page watch a plain HTML listing page
```

The Offers tab has the same three buttons, plus **Scanned items** — everything
the scanner has matched, ten to a page:

- Filter by **Inbox** (matched, undecided), **Tracked**, **Ignored** or
  **Everything**; each chip carries its count.
- Narrow by date: this month, last month, last 7 or 30 days, year to date, all
  time. Ranges resolve in the app's timezone, not the browser's.
- Tick several and **Track** or **Ignore** the lot in one request. A selection
  never survives a page or filter change, so a bulk action always applies to
  rows you can see.
- Each row shows its source, date, how strongly it matched, whether the article
  was opened, the phrases that matched, and the issuer link when one was found.

There is also a **Sources** panel where a source's URL, label and kind can be
edited, paused or removed without touching the bot.

### Adding a card

The **Cards** tab has *Add a card* and, under each card, its earn rates. A card
with no rates never wins a recommendation and its rewards cannot be predicted,
so the two live on one screen.

A rate is more than a number. The form takes the category, the rate (miles per
dollar or percent cashback), the cap and what it resets on, **the merchant codes
the rate is restricted to**, codes it never applies to, the channel, and a
minimum per transaction. The MCC list is what separates "4 mpd online" from
"4 mpd on 5262, 5964 and 5969" — and the second is what the T&C usually says.

If one cap is shared across several categories, give those rates the same
**shared cap name**. Getting that wrong is what makes the app think you have
more bonus headroom than you do.

Closing a card keeps it, with the date: eligibility cooldowns on future offers
run from it.

### Pasting a statement

**Ledger → Paste a statement.** Copy the transaction rows out of your statement
and paste them in. It reads:

- `14 SEP  15 SEP  NTUC FAIRPRICE  23.45` — two dates means transaction date
  then posting date
- `15/09/2026  GRAB *TRIP  12.30` and `2026-09-16  SHOPEE  1,240.00`
- `45.00 CR` and `(10.00)` as refunds
- and skips balances, payments, sub-totals and column headers

A year that is not printed is inferred: December read in January belongs to the
year before, never to the future. Every row is shown before anything is
written; rows matching something already logged start unticked, so importing
the same statement twice does not double your month. Lines it could not read
are listed with the reason rather than dropped.

Imported rows take the same path a typed one does — categorised, evaluated
against the card's rules, and queued for the points wallet.

### Merchant codes

The **Codes** tab is the MCC table seen from your own cards — a grid of codes
against cards, where each cell says what that card does with that code:

| cell | meaning |
|---|---|
| `✕` | earns nothing, and does not count toward a minimum |
| a number on green | a bonus rate; a dot in the corner means it is capped |
| a number, plain | the card's base rate |
| `·` | no rule on this card covers the code |

Filter by excluded, bonus, or codes you have actually spent on; search by code,
description or category; tap a cell for the rule behind it. Every cell is
computed with the same `ruleMatches` the earn engine uses, so the table cannot
say one thing while a purchase does another.

**What is seeded.** All 923 codes in ISO 18245, with the descriptions published
at [check-mcc.sg](https://www.check-mcc.sg/mcc). 596 of them (3000–3999) are
individual airlines, hotel chains and car-rental agencies — real, since a hotel
stay often posts as 3509 rather than 7011, but they would bury everything else,
so they are hidden behind a chip. The remaining 327 are the generic codes you
meet day to day. The table pages at 50 rows.

The `category` column is **this app's own mapping** onto `earn_rules`, not part
of the standard. It was derived from the code ranges and descriptions, with the
previously hand-checked codes kept as they were. If your card's terms group a
code differently, the category is what the earn engine matches on — correct it
in `seed.sql` and re-seed, or adjust the rule instead.

**Keeping codes current.** Codes tab → *Track merchant codes*, or `/mccscan`.
It reads the merchant pages published at check-mcc.sg (whose robots.txt allows
it) and records what they say: about twenty merchants, each with its code and
whether that directory calls it verified. A code **you** confirmed is never
overwritten — your statement outranks a directory — and a disagreement is
listed rather than resolved quietly.

Below it sits the other half: merchants in your own spend that still have no
code, ordered by how much you have spent there, with what the directory would
call them. Setting one also applies it to the purchases already logged under
that name, which were evaluated without a code. `/mcc <merchant> [code]` does
the same from the bot.

**Exclusions are a starting point, not a promise.** The seeded list is what
Singapore issuers commonly exclude — tax, insurance, top-ups, education,
utilities at some banks. Your card's terms are what count. When a statement
shows something earned nothing, record it: the **Add an exclusion** form, or
`/exclude <mcc> [card] [reason]`. Leaving the card out excludes it everywhere.

**Excluded spend and minimums.** Spend on an excluded code still uses your
credit limit, so it counts toward utilization — but it is left out of
minimum-spend progress, and the amount is shown under the meter. Most issuers
exclude the same codes from both. The asymmetry decides the default: believing
a minimum is met when the bank disagrees costs the whole bonus, while not
counting it only means spending a little more than strictly necessary. If your
card's terms say otherwise, set `MIN_SPEND_COUNTS_EXCLUDED` to `true` on the
Settings tab.

### Points that earn themselves

Logging a purchase — in the app or the bot — evaluates it against the card's
rules, so the app already knows what it should earn. What it does with that:

1. The earning programme is resolved at that moment, from the matching rule's
   `program_key`, else the card's. Recording it on the transaction means
   changing a card's programme later cannot retroactively move points you have
   already earned.
2. It joins a queue: **Points → Waiting to be banked**, or `/credit` in the bot.
3. Accepting it adds the points to your balance. Nothing is added on its own:
   a bank can credit a different figure, and a wallet that silently disagrees
   with the statement is worse than no wallet at all.

Accepted points become **one batch per programme per month**, not one per
purchase — a year of daily coffees would otherwise be 365 rows that expire
together anyway — with the programme's expiry months applied from the start of
that month. `/undocredit <id>` takes one back out, subtracting it from the same
batch.

A card needs a programme for any of this. `/newcard` guesses one from the
issuer and says which; `/setprogram <card> <programme>` changes it, and the
wallet's **Earning with nowhere to go** panel names any card that is earning
without one. Cashback cards earn no points, so they never appear there.

The wallet totals in **miles after conversion**, never by adding units
together: 50,000 Citi points and 50,000 KrisFlyer miles are not 100,000 of
anything. Each bank programme is converted at the best route recorded for it,
labelled with the ratio used and whether that ratio has been verified.

### Keeping the database small

Scanned history is the only table that grows without you doing anything: a
matched item stores an excerpt, the phrases it matched and the issuer link,
which is most of its size. Two operations, deliberately named differently:

- **Compact** keeps the row — its id and your decision — and drops the bulk.
  The item is still recognised on the next scan, so it is never shown to you
  twice. This runs nightly on judged items older than `FEED_RETENTION_DAYS`
  (180 by default, editable on the Settings tab), and on demand from the Offers
  tab or `/prune compact`.
- **Delete** removes the row, and with it the memory that you saw the item.
  Anything still carried by a feed will be re-inserted and offered again on the
  next scan. The app says so before you confirm. `/prune delete` does the same
  for ignored items.

`/prune` with no argument reports what the history costs and what is
reclaimable. Settings → **What grows** shows the same figures next to the
transactions table.

**Transactions are not worth pruning.** A row is a hundred-odd bytes — a date,
an amount, a merchant string, a category — with no free text to speak of. At a
few hundred purchases a month that is well under a megabyte a year, against a
5 GB allowance; the Settings page projects the actual figure from your own
data, and it is normally in the thousands of years. Summarising old months
would save nothing measurable and would break the things that read the whole
history: the trends tab, the reward audit, the portfolio check, and eligibility
verdicts that turn on when a card was opened or closed. The right answer here
is to leave them alone.

### Reviewing an offer

An offer's clauses are evaluated against your card history, but some cannot be:
an income floor, a card you closed before you started tracking, a clause the
extractor flagged for a human. Those show as *needs review* and wait for you.

In the app, each clause carries **I meet this · I do not · N/A · Note**. In the
bot it is `/rule <rule id> yes|no|na [note]`; rule ids are printed by `/offers`.

- Your answer sets the verdict; the computed one stays beside it, and a
  disagreement is labelled as an override rather than quietly replacing it.
- Answers are stored with the date and your note.
- **N/A** counts as satisfied but is never displayed as a pass.
- Re-reading a T&C (`/save`, or *Re-read the terms*) keeps the answers to
  clauses that came back identical and drops the ones that changed — a changed
  clause is a new question.
- A clause the extractor got wrong can be removed outright.

An offer that has not been extracted yet shows the paste-into-Claude flow in
place: **Copy the prompt**, then a box for the JSON that comes back. Nothing
about that flow needs the bot any more, though `/extract` and `/save` still
work. `Mark applied`, `Dismiss` and `Back to tracked` set the offer's status;
dismissed offers are hidden until you ask for them.

**The scan window.** By default a scan only considers posts published in the
current calendar month (`SCAN_WINDOW`: `month`, `7d`, `30d`, `ytd`, `all`). A
blog category page lists years of posts, and an offer from 2024 is noise. Dates
come from the feed, then the date in the URL (`/2026/09/05/`), then the
article's own meta tags when it is opened — and are read in your timezone, so a
post published at 00:30 on the 1st stays inside the month. Anything older is
recorded once, marked stale, and never read again. Pasting a URL by hand
ignores the window: asking for a page is deliberate.

**What "opening articles" means.** A feed summary is often one truncated
sentence, which is not enough to tell a sign-up offer from a hotel review. A
deep scan fetches the article itself (at most 12 per scan, 10s timeout each,
600 KB cap), classifies it on the full text, and pulls out the issuer link —
`uob.com.sg/…/apply` rather than the blog post — which is what gets stored as
the offer's source. Tracking URLs are stripped and redirector links unwrapped,
so the same article found through two sources is recognised as one item.

## Verify end to end

```
/status                     full digest with utilization bars
/scan                       force a scan instead of waiting for 06:00
/offers                     offers, their clauses and rule ids
/prune                      what the scanned history costs · compact · delete
/codes [query]              what each card pays on a merchant code
/exclude <mcc> [card]       record one that earns nothing
/wallet                     everything you hold, and what it is worth
/credit                     what your spending earned, waiting to be banked
/setprogram <card> <prog>   where a card's points land
/rule <rule id> yes|no|na   answer a clause only you can settle
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
`/feeds`, or the Sources panel in the Offers tab, and fix or replace dead ones
there.

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
