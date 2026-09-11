-- Singapore miles blogs. All WordPress, all standard /feed/ endpoints.
-- Swap these for your region; any RSS or Atom feed works.
INSERT OR IGNORE INTO feeds (url, label) VALUES
  ('https://milelion.com/feed/',             'MileLion'),
  ('https://mainlymiles.com/feed/',          'Mainly Miles'),
  ('https://blog.seedly.sg/feed/',           'Seedly'),
  ('https://www.moneysmart.sg/blog/feed/',   'MoneySmart');


-- Loyalty programmes and the routes between them.
INSERT OR IGNORE INTO programs (key, name, kind, unit, expiry_months) VALUES
  ('citi_ty',     'Citi ThankYou Points',    'bank',    'points', 60),
  ('citi_miles',  'Citi Miles',              'bank',    'miles',  NULL),
  ('dbs_points',  'DBS Points',              'bank',    'points', 36),
  ('uob_uni',     'UOB UNI$',                'bank',    'UNI$',   24),
  ('ocbc_dollar', 'OCBC$',                   'bank',    'OCBC$',  NULL),
  ('ocbc_90n',    'OCBC 90N Miles',          'bank',    'miles',  NULL),
  ('hsbc_points', 'HSBC Points',             'bank',    'points', 37),
  ('scb_360',     'SC 360 Rewards',          'bank',    'points', NULL),
  ('amex_mr',     'Amex Membership Rewards', 'bank',    'points', NULL),
  ('krisflyer',   'KrisFlyer',               'airline', 'miles',  36),
  ('asia_miles',  'Asia Miles',              'airline', 'miles',  NULL),
  ('heymax',      'HeyMax Max Miles',        'bank',    'miles',  NULL),
  ('eva_air',     'EVA Infinity MileageLands','airline','miles',  NULL),
  ('ana',         'ANA Mileage Club',        'airline', 'miles',  36),
  ('qatar',       'Qatar Privilege Club',    'airline', 'Avios',  NULL),
  ('british_aw',  'British Airways Club',    'airline', 'Avios',  NULL),
  ('emirates',    'Emirates Skywards',       'airline', 'miles',  NULL),
  ('qantas',      'Qantas Frequent Flyer',   'airline', 'points', NULL),
  ('united',      'United MileagePlus',      'airline', 'miles',  NULL),
  ('turkish',     'Turkish Miles&Smiles',    'airline', 'miles',  NULL);

-- expiry_months is left NULL wherever the rule is not something to assert from
-- memory. It is only a default for new batches; the date on each batch is what
-- actually drives the expiry warnings, so set that when you record a balance.

-- The RATIOS below are corroborated across several public summaries published
-- between Nov 2025 and Sep 2026. The FEES AND MINIMUMS are not: sources
-- disagree, and they move (UOB raised its fee in Dec 2025, HSBC reworked its
-- ratio in Jan 2025). Every row is therefore seeded with verified_at NULL, and
-- the weekly rates review reports it as unverified until you check it against
-- your own bank and run /verified. Treat the fees as placeholders.
INSERT OR IGNORE INTO conversions
  (id, from_program, to_program, from_units, to_units, fee_cents, min_block, block_increment, route, note) VALUES
  (1,  'citi_ty',     'krisflyer',  25000, 10000, 2725, 25000, 25000, 'direct', 'fee and min unverified'),
  (2,  'citi_ty',     'krisflyer',  10000,  4000,    0, 10000, 10000, 'Kris+',  'fee-free route, verify it still exists'),
  (3,  'citi_miles',  'krisflyer',  10000, 10000, 2725, 10000,  1000, 'direct', '1 to 1, fee and min unverified'),
  (4,  'dbs_points',  'krisflyer',   5000, 10000, 2725,  5000,  5000, 'direct', '1 point = 2 miles, fee unverified'),
  (5,  'dbs_points',  'asia_miles',  5000, 10000, 2725,  5000,  5000, 'direct', 'fee and min unverified'),
  (6,  'uob_uni',     'krisflyer',   5000, 10000, 2700,  2500,  2500, 'direct', 'fee rose Dec 2025, verify'),
  (7,  'uob_uni',     'asia_miles',  5000, 10000, 2700,  2500,  2500, 'direct', 'fee and min unverified'),
  (8,  'ocbc_dollar', 'krisflyer',  25000, 10000, 2725,  2500,  2500, 'direct', '5 to 2, fee and min unverified'),
  (9,  'ocbc_90n',    'krisflyer',  10000, 10000, 2725, 10000,  1000, 'direct', '1 to 1, fee and min unverified'),
  (10, 'hsbc_points', 'krisflyer',  30000, 10000,    0, 30000, 30000, 'direct', 'often fee-free, verify for your card'),
  (11, 'hsbc_points', 'asia_miles', 25000, 10000,    0, 25000, 25000, 'direct', 'fee and min unverified'),
  (12, 'scb_360',     'krisflyer',  25000, 10000, 2725, 25000, 25000, 'direct', 'ratio and fee unverified'),
  (13, 'amex_mr',     'krisflyer',   4500,  2000,    0,  4500,  4500, 'direct', 'often free and instant, verify');
