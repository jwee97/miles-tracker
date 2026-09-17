-- Money is stored in cents as INTEGER everywhere. Dates are ISO-8601 TEXT.

CREATE TABLE IF NOT EXISTS cards (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  issuer              TEXT    NOT NULL,
  product             TEXT    NOT NULL,
  product_key         TEXT    NOT NULL,          -- normalized: 'dbs_womans_world'
  nickname            TEXT    NOT NULL,          -- short alias used when logging: 'wwmc'
  credit_limit_cents  INTEGER NOT NULL DEFAULT 0,
  statement_day       INTEGER NOT NULL DEFAULT 1,-- day of month the statement closes
  opened_at           TEXT,                      -- YYYY-MM-DD, drives eligibility
  closed_at           TEXT,                      -- YYYY-MM-DD, NULL while held
  signup_bonus_at     TEXT,                      -- when a sign-up bonus was received
  base_mpd            REAL    NOT NULL DEFAULT 0,-- miles per dollar, base rate
  program_key         TEXT    REFERENCES programs(key), -- where this card's points land
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS cards_nickname ON cards(nickname);
CREATE INDEX        IF NOT EXISTS cards_issuer   ON cards(issuer);

-- ---------------------------------------------------------------------------
-- The catalogue: what a card product IS, separately from what you hold.
--
-- Until now one table carried both. "4 mpd on online spend" is a fact about
-- the DBS Woman's World Card and is the same for everyone who holds one; "the
-- limit is $12,000 and it closes on the 12th" is a fact about YOUR card. Mixed
-- together, the first cannot be shared, corrected once, or dated.
--
-- The cards table keeps its name for now and gains product_id. Renaming it to
-- user_cards touches every query in the app and buys nothing this phase: the
-- separation is real once the product owns the rules. The rename belongs with
-- dropping the legacy columns, after this model has run in production.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_key       TEXT    NOT NULL UNIQUE,      -- 'dbs_womans_world'
  issuer            TEXT    NOT NULL,
  product_name      TEXT    NOT NULL,
  network           TEXT,                          -- visa | mastercard | amex | unionpay
  card_type         TEXT    NOT NULL DEFAULT 'credit',
  currency          TEXT    NOT NULL DEFAULT 'SGD',
  reward_type       TEXT    NOT NULL DEFAULT 'miles', -- miles | cashback | points
  program_key       TEXT    REFERENCES programs(key),
  base_mpd          REAL,
  base_cashback_pct REAL,
  annual_fee_cents  INTEGER,
  official_url      TEXT,
  status            TEXT    NOT NULL DEFAULT 'active',   -- active | discontinued
  -- Where this product came from. A card the catalogue has never heard of is a
  -- product too, so there is one reward engine rather than two.
  source            TEXT    NOT NULL DEFAULT 'catalog',  -- catalog | user | imported
  -- Never hidden from the engine: a stale rule may still be the best available,
  -- but it lowers a recommendation's confidence rather than being silently
  -- trusted or silently dropped.
  verification_status TEXT  NOT NULL DEFAULT 'draft',    -- verified | needs_review | stale | draft | migrated_unverified
  last_verified_at  TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS product_issuer ON card_products(issuer, product_name);

-- Where a product's numbers came from, so a rate can be traced to a document.
CREATE TABLE IF NOT EXISTS product_sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER NOT NULL REFERENCES card_products(id) ON DELETE CASCADE,
  source_type     TEXT    NOT NULL,   -- bank_product_page | bank_terms | bank_rewards_terms | bank_faq | manual_verified
  source_url      TEXT    NOT NULL,
  title           TEXT,
  retrieved_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  effective_from  TEXT,
  effective_until TEXT,
  content_hash    TEXT,
  active          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS product_source ON product_sources(product_id, active);

-- ---------------------------------------------------------------------------
-- Rule sets: what a product paid, and WHEN.
--
-- A bank changing its rates in October must not silently rewrite what August
-- earned. So a published rule set is never edited when the economics move — it
-- is closed off and a new version opens the next day. Every historical
-- calculation then picks the version that was in force on the day.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rule_sets (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id       INTEGER NOT NULL REFERENCES card_products(id) ON DELETE CASCADE,
  version          INTEGER NOT NULL,
  effective_from   TEXT    NOT NULL,       -- YYYY-MM-DD, inclusive
  effective_until  TEXT,                   -- inclusive; NULL means still current
  published_at     TEXT,
  status           TEXT    NOT NULL DEFAULT 'draft', -- draft | published | superseded | withdrawn
  source_id        INTEGER REFERENCES product_sources(id),
  verified_at      TEXT,
  notes            TEXT,
  UNIQUE(product_id, version)
);
CREATE INDEX IF NOT EXISTS ruleset_lookup ON rule_sets(product_id, status, effective_from);

-- Exclusions are not timeless either: a code a card stopped excluding in June
-- must still be excluded from May's spend.
CREATE TABLE IF NOT EXISTS rule_exclusions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_set_id   INTEGER NOT NULL REFERENCES rule_sets(id) ON DELETE CASCADE,
  mcc           TEXT    NOT NULL,
  reason        TEXT,
  scope         TEXT    NOT NULL DEFAULT 'rewards'   -- rewards | min_spend | both
);
CREATE INDEX IF NOT EXISTS rule_exclusion_set ON rule_exclusions(rule_set_id);

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id      INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,                 -- negative = refund/payment
  occurred_at  TEXT    NOT NULL,                 -- YYYY-MM-DD, when you paid
  posted_at    TEXT,                             -- YYYY-MM-DD, when the bank posted it
                                                 -- (null until known). Windows are judged
                                                 -- on this when set, else occurred_at
  merchant     TEXT,
  category     TEXT,                             -- matches earn_rules.category
  category_source TEXT,                          -- manual | learned | null
  needs_review INTEGER NOT NULL DEFAULT 0,       -- category unconfirmed
  mcc          TEXT,                             -- merchant category code, if known
  channel      TEXT,                             -- online | offline | contactless
  expected_miles INTEGER,                        -- what the engine predicted
  expected_cashback_cents INTEGER,
  actual_miles INTEGER,                          -- what the bank actually credited
  actual_cashback_cents INTEGER,
  reward_note  TEXT,
  -- Which rule set produced the expected reward, and when. The transaction is
  -- still recalculable from the rules; this is here so an audit can say what
  -- the app believed at the time and why.
  evaluated_rule_set_id INTEGER,
  evaluation_version TEXT,
  evaluated_at TEXT,
  expected_program TEXT,                          -- programme the earn lands in
  credited_at  TEXT,                              -- when you accepted it into the wallet
  credited_tranche_id INTEGER,                    -- which balance tranche took it
  source       TEXT    NOT NULL DEFAULT 'manual',-- manual | sms | import
  -- The merchant as the statement printed it, and the entity it resolved to.
  -- Both, not one: a tidied name is a judgement, and a judgement you cannot
  -- see the input to is one you cannot correct.
  merchant_raw TEXT,
  merchant_id  INTEGER REFERENCES merchants(id) ON DELETE SET NULL,
  -- Where the row is in its life: pending | posted | reversed | refunded.
  -- A purchase logged the moment it is made is pending until the bank confirms
  -- it; the default is 'posted' so every row that predates this column keeps
  -- the meaning it was written with.
  status       TEXT    NOT NULL DEFAULT 'posted',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
-- Every window query filters on the effective date, so index that expression.
CREATE INDEX IF NOT EXISTS tx_card_date ON transactions(card_id, COALESCE(posted_at, occurred_at));

-- Minimum-spend requirements. Two kinds, deliberately modelled together so the
-- digest can report both, plus bonus_cap which is the mirror: when to STOP using
-- a card because the elevated rate no longer applies.
CREATE TABLE IF NOT EXISTS requirements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id         INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL,              -- monthly_min | signup_min
  amount_cents    INTEGER NOT NULL,
  window          TEXT    NOT NULL,              -- calendar_month | calendar_quarter | statement_cycle
                                                 --   | statement_quarter | fixed_window
  deadline        TEXT,                          -- YYYY-MM-DD, for signup_min / fixed_window
  starts_at       TEXT,                          -- YYYY-MM-DD, for fixed_window
  min_txns        INTEGER,                       -- some cards also require N transactions
  bonus_cap_cents INTEGER,                       -- elevated rate applies to first N only
  reward_note     TEXT,                          -- '4 mpd on first $1,000'
  -- A card like UOB One runs on quarters of three STATEMENT months anchored to
  -- the month the card was issued, not on calendar quarters. anchor_at is the
  -- date that sets the cycle (defaults to cards.opened_at); per_month says the
  -- minimum must be hit in every statement month of the window, not once across
  -- it; prorate_first pays thirds when only the later months of the very first
  -- quarter qualified.
  anchor_at       TEXT,
  per_month       INTEGER NOT NULL DEFAULT 0,
  prorate_first   INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS req_card ON requirements(card_id, active);

-- Tiered cashback: one minimum is not one number. UOB One pays a different
-- amount at S$600, S$1,000 and S$2,000 a statement month, so the tiers are rows
-- rather than columns and a card can have as many as it likes.
CREATE TABLE IF NOT EXISTS requirement_tiers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id  INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  min_spend_cents INTEGER NOT NULL,              -- spend per window that reaches this tier
  reward_cents    INTEGER NOT NULL,              -- what the FULL window pays at this tier
  label           TEXT
);
CREATE INDEX IF NOT EXISTS req_tier ON requirement_tiers(requirement_id, min_spend_cents);

-- Merchants you have told the app to stop asking about. A cash-only hawker or
-- a one-off transfer has no merchant code to find, and leaving it in the list
-- of unknowns forever means the list stops being a to-do list. Kept rather
-- than deleted so the decision survives re-import of the same statement.
CREATE TABLE IF NOT EXISTS merchant_ignored (
  merchant   TEXT PRIMARY KEY,               -- lowercased, trimmed, as merchant_mcc
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS offers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  status            TEXT    NOT NULL DEFAULT 'pending', -- pending|tracked|dismissed|applied
  issuer            TEXT,
  product           TEXT,
  product_key       TEXT,
  bonus_miles       INTEGER,
  bonus_note        TEXT,
  min_spend_cents   INTEGER,
  spend_window_days INTEGER,
  valid_from        TEXT,
  valid_until       TEXT,
  source_url        TEXT,
  source_title      TEXT,
  raw_terms         TEXT,
  extracted_at      TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Eligibility clauses as typed predicates, one row per clause, each keeping the
-- exact sentence it came from so a verdict is always traceable to the T&C.
CREATE TABLE IF NOT EXISTS offer_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id   INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  predicate  TEXT    NOT NULL,                   -- JSON
  quote      TEXT,
  decision   TEXT,                               -- NULL | pass | fail | na, set by you
  decided_at TEXT,
  note       TEXT                                -- why you decided that
);
CREATE INDEX IF NOT EXISTS rules_offer ON offer_rules(offer_id);

CREATE TABLE IF NOT EXISTS feeds (
  url    TEXT PRIMARY KEY,
  label  TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  kind   TEXT                              -- NULL = detect | rss | page
);

CREATE TABLE IF NOT EXISTS feed_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guid         TEXT NOT NULL UNIQUE,
  feed         TEXT,
  title        TEXT,
  link         TEXT,
  published_at TEXT,
  seen_at      TEXT NOT NULL DEFAULT (datetime('now')),
  action       TEXT,                             -- NULL | tracked | ignored
  topic        TEXT,                             -- NULL | promo | rates
  score        INTEGER,                          -- how strongly it matched
  terms        TEXT,                             -- which phrases matched
  excerpt      TEXT,                             -- first useful text of the page
  apply_url    TEXT,                             -- the issuer link, when found
  deep         INTEGER NOT NULL DEFAULT 0,       -- 1 = the article was fetched
  offer_id     INTEGER REFERENCES offers(id) ON DELETE SET NULL
);

-- Dedupe for alerts: key encodes card + threshold + period, so each alert fires once.
-- Spending that never touched a credit card: PayLah, PayNow, cash, a bank
-- transfer. It earns nothing, which is exactly why it is worth recording — the
-- question this table answers is how much of a month is missing out, and how
-- much of that could have gone on a card instead.
CREATE TABLE IF NOT EXISTS other_spend (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at  TEXT    NOT NULL,                 -- YYYY-MM-DD
  amount_cents INTEGER NOT NULL,
  method       TEXT    NOT NULL,                 -- paylah | paynow | cash | ...
  merchant     TEXT,
  category     TEXT,                             -- matches earn_rules.category
  -- 0 when a card was never an option: a hawker with no terminal, a transfer to
  -- a person. Keeps the "missed rewards" figure honest.
  card_possible INTEGER NOT NULL DEFAULT 1,
  note         TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS other_spend_date ON other_spend(occurred_at);

CREATE TABLE IF NOT EXISTS alerts_sent (
  key     TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mcc_codes (
  code        TEXT PRIMARY KEY,          -- '5812'
  description TEXT NOT NULL,             -- 'Eating Places and Restaurants'
  category    TEXT NOT NULL,             -- maps to earn_rules.category
  verified    INTEGER NOT NULL DEFAULT 0 -- 1 = in Citibank's published MCC manual
);

-- Which MCC a merchant is likely to present. Likely, not certain: the code is
-- set by the acquirer, varies by outlet and changes without notice, so every
-- row carries where it came from and how much to trust it.
CREATE TABLE IF NOT EXISTS merchant_mcc (
  merchant   TEXT PRIMARY KEY,           -- lowercased
  mcc        TEXT NOT NULL,
  channel    TEXT,                       -- online | offline | contactless | null
  source     TEXT NOT NULL DEFAULT 'seed', -- seed | user | statement
  confidence TEXT NOT NULL DEFAULT 'guess', -- guess | confirmed
  note       TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- MCCs that earn nothing. card_id null means it applies to every card.
CREATE TABLE IF NOT EXISTS exclusions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
  mcc     TEXT NOT NULL,
  reason  TEXT,
  source  TEXT NOT NULL DEFAULT 'seed',
  active  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS excl_card ON exclusions(card_id, active);

CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);

-- Executed point transfers, so a balance reflects what actually moved.
CREATE TABLE IF NOT EXISTS transfers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_program  TEXT    NOT NULL,
  to_program    TEXT    NOT NULL,
  conversion_id INTEGER,
  points_out    INTEGER NOT NULL,
  units_in      INTEGER NOT NULL,
  fee_cents     INTEGER NOT NULL DEFAULT 0,
  route         TEXT,
  executed_at   TEXT    NOT NULL,
  note          TEXT
);

-- Learned from your own tagging, so spend categorises itself over time.
CREATE TABLE IF NOT EXISTS merchant_categories (
  merchant   TEXT PRIMARY KEY,                  -- lowercased
  category   TEXT NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- card earns per spending category.

CREATE TABLE IF NOT EXISTS programs (
  key           TEXT PRIMARY KEY,              -- 'citi_ty', 'krisflyer'
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,                 -- bank | airline
  unit          TEXT NOT NULL DEFAULT 'points',
  expiry_months INTEGER                        -- null = does not expire
);

-- Points expire in batches, not all at once, so a single balance number hides
-- the batch about to lapse. Each row is one batch.
CREATE TABLE IF NOT EXISTS balance_tranches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  program_key TEXT    NOT NULL REFERENCES programs(key) ON DELETE CASCADE,
  points      INTEGER NOT NULL,
  earned_at   TEXT,
  expires_at  TEXT,
  note        TEXT,
  source      TEXT    NOT NULL DEFAULT 'manual', -- manual | auto (from spend)
  period      TEXT,                              -- YYYY-MM, for the automatic ones
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
-- One automatic tranche per programme per month; the accept path relies on it.
CREATE UNIQUE INDEX IF NOT EXISTS tranche_auto ON balance_tranches (program_key, period)
  WHERE source = 'auto';
CREATE INDEX IF NOT EXISTS tranche_prog ON balance_tranches(program_key, expires_at);

-- from_units of the source buys to_units of the target. Transfers move in
-- whole blocks and the fee is per transaction, so neither is a simple ratio.
CREATE TABLE IF NOT EXISTS conversions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_program    TEXT    NOT NULL REFERENCES programs(key) ON DELETE CASCADE,
  to_program      TEXT    NOT NULL REFERENCES programs(key) ON DELETE CASCADE,
  from_units      INTEGER NOT NULL,
  to_units        INTEGER NOT NULL,
  fee_cents       INTEGER NOT NULL DEFAULT 0,  -- charged once per transfer
  min_block       INTEGER NOT NULL,
  block_increment INTEGER NOT NULL,
  route           TEXT,                        -- 'direct', 'Kris+', ...
  bonus_pct       REAL    NOT NULL DEFAULT 0,  -- promotional uplift on miles out
  bonus_until     TEXT,
  verified_at     TEXT,                        -- null = never checked against the bank
  source_url      TEXT,
  note            TEXT,
  active          INTEGER NOT NULL DEFAULT 1
);

-- What a card earns, per category. '*' is the fallback for anything unmatched.
-- Rules sharing a cap_group share one cap between them, which is how most
-- bonus categories actually work.
CREATE TABLE IF NOT EXISTS earn_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Nullable: a rule belonging to a product's rule set is not any one card's.
  -- Kept only for rules that predate the product model.
  card_id     INTEGER REFERENCES cards(id) ON DELETE CASCADE,
  category    TEXT    NOT NULL,
  mpd         REAL    NOT NULL,                -- miles per dollar, or percent if cashback
  reward_type TEXT    NOT NULL DEFAULT 'miles', -- miles | cashback
  mcc_include TEXT,                             -- CSV of MCCs, null = any
  mcc_exclude TEXT,                             -- CSV of MCCs that never match
  channel     TEXT,                             -- online | offline | contactless | null = any
  -- The versioned set this rule belongs to. card_id below is the legacy link,
  -- kept until the product layer is verified in production; activation is
  -- decided by the rule set's effective dates, not by `active`.
  rule_set_id INTEGER REFERENCES rule_sets(id) ON DELETE CASCADE,
  priority    INTEGER NOT NULL DEFAULT 0,       -- higher wins among equals
  min_txn_cents INTEGER,                        -- rule needs a transaction this large
  -- Cards whose rate depends on which spend tier the quarter is holding: UOB
  -- One pays 3.33% on groceries at the S$600 rung but 6% at S$1,000. This is
  -- the monthly rung at or above which the rate applies; null means always.
  min_tier_cents INTEGER,
  program_key TEXT    REFERENCES programs(key),
  cap_cents   INTEGER,                         -- bonus rate applies below this
  cap_group   TEXT,                            -- rules sharing one cap
  cap_window  TEXT,                            -- statement_cycle | calendar_month | calendar_quarter
  note        TEXT,
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS earn_card ON earn_rules(card_id, active);

-- ===========================================================================
-- Transaction capture (P0 phase 4)
--
-- A purchase can reach the app more than once: an SMS the moment it is made,
-- then the same purchase on a statement three days later. Those are one
-- transaction, and the tables below exist so the second arrival can be
-- recognised as the first rather than doubling the month's spend.
-- ===========================================================================

-- Every arrival of a transaction, whatever channel it came through. A
-- transaction can have several: one row per time the world told us about it.
CREATE TABLE IF NOT EXISTS transaction_sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id  INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  source          TEXT    NOT NULL,            -- manual | telegram | sms | statement | csv | advisor
  -- The source's own identifier, when it has one. UNIQUE with source, so the
  -- same statement row can never be imported twice however often it is offered.
  external_id     TEXT,
  imported_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  raw_hash        TEXT,                        -- hash of the raw line, for exact repeats
  raw_description TEXT,                        -- the statement text, never overwritten
  metadata_json   TEXT,
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS txsrc_tx ON transaction_sources(transaction_id);
CREATE INDEX IF NOT EXISTS txsrc_hash ON transaction_sources(raw_hash);

-- A merchant as a thing, rather than as whatever string a statement printed.
-- GRAB*RIDE, GRAB SINGAPORE and GRAB.COM are one merchant with three aliases.
CREATE TABLE IF NOT EXISTS merchants (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_name TEXT NOT NULL,
  normalized_key TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS merchant_aliases (
  alias_key   TEXT PRIMARY KEY,                -- normalised form of the raw text
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  raw_example TEXT,                            -- one real spelling, for the UI
  source      TEXT,                            -- statement | sms | manual
  confidence  TEXT NOT NULL DEFAULT 'guess'    -- guess | confirmed
);
CREATE INDEX IF NOT EXISTS alias_merchant ON merchant_aliases(merchant_id);

-- A merchant's code is not one eternal truth: it is set by the acquirer, it
-- differs between outlets and channels, and it changes. So observations are
-- recorded as evidence and the current best guess is derived from them.
CREATE TABLE IF NOT EXISTS merchant_mcc_evidence (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id     INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  mcc             TEXT    NOT NULL,
  channel         TEXT,
  card_product_id INTEGER REFERENCES card_products(id),
  observed_at     TEXT,
  source          TEXT    NOT NULL,            -- statement | user | seed | sms
  confidence      TEXT    NOT NULL DEFAULT 'guess',
  transaction_id  INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  note            TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS evidence_merchant ON merchant_mcc_evidence(merchant_id, mcc);

-- Things the pipeline could not decide, queued rather than guessed at. One row
-- per open question, so answering it is one action and not a hunt through the
-- ledger.
CREATE TABLE IF NOT EXISTS review_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  reason         TEXT    NOT NULL,             -- unknown_card | unknown_merchant | unknown_mcc
                                               --   | ambiguous_mcc | possible_duplicate
                                               --   | unknown_category | reward_rule_uncertain
                                               --   | statement_match_ambiguous
  detail         TEXT,
  -- What the pipeline would choose if forced, so the answer is usually one tap.
  suggestion     TEXT,
  -- The other transaction, for a possible duplicate.
  other_id       INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  status         TEXT    NOT NULL DEFAULT 'open', -- open | resolved | ignored
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  resolved_at    TEXT,
  resolution     TEXT
);
CREATE INDEX IF NOT EXISTS review_open ON review_items(status, reason);
CREATE INDEX IF NOT EXISTS review_tx ON review_items(transaction_id);
