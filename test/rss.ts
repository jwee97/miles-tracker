import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/migrate';
import {
  canonicalUrl,
  classify,
  decodeEntities,
  extractLinks,
  htmlToText,
  ignoreFeedItem,
  looksLikeFeed,
  normalizeText,
  pageMeta,
  parseFeed,
  parseIndexPage,
  pickApplyUrl,
  scanFeedsDetailed,
  scanUrl,
  trackFeedItem,
} from '../src/rss';
import type { Env } from '../src/types';

const db = new DatabaseSync(':memory:');
const wrap = (sql: string, args: unknown[] = []): any => ({
  bind: (...a: unknown[]) => wrap(sql, a),
  first: async () => db.prepare(sql).get(...(args as any)) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...(args as any)) }),
  run: async () => {
    const r = db.prepare(sql).run(...(args as any));
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  },
});
const env = { DB: { prepare: (s: string) => wrap(s) } } as unknown as Env;

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};

// --- fixtures ---------------------------------------------------------------

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>MileLion</title>
  <item>
    <title><![CDATA[UOB Lady&#8217;s Card: 30,000 bonus miles for new sign-ups]]></title>
    <link>https://www.milelion.com/2026/09/01/uob-ladys-signup/?utm_source=rss&amp;utm_medium=feed</link>
    <guid isPermaLink="false">milelion-1</guid>
    <pubDate>Tue, 01 Sep 2026 02:00:00 +0000</pubDate>
    <description>A short teaser.</description>
    <content:encoded><![CDATA[<p>Sign up and spend S$1,000 to receive 30,000 bonus miles.</p>]]></content:encoded>
  </item>
  <item>
    <title>Weekend reading</title>
    <link>https://www.milelion.com/2026/09/02/weekend/</link>
    <guid>milelion-2</guid>
    <description>Assorted links about nothing in particular.</description>
  </item>
  <item>
    <title>Citi card news</title>
    <link>https://www.milelion.com/2026/09/03/citi-news/</link>
    <guid>milelion-3</guid>
    <description>Short.</description>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>KrisFlyer transfer bonus is back</title>
    <link rel="edit" href="https://example.com/edit/1"/>
    <link rel="alternate" href="https://example.com/posts/transfer-bonus"/>
    <id>atom-1</id>
    <updated>2026-09-04T00:00:00Z</updated>
    <summary>A 15% transfer bonus on points-to-miles conversions this month.</summary>
  </entry>
</feed>`;

const INDEX_PAGE = `<html><body>
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <main>
    <a href="/2026/09/05/dbs-altitude-welcome-offer/">DBS Altitude welcome offer: 20,000 miles for new cardholders</a>
    <a href="/2026/09/06/lounges/">Short</a>
    <a href="https://mainlymiles.com/2026/09/07/hotel-review/">A very long hotel review of somewhere pleasant</a>
  </main>
</body></html>`;

const ARTICLE_PROMO = `<html><head>
  <title>UOB Lady's Card sign-up offer | MileLion</title>
  <meta property="og:description" content="30,000 bonus miles when you spend S$1,000 in 60 days."/>
  </head><body>
  <script>var tracker = 'ignore me';</script>
  <nav><a href="/">Home</a></nav>
  <article>
    <p>New-to-bank customers who apply for the UOB Lady&#8217;s Card receive 30,000 bonus miles
    after spending S$1,000 within 60 days. The annual fee is waived for the first year.</p>
    <p><a href="https://www.uob.com.sg/personal/cards/apply/ladys?utm_campaign=milelion">Apply now</a></p>
  </article>
  <footer><a href="/privacy">Privacy</a></footer>
</body></html>`;

const ARTICLE_THIN = `<html><head><title>Citi card news</title></head><body><article>
  <p>Citi has refreshed the Rewards card landing page. Spend S$800 and get 10,000 bonus points
  if you are new to bank.</p>
  <p><a href="https://www.citibank.com.sg/credit-cards/rewards/apply">Find out more</a></p>
</article></body></html>`;

const ARTICLE_BORING = `<html><head><title>Weekend reading</title></head><body><article>
  <p>Some assorted links about travel photography and nothing to do with banking.</p>
</article></body></html>`;

const PAGES: Record<string, { body: string; type: string }> = {
  'https://feeds.test/rss': { body: RSS, type: 'application/rss+xml' },
  'https://feeds.test/atom': { body: ATOM, type: 'application/atom+xml' },
  'https://milelion.com/cards': { body: INDEX_PAGE, type: 'text/html' },
  'https://milelion.com/2026/09/01/uob-ladys-signup': { body: ARTICLE_PROMO, type: 'text/html' },
  'https://milelion.com/2026/09/03/citi-news': { body: ARTICLE_THIN, type: 'text/html' },
  'https://milelion.com/2026/09/02/weekend': { body: ARTICLE_BORING, type: 'text/html' },
  'https://milelion.com/2026/09/05/dbs-altitude-welcome-offer': {
    body: ARTICLE_PROMO.replace('UOB Lady', 'DBS Altitude'),
    type: 'text/html',
  },
  'https://mainlymiles.com/2026/09/07/hotel-review': { body: ARTICLE_BORING, type: 'text/html' },
};

const requested: string[] = [];
(globalThis as any).fetch = async (input: string) => {
  const url = String(input);
  requested.push(url);
  const page = PAGES[url.replace(/\/$/, '')];
  if (!page) return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
  return { ok: true, status: 200, headers: { get: () => page.type }, text: async () => page.body };
};

await runMigrations(env);

// --- URL canonicalisation ---------------------------------------------------

check('resolves a relative href', canonicalUrl('/a/b', 'https://site.test/x/y') === 'https://site.test/a/b', '');
check(
  'drops tracking parameters',
  canonicalUrl('https://site.test/p?utm_source=rss&id=7&fbclid=abc') === 'https://site.test/p?id=7',
  String(canonicalUrl('https://site.test/p?utm_source=rss&id=7&fbclid=abc'))
);
check(
  'drops the query entirely when only tracking was there',
  canonicalUrl('https://site.test/p?utm_source=rss') === 'https://site.test/p',
  String(canonicalUrl('https://site.test/p?utm_source=rss'))
);
check(
  'unwraps a redirector',
  canonicalUrl('https://news.google.com/read?url=https%3A%2F%2Fbank.test%2Foffer') === 'https://bank.test/offer',
  String(canonicalUrl('https://news.google.com/read?url=https%3A%2F%2Fbank.test%2Foffer'))
);
check('strips www and the fragment', canonicalUrl('https://www.site.test/p/#more') === 'https://site.test/p', '');
check('rejects javascript hrefs', canonicalUrl('javascript:void(0)') === null, '');
check('rejects nonsense', canonicalUrl('not a url') === null, String(canonicalUrl('not a url')));
check('two spellings of one article agree', canonicalUrl('https://www.site.test/p/?utm_source=x') === canonicalUrl('https://site.test/p'), '');
check('decodes numeric entities', decodeEntities('Lady&#8217;s &amp; Co') === 'Lady\u2019s & Co', decodeEntities('Lady&#8217;s &amp; Co'));
check('folds curly punctuation to ASCII', normalizeText('Lady\u2019s \u201ccard\u201d') === `Lady's "card"`, normalizeText('Lady\u2019s \u201ccard\u201d'));

// --- HTML reading -----------------------------------------------------------

const text = htmlToText(ARTICLE_PROMO);
check('drops script contents', !text.includes('tracker'), text.slice(0, 80));
check('drops the nav and footer', !text.includes('Privacy') && !text.includes('Home'), text.slice(0, 120));
check('keeps the article body', text.includes('30,000 bonus miles'), text.slice(0, 120));
check('decodes entities in the body', text.includes("Lady's"), text.slice(0, 120));

const meta = pageMeta(ARTICLE_PROMO);
check('reads the title', meta.title.startsWith("UOB Lady's Card sign-up offer"), meta.title);
check('reads the og description', meta.description.includes('30,000 bonus miles'), meta.description);

const links = extractLinks(ARTICLE_PROMO, 'https://milelion.com/2026/09/01/uob-ladys-signup');
check('makes hrefs absolute', links.some((l) => l.url === 'https://milelion.com/privacy'), JSON.stringify(links));
check(
  'cleans the outbound link',
  links.some((l) => l.url === 'https://uob.com.sg/personal/cards/apply/ladys'),
  JSON.stringify(links.map((l) => l.url))
);

const apply = pickApplyUrl(links, 'https://milelion.com/2026/09/01/uob-ladys-signup');
check('picks the issuer link to apply on', apply === 'https://uob.com.sg/personal/cards/apply/ladys', String(apply));
check(
  'ignores links back into the same site',
  pickApplyUrl(
    [{ url: 'https://milelion.com/apply-here', text: 'Apply now' }],
    'https://milelion.com/post'
  ) === null,
  ''
);
check(
  'will not guess from a weak hint alone',
  pickApplyUrl([{ url: 'https://random.test/page', text: 'Read more' }], 'https://milelion.com/post') === null,
  ''
);

// --- feed parsing -----------------------------------------------------------

const rssItems = parseFeed(RSS);
check('reads every item', rssItems.length === 3, String(rssItems.length));
check('decodes the title', rssItems[0].title.includes("Lady's"), rssItems[0].title);
check('prefers content:encoded over the teaser', rssItems[0].summary.includes('30,000 bonus miles'), rssItems[0].summary);
check('parses the date', rssItems[0].published_at === '2026-09-01T02:00:00.000Z', String(rssItems[0].published_at));

const atomItems = parseFeed(ATOM);
check('takes the alternate link, not the edit link', atomItems[0].link === 'https://example.com/posts/transfer-bonus', atomItems[0].link);
check('recognises a feed body', looksLikeFeed(RSS) && looksLikeFeed(ATOM), '');
check('and knows a web page is not one', !looksLikeFeed(INDEX_PAGE, 'text/html'), '');

const pageItems = parseIndexPage(INDEX_PAGE, 'https://milelion.com/cards');
check('harvests headline links from a plain page', pageItems.length === 2, JSON.stringify(pageItems.map((i) => i.title)));
check('skips navigation links', !pageItems.some((i) => /Home|About|Short/.test(i.title)), '');
check('resolves harvested links', pageItems[0].link === 'https://milelion.com/2026/09/05/dbs-altitude-welcome-offer', pageItems[0].link);

// --- classification ---------------------------------------------------------

check('a figure plus a card term is an offer', classify('Get 30,000 bonus miles with this card').promo, '');
check('a promo word alone is not', !classify('Limited-time promotion on hotel stays').promo, '');
check('a card term alone is not', !classify('I reviewed my credit card statement today').promo, '');
check('a watched product always matches', classify('Notes on the UOB Ladys Card', ["UOB Ladys"]).promo, '');
check('rate news is flagged separately', classify('A 15% transfer bonus to KrisFlyer').rates, '');
check('the trace names what matched', classify('30,000 bonus miles on this card').terms.length >= 2, JSON.stringify(classify('30,000 bonus miles on this card').terms));
check(
  'a stronger page scores higher',
  classify('Sign-up offer: 30,000 bonus miles on the UOB card').score > classify('A card').score,
  ''
);

// --- scanning ---------------------------------------------------------------

db.prepare(`INSERT INTO feeds (url, label, kind) VALUES ('https://feeds.test/rss', 'Feeds', 'rss')`).run();
db.prepare(`INSERT INTO feeds (url, label, kind) VALUES ('https://milelion.com/cards', 'Cards page', 'page')`).run();
db.prepare(`INSERT INTO feeds (url, label) VALUES ('https://gone.test/rss', 'Gone')`).run();

const scan = await scanFeedsDetailed(env, { deep: true });
check('reports the sources it could read', scan.feeds_read === 2, String(scan.feeds_read));
check('names the one it could not', scan.feeds_failed.join() === 'Gone', scan.feeds_failed.join());
const titles = scan.fresh.map((f) => f.title);
check('finds the obvious sign-up offer', titles.some((t) => t.includes("Lady's")), JSON.stringify(titles));
check('finds the offer buried on a listing page', titles.some((t) => t.includes('DBS Altitude')), JSON.stringify(titles));
check(
  'reading the article rescues a thin summary',
  scan.fresh.some((f) => f.link.endsWith('citi-news')),
  JSON.stringify(scan.fresh.map((f) => f.link))
);
check('and still passes over the irrelevant post', !titles.some((t) => t.includes('Weekend')), JSON.stringify(titles));

const lady = scan.fresh.find((f) => f.title.includes("Lady's"))!;
check('captures where to apply', lady.apply_url === 'https://uob.com.sg/personal/cards/apply/ladys', String(lady.apply_url));
check('stores an excerpt worth reading', !!lady.excerpt && lady.excerpt.includes('30,000'), String(lady.excerpt));
check('records that the page was opened', lady.deep === true, '');
check('the stored link is the clean one', lady.link === 'https://milelion.com/2026/09/01/uob-ladys-signup', lady.link);

const again = await scanFeedsDetailed(env, { deep: true });
check('a second scan finds nothing new', again.fresh.length === 0, JSON.stringify(again.fresh));
check('and opens no pages', again.pages_fetched === 0, String(again.pages_fetched));

const boring = db.prepare(`SELECT * FROM feed_items WHERE link LIKE '%weekend%'`).get() as any;
check('an ignored item is still remembered, so it is judged once', !!boring, '');
check('with no topic set', boring.topic === null, String(boring.topic));

// The budget is what keeps a busy feed day from turning into 60 fetches.
db.prepare(`DELETE FROM feed_items`).run();
const budgeted = await scanFeedsDetailed(env, { deep: true, budget: 1 });
check('honours the page budget', budgeted.pages_fetched === 1, String(budgeted.pages_fetched));

db.prepare(`DELETE FROM feed_items`).run();
const shallow = await scanFeedsDetailed(env, { deep: false });
check('a quick scan opens nothing', shallow.pages_fetched === 0, String(shallow.pages_fetched));
check(
  'and so sees less',
  shallow.fresh.length < scan.fresh.length,
  `${shallow.fresh.length} vs ${scan.fresh.length}`
);

// --- one page on demand -----------------------------------------------------

const manual = await scanUrl(env, 'https://www.milelion.com/2026/09/01/uob-ladys-signup/?utm_source=telegram');
check('reads a pasted URL', !!manual && manual.topic === 'promo', JSON.stringify(manual));
check('and finds the apply link there too', manual!.apply_url === 'https://uob.com.sg/personal/cards/apply/ladys', String(manual!.apply_url));
check('a dead URL fails quietly', (await scanUrl(env, 'https://gone.test/nothing')) === null, '');

// --- acting on an item ------------------------------------------------------

const offerId = await trackFeedItem(env, manual!.id);
check('tracking creates an offer', typeof offerId === 'number', String(offerId));
const offer = db.prepare(`SELECT * FROM offers WHERE id = ?`).get(offerId) as any;
check('the offer points at the issuer page, not the blog', offer.source_url === 'https://uob.com.sg/personal/cards/apply/ladys', offer.source_url);
check('tracking twice does not duplicate', (await trackFeedItem(env, manual!.id)) === offerId, '');
check('tracking a missing item is not an error', (await trackFeedItem(env, 99999)) === null, '');

// The rows were cleared for the budget test, so take the current one.
const stale = db.prepare(`SELECT id FROM feed_items WHERE link LIKE '%weekend%'`).get() as any;
await ignoreFeedItem(env, stale.id);
check(
  'ignoring is recorded',
  (db.prepare(`SELECT action FROM feed_items WHERE id = ?`).get(stale.id) as any)?.action === 'ignored',
  ''
);

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
