import { statementCycle, calendarMonth, calendarQuarter, addMonths, daysBetween, parseMoney, today } from '../src/spend';
import { evaluateRule } from '../src/eligibility';
import { parseFeed, isRelevant } from '../src/rss';
import type { Card, Env } from '../src/types';

const env = { TZ_OFFSET_MINUTES: '480' } as Env;
let fails = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

console.log('local today (SGT):', today(env));

// --- statement cycles -------------------------------------------------------
const realNow = Date.now;
const at = (iso: string) => { Date.now = () => Date.parse(iso); };

at('2026-09-11T04:00:00Z');            // 12:00 SGT on the 11th
eq('cycle, stmt day 18, before close', statementCycle(18, env), { start: '2026-08-19', end: '2026-09-18' });
eq('cycle, stmt day 5, after close',   statementCycle(5, env),  { start: '2026-09-06', end: '2026-10-05' });
eq('cycle, stmt day 11 = today',       statementCycle(11, env), { start: '2026-08-12', end: '2026-09-11' });
eq('calendar month',                   calendarMonth(env),      { start: '2026-09-01', end: '2026-09-30' });
eq('calendar quarter (Q3)',            calendarQuarter(env),    { start: '2026-07-01', end: '2026-09-30' });

at('2026-02-15T04:00:00Z');
eq('quarter Q1 ends on 31 Mar', calendarQuarter(env), { start: '2026-01-01', end: '2026-03-31' });
at('2026-12-25T04:00:00Z');
eq('quarter Q4 ends on 31 Dec', calendarQuarter(env), { start: '2026-10-01', end: '2026-12-31' });

at('2026-01-31T04:00:00Z');            // clamping into February
eq('cycle clamps short month', statementCycle(31, env), { start: '2026-01-01', end: '2026-01-31' });
at('2026-02-15T04:00:00Z');
eq('cycle clamps Feb end',     statementCycle(31, env), { start: '2026-02-01', end: '2026-02-28' });

at('2026-09-11T20:00:00Z');            // 04:00 SGT on the 12th — TZ must roll the day
eq('timezone rolls the day', today(env), '2026-09-12');

Date.now = realNow;

// --- date helpers -----------------------------------------------------------
eq('addMonths back over year', addMonths('2026-03-15', -12), '2025-03-15');
eq('addMonths clamps day',     addMonths('2026-03-31', -1),  '2026-02-28');
eq('daysBetween',              daysBetween('2026-09-01', '2026-09-11'), 10);
eq('parseMoney',               parseMoney('$1,234.50'), 123450);
eq('parseMoney rejects junk',  parseMoney('abc'), null);

// --- eligibility ------------------------------------------------------------
at('2026-09-11T04:00:00Z');
const card = (o: Partial<Card>): Card => ({
  id: 1, issuer: 'DBS', product: 'Altitude', product_key: 'dbs_altitude', nickname: 'alt',
  credit_limit_cents: 0, statement_day: 1, opened_at: null, closed_at: null,
  signup_bonus_at: null, base_mpd: 0, ...o,
});

// Closed 14 months ago: the 12-month cooldown has lapsed.
eq('cooldown lapsed',
  evaluateRule({ type: 'no_issuer_card_within_months', issuer: 'DBS', months: 12 },
    [card({ opened_at: '2023-01-01', closed_at: '2025-07-01' })], env).verdict, 'pass');

// Closed 4 months ago: still inside the window.
eq('cooldown active',
  evaluateRule({ type: 'no_issuer_card_within_months', issuer: 'DBS', months: 12 },
    [card({ opened_at: '2023-01-01', closed_at: '2026-05-01' })], env).verdict, 'fail');

// Still open counts as held right now.
eq('open card blocks',
  evaluateRule({ type: 'no_issuer_card_within_months', issuer: 'DBS', months: 12 },
    [card({ opened_at: '2023-01-01' })], env).verdict, 'fail');

// A different issuer is irrelevant.
eq('other issuer ignored',
  evaluateRule({ type: 'new_to_bank', issuer: 'UOB' },
    [card({ opened_at: '2023-01-01' })], env).verdict, 'pass');

// A row with no opened_at is a card never actually held.
eq('never-opened row ignored',
  evaluateRule({ type: 'never_held_product', product_key: 'dbs_altitude' },
    [card({ opened_at: null })], env).verdict, 'pass');

eq('signup bonus cooldown',
  evaluateRule({ type: 'no_signup_bonus_within_months', issuer: 'DBS', months: 12 },
    [card({ opened_at: '2026-02-01', signup_bonus_at: '2026-03-01' })], env).verdict, 'fail');

eq('income is unknown, not pass',
  evaluateRule({ type: 'min_income', amount_cents: 3000000, period: 'year' }, [], env).verdict, 'unknown');

const lapsed = evaluateRule({ type: 'no_issuer_card_within_months', issuer: 'DBS', months: 12 },
  [card({ opened_at: '2023-01-01', closed_at: '2026-05-01' })], env);
eq('fail explains when eligible', /2027-05-01/.test(lapsed.reason), true);
Date.now = realNow;

// --- RSS --------------------------------------------------------------------
const rss = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[DBS Altitude sign-up bonus: 30,000 miles]]></title>
<link>https://x.test/a</link><guid>g1</guid><pubDate>Tue, 09 Sep 2026 02:00:00 +0000</pubDate>
<description><![CDATA[<p>New-to-bank customers get bonus miles.</p>]]></description></item>
<item><title>Best hawker food in Singapore</title><link>https://x.test/b</link>
<guid>g2</guid><description>Nothing to do with cards.</description></item>
</channel></rss>`;
const items = parseFeed(rss);
eq('rss item count', items.length, 2);
eq('rss strips CDATA + entities', items[0].title, 'DBS Altitude sign-up bonus: 30,000 miles');
eq('rss link', items[0].link, 'https://x.test/a');
eq('rss date -> iso', items[0].published_at, '2026-09-09T02:00:00.000Z');
eq('promo item matches', isRelevant(items[0]), true);
eq('food item filtered out', isRelevant(items[1]), false);

const atom = `<feed><entry><title>UOB welcome offer for cardmembers</title>
<link rel="alternate" href="https://y.test/c"/><id>at1</id>
<updated>2026-09-10T00:00:00Z</updated><summary>Apply and get bonus miles.</summary></entry></feed>`;
const a = parseFeed(atom);
eq('atom parsed', [a.length, a[0].link, a[0].guid], [1, 'https://y.test/c', 'at1']);
eq('atom relevant', isRelevant(a[0]), true);

// A card the user holds should match even without promo wording.
eq('watched product name matches',
  isRelevant({ guid: 'x', title: 'Changes to the Altitude Visa', link: '', published_at: null, summary: '' },
    ['Altitude Visa']), true);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall passed');
process.exit(fails ? 1 : 0);
