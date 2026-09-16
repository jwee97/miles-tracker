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

**1. Point it at the rewards page.**

**Cards → Read a rewards page.** Give it the card's rewards or T&C page, or
paste the terms in — most bank sites refuse anything that is not a browser, so
select the page and paste it and you are never stuck.

It reads the *numbers*: every rate, the cap beside it, the window the cap
resets on, the merchant codes a rate is restricted to, and the sentences that
say something earns nothing. Each one comes back **with the sentence it came
from**, and nothing is saved until you press the button on it — a rate lifted
out of the wrong paragraph would quietly misdirect every recommendation the app
makes, which is worse than having no rate at all. Every code the page names is
listed with what this app already calls it, so a list of digits is something
you can check.

What it cannot do is read prose. "Miles are awarded on the first S$1,000 of
eligible spend in each statement month, excluding the categories set out in
Clause 7.2" is a rule no regular expression should be trusted with. For that,
**Copy the prompt for Claude** on the same panel — it hands over the whole page
wrapped in the instructions that turn it into `/addearn` and `/exclude` lines.
`/cardrules citirw` in the bot gives you the same prompt, bare, to paste a page
under yourself.

**2. Type them yourself.**

```
/addearn citirw shopping 4              4 miles per dollar
/addearn uobone groceries 5%            5% cashback (the % matters)
/addearn citirw shopping 4 cap 1000     bonus stops after $1,000
/addearn citirw * 0.4                   the fallback for everything else
```

Extras go after the rate in any order: `cap <amount>`,
`window <statement_cycle|calendar_month|calendar_quarter>`, `group <name>`,
`mcc <codes>`, `note <text>`.

**`mcc` is the one that makes a rule true.** `/addearn citirw online 4` claims
every online purchase earns 4 mpd; the terms almost never say that. What they
say is a list of codes, and `/addearn citirw online 4 mcc 5262,5964,5969` is
the rule that matches them — anything outside the list falls to the base rate,
which is what the card actually does.

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

## Cards that pay by the quarter, in tiers

Some cards — UOB One is the one everyone means — do not work on calendar
quarters or calendar months, and do not pay a single number.

**The quarter.** Three consecutive *statement* months, counted from the month
the principal card was issued, fixed for as long as you hold the card. A card
issued in February runs Feb–Mar–Apr, then May–Jun–Jul, then Aug–Sep–Oct, then
Nov–Dec–Jan.

Month one is the first statement cycle that **starts on or after** the anchor
date: the part-month a card is issued into was never a whole statement month.

**The anchor is the field to get right.** It alone decides which months every
quarter covers, and being one month out moves every quarter for the life of the
card — an anchor in March gives quarters beginning Mar, Jun, Sep and Dec, while
July gives Jan, Apr, Jul and Oct. So the app says which: on the card, under the
quarter dates, and next to the date field while you are setting it. If your
statement says Jul–Sep and the app says the quarter begins in September, the
anchor is the thing to change.

**The month.** A statement month, not a calendar one. If the statement closes on
the 18th, month 1 runs 19 Feb to 18 Mar, month 2 runs 19 Mar to 18 Apr, month 3
runs 19 Apr to 18 May. Spend has to *post* inside the month to count, which is
why the app reports at-risk spend separately.

**The gate.** The minimum and the transaction count must both be met in **every
one of the three months**. One thin month and the quarter pays nothing.

**The tiers.** A different quarterly payout at each monthly spend level. The
quarter pays at the **lowest** tier held across its three months — the reward is
for sustaining the spend, so one big month does not carry two thin ones.

Two things follow from that, and the app now says both out loud.

*The lowest rung is the minimum.* A card with rungs at S$600 / S$1,000 /
S$2,000 has a monthly minimum of **S$600**. Whatever figure a requirement was
created with is ignored once it has tiers, and is corrected in the row when you
save the ladder — otherwise a perfectly good S$900 month reads as a miss.

*Once a month closes a rung down, that is the rung for the quarter.* Spend
S$900 in month 1 and the quarter can pay at most the S$600 tier, however much
goes on the card in months 2 and 3. So the target for those months is S$600, not
S$1,000 — and the app says so, names the month that capped it, strikes the
unreachable rungs off the ladder, and tells you when you are past the point
where more spend adds anything.

The ladder is shown on the card with the rung you are on marked:

```
✓ $600.00 a month     $60.00 a quarter
  where you are
✕ $1,000.00 a month  $100.00 a quarter
  out of reach this quarter
✕ $2,000.00 a month  $200.00 a quarter
  out of reach this quarter
```

In the first month of a quarter nothing is decided, so nothing is struck off and
no target is invented — every rung is still reachable and the app says that
instead.

**The first quarter.** It pro-rates on a trailing run: meet the minimum in the
3rd month only and a third is paid; in the 2nd and 3rd, two thirds. Every later
quarter is all three or nothing.

Set one up in the bot:

```
/req uobone|monthly_min|600|statement_quarter||||10|quarterly cashback
/tiers uobone 600=50 1000=110 2000=300
```

Or in the app: **Cards → Add a minimum**, set *Measured over* to **every
statement month of a rolling quarter**, then add the tiers. The quarter is
anchored to the card's opening date unless you give another, and the app refuses
to create one with nothing to anchor to — without a date every month would look
like quarter one.

Once it exists, every status report draws the quarter month by month:

```
✅ M1 $700.00/10tx  ▶️ M2 $420.00/6tx  · M3 $0.00/0tx
💰 on course for $50.00 at the $600.00 tier
↗ $180.00 more this month reaches the $1,000.00 tier ($110.00/quarter)
```

A tick is a month that qualified, a cross is one that closed short, and the
arrow is the month in play. A month that fails is alerted the moment it closes,
not when the cashback fails to arrive three months later — and once a quarter is
beyond saving the app stops urging you to spend into it, because nothing you
spend now brings it back.

## Where the app looks first: minimums, not limits

`/status` and the Cards tab lead with minimum spend. The credit limit is what a
credit score reads, and it is still reported — under the minimum, on every card
and in the total — but it is not the thing being asked about. What you can act
on today is the minimum you are short of, so cards are ordered by how soon one
can be missed, with the headline bar showing progress toward it.

Three bands, in order: minimums you can still hit, soonest deadline first; then
ones already met; then windows already lost; then cards with no minimum at all.

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

Rather than typing all that, use **Read a rewards page** on the same card — see
*Earn rules* above. It fills the same form from the page, one rate at a time,
with the sentence each came from next to it.

Closing a card keeps it, with the date: eligibility cooldowns on future offers
run from it.

### Uploading a statement PDF

**Ledger → Paste a statement → Statement PDF.** Drop in the PDF and the rows
come out ready to import. It reads the PDF's text layer in your browser —
pdf.js is fetched only when you open one — so the file itself is never
uploaded; only the lines you choose to import are sent, and only to your own
Worker.

A statement PDF has no lines, only positioned text. The reader groups the
fragments by their y coordinate, sorts each row left to right, and hands the
result to a bank profile: recognise the issuer, find the statement date, drop
the furniture, keep the rows that have both a date and an amount.

Five banks are recognised — **Citibank, DBS/POSB, UOB, OCBC and HSBC** — and
the picker overrides the guess if a statement is unusual. What the profiles
handle:

- `(259.28)` and `12.30 CR` as refunds
- one date or two, `05/08`, `16 AUG`, `2026-08-16`
- a day and month that arrive as separate fragments
- balances, sub-totals, grand totals, payments and legal text, dropped
- the statement's own date, which dates rows that print no year **exactly**:
  nothing on a statement happened after it was issued, so a July row on an
  August statement is this year and a December row on a January statement is
  the year before

A scanned statement has no text layer and nothing can be extracted from it; the
app says so rather than silently returning nothing.

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

### Off-card spending

The **Off-card** tab records what never touched a credit card: PayLah, PayNow,
cash, NETS, a bank transfer, GIRO. `/spend 12.80 paylah lunch` does the same
from the bot, and `/spends` reports the month.

It earns nothing, so the numbers that matter are the share and the cost:

- how much of the month went out off-card, against what went on cards
- for each category, the card that would have earned most on it and what it
  would have paid — **$100 of PayLah dining would have been 400 miles on your
  Lady's Card**

Two things keep that honest. A row marked *a card was never an option* — a
hawker with no terminal, a transfer to a person — stays in the total but out of
the cost, since there was nothing to miss. And spend with no category cannot be
costed at all, so it is reported separately rather than counted as zero: give
those rows a category and the figure grows.

Merchant categories are shared with card spend, so tagging a merchant once
teaches both. One thing to watch: if you top up PayLah with a card, the top-up
is already card spend — record what you buy here, not the top-up, or it counts
twice.

### Rates that move with the tier

On a card like UOB One the rate is not one number per category — it is one per
category *per tier*. Groceries pay 3.33% while the card holds the S$600 rung and
6% at S$1,000; partner merchants pay 8.33% at the lower rungs and 10% at
S$2,000.

Record one rate per rung, with the rung's **monthly** spend in *Only at this
tier*:

```
/addearn uobone groceries 3.33% tier 600
/addearn uobone groceries 6% tier 1000
/addearn uobone groceries 8% tier 2000
```

The engine then earns at whichever rung the card is **actually holding**, which
is the tier the *quarter* will pay — not the one this month alone might reach.
That distinction is the whole point: a S$2,500 month inside a quarter already
capped at S$600 by an earlier month does not earn the 8% rate, and the
explanation on the purchase says so in as many words.

A tier-gated rate on a card with no ladder never applies, and says why rather
than quietly falling through to the base rate.

### Correcting a minimum

Every minimum has an **Edit** beside it now, which loads the whole thing —
window, transaction count, anchor, ladder — back into the form. Saving replaces
the ladder wholesale, so a rung can be removed as well as added.

This matters because the commonest thing to get wrong is the window, and until
now the only fix was to delete the requirement and start again.

**The app also checks the shape.** A minimum measured over a whole calendar
quarter adds three months into one total and reads far higher than a month's
spend — that is exactly how a card shows "$1,621 / $1,000" when the month's
spend was $900. When it sees that, the card says so, and says what to change the
window to.

### Why a minimum-spend total looks too big

Every minimum on a card now prints the **window it is counting** — the two
dates and what kind of window it is — with a *what's counted?* link that opens
the purchases behind the figure.

This is worth knowing about because the commonest surprise is not a bug. A
minimum set to *each calendar quarter* adds three months together; one set to
*each calendar month* runs the 1st to the 31st, which is not the same as a
statement month if your statement closes on the 18th. A total that looks like
three months usually is three months, and the window line says so at a glance.

If the window is wrong, remove the minimum and add it again with the right one.
For a card like UOB One the answer is nearly always **every statement month of
a rolling quarter**, not *each calendar quarter*.

### Tidying merchant names

**Ledger → Tidy merchant names.** A statement writes the same merchant a
hundred ways — `BUS/MRT 3948201`, `BUS/MRT 7712`, `BUS/MRT 22` — and until they
are one name every merchant total is wrong, no category is ever learned from
them, and the merchant-code list carries a row per terminal.

Open it and it suggests groups: spellings that share an opening and differ only
by digits. Pick one, or type your own match, and **Show me what changes** lists
every name it would rewrite and how many rows. The rename button only appears
once you have seen that list — two genuinely different shops can share an
opening, and only you can tell.

### When a code sets a category too

Recording a merchant code now also fills in the **category** on that merchant's
past purchases, since the code carries one and a purchase with a code but no
category is still invisible to any rule that matches on one.

It only fills a gap. A category you set by hand is never overwritten; only rows
with none at all, or one that was guessed from the merchant name, are touched,
and they are marked as having come from the code. Nothing else changes: the
earn engine prefers an MCC-restricted rule over a category word anyway, so this
only helps the rules that have no codes attached.

### Long lists

Four lists in the app grow without a ceiling: spend, merchant codes, merchants
with no code yet, and off-card entries. Each now has a **page size** (10, 25, 50
or 100) next to its pager, and the off-card list offers *all* as well, since one
month's entries arrive together anyway. Changing the size returns to page one —
staying on page 7 of a list that just became four pages long shows nothing — and
each list remembers its own size on that device, so leaving the tab and coming
back does not put it back to 25.

**Merchants with no code** also has an **Ignore** on every row. Some spend has
no code to find — a hawker stall, a transfer to a friend — and taking it off the
list is a better answer than inventing a code for it. Ignored merchants are
counted, listed behind one button and can be put back. `/mccskip <merchant>` in
the bot does the same, and `/mccskip` alone lists them.

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

**What is seeded.** All 924 codes in ISO 18245. Descriptions come from the
[Merchant Category Codes manual](https://www.citibank.com/tts/solutions/commercial-cards/assets/docs/govt/Merchant-Category-Codes.pdf)
Citibank publishes for commercial cards — the authoritative wording — and every
code carries a `verified` flag saying whether it appears there. 904 do; the
other 20 keep the wording from [check-mcc.sg](https://www.check-mcc.sg/mcc) and
are shown as *not in the published manual* in the Codes tab. They are mostly
newer network codes the manual does not enumerate: marketplaces (5262), the
payment-transaction range (6532–6534), EV charging (5552), multi-category
digital goods (5818).

`/seed` refreshes descriptions in place and leaves categories alone, so an edit
of your own survives. 596 of them (3000–3999) are
individual airlines, hotel chains and car-rental agencies — real, since a hotel
stay often posts as 3509 rather than 7011, but they would bury everything else,
so they are hidden behind a chip. The remaining 327 are the generic codes you
meet day to day. The table pages at 50 rows.

The `category` column is **this app's own mapping** onto `earn_rules`, not part
of the standard. It was derived from the code ranges and descriptions, with the
previously hand-checked codes kept as they were. If your card's terms group a
code differently, the category is what the earn engine matches on — correct it
in `seed.sql` and re-seed, or adjust the rule instead.

**Searching for a merchant.** Codes tab → *Look up a merchant*, or
`/mcc <name>` in the bot. It searches the public directory of Singapore
merchants — the same search its own site runs, `/api/store/search?q=` — which
matches on fragments, so `kopi` returns ten kopitiams and `circles` finds
Circles Life. Each hit shows the directory's code, what this app calls that
code, and the category the earn engine would use, and can be recorded under the
name you searched for or the directory's own spelling.

Your own table is consulted first and shown above the results: a code confirmed
from your statement outranks anything published, and it is never overwritten by
a search.

Some merchants genuinely carry more than one code — Shopee comes back as both
5262 (marketplaces) and 9311 (tax payments, for bill pay) — which is the reason
every hit is listed rather than the first one being taken as the answer.

Nothing is written until you press *Record*. If the directory cannot be
reached, the app says so rather than showing an empty list, which would read as
"no such merchant".

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

## Reading Cloudflare's own meters

The Settings tab counts the database from the inside: rows, bytes, what grows.
This is the other half — Worker invocations, D1 queries and rows read, as
Cloudflare's own meters record them. It is optional, and free: the GraphQL
Analytics API costs nothing on the Workers free plan.

Four things, and only one of them is a secret.

**1. Create the API token.**

Cloudflare dashboard → your profile picture (top right) → **My Profile** →
**API Tokens** → **Create Token** → scroll past the templates to **Create
Custom Token → Get started**.

Give it a name you will recognise (`miles-tracker analytics`), then set one
permission:

| | | |
|---|---|---|
| **Account** | **Account Analytics** | **Read** |

Under *Account Resources*, include the account this Worker is on. Leave
*Zone Resources* alone — this token needs nothing from a zone. Set a TTL if you
want one; the panel will simply report that the token expired.

Create it, then **copy the token now** — Cloudflare shows it once.

**2. Find the account id.**

Cloudflare dashboard → **Workers & Pages** → open `miles-tracker`. The account
id is the 32-character hex string in the URL:

```
https://dash.cloudflare.com/<this-part-is-the-account-id>/workers/services/view/miles-tracker
```

It is not a credential and grants nothing on its own.

**3. Put the token in as a secret.**

```
wrangler secret put CF_API_TOKEN
```

Or, with no terminal: Cloudflare dashboard → **Workers & Pages** →
`miles-tracker` → **Settings** → **Variables and Secrets** → **Add** → type
**Secret**, name `CF_API_TOKEN`, paste the value → **Deploy**.

It goes in as a secret for the same reason the Telegram token does: the app
cannot read it back, no endpoint returns it, and it is not in the settings
table. The panel reports numbers, never credentials.

**4. Tell it which Worker and which database.**

In the app: **Settings**, and fill in the three that are already listed there —

| Setting | Where it comes from |
|---|---|
| Cloudflare account id | the URL in step 2 |
| Worker name | `name` in `wrangler.toml` — `miles-tracker` unless you renamed it |
| D1 database id | `database_id` under `[[d1_databases]]` in `wrangler.toml` |

None of the three is sensitive; the database id is already committed to this
repo.

Open **Settings → Cloudflare**. It should fill in within a second or two.

### If it does not

Which fields and dimensions a Cloudflare dataset offers varies by dataset and
by plan, so the panel does not assume one shape — it tries several in
descending order of confidence and uses the first that is accepted. **What was
asked** at the bottom of the panel lists every attempt and what Cloudflare said
to each, which is the fastest way to tell a wrong token from a wrong id from a
field your plan does not have.

- **"Cloudflare refused the token (403)"** — the token is wrong, expired, or
  missing *Account Analytics → Read*. Re-check step 1.
- **Numbers that are all zero** — the Worker name or database id does not match
  what you deployed. A wrong name reads as an idle Worker, not as an error,
  because to Cloudflare it is simply a Worker with no traffic.
- **An `Unknown field` message against one shape but not the next** — normal.
  That is the probing working.
- **Every shape failing** — the error from the last one is shown in full.
  Workers and D1 are read separately, so one failing does not hide the other.

### What it shows

**Worker** — invocations and how many a day, errors as a share of requests,
outcomes broken down by status, subrequests, and CPU time per invocation.

CPU is reported as the **median**: the request you actually get. Cloudflare
returns these in *microseconds*, which is worth knowing — a panel that forgets
to convert reports a typical request as "41ms" when it was 41 millionths of a
second. The 99th percentile sits beside it, labelled, because one request in a
hundred being slow is a different fact from the typical one being slow.

**D1** — rows read and written, query counts, batch latency (average and 90th
percentile), bytes of results returned, database size *and how much it grew
across the window*. Also **rows read per read query**, which is the one number
that says whether a query found its rows by index or walked the table to reach
them; past a thousand, the panel says so.

**Where the rows go** — the statements doing the work, heaviest by rows read,
with the SQL D1 kept (bound parameters are stripped, so nothing sensitive is in
it). This is the panel that pays for itself: rows read is where a free tier is
actually spent and it is never spread evenly — one query missing an index reads
more in a week than everything else together. Each row shows its share of the
window, how many rows it touches *per run*, and says so in words when that
number means it is walking a table rather than using an index.

**Against the free tier** — each daily allowance measured on the **busiest day
of the window**. The allowance resets daily, so an average across a quiet week
would hide the one day that nearly ran out.

The window offers **today** as well as 7, 14 and 30 days. Today is its own
question — is the thing I just deployed working — and it is the one a weekly
view cannot answer.

Cloudflare keeps about 30 days of this, and the most recent hours lag.

### What the exceptions actually were

The counts say *17 scriptThrewException*; only the logs say which line threw. If
your token carries **Workers Observability Read**, the panel lists the messages
under the error count, commonest first.

That needs Workers Logs switched on, which this repo now does:

```toml
[observability]
enabled = true
head_sampling_rate = 1
```

It is free — 200,000 events a day, three days of retention — and this app uses a
fraction of that. Without it the permission is dead weight, and the panel says
so rather than showing an empty list.

### Permissions, and what each one buys

| Permission | What it adds |
|---|---|
| Account Analytics → Read | everything above: invocations, CPU, D1 rows, storage |
| D1 → Read | the per-query breakdown under *Where the rows go* |
| Workers Observability → Read | the exception messages, with `[observability]` on |
| Workers Metadata → Read-Only | not used yet |
| Zone Analytics / Logs → Read | nothing here: this Worker has no zone, it runs on workers.dev |
| Network Quality → Read | nothing here: it measures your connection, not the app |

A token with only the first line still works; the extra panels report what they
are missing instead of going blank.

## The product model

Under the app there are now four things rather than two, and the separation is
what makes almost everything else easier:

| | |
|---|---|
| **Card products** | what a card IS. "4 mpd on online spend" is a fact about the DBS Woman's World Card, the same for everyone holding one. |
| **Your cards** | what you hold. The limit, the statement day, the nickname, the opening date. |
| **Rule sets** | what a product paid, *and when*. Versioned, with dates. |
| **Transactions** | what actually happened. |

Mixed together, as they were, a reward rate could never be shared between
holders, corrected in one place, or given a date.

### Why the dates matter

A bank cutting a rate in October must not rewrite what August earned. So a
published rule set is **never edited** when the economics change — it is closed
off on the day before the new one opens:

```
version 1   2025-06-01 → 2026-09-30   superseded
version 2   2026-10-01 → (current)    published
```

A purchase dated 30 September finds version 1 and earns the old rate; one dated
1 October finds version 2. Every evaluation records which version produced its
numbers, so an audit can say what the app believed and why.

Two invariants are enforced rather than hoped for:

- **No two published versions may cover the same day.** An overlap is not a
  smaller problem than a gap — it is an ambiguous answer to "what did this card
  pay on the 14th", and the calculation would pick one silently. Publishing one
  fails with `RULE_VERSION_OVERLAP`, naming the version it clashes with.
- **At most one version is open-ended.** Publishing a new current version closes
  the one it replaces.

Drafts never apply to anything, and a version dated in the future does not apply
early.

### What the migration did

It runs inside `/migrate`, is idempotent, and deletes nothing:

1. one product per distinct card product;
2. every card linked to its product;
3. each product's existing rules wrapped in **version 1**, published, effective
   from the card's opening date;
4. card-scoped exclusions versioned alongside them. Global exclusions stay
   global rather than being copied into every product.

The effective date is the honest weak point: the real start of a card's terms is
recorded nowhere, so the card's opening date is used and the product is marked
`migrated_unverified`. That lowers a recommendation's confidence later rather
than pretending the date was checked. Nothing else is invented — a card with no
opening date gets an explicitly early one rather than a guess.

`earn_rules.card_id` was `NOT NULL`, which a product-scoped rule cannot satisfy,
so the migration rebuilds that table to make it nullable. Every row is copied by
name, ids included, and the rebuild only runs while the old constraint is there.

### Looking at it

```
GET /api/catalog/cards            every product, who holds it, which version is live
GET /api/catalog/cards/:key       one product: all versions, their rules, sources, overlaps
```

Read-only for now. Nothing in the interface depends on the catalogue yet — this
phase deliberately left the UI alone so the model could be proved underneath it.

## The catalogue, as shipped

`/migrate` now also seeds a Singapore card catalogue: 31 products across DBS/POSB,
UOB, Citi, OCBC, Standard Chartered, HSBC, Amex and Maybank. Seeding is
idempotent and never touches a product that already exists, so it is safe to run
again and it will not overwrite a product you have since verified yourself.

What it contains is **identity only** — issuer, product name, network, whether it
pays miles or cashback, which programme the points land in, and the official page
to check:

```
dbs_womans_world   DBS   Woman's World Card   mastercard   miles      dbs_points
uob_one            UOB   One Card             visa         cashback   —
citi_rewards       Citi  Rewards Card         visa         miles      citi_ty
…
```

Every seeded product arrives `draft`, with **no rule sets and no rates**. That is
deliberate rather than unfinished: the banks' own rewards pages were not
fetchable from here, and a rate written from memory is worse than a blank —
a blank asks you, a wrong rate answers you. So the seed writes no rates of its
own, and a test enforces that it never starts to.

Rates arrive the way they always did — through a card you hold. Add the card,
then use the rewards-page reader on the Cards tab: paste the bank's page, check
each rate against the sentence it came from, and save. Those rules land in the
current version of that card's product, so every card on the same product picks
them up, and a later change is a new version rather than an edit.

Two honest limits while the catalogue is read-only:

- a product **nobody holds** has no way to be given rules yet — the standalone
  publishing workflow is still to come;
- nothing yet marks a product `verified`. `draft` and `migrated_unverified` both
  mean "not checked against a bank document", and both lower a recommendation's
  confidence rather than pretending otherwise.

```
GET /api/catalog/cards            31 products, who holds each, which version is live
GET /api/catalog/cards/:key       one product: versions, rules, sources, overlaps
```

A product with no published version simply never wins a recommendation — it is
counted in `awaiting_rules` rather than guessed at.

## Which card to use, version 2

`POST /api/recommend` answers the same question the old endpoint did, and three
things it could not.

```
POST /api/recommend
{ "merchant": "Sheng Siong", "amount": "82.40", "objective": "balanced" }
```

**Disqualification is not a bad score.** An excluded merchant code, a closed
card, or a product with no rules in force on that date means the card *cannot be
used here* — not that it is slightly behind. Such a card is moved to
`ineligible`, with a reason in words, and no rate however good can float it back
to the top. It stays in the answer so the omission is explicable:

```json
"ineligible": [{ "card": {"nickname": "Rewards"},
                 "disqualified": { "reason": "excluded code",
                                   "detail": "5411 earns base rate on this card" } }]
```

**The score says what it is made of.** No magic numbers: each pick carries
`score_components`, and they add up to `score`.

| component | what it is |
|---|---|
| `reward_value` | the purchase's value in cents, miles normalised by `MILE_VALUE_CENTS` |
| `objective_bonus` | your objective's thumb on the scale — miles, cashback, or minimum-spend |
| `minimum_spend_bonus` | a minimum still short is worth more than a good rate |
| `urgency_bonus` | a deadline inside a week outranks any plausible reward |
| `uncertainty_penalty` | charged once per unknown the answer depends on |
| `exhausted_cap_penalty` | a bonus already spent is a real disadvantage |

The ordering falls out of the weights rather than out of a sort comparator:
urgency beats any reward, and an explicit minimum-spend objective beats urgency.

**A guess is labelled as one.** Confidence is `high`, `medium` or `low`, with the
reasons and the list of assumptions:

```json
"confidence": { "level": "low",
                "reasons": ["the merchant code is unknown, and a card's bonus turns on it"] },
"assumptions": [{ "what": "the merchant code",
                  "because": "no code recorded for this merchant",
                  "weight": "material" }]
```

`weight: "material"` means the answer could change if the assumption is wrong;
one material assumption is enough to make the whole answer `low`.

An unknown merchant code lowers confidence only where a
card actually cares about codes — sensitivity is read off the card's rules, not
off the rule that happened to match. (A code-gated rule *cannot* match while the
code is unknown, which is precisely when it matters.)

### Splitting a payment

When a bonus cap will run out part-way through a purchase, the answer says so
and what to do:

```json
"split_advice": { "bonus_cents": 4000, "remainder_cents": 4240,
                  "use": "Rewards Card", "earns": "170 miles", "gain_cents": 310 }
```

Read as: the first $40.00 fills the top card's remaining bonus cap, and the
$42.40 left over is better put on the Rewards Card, which earns 170 miles there
— 310 cents more than leaving it on the top card at its base rate. That last
comparison is the point: re-evaluating the top card fresh would see an unused
cap and wrongly conclude nothing beats it, so the remainder is scored at the
**base** rate it would actually earn.

Below `SPLIT_MIN_GAIN_CENTS` (default `150`, editable in Settings) it stays
quiet — two taps at the counter should be worth more than a dollar fifty.

### Every answer is dated

`evaluated_at` is the day the answer was computed; `data_version` is how fresh
the card data behind it is, and it is honest about a product that has never been
verified. Each pick also carries the `rule_set_id` that produced its numbers, so
an old answer can be re-read against the version it actually used.

## Verify end to end

```
/status                     full digest with utilization bars
/scan                       force a scan instead of waiting for 06:00
/offers                     offers, their clauses and rule ids
/prune                      what the scanned history costs · compact · delete
/spend <amt> <method> [note] log spending that never touched a card
/spends [YYYY-MM]           the month off-card, and what it cost
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
