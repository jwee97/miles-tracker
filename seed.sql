-- Singapore miles blogs. All WordPress, all standard /feed/ endpoints.
-- Swap these for your region; any RSS or Atom feed works.
INSERT OR IGNORE INTO feeds (url, label, kind) VALUES
  ('https://milelion.com/feed/',             'MileLion',     'rss'),
  ('https://mainlymiles.com/feed/',          'Mainly Miles',  'rss'),
  ('https://blog.seedly.sg/feed/',           'Seedly',        'rss'),
  ('https://www.moneysmart.sg/blog/feed/',   'MoneySmart',    'rss'),
  ('https://milelion.com/category/credit-cards/', 'MileLion cards', 'page'),
  ('https://mainlymiles.com/category/credit-cards/', 'Mainly Miles cards', 'page');


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

-- Merchant category codes. The codes and descriptions are the ISO standard and
-- stable; the category column is this app's own mapping onto earn_rules.
INSERT OR IGNORE INTO mcc_codes (code, description, category) VALUES
  ('5812','Eating places and restaurants','dining'),
  ('5813','Drinking places, bars','dining'),
  ('5814','Fast food restaurants','dining'),
  ('5462','Bakeries','dining'),
  ('5411','Grocery stores and supermarkets','groceries'),
  ('5422','Freezer and locker meat provisioners','groceries'),
  ('5441','Candy, nut and confectionery stores','groceries'),
  ('5499','Miscellaneous food stores and convenience','groceries'),
  ('5311','Department stores','shopping'),
  ('5399','General merchandise','shopping'),
  ('5651','Family clothing stores','shopping'),
  ('5691','Men''s and women''s clothing stores','shopping'),
  ('5661','Shoe stores','shopping'),
  ('5944','Jewellery and watches','shopping'),
  ('5945','Hobby, toy and game shops','shopping'),
  ('5732','Electronics stores','shopping'),
  ('5722','Household appliance stores','shopping'),
  ('5712','Furniture and home furnishings','shopping'),
  ('5942','Book stores','shopping'),
  ('5977','Cosmetic stores','shopping'),
  ('5912','Drug stores and pharmacies','health'),
  ('5999','Miscellaneous retail','shopping'),
  ('5262','Marketplaces','online'),
  ('5964','Direct marketing, catalogue merchants','online'),
  ('5967','Direct marketing, inbound telemarketing','online'),
  ('5968','Direct marketing, subscription','online'),
  ('5969','Direct marketing, other','online'),
  ('7996','Amusement parks and attractions','entertainment'),
  ('7832','Cinemas','entertainment'),
  ('7922','Theatrical and ticket agencies','entertainment'),
  ('7997','Membership clubs and gyms','entertainment'),
  ('4111','Local and suburban transit','transport'),
  ('4121','Taxicabs, limousines and ride hailing','transport'),
  ('4131','Bus lines','transport'),
  ('4784','Tolls and bridge fees','transport'),
  ('7523','Parking lots and garages','transport'),
  ('5541','Service stations','fuel'),
  ('5542','Automated fuel dispensers','fuel'),
  ('4511','Airlines and air carriers','travel'),
  ('4722','Travel agencies and tour operators','travel'),
  ('7011','Hotels, resorts and lodging','travel'),
  ('7512','Car rental','travel'),
  ('4411','Cruise lines','travel'),
  ('4814','Telecommunication services','utilities'),
  ('4899','Cable and streaming services','utilities'),
  ('4900','Utilities, electric, gas, water','utilities'),
  ('8011','Doctors and physicians','health'),
  ('8021','Dentists and orthodontists','health'),
  ('8062','Hospitals','health'),
  ('8099','Health practitioners, medical services','health'),
  ('8211','Schools, elementary and secondary','education'),
  ('8220','Colleges and universities','education'),
  ('8299','Educational services','education'),
  ('6012','Financial institutions, merchandise and services','financial'),
  ('6051','Quasi-cash, money orders, crypto','financial'),
  ('6300','Insurance sales and premiums','insurance'),
  ('8398','Charitable and social service organisations','charity'),
  ('9211','Court costs and fines','government'),
  ('9222','Fines','government'),
  ('9311','Tax payments','government'),
  ('9399','Government services','government'),
  ('4829','Money transfer','financial'),
  ('6513','Real estate agents and rentals','rental');

-- MCCs that most Singapore cards exclude from bonus earning. Seeded as a
-- starting point ONLY: exclusion lists are per-card and change, so check your
-- own terms and edit. card_id null means it applies to every card.
INSERT OR IGNORE INTO exclusions (id, card_id, mcc, reason, source) VALUES
  (1,  NULL, '6012', 'Financial services are excluded by most issuers', 'seed'),
  (2,  NULL, '6051', 'Quasi-cash and top-ups are excluded by most issuers', 'seed'),
  (3,  NULL, '4829', 'Money transfers are excluded by most issuers', 'seed'),
  (4,  NULL, '6300', 'Insurance premiums are commonly excluded', 'seed'),
  (5,  NULL, '9311', 'Tax payments are commonly excluded', 'seed'),
  (6,  NULL, '9399', 'Government services are commonly excluded', 'seed'),
  (7,  NULL, '9211', 'Court costs and fines are commonly excluded', 'seed'),
  (8,  NULL, '9222', 'Fines are commonly excluded', 'seed'),
  (9,  NULL, '8220', 'Education is commonly excluded', 'seed'),
  (10, NULL, '8211', 'Schools are commonly excluded', 'seed'),
  (11, NULL, '6513', 'Rental payments are commonly excluded', 'seed'),
  (12, NULL, '8398', 'Charitable donations are commonly excluded', 'seed');

-- Likely merchant codes. GUESSES, not facts: the code is set by the acquirer,
-- differs between outlets of the same brand and changes without notice. Confirm
-- one from a posted transaction and the app will trust it over these.
INSERT OR IGNORE INTO merchant_mcc (merchant, mcc, channel, source, confidence) VALUES
  ('din tai fung','5812','offline','seed','guess'),
  ('ntuc fairprice','5411','offline','seed','guess'),
  ('fairprice','5411','offline','seed','guess'),
  ('cold storage','5411','offline','seed','guess'),
  ('sheng siong','5411','offline','seed','guess'),
  ('giant','5411','offline','seed','guess'),
  ('shopee','5262','online','seed','guess'),
  ('lazada','5262','online','seed','guess'),
  ('amazon','5262','online','seed','guess'),
  ('taobao','5262','online','seed','guess'),
  ('grab','4121','online','seed','guess'),
  ('gojek','4121','online','seed','guess'),
  ('comfortdelgro','4121','offline','seed','guess'),
  ('courts','5732','offline','seed','guess'),
  ('harvey norman','5732','offline','seed','guess'),
  ('challenger','5732','offline','seed','guess'),
  ('uniqlo','5651','offline','seed','guess'),
  ('zara','5651','offline','seed','guess'),
  ('decathlon','5941','offline','seed','guess'),
  ('watsons','5912','offline','seed','guess'),
  ('guardian','5912','offline','seed','guess'),
  ('unity','5912','offline','seed','guess'),
  ('singapore airlines','4511','online','seed','guess'),
  ('scoot','4511','online','seed','guess'),
  ('agoda','4722','online','seed','guess'),
  ('booking.com','4722','online','seed','guess'),
  ('expedia','4722','online','seed','guess'),
  ('klook','4722','online','seed','guess'),
  ('netflix','4899','online','seed','guess'),
  ('spotify','4899','online','seed','guess'),
  ('disney+','4899','online','seed','guess'),
  ('singtel','4814','online','seed','guess'),
  ('starhub','4814','online','seed','guess'),
  ('m1','4814','online','seed','guess'),
  ('sp group','4900','online','seed','guess'),
  ('shell','5541','offline','seed','guess'),
  ('esso','5541','offline','seed','guess'),
  ('caltex','5541','offline','seed','guess'),
  ('spc','5541','offline','seed','guess'),
  ('golden village','7832','online','seed','guess'),
  ('cathay cineplexes','7832','offline','seed','guess'),
  ('starbucks','5814','offline','seed','guess'),
  ('mcdonald''s','5814','offline','seed','guess'),
  ('toast box','5814','offline','seed','guess'),
  ('ya kun','5814','offline','seed','guess'),
  ('kopitiam','5814','offline','seed','guess');
