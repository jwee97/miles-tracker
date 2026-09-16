# Miles Tracker

Credit card spend, limits, minimum-spend progress, and sign-up promo tracking.
Runs entirely on Cloudflare's free tier. No domain, no email, no API key.

- **Telegram bot** — logging spend, alerts, and login, all in one channel
- **One Cloudflare Worker** — API, database, three daily crons, and the dashboard
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

**Promotions.** Twice-daily scanning across miles blogs — RSS feeds *and* plain
listing pages — which opens each promising article, reads past the headline and
pulls out the issuer's own apply link. Matches arrive in Telegram with Track /
Ignore buttons and in the Offers tab, where **Scan now** runs the same job on
demand and a URL box reads any page you paste. Everything matched lands in a
paged list you can filter by state and date and judge in batches.

**Statements.** Upload the PDF — Citibank, DBS/POSB, UOB, OCBC or HSBC — and
the rows are extracted in your browser, never uploaded. Or copy the rows out
and paste them. Either way the app reads them — transaction date, posting date, merchant, amount, refunds included —
shows every row before writing anything, unticks the ones that look already
logged, and lists the lines it could not parse with the reason. Imported rows
go through the same evaluation a typed one does.

**Off-card spending.** PayLah, PayNow, cash, a bank transfer — none of it earns
anything, which is the reason to record it. The Off-card tab shows what share
of the month went out without a card, and what that cost: for each category, the
card that would have earned most and what it would have paid. Only spend a card
could actually have taken is costed, and rows with no category are named rather
than quietly excluded.

**Merchant codes.** A Codes tab listing all 924 merchant category codes — with
Citibank's own published descriptions, and a flag on the 20 its manual does not
list — as a grid against your own cards: which earn nothing, which carry a bonus rate and at
what cap, and which you actually spend on. Every cell is computed with the same
matching the earn engine uses, so the table cannot drift from what a purchase
would really earn. Spend on an excluded code is left out of minimum-spend
progress and the amount is reported — most issuers exclude the same codes from
both, and believing a minimum is met when the bank disagrees costs the bonus.

**The points wallet.** Every purchase is evaluated as it is logged, so the app
knows what it should earn and which programme it lands in. Those points wait in
a queue until you accept them — a bank can credit something other than the
published rate, and a wallet that quietly disagrees with the statement is worse
than none. Accepting banks them as one batch per programme per month, with the
programme's own expiry clock applied.

**Eligibility.** Tracked offers get their T&C turned into typed predicates —
`{"type":"no_issuer_card_within_months","issuer":"DBS","months":12}` — which a
deterministic evaluator runs against your own card history. The LLM only does
extraction; the verdict is computed from your data, and every clause keeps the
verbatim sentence it came from. Anything the rules can't decide returns
`needs_review` rather than a guess, because a wrong "eligible" costs a hard
pull and a 12-month cooldown.

**Review.** The clauses no card table can settle — an income floor, a card you
closed before you started tracking — are answered by you, in the Offers tab or
with `/rule <id> yes|no|na`. Your answer sets the verdict and is stored with the
date and your note; the computed verdict stays visible beside it, so an override
is never silent. Re-reading a T&C keeps the answers to clauses that did not
change and drops the ones that did.

---

## Setup

**[SETUP.md](SETUP.md) is the full walkthrough**, with two paths:

- **Path A — no terminal.** Cloudflare dashboard plus a git connection; every
  push builds and deploys. Use this on StackBlitz, a Chromebook, an iPad, or
  anywhere Wrangler won't run. *(Wrangler cannot run in a StackBlitz
  WebContainer — it needs native binaries and a local OAuth socket.)*
- **Path B — local terminal.** The Wrangler CLI, if you have a normal shell.

Both end up in the same place, and you can use both.

## What it leads with

Minimum spend, not the credit limit.

The limit is what a credit score reads, but it is not what decides where the
next purchase goes. A minimum you are short of is: miss it and the whole
window's bonus is gone, and the only way to fix that is to spend on that card
before the window closes. So `/status` and the Cards tab lead with progress
toward the minimum, order cards by how soon one can be missed, and keep the
balance and utilization underneath.

A card whose quarter is already short sorts *below* every minimum still worth
hitting, and says so — spending there cannot bring that quarter back.

## Daily use

```
25.40 wwmc lunch          log spend — amount, nickname, note
/status                   full digest
/cards  /offers  /reqs    listings
/help                     everything else
```

Three crons fire daily: 06:00 and 14:00 local scan for offers, 09:30 local
sends the digest. Threshold alerts also fire the moment a transaction crosses
one. `/scan` runs a scan immediately; `/scan <url>` reads a single page.

### Adding a card and its minimums

```
/newcard DBS|Altitude Visa|alt|8000|18|2025-03-04
/req alt|signup_min|1000|fixed_window|2026-11-14||30k miles
/req wwmc|monthly_min|800|calendar_month||1000|4 mpd on first $1k
```

`/req` fields are `nickname|kind|amount|window|deadline|cap|txns|note`.
Window is `calendar_month`, `statement_cycle`, `calendar_quarter`,
`statement_quarter` or `fixed_window`.

### Cards that pay by the quarter, in tiers

A card like UOB One does not use calendar quarters. Its quarter is **three
statement months counted from the month the card was issued** — issued in
February means Feb–Mar–Apr, then May–Jun–Jul — and a "month" runs from the day
after one statement closes to the day the next one does, not the 1st to the
31st. The minimum has to be hit in *every* one of the three, and how much the
quarter pays depends on which spend tier you held.

```
/req uobone|monthly_min|600|statement_quarter||||10|quarterly cashback
/tiers uobone 600=50 1000=110 2000=300
```

`/tiers` is spend per statement month on the left, what the quarter pays on the
right. The quarter pays at the **lowest** tier held across its three months, so
one big month does not carry two thin ones. The first quarter pro-rates: hit the
minimum in the last two months only and two thirds is paid; in the last month
only, a third.

Same thing in the app: **Cards → Add a minimum → every statement month of a
rolling quarter**, then add the tiers. Every card shows its three months with a
tick, a cross or the one in progress, so a month that closed short is visible
the day it happens rather than when the cashback fails to arrive.

When you close a card, use `/closecard alt|2026-09-01` — eligibility cooldowns
run from the closure date, so this is what keeps future verdicts honest.

### Telling it what a card pays

**Cards → Read a rewards page.** Give it the card's rewards page, or paste the
terms (bank sites refuse anything that is not a browser). It reads the rates,
caps, minimums and merchant codes, shows each one **with the sentence it came
from**, and saves nothing until you press the button on it. A rate read out of
the wrong paragraph would misdirect every recommendation the app makes, so it
is offered, never applied.

For the prose it cannot read, **Copy the prompt for Claude** hands over the
page already wrapped in the instructions that turn it into `/addearn` and
`/exclude` lines. `/cardrules alt` gives the same prompt in the bot.

The codes matter more than the category word: `/addearn alt online 4` claims
every online purchase earns the bonus, while
`/addearn alt online 4 mcc 5262,5964,5969` is what the terms actually say.

### Working an offer

1. A scan posts a match → tap **Track** → it becomes offer #N.
2. **Copy the prompt** in the Offers tab (or `/extract N` in the bot) — it comes
   with the JSON schema baked in.
3. Open the T&C, paste the prompt plus the terms into Claude Pro.
4. Paste the reply into the box under the offer (or `/save N {…}`).
5. It is evaluated against your card history immediately.
6. Answer whatever it could not decide: **I meet this / I do not / N/A**, with a
   note, or `/rule <rule id> yes|no|na`. Then **Mark applied** or **Dismiss**.

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
src/rss.ts            feed and page fetch, parse, URL cleaning, keyword gate
src/mcc.ts            the code table read across your cards
src/other.ts          spending that never touched a card, and what it cost
src/mccscan.ts        importing merchant codes, and the gaps in your own
src/statement.ts      reading a pasted statement into transactions
web/src/pdf.ts        the PDF text layer, grouped back into lines
web/src/banks.ts      one profile per issuer's statement layout
src/eligibility.ts    predicate evaluator and your review decisions
src/offers.ts         saving an extraction without losing your answers
src/extraction.ts     the prompt handed to you for Claude — the LLM half
src/auth.ts           HMAC magic-link tokens
migrations/           ALTER statements for databases created before a change
web/                  React + Vite PWA, served by the Worker as assets
.github/workflows/    CI: typecheck, both test suites, dashboard build
```

## Offers that have ended

Every offer carries its end date. The Offers tab shows days remaining, turns
the line amber inside two weeks and red once it has passed. Ended offers are
marked expired each night and deleted `OFFER_RETENTION_DAYS` (90) later —
except ones you marked applied, which are your own record and are never swept.

## What it costs to run

**Settings → Cloudflare** reads Cloudflare's own meters: Worker invocations and
errors, D1 rows read and written, database size, each against the free tier's
*daily* allowance measured on the busiest day of the window — an average across
a quiet week would hide the day that nearly ran out.

It needs an API token with one permission (Account → Account Analytics → Read),
which is free. The token goes in as a secret like the others; the account id,
Worker name and database id go in Settings and are not credentials. Without
them the panel says exactly what is missing rather than reporting a confident
zero. Full walkthrough in SETUP.md.

## Keeping it small

Scanning only looks at the current calendar month by default (`SCAN_WINDOW`);
older posts are recorded once so they are never re-read, and never pushed at
you. Scanned items are compacted nightly after `FEED_RETENTION_DAYS` (180): the id
and your decision stay, so nothing is ever shown twice, and the excerpt, terms
and offer link go. `/prune` reports what the history costs; the Offers tab can
compact or delete on demand. Transactions are left alone — they are a hundred
bytes each, and the analytics, audit and eligibility all read the full history.

## Adding sources

The Offers tab has a **Sources** panel: add one, edit its URL or label, switch
between `rss` and `page`, pause it, or remove it. Renaming keeps the items
already scanned; removing a source leaves its history, which is what stops a
removed-then-re-added source from re-notifying you about everything.


`/addfeed <url>|<label>|<kind>`, or edit `seed.sql`. `kind` is `rss`, `page`, or
blank to detect from the response. RSS and Atom both work; `page` treats an
ordinary HTML listing — a bank's promotions page, a blog category — as a source
by harvesting its headline links.

The keyword gate in `src/rss.ts` requires a promo term *and* a card term, or a
concrete reward figure next to a card term, and always matches your own cards'
product names. When the summary is too thin to judge, the scanner opens the
article and decides on the full text; at most 12 pages are fetched per scan.
