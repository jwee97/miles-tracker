-- Run this in the D1 Console if your database was created before the
-- transaction-count requirement existed (schema.sql already includes it).
-- Some cards gate their reward on a number of transactions as well as a
-- dollar amount, so a requirement needs to track both.
ALTER TABLE requirements ADD COLUMN min_txns INTEGER;
