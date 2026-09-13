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
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS cards_nickname ON cards(nickname);
CREATE INDEX        IF NOT EXISTS cards_issuer   ON cards(issuer);

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
  source       TEXT    NOT NULL DEFAULT 'manual',-- manual | sms | import
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
  window          TEXT    NOT NULL,              -- calendar_month | calendar_quarter | statement_cycle | fixed_window
  deadline        TEXT,                          -- YYYY-MM-DD, for signup_min / fixed_window
  starts_at       TEXT,                          -- YYYY-MM-DD, for fixed_window
  min_txns        INTEGER,                       -- some cards also require N transactions
  bonus_cap_cents INTEGER,                       -- elevated rate applies to first N only
  reward_note     TEXT,                          -- '4 mpd on first $1,000'
  active          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS req_card ON requirements(card_id, active);

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
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id  INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  predicate TEXT    NOT NULL,                    -- JSON
  quote     TEXT
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
CREATE TABLE IF NOT EXISTS alerts_sent (
  key     TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mcc_codes (
  code        TEXT PRIMARY KEY,          -- '5812'
  description TEXT NOT NULL,             -- 'Eating places and restaurants'
  category    TEXT NOT NULL              -- maps to earn_rules.category
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
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
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
  card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  category    TEXT    NOT NULL,
  mpd         REAL    NOT NULL,                -- miles per dollar, or percent if cashback
  reward_type TEXT    NOT NULL DEFAULT 'miles', -- miles | cashback
  mcc_include TEXT,                             -- CSV of MCCs, null = any
  mcc_exclude TEXT,                             -- CSV of MCCs that never match
  channel     TEXT,                             -- online | offline | contactless | null = any
  min_txn_cents INTEGER,                        -- rule needs a transaction this large
  program_key TEXT    REFERENCES programs(key),
  cap_cents   INTEGER,                         -- bonus rate applies below this
  cap_group   TEXT,                            -- rules sharing one cap
  cap_window  TEXT,                            -- statement_cycle | calendar_month | calendar_quarter
  note        TEXT,
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS earn_card ON earn_rules(card_id, active);
