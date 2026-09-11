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
  occurred_at  TEXT    NOT NULL,                 -- YYYY-MM-DD
  merchant     TEXT,
  category     TEXT,
  source       TEXT    NOT NULL DEFAULT 'manual',-- manual | sms | import
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tx_card_date ON transactions(card_id, occurred_at);

-- Minimum-spend requirements. Two kinds, deliberately modelled together so the
-- digest can report both, plus bonus_cap which is the mirror: when to STOP using
-- a card because the elevated rate no longer applies.
CREATE TABLE IF NOT EXISTS requirements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id         INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL,              -- monthly_min | signup_min
  amount_cents    INTEGER NOT NULL,
  window          TEXT    NOT NULL,              -- calendar_month | statement_cycle | fixed_window
  deadline        TEXT,                          -- YYYY-MM-DD, for signup_min / fixed_window
  starts_at       TEXT,                          -- YYYY-MM-DD, for fixed_window
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
  active INTEGER NOT NULL DEFAULT 1
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
  offer_id     INTEGER REFERENCES offers(id) ON DELETE SET NULL
);

-- Dedupe for alerts: key encodes card + threshold + period, so each alert fires once.
CREATE TABLE IF NOT EXISTS alerts_sent (
  key     TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
