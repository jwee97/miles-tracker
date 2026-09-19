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

## How it is put together

Four things, deliberately separate:

**Card products** are what a card *is* — the rates, the programme, the caps.
**Your cards** are what you hold — the limit, the statement day, the nickname.
**Rule sets** are what a product paid *and when*, versioned with effective
dates. **Transactions** are what actually happened.

A bank changing a rate in October does not rewrite what August earned: the old
version is closed the day before the new one opens, and every calculation picks
the version in force on the day it is asking about. Two published versions may
never cover the same day, and every evaluation records which version produced
its numbers. See SETUP.md for the detail.

The card products ship pre-populated: 31 Singapore cards across DBS/POSB, UOB,
Citi, OCBC, Standard Chartered, HSBC, Amex and Maybank — identity only, and
deliberately **no rates**. The banks' pages are not machine-readable from here,
and a rate written from memory is worse than a blank, because a blank asks you
and a wrong rate answers you. Read a rewards page onto a card you hold and
those rates become that product's current version, shared by every card on it.

## Did the bank credit what it owed?

Expectations and observations are two ledgers, and reconciliation never makes
them agree — it compares them. Per component, so the answer is "the base matches
and the bonus is short by 1,500" rather than "reward mismatch".

Every explanation is a claim about evidence, and the first candidate is usually
the app's own fault: rates nobody has verified, or a purchase whose merchant
code was a guess. Nothing is ever phrased as an accusation.

If the statement shows a different merchant code, one button takes it, teaches
the merchant, and re-prices the transaction — at which point the discrepancy
usually disappears, because the expectation was what was wrong.

A welcome bonus with two months to run is pending, not missing. Reporting it as
a shortfall would make the check useless for the rewards people most want
checked.

## What to do with the points, and what is missing

The wallet plans transfers rather than listing balances: whole blocks, what gets
stranded, the fee over the miles it buys, expiring points first if you ask. The
app never transfers anything — it writes the instruction and you carry it out.
Bonuses are dated rows on top of routes, never written into the ratio, and one
that needs registering is shown but not counted.

Offers are filtered to this wallet and this spending, and every one says why it
is being shown. Tracking an offer creates an ordinary minimum-spend requirement,
and completing it writes what the bank now owes — which the rewards check then
looks for.

**Improve my setup** starts from gaps in your own spending, not from a list of
cards. Candidates are re-run through the real recommendation engine over your
real transactions, so a card only counts where it would have beaten the one you
used. The annual fee, the welcome bonus and the cost of having another card to
manage are all kept separate, and the section listing cards that are *not* worth
it is the half that prevents an unnecessary purchase.

## Re-pricing the past

Correct a rate, confirm a merchant code, fix a category — and every purchase
priced before that is carrying an old prediction. The ledger can re-price them.

It uses the rules as they now read **for the day each purchase happened**, with
that purchase's cap window and the cap position as it stood earlier in the
ledger. So August is re-priced by August, running it twice changes nothing the
second time, and the answer does not drift as later purchases arrive.

It never touches what the bank actually paid. That is an observation, and it is
the only thing the reward audit has to check a prediction against — after a
re-pricing the audit often shows a *bigger* gap, which is the gap that was
always there behind a stale number.

## Changing what a card pays

One rule holds the whole catalogue layer up: the only way rules a calculation
can reach have changed is that a person read a comparison and said yes.

A new version is drafted from whatever is live, so a rule nobody meant to remove
cannot vanish by being left out. A draft is invisible to every calculation; a
published version cannot be edited at all. Before publishing you get the change
in sentences — *"online goes from 4 mpd, capped at $1,000 to 1.2 mpd, capped at
$500"* — and the publish button only exists once you have seen it.

Products name the bank documents they were read out of, with a hash of what the
page said. Paste the page again later and the app tells you whether it moved. A
moved page marks the card for review and changes no rule: automated extraction
may write a draft, never production.

Cards whose numbers nobody has checked lately are listed rather than hidden.
They are still used — a stale rate beats no rate — but every recommendation made
from them says it is uncertain.

Adding a card means picking it, not describing it: the issuer, programme and
every rate come with the product.

## Which card to use

`POST /api/recommend` ranks your cards for one purchase and shows its working.

Three things it does that a sort by reward rate cannot:

**It disqualifies rather than demotes.** An excluded merchant code, a closed
card, or a product with no rules in force on that date means the card cannot be
used for this purchase — not that it is a little behind. No rate however good
floats it back to the top. It is still returned, under `ineligible` with a
reason, so the omission is explicable.

**It shows the arithmetic.** Every pick carries its `score_components` — reward
value, objective bonus, minimum-spend bonus, urgency, uncertainty penalty,
exhausted-cap penalty — and they add up to the score. A minimum-spend deadline
inside the week outranks any plausible reward; that is a weight you can read,
not a comparator you have to trust.

**It says when it is guessing.** Confidence is high, medium or low, with the
assumptions listed. An unknown merchant code lowers it only where a card's rules
actually turn on codes — which is exactly the case where a code-gated rule
cannot match, so the uncertainty must be read off the card, not off the rule
that won.

When a bonus cap will run out mid-purchase it also says what to put where and
what the split is worth; under `SPLIT_MIN_GAIN_CENTS` (default $1.50) it keeps
quiet, because two taps at the counter should be worth something.

## Setting up

Three steps, and not one of them asks for a reward rate. Search the catalogue by
whatever you call the card — `wwmc` works — pick the ones you hold, and answer
only what the catalogue cannot know: when you got it, when its statement closes.
The rates, codes, caps and programme come with the product.

The questions vary by card. UOB One needs its opening date because its quarters
are counted from the month it was issued; an ordinary card does not. A statement
day nobody supplied still works — the card says the cycle is assumed rather than
pretending it bills on the 1st.

A recently opened card is asked once whether it came with a welcome offer, and
the offer becomes an ordinary minimum-spend requirement rather than a second
progress system.

Someone who already has cards is never shown a welcome screen. Gaps in an
existing setup appear on Home as a repair, naming the card and what the gap
costs.

## The home screen

One question at the top — which card should I use — and the answer to it gets
the screen. Below it, *things to take care of*: the minimums, deadlines,
allowances and expiries that can still be acted on, ordered by what it costs to
ignore them, with the housekeeping grouped into one line each rather than
listed. Then what you have actually spent, with what it earned and how sure that
is.

Under the recommendation, one button — **I used this card** — logs that purchase
against that card as **pending**, because the bank has not confirmed it and a
posting date the app invented would be counted as a fact by every window that
judges by posting date.

Five tabs: Home, Activity, Cards, Rewards, More. The catalogue, codes, audit,
trends and the rest are management tools and now live under More.

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

Rates can hang off the rungs too: `/addearn uobone groceries 6% tier 1000`
earns 6% only while the card is holding the $1,000 tier, and 3.33% below it.
The rung used is the one the *quarter* will pay, so a big month inside a quarter
already capped lower does not earn the higher rate.

The ladder is the minimum: with rungs at $600/$1,000/$2,000 the monthly minimum
is **$600**, not whatever figure the requirement was created with. A minimum set
up with the wrong window can be corrected in place — **Edit** beside it — and a
window that adds three months into one total is flagged on the card with what to
change it to. And because
the quarter pays at its weakest month, a month that closes at $900 caps the
whole quarter at the $600 rung — so the target for the remaining months is $600,
and the app says so rather than urging spend that buys nothing.

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

## One way in

Every channel — the form, the bot, an SMS, a statement, a CSV, "I used this
card" — goes through one pipeline: normalised, deduplicated, merchant resolved,
coded, priced, and queued where something could not be decided.

The same purchase often arrives twice: an SMS when you pay, a statement line
three days later with a different date and spelling. Certainty is graded. The
source's own identifier, or the same card, amount and merchant within three
days, merges by itself; a mere resemblance is queued as a question with both
transactions intact, because nothing in the data distinguishes a real duplicate
from two similar purchases and a wrong merge leaves no trace.

Importing a statement is a reconciliation, not a create: rows are classified
against what the app already believes, bill payments and fees are never counted
as spend, and importing the same statement twice creates nothing the second
time.

Merchant codes are evidence, not fact. A merchant legitimately presents several,
so observations accumulate with a weight by source and the answer is derived —
and when two codes have comparable support the app says *ambiguous* rather than
choosing quietly, because that is exactly the case where the choice changes
which card wins.

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
src/promotions/       the offer platform: terms, relevance, tracking, variants
src/promotions/evidence.ts       why the app believes an offer is current
src/promotions/discovery/        finding offers without being asked
  sources.ts          the source registry and how often each is worth reading
  search-provider.ts  the search API, behind one swappable interface
  search-runner.ts    running searches, within a budget, and ingesting results
  domains.ts          who a domain is, and therefore what a page from it is worth
  diagnostics.ts      testing one source without changing it
  reclassify.ts       judging old articles again, after the classifier improves
  fetch.ts            robots, refusals, size limits — the politeness layer
  classify.ts         is this article about an offer at all
  extract.ts          article text into claims, never into facts
  fingerprint.ts      is this the same offer we already know about
  corroborate.ts      weighing claims by independent host and trust tier
  verify.ts           one careful look at the issuer's own page
  diff.ts             what changed between two monthly roundups
  publish.ts          claims into the promotion the rest of the app reads
  review.ts           the short list left for a person
src/auth.ts           HMAC magic-link tokens
shared/discovery.ts   the pipeline vocabulary both halves of the app import
migrations/           ALTER statements for databases created before a change
web/                  React + Vite PWA, served by the Worker as assets
.github/workflows/    CI: typecheck, both test suites, dashboard build
```

## Finding offers by itself

**More → Offer discovery.** The app reads the sites that cover Singapore card
promotions, turns what they say into claims, weighs the claims against each
other, and publishes the ones the evidence carries. Three rules shape all of
it, and each is about what the system must *not* do.

**It does not read a site that has said no.** A 403, a 429, a robots rule or a
bot-check page is a recorded outcome, not a puzzle to solve. There is no
retrying, no header-spoofing and no CAPTCHA handling anywhere in the code. A
source that keeps refusing is scanned less often and its absence lowers
confidence, rather than stopping discovery. Nothing is archived either: a claim
keeps a URL, a title, a date, a short excerpt and a content hash — never the
article.

**It does not turn an article into a fact.** Every number an extractor produces
is a claim in `promotion_claims` with the URL and the sentence it came from.
What a promotion says is then decided by weighing claims, counting *independent
hosts* rather than articles, so one blog quoted three times is one source. Two
sources disagreeing produces a `conflicting` state that a person sees — not a
coin toss.

**It does not publish money terms nobody checked.** Only two things publish
themselves: an offer the issuer's own page confirms, and an offer already
published whose end date moved with at least two independent sources agreeing.
Everything else waits in the review queue. And publication is refused outright
while a term that decides money is unknown, because an offer with a wrong
threshold is worse than no offer — somebody spends against it.

It reads feeds, and — with a provider configured — searches the web. Search
results become the same articles a feed produces, and trust follows the
destination: a MileLion article surfaced by a search engine is a specialist
source, not a search result. Without `SEARCH_PROVIDER` and `SEARCH_API_KEY`,
search reports itself **not configured** rather than healthy, and feeds carry
on alone.

Three stages run nightly, each bounded and independently recoverable: read the
feeds and run the searches, read the articles worth reading, weigh the
evidence. **Run discovery now** loops all three until nothing moves.

### Knowing where it stopped

The system is built so it cannot fail silently. Eight situations that a naive
implementation reports identically as "nothing new" are kept apart: nothing
configured, search not configured, a source refusing, nothing searched, nothing
found, found but irrelevant, read but naming no offer, and extracted but
already known. Each has its own state, its own sentence, and its own line in
the funnel the run reports.

Source cadence adapts to what a source carries, but only after five scans, only
one step at a time, and never at all for the pinned publications — because an
earlier version walked the most productive feed in the system down to monthly
on the strength of a few quiet days. Re-running the seed restores a source that
drifted.

### What an offer says about itself

Every offer in **Offers for you** carries how sure the app is — "the bank's own
page said this", "two independent sites agree, nobody has read it off the
bank's page", "one source said this three weeks ago". **Why we think this is
current** opens the provenance: which sites, when each was read, the sentence
each one said it in, every value anyone claimed for each field, and what has
changed since the offer was first recorded.

Offers old enough to be worth re-checking say so rather than presenting a stale
number confidently.

### One campaign, several offers

The same campaign is rarely one offer: a welcome bonus often pays one number
through the bank's page and another through a comparison site, and pays new
customers something it does not pay you. Those are stored as **variants**, and
what an offer pays is shown as a range when they disagree — never the largest
one on its own. A variant you cannot take is shown *with the sentence that says
why*, because hiding it is how an app quietly recommends something that turns
out to be for new customers only.

Targeted offers are the one thing the app cannot read anywhere — they arrive by
email to a list nobody outside the bank can see. **I was sent a different
offer** records yours. It is trusted, because you are holding the email, and it
is kept as your own variant so it never changes what the app believes the
public offer to be.

### The review queue

**More → Offer discovery** leads with what is left for a person, and the aim is
that this list is short and each item takes seconds. Everything needed is
already on the item: the terms, how many independent sources back each one, the
sentence each said it in, any conflicting value, and the diff against what is
already published. Nobody should have to open the articles.

Any number you type there is recorded as a claim sourced to you at the highest
trust tier — a correction made during review is the strongest evidence the
system ever gets.

### "I do not own this card" is not "I cannot use this promotion"

Those are different facts, and treating them as one produced the worst bug this
app has had. A promotion linked to a card product, held by nobody, was reported
as not applicable — correct for "existing OCBC Rewards cardholders get $20
back", exactly backwards for "apply for the OCBC Rewards Card and get 20,000
miles", where not holding it is the precondition rather than the
disqualification.

Six questions are now asked separately:

| | |
|---|---|
| **Audience** | who the offer is for, structured, with the wording it came from |
| **Relationship** | how it relates to you — held card, new-card offer, points, invitation, unknown |
| **Eligibility** | whether you can qualify, computed from your own card history |
| **Relevance** | whether it is worth showing, which encodes no ownership at all |
| **Acquisition** | whether qualifying means getting the card |
| **Confidence** | how sure any of that is |

A link between a promotion and a card means only that the promotion concerns
that card. The audience says what holding it has to do with anything.

**Unknown stays unknown.** "No restriction was extracted" is not evidence that
an offer is open to everyone — most articles never spell eligibility out — so
absence of evidence resolves to `unknown`, never to `public`, and a linked card
you do not hold with no established audience is shown at low relevance saying
what could not be determined. The old model concluded a rejection from exactly
that evidence.

**Eligibility is arithmetic, never a guess.** It reuses the predicate evaluator
the app already had: new-to-bank rules, exclusion windows and never-held
conditions are evaluated against the cards you have entered, and anything the
data cannot settle returns unresolved rather than a verdict. Extraction may
propose that a sentence means "new-to-bank"; whether *you* are new to that bank
is counting. Getting this wrong costs a hard credit pull and a twelve-month
cooldown, which is why nothing here is inferred.

**New-card offers get their own section**, and open the acquisition simulator
with the offer attached — where the one-off bonus stays out of the annual
figure, because a card whose whole case rests on a welcome bonus is a card
worth having for one year.

Tracking one saves it rather than pretending to measure it: there is no card
for the spend to land on yet. Adding the card activates the requirement by
itself.

### When a number is wrong

Two things the app used to be able to state and not solve.

**"This card's rates have never been checked."** Publishing a rule set marks a
product verified, which is right when the rules are changing — but it left no
way to say *the rules already here are correct, I have just re-read the bank's
page*, so those cards stayed unchecked forever. **Catalogue → These rates are
right** is that route. It asks for the page you read, because the claim is
about a document, and records it as a source so the confirmation is auditable.
It is dated, not permanent: the warning returns when the confirmation ages.

**A published offer with a wrong figure.** The likeliest correction is one
number — a source misread it, or somebody typed dollars into a field that meant
cents. Rejecting the whole offer to get it rediscovered would take the tracking
and the history with it, so **These numbers are wrong** edits it in place: a new
version, a change event, and a claim attributed to you at the tier an issuer
gets, so the next scan cannot quietly put the old number back.

An offer's **name and kind** are correctable too. The kind decides which
section an offer appears under, so a cashback welcome offer read as a transfer
bonus sits where nobody would look for it — and being right about its figures
does not help.

Amounts are entered in dollars everywhere, and a figure that could only be a
units mistake is refused rather than stored — a $4.00 cashback bonus with a
$4.00 threshold is not a real offer, and nothing else on the screen would have
told you it was a typo rather than a bad source.

## Offers that have ended

Every offer carries its end date. The Offers tab shows days remaining, turns
the line amber inside two weeks and red once it has passed. Ended offers are
marked expired each night and deleted `OFFER_RETENTION_DAYS` (90) later —
except ones you marked applied, which are your own record and are never swept.

## What it costs to run

**Settings → Cloudflare** reads Cloudflare's own meters: Worker invocations,
errors and CPU time per request; D1 rows read and written, query latency,
database size and how fast it is growing; each against the free tier's *daily*
allowance measured on the busiest day of the window — an average across a quiet
week would hide the day that nearly ran out.

It also names **where the rows go** — the statements doing the most reading,
with the SQL and each one's share of the window — because rows read is never
spread evenly, and one query missing an index costs more than everything else
together. With `Workers Observability Read` on the token it lists what the
exceptions actually were, not just how many.

Which fields a Cloudflare dataset offers varies by plan, so the panel tries
several query shapes and uses the first that is accepted. **What was asked**
lists every attempt and Cloudflare's reply to each, so an empty panel can be
explained rather than guessed at.

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
