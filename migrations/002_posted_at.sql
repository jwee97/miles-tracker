-- Banks assess statement cycles, minimum spend and bonus caps on the date a
-- transaction POSTS, not the date it was made. A purchase a day before the
-- statement closes can post after it and count toward the next cycle instead.
-- posted_at is null until known; window math falls back to occurred_at and
-- flags anything near a boundary as at risk of moving.
ALTER TABLE transactions ADD COLUMN posted_at TEXT;
