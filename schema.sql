-- Money is stored in cents as INTEGER everywhere. Dates are ISO-8601 TEXT.

CREATE TABLE IF NOT EXISTS cards (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  issuer              TEXT    NOT NULL,
  product             TEXT    NOT NULL,
  product_key         TEXT    NOT NULL,          -- normalized: 'dbs_womans_world'
  nickname            TEXT    NOT NULL,          -- short alias used when logging: 'wwmc'
  credit_limit_cents  INTEGER NOT NULL DEFAULT 0,
  statement_day       INTEGER NOT NULL DEFAULT 1,-- day of month the statement closes
  -- Whether that day was told to us or is just the default. Every window
  -- calculation needs a number, so the column stays NOT NULL — but a card
  -- billing on the 1st because nobody said otherwise must not look the same
  -- as one that genuinely bills on the 1st.
  statement_day_known INTEGER NOT NULL DEFAULT 1,
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
  -- How this card's bank rounds rewards: {unit_cents, mode}. A property of the
  -- product, because it differs by bank and by card, and reconciliation without
  -- it reports rounding as a shortfall.
  reward_rounding_json TEXT,
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
  expiry_months INTEGER,                       -- null = does not expire
  programme_type TEXT,                         -- bank | airline | hotel
  expiry_policy TEXT,                          -- in words, for the wallet screen
  status        TEXT NOT NULL DEFAULT 'active' -- active | closed
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
  -- Legacy promotional fields, kept so older rows still read correctly. New
  -- bonuses go in transfer_promotions: a temporary uplift written into the
  -- route would leave the app believing it for ever.
  bonus_pct       REAL    NOT NULL DEFAULT 0,
  bonus_until     TEXT,
  -- A route is versioned: banks change ratios, and a transfer made in June has
  -- to stay explicable in December.
  effective_from  TEXT,
  effective_until TEXT,
  processing_days_min INTEGER,
  processing_days_max INTEGER,
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

-- ---------------------------------------------------------------------------
-- Intelligence: estimates, and the record of how good they were.
--
-- Everything in this block ESTIMATES. None of it decides. A label is what a
-- person confirmed, a prediction carries where it came from, a forecast
-- carries the interval around it, and an evaluation says what actually
-- happened. The deterministic engines read these as inputs and remain the only
-- thing that turns them into money.
-- ---------------------------------------------------------------------------

-- One confirmed descriptor, kept so a classifier could one day be trained on
-- it. Written only when a person answers — never from the app's own guess,
-- because training on your own predictions teaches you your own mistakes.
CREATE TABLE IF NOT EXISTS merchant_training_labels (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_descriptor        TEXT    NOT NULL,
  normalized_descriptor TEXT    NOT NULL,
  processor             TEXT,
  country               TEXT,
  merchant_id           INTEGER REFERENCES merchants(id) ON DELETE SET NULL,
  canonical_merchant    TEXT,
  confirmed_mcc         TEXT,
  category              TEXT,
  channel               TEXT,
  issuer                TEXT,
  network               TEXT,
  -- user_confirmed | imported | statement_verified. Only the first is
  -- trusted for training; the others are recorded and excluded.
  source                TEXT    NOT NULL DEFAULT 'user_confirmed',
  transaction_id        INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  confirmed_at          TEXT    NOT NULL,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(normalized_descriptor, confirmed_mcc, confirmed_at)
);
CREATE INDEX IF NOT EXISTS label_norm ON merchant_training_labels(normalized_descriptor);
CREATE INDEX IF NOT EXISTS label_category ON merchant_training_labels(category);

-- Which models exist, what they scored, and which one is live. A prediction
-- names its model version, so a resolution made six months ago can still be
-- explained by the model that made it.
CREATE TABLE IF NOT EXISTS ml_models (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  model_key              TEXT    NOT NULL,
  version                INTEGER NOT NULL,
  architecture           TEXT    NOT NULL,
  trained_at             TEXT,
  training_examples      INTEGER NOT NULL DEFAULT 0,
  validation_metrics_json TEXT,
  artifact_hash          TEXT,
  -- candidate | active | retired | rejected. Only one active per model_key,
  -- and promoting a candidate retires the incumbent rather than deleting it,
  -- so a bad model is rolled back by flipping rows, not by shipping code.
  status                 TEXT    NOT NULL DEFAULT 'candidate',
  deployed_at            TEXT,
  note                   TEXT,
  -- What the model can say, and the bias term for each. Kept on the model row
  -- rather than with the features: every prediction needs all of it, and it is
  -- a few hundred bytes.
  classes_json           TEXT,
  intercept_json         TEXT,
  feature_count          INTEGER NOT NULL DEFAULT 0,
  -- The probability at or above which this model's answer may be acted on
  -- without asking. Stored with the model because it was measured on it.
  high_confidence        REAL    NOT NULL DEFAULT 0.85,
  created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(model_key, version)
);
CREATE INDEX IF NOT EXISTS ml_model_active ON ml_models(model_key, status);

-- The model itself, one row per feature.
--
-- Not a blob, and not bundled into the Worker, for a reason worth stating.
-- A Worker request gets 10 ms of CPU; deserialising a whole model and
-- building a vocabulary Map costs tens of milliseconds, which is fine at
-- module init and fatal per request. Stored this way, inference fetches only
-- the handful of n-grams the descriptor being classified actually contains —
-- one indexed query, a few hundred rows, no cold start at all. It also means
-- retraining is a write, not a redeploy.
--
-- `weights_b64` is the per-class weight vector for this n-gram, packed as
-- base64 float32 in the model's class order. Measured at 50k features, JSON
-- costs 181 ms to parse where base64 costs 1 ms.
CREATE TABLE IF NOT EXISTS ml_model_features (
  model_id    INTEGER NOT NULL REFERENCES ml_models(id) ON DELETE CASCADE,
  ngram       TEXT    NOT NULL,
  idf         REAL    NOT NULL,
  weights_b64 TEXT    NOT NULL,
  PRIMARY KEY (model_id, ngram)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ml_feature_lookup ON ml_model_features(model_id, ngram);

-- How one resolution was reached. Kept apart from the transaction because a
-- transaction has one MCC and a resolution has a whole distribution behind it.
CREATE TABLE IF NOT EXISTS merchant_predictions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id         INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  raw_descriptor         TEXT    NOT NULL,
  normalized_descriptor  TEXT,
  merchant_id            INTEGER REFERENCES merchants(id) ON DELETE SET NULL,
  predicted_mcc          TEXT,
  predicted_category     TEXT,
  confidence             REAL,
  -- exact_alias | user_history | merchant_evidence | fuzzy | self_trained_ml
  --   | workers_ai | external | user_confirmed | none
  prediction_source      TEXT    NOT NULL,
  model_key              TEXT,
  model_version          INTEGER,
  candidate_distribution_json TEXT,
  needs_review           INTEGER NOT NULL DEFAULT 0,
  review_reason          TEXT,
  reward_spread_cents    INTEGER,
  predicted_at           TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS prediction_txn ON merchant_predictions(transaction_id);
CREATE INDEX IF NOT EXISTS prediction_source ON merchant_predictions(prediction_source, predicted_at);

-- Spending that repeats. Detected before any forecasting, because a
-- subscription is not a prediction problem — it is a known amount on a known
-- date, and mixing it into a variable-spend average makes both worse.
CREATE TABLE IF NOT EXISTS recurring_patterns (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id          INTEGER REFERENCES merchants(id) ON DELETE CASCADE,
  merchant_key         TEXT,
  card_id              INTEGER REFERENCES cards(id) ON DELETE SET NULL,
  category             TEXT,
  -- weekly | fortnightly | monthly | quarterly | annual
  frequency            TEXT    NOT NULL,
  expected_amount_cents INTEGER NOT NULL,
  amount_variance_cents INTEGER NOT NULL DEFAULT 0,
  interval_days        REAL,
  next_expected_date   TEXT,
  confidence           REAL    NOT NULL DEFAULT 0,
  observations         INTEGER NOT NULL DEFAULT 0,
  first_observed_at    TEXT,
  last_observed_at     TEXT,
  active               INTEGER NOT NULL DEFAULT 1,
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(merchant_key, card_id, frequency)
);
CREATE INDEX IF NOT EXISTS recurring_next ON recurring_patterns(active, next_expected_date);

-- A forecast, stored when made so it can be judged later. A forecast nobody
-- scored is an opinion; a forecast with its outcome attached is a measurement.
CREATE TABLE IF NOT EXISTS spend_forecasts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at          TEXT    NOT NULL,
  period_start          TEXT    NOT NULL,
  period_end            TEXT    NOT NULL,
  -- category | mcc_group | card | requirement | total
  dimension_type        TEXT    NOT NULL,
  dimension_key         TEXT    NOT NULL,
  expected_cents        INTEGER NOT NULL,
  lower_cents           INTEGER NOT NULL,
  upper_cents           INTEGER NOT NULL,
  -- Of the expected figure, how much is already-known recurring spend.
  recurring_cents       INTEGER NOT NULL DEFAULT 0,
  model_key             TEXT    NOT NULL,
  model_version         INTEGER,
  training_window_start TEXT,
  training_window_end   TEXT,
  observations          INTEGER NOT NULL DEFAULT 0,
  confidence            TEXT    NOT NULL DEFAULT 'low',
  UNIQUE(period_start, period_end, dimension_type, dimension_key, model_key)
);
CREATE INDEX IF NOT EXISTS forecast_period ON spend_forecasts(period_start, period_end);

-- What actually happened, against what was predicted.
CREATE TABLE IF NOT EXISTS forecast_evaluations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  forecast_id       INTEGER NOT NULL REFERENCES spend_forecasts(id) ON DELETE CASCADE,
  evaluated_at      TEXT    NOT NULL,
  actual_cents      INTEGER NOT NULL,
  error_cents       INTEGER NOT NULL,
  abs_error_cents   INTEGER NOT NULL,
  pct_error         REAL,
  within_interval   INTEGER NOT NULL DEFAULT 0,
  UNIQUE(forecast_id)
);
CREATE INDEX IF NOT EXISTS evaluation_forecast ON forecast_evaluations(forecast_id);

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

-- ===========================================================================
-- Onboarding (P1 phase 1)
--
-- Setting the app up used to mean understanding merchant codes, cap windows
-- and rule configuration before it could answer a single question. The point
-- of these tables is that a person supplies only what the catalogue cannot
-- know — when they got the card, when its statement closes — and everything
-- else comes from the product.
-- ===========================================================================

-- How far through setup we are. One row, because this is a single-user app;
-- a multi-user version would key it by user and nothing else would change.
CREATE TABLE IF NOT EXISTS onboarding_state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  status             TEXT    NOT NULL DEFAULT 'not_started', -- not_started | in_progress | completed
  cards_completed    INTEGER NOT NULL DEFAULT 0,
  statements_offered INTEGER NOT NULL DEFAULT 0,
  wallet_offered     INTEGER NOT NULL DEFAULT 0,
  completed_at       TEXT,
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- What people actually type when they mean a card. "wwmc" is not the product
-- name and never will be, and a search that only matches the official name is
-- a search that fails for everyone who knows the card by its nickname.
CREATE TABLE IF NOT EXISTS card_product_aliases (
  alias_key  TEXT    PRIMARY KEY,               -- lowercased, punctuation stripped
  product_id INTEGER NOT NULL REFERENCES card_products(id) ON DELETE CASCADE,
  source     TEXT    NOT NULL DEFAULT 'seed'    -- seed | user | legacy_name
);
CREATE INDEX IF NOT EXISTS alias_product ON card_product_aliases(product_id);

-- Which personal details a given product actually needs, so the questions can
-- vary by card without a screen hardcoded per card. A field is here only if it
-- changes a calculation: anything that does not is not worth asking for.
CREATE TABLE IF NOT EXISTS product_onboarding_fields (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES card_products(id) ON DELETE CASCADE,
  field_key  TEXT    NOT NULL,                  -- statement_day | opened_at | credit_limit | …
  field_type TEXT    NOT NULL,                  -- date | day_of_month | money | number | choice | boolean
  label      TEXT    NOT NULL,
  help_text  TEXT,
  required   INTEGER NOT NULL DEFAULT 0,
  -- What breaks without it, so "why are you asking" has an answer.
  affects    TEXT    NOT NULL,                  -- reward_calculation | statement_window
                                                --   | minimum_spend | eligibility | notification
  sort       INTEGER NOT NULL DEFAULT 0,
  UNIQUE(product_id, field_key)
);

-- ===========================================================================
-- The reward ledger (P1 phase 2)
--
-- The app used to hold one number per transaction for what it expected and one
-- for what arrived. That cannot answer the question people actually have —
-- "did the bank credit me correctly?" — because banks credit in aggregate, pay
-- components on different days, round in their own way, and reverse things.
--
-- So expectations and observations become two ledgers, and they are never
-- reconciled by editing one to match the other. A discrepancy is information.
-- ===========================================================================

-- What actually arrived. One row per credit, reversal or adjustment observed.
CREATE TABLE IF NOT EXISTS reward_ledger_entries (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id            INTEGER REFERENCES cards(id) ON DELETE CASCADE,
  program_key        TEXT    REFERENCES programs(key),
  -- base_reward | bonus_reward | campaign_reward | cashback | adjustment
  --   | reversal | expiry | transfer | manual
  entry_type         TEXT    NOT NULL,
  amount             REAL    NOT NULL,           -- negative for a reversal
  unit               TEXT    NOT NULL,           -- miles | points | cents
  period_start       TEXT,
  period_end         TEXT,
  credited_at        TEXT,
  source             TEXT    NOT NULL,           -- statement | manual | import | bot
  -- The bank's own reference, when there is one. UNIQUE with source, so the
  -- same statement line cannot be counted twice however often it is imported.
  external_reference TEXT,
  statement_id       INTEGER,
  transaction_id     INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  description        TEXT,
  raw_description    TEXT,                       -- never overwritten
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, external_reference)
);
CREATE INDEX IF NOT EXISTS ledger_card_period ON reward_ledger_entries(card_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS ledger_tx ON reward_ledger_entries(transaction_id);

-- What the app believes is owed, broken into the parts a bank pays separately.
-- Not derived from transactions.expected_miles at comparison time: banks credit
-- base and bonus on different days, and one opaque total cannot say which half
-- is missing.
CREATE TABLE IF NOT EXISTS expected_reward_entries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id           INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  transaction_id    INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  -- The window this belongs to, for rewards that are not per transaction:
  -- 'statement:2026-09' or 'quarter:2026-01-28'.
  reward_period_key TEXT,
  rule_set_id       INTEGER REFERENCES rule_sets(id),
  -- base | category_bonus | campaign_bonus | minimum_spend_bonus
  --   | quarterly_reward | manual_adjustment
  component         TEXT    NOT NULL,
  expected_amount   REAL    NOT NULL,
  unit              TEXT    NOT NULL,
  program_key       TEXT,
  -- When the bank could first credit it, and when it is late. A welcome bonus
  -- is not missing on day two; it is missing on day ninety-one.
  available_from    TEXT,
  expected_by       TEXT,
  source_note       TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS expected_card ON expected_reward_entries(card_id, reward_period_key);
CREATE INDEX IF NOT EXISTS expected_tx ON expected_reward_entries(transaction_id, component);

-- Reward candidates read off a statement, before anything is written to either
-- ledger. Extraction proposes; a person or a rule accepts.
CREATE TABLE IF NOT EXISTS statement_reward_candidates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id         INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  program_key     TEXT,
  entry_type      TEXT    NOT NULL,
  amount          REAL    NOT NULL,
  unit            TEXT    NOT NULL,
  description     TEXT    NOT NULL,
  credited_at     TEXT,
  period_start    TEXT,
  period_end      TEXT,
  confidence      TEXT    NOT NULL DEFAULT 'medium', -- high | medium | low
  raw_line        TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS candidate_card ON statement_reward_candidates(card_id, status);

-- ===========================================================================
-- Transfers (P2 phase 4)
--
-- A route's ratio is what the bank permanently offers. A 25% bonus for three
-- weeks in September is not that, and writing it into the ratio would leave the
-- app believing 40,000 points became 50,000 miles for ever. So promotions are
-- separate rows with their own dates, and a route is versioned like a reward
-- rule: what it paid, and when.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS transfer_promotions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  conversion_id         INTEGER NOT NULL REFERENCES conversions(id) ON DELETE CASCADE,
  bonus_pct             REAL,
  bonus_flat_units      INTEGER,
  min_transfer_units    INTEGER,
  start_at              TEXT    NOT NULL,
  end_at                TEXT    NOT NULL,
  -- Many bonuses pay nothing unless you registered first, so the optimiser may
  -- not assume you are in one.
  registration_required INTEGER NOT NULL DEFAULT 0,
  registered            INTEGER NOT NULL DEFAULT 0,
  title                 TEXT,
  source_url            TEXT,
  verified_at           TEXT,
  promotion_id          INTEGER,                 -- the promotion record it came from
  created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS promo_route ON transfer_promotions(conversion_id, start_at, end_at);

-- What the points are for. A target changes the answer: the cheapest way to
-- move points is not the cheapest way to reach 85,000 of them.
CREATE TABLE IF NOT EXISTS reward_goals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  program_key    TEXT    NOT NULL REFERENCES programs(key) ON DELETE CASCADE,
  target_units   INTEGER NOT NULL,
  target_date    TEXT,
  description    TEXT,
  status         TEXT    NOT NULL DEFAULT 'active',  -- active | met | abandoned
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS goal_active ON reward_goals(status, program_key);

-- ===========================================================================
-- Promotions (P2 phase 5)
--
-- The feed scanner found pages. This is the structured thing underneath: what
-- a promotion actually requires and pays, which cards and programmes it applies
-- to, and where the claim came from. Nothing is published automatically when
-- the economic terms are uncertain — an offer with a wrong threshold is worse
-- than no offer, because someone will spend against it.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS promotions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  promotion_key         TEXT    UNIQUE,
  -- welcome_offer | spend_bonus | merchant_offer | transfer_bonus
  --   | annual_fee_offer | points_conversion_offer | category_bonus
  --   | cardholder_offer | bank_campaign
  promotion_type        TEXT    NOT NULL,
  issuer                TEXT,
  title                 TEXT    NOT NULL,
  description           TEXT,
  start_at              TEXT,
  end_at                TEXT,
  registration_required INTEGER NOT NULL DEFAULT 0,
  source_url            TEXT,
  source_type           TEXT,
  retrieved_at          TEXT,
  verified_at           TEXT,
  -- draft | published | expired | rejected. A draft is invisible to the app.
  status                TEXT    NOT NULL DEFAULT 'draft',
  -- The machine-readable terms: thresholds, rewards, windows.
  terms_json            TEXT,
  -- The sentence the terms were read out of, kept as provenance.
  source_quote          TEXT,
  confidence            TEXT    NOT NULL DEFAULT 'medium',
  -- official_verified | secondary_verified | single_source | conflicting
  --   | needs_review | expired. More useful than a boolean: "the bank says so"
  -- and "two publications agree" deserve different words in front of a person.
  verification_state    TEXT    NOT NULL DEFAULT 'single_source',
  -- issuer_direct | moneysmart | singsaver | third_party | unknown. A
  -- comparison site's exclusive is not the issuer's own offer.
  application_channel   TEXT    NOT NULL DEFAULT 'unknown',
  fingerprint           TEXT,
  audience              TEXT    NOT NULL DEFAULT 'everyone',
  -- Who the offer is for, denormalised from terms_json.audience for querying.
  -- terms_json stays the source of truth, including the raw wording it was
  -- classified from; this is a derived index on it. Default 'unknown' rather
  -- than 'public': absence of a restriction is not evidence of its absence,
  -- and a promotion nobody has classified has not been established as open.
  audience_type         TEXT    NOT NULL DEFAULT 'unknown',
  extended_from_promotion_id INTEGER REFERENCES promotions(id) ON DELETE SET NULL,
  last_verified_at      TEXT,
  independent_sources   INTEGER NOT NULL DEFAULT 0,
  -- Set when this was merged into another as a duplicate.
  duplicate_of          INTEGER REFERENCES promotions(id) ON DELETE SET NULL,
  dismissed_at          TEXT,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS promo_status ON promotions(status, promotion_type, end_at);

-- Who a promotion applies to. Separate tables rather than a CSV column, so a
-- promotion can be found from a card, a programme or a merchant code.
CREATE TABLE IF NOT EXISTS promotion_card_products (
  promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES card_products(id) ON DELETE CASCADE,
  PRIMARY KEY (promotion_id, product_id)
);

CREATE TABLE IF NOT EXISTS promotion_programmes (
  promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  program_key  TEXT    NOT NULL REFERENCES programs(key) ON DELETE CASCADE,
  -- source | destination, for a transfer bonus.
  role         TEXT    NOT NULL DEFAULT 'source',
  PRIMARY KEY (promotion_id, program_key, role)
);

CREATE TABLE IF NOT EXISTS promotion_merchants (
  promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  merchant_key TEXT    NOT NULL,
  PRIMARY KEY (promotion_id, merchant_key)
);

CREATE TABLE IF NOT EXISTS promotion_mccs (
  promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  mcc          TEXT    NOT NULL,
  PRIMARY KEY (promotion_id, mcc)
);

-- What has been decided about a promotion: tracked, dismissed, completed.
CREATE TABLE IF NOT EXISTS promotion_tracking (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  promotion_id   INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  card_id        INTEGER REFERENCES cards(id) ON DELETE CASCADE,
  -- The requirement it became, so progress uses the existing engine.
  requirement_id INTEGER REFERENCES requirements(id) ON DELETE SET NULL,
  status         TEXT    NOT NULL DEFAULT 'tracked', -- tracked | completed | dismissed
  tracked_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  completed_at   TEXT,
  UNIQUE(promotion_id, card_id)
);
CREATE INDEX IF NOT EXISTS ptrack_status ON promotion_tracking(status);

-- ===========================================================================
-- Promotion discovery
--
-- The design rule: the internet is a network of sensors, and no single site is
-- a dependency. A specialist article, a comparison site and an indexed bank PDF
-- are three signals about one offer; the system combines them and records what
-- each one said.
--
-- Nothing here scrapes its way past a site that does not want to be read. A
-- blocked issuer is an expected outcome, not a failure — it costs a promotion
-- its "official" status and nothing else.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS discovery_sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key      TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL,
  -- rss | search | website | official_page | official_pdf | manual
  source_type     TEXT    NOT NULL,
  base_url        TEXT,
  feed_url        TEXT,
  -- 1 official issuer · 2 specialist miles publication · 3 comparison site
  -- 4 search · 5 anything else. Lower is stronger.
  trust_tier      INTEGER NOT NULL,
  scan_frequency  TEXT    NOT NULL DEFAULT 'weekly', -- daily | every3days | weekly | monthly
  issuer          TEXT,
  content_scope   TEXT,                    -- welcome_offers | credit_card_promotions | …
  last_scanned_at TEXT,
  last_success_at TEXT,
  failure_count   INTEGER NOT NULL DEFAULT 0,
  -- How often this source actually yields something, which is what earns it a
  -- higher scan frequency. A quiet source checked daily is wasted requests.
  change_frequency_score REAL NOT NULL DEFAULT 0,
  promotions_found INTEGER NOT NULL DEFAULT 0,
  scans            INTEGER NOT NULL DEFAULT 0,
  successes        INTEGER NOT NULL DEFAULT 0,
  -- What this source should normally run at, kept apart from the frequency
  -- adaptation has moved it to. Without this the configured schedule is lost
  -- the first time a quiet week demotes a good source.
  base_scan_frequency TEXT,
  -- 0 pins the cadence. The publications that carry most of the value are
  -- pinned: a daily source that goes quiet for a week is still a daily source.
  adaptive_frequency  INTEGER NOT NULL DEFAULT 1,
  -- What the most recent scan actually saw, so "scanned fine, found nothing"
  -- and "never scanned" are different sentences on the screen.
  last_items_seen      INTEGER,
  last_items_new       INTEGER,
  last_relevant_new    INTEGER,
  -- Why the last scan failed, in the source's own terms, so a screen can say
  -- "403, not retried" rather than "ailing".
  last_error           TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS dsource_active ON discovery_sources(active, scan_frequency);

-- An article the discovery engine has seen. Deliberately not an archive of
-- other people's writing: the URL, the title, a hash and a short excerpt, and
-- nothing more.
CREATE TABLE IF NOT EXISTS discovery_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER REFERENCES discovery_sources(id) ON DELETE CASCADE,
  url           TEXT    NOT NULL,
  canonical_url TEXT,
  title         TEXT,
  published_at  TEXT,
  discovered_at TEXT    NOT NULL DEFAULT (datetime('now')),
  content_hash  TEXT,
  -- promotion_related | card_rules_change | transfer_related | general_news
  --   | irrelevant | roundup
  item_type     TEXT,
  -- new | processed | irrelevant | failed | duplicate
  status        TEXT    NOT NULL DEFAULT 'new',
  fetch_note    TEXT,
  -- Why the classifier decided what it did, kept so "why was this ignored?"
  -- has an answer that is not a re-run.
  classification_score REAL,
  classification_signals_json TEXT,
  -- Why extraction produced nothing, for the articles that were read fine and
  -- still yielded no offer. Silence here used to be indistinguishable from
  -- the article never being read.
  extraction_note TEXT,
  UNIQUE(source_id, canonical_url)
);
CREATE INDEX IF NOT EXISTS ditem_status ON discovery_items(status, discovered_at);
-- One article, however many ways it was found. A URL that arrives by both feed
-- and search is one article, not two.
CREATE UNIQUE INDEX IF NOT EXISTS ditem_canonical ON discovery_items(canonical_url)
  WHERE canonical_url IS NOT NULL;

-- How an article was found, which is not the same question as what it is.
CREATE TABLE IF NOT EXISTS discovery_item_sources (
  discovery_item_id INTEGER NOT NULL REFERENCES discovery_items(id) ON DELETE CASCADE,
  source_id         INTEGER NOT NULL REFERENCES discovery_sources(id) ON DELETE CASCADE,
  discovered_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Set when search found it, so a query that keeps paying for itself is visible.
  search_query      TEXT,
  PRIMARY KEY (discovery_item_id, source_id)
);

-- What each run of the pipeline did. Today's counters answer "is it working
-- now"; this answers "when did it stop", which is the question that actually
-- gets asked.
CREATE TABLE IF NOT EXISTS discovery_runs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  stage                TEXT    NOT NULL,
  started_at           TEXT    NOT NULL,
  finished_at          TEXT,
  success              INTEGER NOT NULL DEFAULT 0,
  sources_scanned      INTEGER NOT NULL DEFAULT 0,
  items_seen           INTEGER NOT NULL DEFAULT 0,
  items_found          INTEGER NOT NULL DEFAULT 0,
  relevant_items_found INTEGER NOT NULL DEFAULT 0,
  articles_fetched     INTEGER NOT NULL DEFAULT 0,
  candidates_created   INTEGER NOT NULL DEFAULT 0,
  published            INTEGER NOT NULL DEFAULT 0,
  held_for_review      INTEGER NOT NULL DEFAULT 0,
  error                TEXT
);
CREATE INDEX IF NOT EXISTS drun_started ON discovery_runs(started_at DESC);

-- Every search actually executed, so "did search run?" is answerable without
-- guessing. A stub that plans queries and calls itself healthy is exactly what
-- this table exists to make impossible.
CREATE TABLE IF NOT EXISTS discovery_search_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER REFERENCES discovery_sources(id) ON DELETE SET NULL,
  provider      TEXT    NOT NULL,
  query         TEXT    NOT NULL,
  query_kind    TEXT    NOT NULL,
  searched_at   TEXT    NOT NULL,
  result_count  INTEGER NOT NULL DEFAULT 0,
  new_url_count INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS dsearch_when ON discovery_search_runs(searched_at DESC);
CREATE INDEX IF NOT EXISTS dsearch_query ON discovery_search_runs(query, searched_at DESC);

-- What an article claims a promotion is, before anything is believed. One
-- roundup article routinely yields fifteen of these.
CREATE TABLE IF NOT EXISTS promotion_candidates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  discovery_id    INTEGER REFERENCES discovery_items(id) ON DELETE CASCADE,
  promotion_type  TEXT,
  issuer          TEXT,
  raw_product_name TEXT,
  resolved_product_id INTEGER REFERENCES card_products(id) ON DELETE SET NULL,
  -- The canonical shape of this campaign, for matching across sources.
  fingerprint     TEXT,
  terms_json      TEXT,
  application_channel TEXT NOT NULL DEFAULT 'unknown',
  extraction_confidence TEXT NOT NULL DEFAULT 'low',
  -- discovered | extracted | corroborating | verified | review | published | rejected
  status          TEXT    NOT NULL DEFAULT 'discovered',
  -- The promotion it became, or the one it turned out to already be.
  promotion_id    INTEGER REFERENCES promotions(id) ON DELETE SET NULL,
  review_reason   TEXT,
  -- Whether nobody looked at this before it went live. Derived from change
  -- events before, which counted every creation including the ones a person
  -- approved — so "published by itself" read higher than it was.
  auto_published  INTEGER NOT NULL DEFAULT 0,
  published_at    TEXT,
  verified_at     TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS pcand_status ON promotion_candidates(status, created_at);
CREATE INDEX IF NOT EXISTS pcand_fingerprint ON promotion_candidates(fingerprint);

-- One source's assertion about one field. The promotion record is DERIVED from
-- these; nothing writes a reward straight from an article, so two sources
-- disagreeing is a state the system can see rather than a coin it tosses.
CREATE TABLE IF NOT EXISTS promotion_claims (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id       INTEGER REFERENCES promotion_candidates(id) ON DELETE CASCADE,
  promotion_id       INTEGER REFERENCES promotions(id) ON DELETE CASCADE,
  field_name         TEXT    NOT NULL,
  value_json         TEXT    NOT NULL,
  source_url         TEXT    NOT NULL,
  source_type        TEXT    NOT NULL,
  source_tier        INTEGER NOT NULL,
  extracted_at       TEXT    NOT NULL,
  confidence         TEXT    NOT NULL,
  -- The sentence it came from. Short on purpose: enough to check the reading,
  -- not a copy of somebody else's article.
  supporting_excerpt TEXT
);
CREATE INDEX IF NOT EXISTS pclaim_candidate ON promotion_claims(candidate_id, field_name);
CREATE INDEX IF NOT EXISTS pclaim_promotion ON promotion_claims(promotion_id, field_name);

-- What a promotion said, and when. A campaign that goes from 16k to 20k and
-- then gets extended is one campaign with three versions, not three campaigns.
CREATE TABLE IF NOT EXISTS promotion_versions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  promotion_id        INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  valid_from          TEXT,
  valid_until         TEXT,
  terms_json          TEXT    NOT NULL,
  verification_status TEXT    NOT NULL,
  published_at        TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(promotion_id, version)
);

-- Offers that are one campaign with different terms by audience or channel: a
-- comparison site's exclusive is not the issuer's own offer, and merging them
-- would advertise terms nobody can actually get.
CREATE TABLE IF NOT EXISTS promotion_variants (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  promotion_id        INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  variant_key         TEXT,
  audience            TEXT,                -- everyone | new_customer | existing | targeted
  minimum_spend_cents INTEGER,
  reward_json         TEXT,
  annual_fee_required INTEGER,
  application_channel TEXT NOT NULL DEFAULT 'issuer_direct',
  terms_json          TEXT,
  UNIQUE(promotion_id, variant_key)
);

CREATE TABLE IF NOT EXISTS promotion_change_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  promotion_id   INTEGER REFERENCES promotions(id) ON DELETE CASCADE,
  -- created | extended | reward_changed | spend_changed | eligibility_changed
  --   | expired | withdrawn | terms_changed
  change_type    TEXT    NOT NULL,
  old_value_json TEXT,
  new_value_json TEXT,
  detected_at    TEXT    NOT NULL,
  source_url     TEXT
);
CREATE INDEX IF NOT EXISTS pchange_promo ON promotion_change_events(promotion_id, detected_at);
