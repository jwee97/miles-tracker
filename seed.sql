-- Singapore miles blogs. All WordPress, all standard /feed/ endpoints.
-- Swap these for your region; any RSS or Atom feed works.
INSERT OR IGNORE INTO feeds (url, label) VALUES
  ('https://milelion.com/feed/',             'MileLion'),
  ('https://mainlymiles.com/feed/',          'Mainly Miles'),
  ('https://blog.seedly.sg/feed/',           'Seedly'),
  ('https://www.moneysmart.sg/blog/feed/',   'MoneySmart');

-- Loyalty programmes and the Citi -> KrisFlyer routes. Fees, blocks and bonuses
-- change often; edit with /addconv rather than trusting these forever.
INSERT OR IGNORE INTO programs (key, name, kind, unit, expiry_months) VALUES
  ('citi_ty',    'Citi ThankYou Points', 'bank',   'points', NULL),
  ('dbs_points', 'DBS Points',           'bank',   'points', NULL),
  ('uob_uni',    'UOB UNI$',             'bank',   'UNI$',   NULL),
  ('krisflyer',  'KrisFlyer',            'airline','miles',  36),
  ('asia_miles', 'Asia Miles',           'airline','miles',  NULL);

INSERT OR IGNORE INTO conversions
  (id, from_program, to_program, from_units, to_units, fee_cents, min_block, block_increment, route) VALUES
  (1, 'citi_ty', 'krisflyer', 25000, 10000, 2725, 25000, 25000, 'direct'),
  (2, 'citi_ty', 'krisflyer', 10000,  4000,    0, 10000, 10000, 'Kris+');
