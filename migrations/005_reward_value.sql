-- A cashback card and a miles card cannot be compared on "miles per dollar".
-- Rules now declare what they pay, and ranking converts both to cents of value
-- using your own valuation of a mile.
ALTER TABLE earn_rules ADD COLUMN reward_type TEXT NOT NULL DEFAULT 'miles';  -- miles | cashback

-- Learned from your own tagging: once NTUC is tagged #groceries, later spend
-- at NTUC categorises itself.
CREATE TABLE IF NOT EXISTS merchant_categories (
  merchant   TEXT PRIMARY KEY,     -- lowercased
  category   TEXT NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
