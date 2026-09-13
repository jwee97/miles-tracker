-- The rules engine. Singapore card rewards turn on the merchant category code,
-- the channel (online vs contactless vs in-store), per-card exclusions and caps
-- — none of which the app could express before.

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

-- A rule can now be conditioned on the code and the channel, not just a
-- category label the user typed.
ALTER TABLE earn_rules ADD COLUMN mcc_include TEXT;     -- CSV, null = any
ALTER TABLE earn_rules ADD COLUMN mcc_exclude TEXT;     -- CSV
ALTER TABLE earn_rules ADD COLUMN channel TEXT;         -- online | offline | contactless | null = any
ALTER TABLE earn_rules ADD COLUMN min_txn_cents INTEGER;

-- What the app expected a transaction to earn, and what the bank actually gave.
ALTER TABLE transactions ADD COLUMN mcc TEXT;
ALTER TABLE transactions ADD COLUMN channel TEXT;
ALTER TABLE transactions ADD COLUMN expected_miles INTEGER;
ALTER TABLE transactions ADD COLUMN expected_cashback_cents INTEGER;
ALTER TABLE transactions ADD COLUMN actual_miles INTEGER;
ALTER TABLE transactions ADD COLUMN actual_cashback_cents INTEGER;
ALTER TABLE transactions ADD COLUMN reward_note TEXT;
