/**
 * The bot hands you this prompt; you paste it into Claude Pro along with the
 * card's T&C text, then paste the JSON it returns back into the chat with
 * /save <offer_id>. No API key, no automation, and you read the clauses at the
 * moment you are deciding whether to apply anyway.
 *
 * Kept under Telegram's 4096-character message limit so it sends in one piece.
 */
export function extractionPrompt(offerId: number, sourceUrl: string | null): string {
  return `You are extracting a credit card sign-up offer into structured data.

I will paste the offer page and its full Terms & Conditions below.
${sourceUrl ? `Source: ${sourceUrl}\n` : ''}
Return ONLY a JSON object, no commentary, matching exactly:

{
  "issuer": "DBS",
  "product": "Altitude Visa",
  "product_key": "dbs_altitude_visa",
  "bonus_miles": 30000,
  "bonus_note": "free text if the reward is not plain miles",
  "min_spend": 1000.00,
  "spend_window_days": 60,
  "valid_from": "2026-09-01",
  "valid_until": "2026-12-31",
  "rules": [
    { "predicate": {"type":"new_to_bank","issuer":"DBS"},
      "quote": "the exact sentence from the T&C this came from" }
  ]
}

Rules for "predicate" — use ONLY these shapes:
- {"type":"new_to_bank","issuer":"X"}
  no card with that issuer, ever
- {"type":"never_held_product","product_key":"x"}
  never held this specific card
- {"type":"no_product_within_months","product_key":"x","months":12}
  cancelled-and-reapply cooldown on this card
- {"type":"no_issuer_card_within_months","issuer":"X","months":12}
  no principal card with that issuer in the window
- {"type":"no_signup_bonus_within_months","issuer":"X","months":12}
  has not taken that issuer's sign-up bonus recently
- {"type":"min_income","amount_cents":3000000,"period":"year"}
- {"type":"manual_review","note":"why this needs a human"}

Extraction rules:
1. Every eligibility clause becomes its own rules[] entry with the verbatim
   "quote" it came from. Never paraphrase a quote.
2. If a clause does not fit a shape above, use "manual_review" with a note.
   Do NOT force it into a closer-looking shape.
3. "principal card" / "primary cardmember" means the cardholder, not a
   supplementary card. Note the distinction in the quote if it matters.
4. If the window is ambiguous (e.g. "in the past 12 months" without saying
   from what date), add a manual_review rule saying so.
5. product_key is lowercase snake_case: issuer + product, no punctuation.
6. min_spend is dollars as a number. Omit or null any field not stated —
   never invent a value.
7. Dates are YYYY-MM-DD.

This is offer #${offerId}. Paste the reply back to the bot as:
/save ${offerId} <the JSON>

T&C text follows:
---
`;
}

/**
 * The prompt that turns a card's terms into rules.
 *
 * One prompt, two callers: the bot hands it over bare for you to paste a page
 * under, and the rewards-page reader hands it over with the page already in it.
 * They must not drift apart — a rule the bot's version insists on and the web
 * app's forgets is a rule the app silently stops getting right.
 */
export function cardRulesPrompt(
  nickname: string,
  product: string,
  opts: { source?: string; text?: string } = {}
): string {
  const { source, text } = opts;
  return `Extract this credit card's earning structure into commands.

Return ONLY a list of commands, one per line, no commentary:

/addearn ${nickname} <category> <rate> cap <amount> window <window> mcc <codes> group <name>
/exclude <mcc> ${nickname} <reason>

Rules:
1. <rate> is miles per dollar as a plain number (4), OR a percentage with a
   % sign for cashback cards (5%). Never mix the two on one line.
2. <category> is one lowercase word. Use the closest of: dining, groceries,
   online, shopping, transport, travel, fuel, utilities, entertainment,
   contactless, foreign, health. Use * for the fallback rate on everything else.
3. ALWAYS include a /addearn ${nickname} * <rate> line for the base rate.
4. cap is the spend at which the bonus rate stops, in dollars. Omit if none.
5. window is statement_cycle, calendar_month or calendar_quarter — whichever
   the cap resets on. Omit if there is no cap.
6. mcc is a comma-separated list of four-digit codes the rate is restricted to,
   when the terms name them. This matters more than the category word: a rate
   restricted to 5262,5964,5969 is not the same thing as "online".
7. If ONE cap is shared across several categories, give those lines the SAME
   group name. If each category has its own cap, omit group. This matters:
   getting it wrong makes the app think you have more bonus headroom than you do.
8. Add a /exclude line for every merchant code or category the terms say earns
   nothing, with the reason in a few words.
9. If the card lets you CHOOSE the bonus category, output only the category
   currently selected, and add a comment line saying so.
10. Do not invent rates or codes. If the terms do not state one, leave that line
   out and add a comment naming what is missing.

Card: ${product} (nickname: ${nickname})
${source ? `Source: ${source}\n` : ''}
${text ? 'Page text follows:' : 'Rewards page and terms follow:'}
---
${text ? `${text.slice(0, 12_000)}\n` : ''}`;
}

export const HELP = `*Miles tracker*

*Logging spend*
\`25.40 uobone lunch\` — amount, card, optional note (dated today)
Add a date anywhere to backdate:
  \`25.40 uobone yesterday lunch\`
  \`25.40 uobone 5/9 lunch\` — day/month
  \`25.40 uobone 2026-09-05 lunch\`
  \`25.40 uobone -3 lunch\` — three days ago
/recent — last 15 entries (⏳ = posting date unknown)
/review — spend with no category yet
/cat <id> <category> — set one
Tag \`#?\` when you don't know the category yet — better than guessing
/posted <id> <date> — set when the bank actually posted it
/del <id> — remove one · /undo — remove the last

*Which card to use*
/which — best card for each category
/optimise — where the same spend would earn more
/which groceries 120 — ranked, with what each would actually return
/which NTUC 120 — a merchant works too, once you've tagged it
Tag a merchant once: \`25.40 citirw #groceries NTUC\`
After that \`25.40 citirw NTUC\` categorises itself.
Cashback and miles cards are compared in dollars, using MILE\_VALUE\_CENTS.

*Points & miles*
/bal — balances, with the nearest expiry
/addbal program|points|expires|note
/convert 50000 citi\_ty krisflyer — compare routes, changes nothing
/transfer 50000 citi\_ty krisflyer — actually move them, oldest batch first
/expiry — every batch, soonest expiry first
/earn — list earn rules
/addearn <card> <category> <rate> — e.g. \`/addearn citirw shopping 4\`
   add \`cap 1000\`, \`window calendar_month\`, \`group tenx\`, \`mcc 5262,5964\` as needed
   a rate ending in % means cashback: \`/addearn uobone groceries 5%\`
/cardrules <card> — get a prompt to extract a card's rates with Claude
/setearn <id> <rate> — correct a rule, e.g. \`/setearn 3 5%\`
/delearn <id>
/routes — every transfer route and when it was last checked
/rates — the weekly rates review, on demand
/verified <id> — mark a route checked against the bank
/setrate id|from|to|fee|min|increment — correct a route
/setbonus id|pct|until — record a promo bonus
/addconv — add a transfer route

*Status*
/status — full digest: utilization + minimum spend
/cards — one line per card
/offers — tracked offers and eligibility

*Setting up*
/newcard issuer|product|nickname|limit|statement\\_day|opened\\_at
  e.g. \`/newcard DBS|Altitude Visa|alt|8000|18|2025-03-04\`
/closecard nickname|YYYY-MM-DD
/req nickname|kind|amount|window|deadline|cap|txns|note
  monthly: \`/req wwmc|monthly_min|800|calendar_month||1000||4 mpd on first $1k\`
  signup:  \`/req alt|signup_min|1000|fixed_window|2026-11-14|||30k miles\`
  rolling: \`/req uobone|monthly_min|600|statement_quarter||||10|quarterly cashback\`
  window is calendar_month, statement_cycle, calendar_quarter,
  statement_quarter or fixed_window
  statement_quarter = three statement months counted from the month the
  card was issued, and the amount must be hit in EVERY one of them
/tiers <card> 600=50 1000=110 2000=300 — tiered cashback: spend a month,
  pays a quarter. The quarter pays at the LOWEST tier its three months held.
/reqs — list requirements
/delreq <id>

*Off-card spending*
/spend <amount> <method> [date] [note] — PayLah, cash, PayNow…
/spends [YYYY-MM] — the month, and what it cost you
/delspend <id>

*Merchant codes*
/mccscan — refresh merchant codes from the public directory
/mcc <merchant> [code] — look one up here or online, or record it
/codes — codes you have spent on, and what each card pays
/codes <query> — search by code, description or category
/exclude <mcc> [card] [reason] — record one that earns nothing

*Points wallet*
/wallet — everything you hold, and what it is worth
/credit — what your spending earned, waiting to be banked
/credit all — accept it · /credit <programme> for one
/undocredit <txn id> — take one back out
/setprogram <card> <programme> — where a card's points land

*Offers*
/offers — tracked offers and their clauses (/offers all includes dismissed)
/extract <offer id> — get the prompt to paste into Claude
/save <offer id> {json} — store what Claude returned
/rule <rule id> yes|no|na [note] — answer a clause only you can settle
/apply <offer id> — mark as applied
/dismiss <offer id> — set it aside
/scan — check every source now (opens articles)
/scan quick — headlines only, no page fetches
/scan <url> — read one promo page on demand
/feeds — list sources
/addfeed <url>|<label>|<rss|page>

/prune — what the scanned history costs, and clean it up
/prune offers — mark ended offers expired, remove old ones
/app — open the dashboard
/migrate — bring the database up to date after a deploy
/seed — load the default feeds and transfer routes`;
