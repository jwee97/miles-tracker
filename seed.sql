-- Singapore miles blogs. All WordPress, all standard /feed/ endpoints.
-- Swap these for your region; any RSS or Atom feed works.
INSERT OR IGNORE INTO feeds (url, label) VALUES
  ('https://milelion.com/feed/',             'MileLion'),
  ('https://mainlymiles.com/feed/',          'Mainly Miles'),
  ('https://blog.seedly.sg/feed/',           'Seedly'),
  ('https://www.moneysmart.sg/blog/feed/',   'MoneySmart');
