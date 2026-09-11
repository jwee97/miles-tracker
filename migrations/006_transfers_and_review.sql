-- Converting points only ever produced a plan; nothing was ever deducted, so a
-- balance stayed put after a transfer that really happened. Transfers are now
-- executed against the ledger and recorded.
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

-- A category can be certain (you said so), provisional (learned from a merchant
-- you tagged before), or unknown. Treating all three as equal made rewards and
-- the wrong-card analysis look more precise than the data supports.
ALTER TABLE transactions ADD COLUMN category_source TEXT;     -- manual | learned
ALTER TABLE transactions ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
