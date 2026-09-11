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

export const HELP = `*Miles tracker*

*Logging spend*
\`25.40 uobone lunch\` — amount, card, optional note (dated today)
Add a date anywhere to backdate:
  \`25.40 uobone yesterday lunch\`
  \`25.40 uobone 5/9 lunch\` — day/month
  \`25.40 uobone 2026-09-05 lunch\`
  \`25.40 uobone -3 lunch\` — three days ago
/recent — last 15 entries (⏳ = posting date unknown)
/posted <id> <date> — set when the bank actually posted it
/del <id> — remove one · /undo — remove the last

*Which card to use*
/which groceries 120 — ranks cards by what you'd actually earn
Tag spend with a category so caps track: \`25.40 citirw #groceries NTUC\`

*Points & miles*
/bal — balances, with the nearest expiry
/addbal program|points|expires|note
/convert 50000 citi\_ty krisflyer — blocks, fees, best route
/earn — earn rules · /addearn · /delearn
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
/req nickname|kind|amount|window|deadline|cap|note
  monthly: \`/req wwmc|monthly_min|800|calendar_month||1000|4 mpd on first $1k\`
  signup:  \`/req alt|signup_min|1000|fixed_window|2026-11-14||30k miles\`
  window is calendar_month, statement_cycle or fixed_window
/reqs — list requirements
/delreq <id>

*Offers*
/extract <offer id> — get the prompt to paste into Claude
/save <offer id> {json} — store what Claude returned
/apply <offer id> — mark as applied
/feeds — list RSS sources
/addfeed <url>|<label>

/app — open the dashboard`;
