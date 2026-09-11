-- Conversion terms drift constantly: UOB raised its fee in Dec 2025, HSBC
-- reworked its ratio in Jan 2025, and promo bonuses come and go. Track when
-- each route was last checked against the bank so stale figures can be flagged
-- rather than silently trusted.
ALTER TABLE conversions ADD COLUMN verified_at TEXT;
ALTER TABLE conversions ADD COLUMN source_url TEXT;
ALTER TABLE conversions ADD COLUMN note TEXT;

-- Feed items get classified as they arrive so the weekly rates review can pull
-- the ones about transfer bonuses and rate changes, separately from sign-up promos.
ALTER TABLE feed_items ADD COLUMN topic TEXT;
