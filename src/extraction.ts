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

Return ONLY commands, one per line, and # comment lines. No other prose:

/addearn ${nickname} <category> <rate> cap <amount> window <window> mcc <codes> group <name> tier <amount> mode <key> region <local|foreign> min <amount>
/exclude <mcc> ${nickname} <reason>
/req ${nickname}|monthly_min|<amount>|<window>|||<txns>|<note>

Rules:
1. <rate> is miles per dollar (4), OR a percentage with a % sign for cashback
   (5%). Never mix the two on one line.
2. <category> is one lowercase word: dining, groceries, online, shopping,
   transport, travel, fuel, utilities, entertainment, contactless, health.
   Use * for the rate on everything else, and ALWAYS include a
   /addearn ${nickname} * <rate> line.
3. cap is the SPEND at which the rate stops, in dollars. If the terms cap the
   REWARD ("S$500 of cashback a quarter"), divide by the rate: S$500 at 3% is
   \`cap 16666.67\`. Writing the reward as the spend caps it at 3% of itself.
4. window is calendar_month, calendar_quarter, statement_cycle, or
   membership_quarter (three months from the month the card was approved).
   There is no yearly window: say so in a # comment instead.
5. mcc lists the codes a rate is restricted to, comma separated, ranges allowed
   (3000-3308). The bank pays on the code, not the word, so give the list
   whenever the terms do.
6. If ONE cap is shared across several lines, give them the SAME group name.
7. If local and foreign spend earn differently, one line each with
   \`region local\` / \`region foreign\`. \`min <amount>\` if nothing is paid
   below a transaction size; \`step <amount>\` if spend is rounded down first.
8. A minimum spend is NOT a cap: write a /req line for it, and put
   \`tier <amount>\` on rates that need a spend rung.
9. /exclude every code the terms exclude; lists are fine.
10. If the card makes you CHOOSE what it pays, encode EVERY mode, not the one in
   use. Start with \`/mode ${nickname} add <key>|<label>|<payout>|<categories>\`
   (add \`|default\` to the mode that applies until one is chosen), and put
   \`mode <key>\` on each rule. If a mode lets you pick a category, give each
   category its own lines with \`mode <key>:<category>\` and that category's mcc.
11. Never invent a rate or code; say what is missing in a # comment.
12. If the rates start on a FUTURE date, write \`# effective from YYYY-MM-DD\`,
   list the rates as # comments and output no /addearn lines: dated rates go in
   as a new version under Catalogue → Edit its rules.
13. End with \`# source <url>\`.

Card: ${product} (nickname: ${nickname})
${source ? `Source: ${source}\n` : ''}
${text ? 'Page text follows:' : 'Rewards page and terms follow:'}
---
${text ? `${text.slice(0, 12_000)}\n` : ''}`;
}

/**
 * The command menu Telegram offers when you type "/".
 *
 * Registered with setMyCommands, which is the only way the client knows a
 * command exists — a command the bot handles but never advertises is a command
 * only its author can find. Kept here beside HELP, and checked against the
 * handler's own cases, because a menu that has drifted from the code is worse
 * than no menu: it offers something that answers "Unknown command".
 *
 * Telegram's rules: name is lowercase letters, digits and underscores, 1-32
 * characters, no leading slash; description 1-256 characters; at most 100.
 * Order is the order it displays in, so the daily ones come first.
 */
export const COMMANDS: { command: string; description: string }[] = [
  // Every day
  { command: 'which', description: 'Best card for a category, merchant or amount' },
  { command: 'recent', description: 'The last 15 entries' },
  { command: 'review', description: 'Spend with no category yet' },
  { command: 'cat', description: 'Set a category: /cat <id> <category>' },
  { command: 'status', description: 'Utilization, minimums and what still needs spending' },
  { command: 'cards', description: 'One line per card' },
  { command: 'app', description: 'Open the dashboard' },
  { command: 'add', description: 'Log spend: /add 25.40 uobone lunch' },
  { command: 'del', description: 'Remove one entry: /del <id>' },
  { command: 'undo', description: 'Remove the last entry' },
  { command: 'posted', description: 'Set when the bank posted an entry' },
  { command: 'optimise', description: 'Where the same spend would have earned more' },

  // Points and miles
  { command: 'bal', description: 'Balances, with the nearest expiry' },
  { command: 'wallet', description: 'Everything you hold and what it is worth' },
  { command: 'credit', description: 'Rewards your spending earned, waiting to be banked' },
  { command: 'undocredit', description: 'Take one credited reward back out' },
  { command: 'expiry', description: 'Every batch of points, soonest expiry first' },
  { command: 'convert', description: 'Compare transfer routes without moving anything' },
  { command: 'transfer', description: 'Move points, oldest batch first' },
  { command: 'routes', description: 'Every transfer route and when it was last checked' },
  { command: 'rates', description: 'The weekly rates review, on demand' },
  { command: 'verified', description: 'Mark a transfer route checked against the bank' },
  { command: 'setrate', description: 'Correct a transfer route' },
  { command: 'setbonus', description: 'Record a promotional transfer bonus' },
  { command: 'addconv', description: 'Add a transfer route' },
  { command: 'addbal', description: 'Record a points balance' },
  { command: 'setprogram', description: 'Where a card\'s points land' },

  // Cards and what they pay
  { command: 'newcard', description: 'Add a card: issuer|product|nickname|limit|statement_day|opened_at' },
  { command: 'closecard', description: 'Close a card: nickname|YYYY-MM-DD' },
  { command: 'earn', description: 'List earn rules' },
  { command: 'addearn', description: 'Add an earn rule: /addearn citirw dining 4 cap 1000' },
  { command: 'setearn', description: 'Correct a rule\'s rate: /setearn 3 5%' },
  { command: 'delearn', description: 'Remove an earn rule' },
  { command: 'cardrules', description: 'Get the prompt that reads a card\'s rates out of its page' },
  { command: 'mode', description: 'Cards you choose the reward of: see or switch the mode' },
  { command: 'cardfix', description: 'Put a card back to its checked definition: /cardfix freedom' },
  { command: 'tiers', description: 'Tiered cashback: /tiers uobone 600=50 1000=110' },
  { command: 'req', description: 'Add a minimum spend requirement' },
  { command: 'reqs', description: 'List minimum spend requirements' },
  { command: 'delreq', description: 'Remove a requirement' },

  // Merchant codes
  { command: 'codes', description: 'Codes you have spent on, and what each card pays' },
  { command: 'mcc', description: 'Look up or record a merchant\'s code' },
  { command: 'mccscan', description: 'Refresh merchant codes from the public directory' },
  { command: 'mccskip', description: 'Stop listing a merchant as missing a code' },
  { command: 'merchants', description: 'Merchants you have tagged, most seen first' },
  { command: 'exclude', description: 'Record a code that earns nothing' },

  // Off-card spending
  { command: 'spend', description: 'Spending that never touched a card: PayLah, cash, PayNow' },
  { command: 'spends', description: 'A month of off-card spending, and what it cost you' },
  { command: 'delspend', description: 'Remove an off-card entry' },

  // Offers
  { command: 'offers', description: 'Tracked offers and their clauses' },
  { command: 'extract', description: 'Get the prompt that turns an offer\'s terms into data' },
  { command: 'save', description: 'Store what the prompt returned: /save <offer id> {json}' },
  { command: 'rule', description: 'Answer a clause only you can settle' },
  { command: 'apply', description: 'Mark an offer as applied' },
  { command: 'dismiss', description: 'Set an offer aside' },
  { command: 'scan', description: 'Check every source now' },
  { command: 'feeds', description: 'List the sources that get scanned' },
  { command: 'addfeed', description: 'Add a source: <url>|<label>|<rss|page>' },
  { command: 'prune', description: 'What the scanned history costs, and clean it up' },

  // Housekeeping
  { command: 'commands', description: 'Refresh this menu after a deploy' },
  { command: 'migrate', description: 'Bring the database up to date after a deploy' },
  { command: 'seed', description: 'Load the default feeds and transfer routes' },
  { command: 'help', description: 'Everything, in one message' },
  { command: 'start', description: 'Connect this chat and show the help' },
];

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
Tag \`#fx\` for foreign spend, on cards that pay less on it
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
   add \`cap 1000\`, \`window calendar_month\`, \`group tenx\`, \`mcc 5262,5964\`,
   \`tier 1000\` (rate only while the card holds that spend rung) as needed
   a rate ending in % means cashback: \`/addearn uobone groceries 5%\`
/mode — cards you choose the reward of (Trust Freedom: miles, cashback, stock)
/mode <card> — its options, what it is set to, and every switch so far
/mode <card> <key> [YYYY-MM-DD] [category] — switch, from the day it started
/mode <card> add <key>|<label>|<payout>|<categories> — record a mode it offers
/mode <card> compare — what each mode would have paid on your own spending
/cardfix <card> — put a card's rules, modes and exclusions back to its checked definition
   shows what would change; \`/cardfix <card> confirm [mode]\` applies it
/cardrules <card> — get a prompt to extract a card's rates with Claude
   paste the whole reply back in one message: every command line runs, up to 8
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
/mccskip <merchant> — stop listing one as missing a code (a hawker stall,
  a transfer); \`--undo\` puts it back, bare \`/mccskip\` lists them
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
/commands — refresh the / menu after a deploy
/migrate — bring the database up to date after a deploy
/seed — load the default feeds and transfer routes`;
