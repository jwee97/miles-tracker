import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { readCardPage, scanCardPage } from '../src/cardscan';
import { cardRulesPrompt } from '../src/extraction';
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
const env = {
  DB: { prepare: (s: string) => wrap(s) },
  TZ_OFFSET_MINUTES: '480',
  MILE_VALUE_CENTS: '1.5',
} as unknown as Env;

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};

await runMigrations(env);
await runSeed(env);

const page = (body: string) => `<html><head><title>Citi Rewards Card</title></head><body>${body}</body></html>`;
const rates = (r: ReturnType<typeof readCardPage>) => r.candidates.filter((c) => c.kind === 'rate');

// --- the numbers a page states -------------------------------------------

let read = readCardPage(
  page('<p>Earn 4 miles per dollar on online shopping, capped at S$1,000 per calendar month.</p>'),
  'https://example.test/rw'
);
check('the headline rate is read', rates(read)[0]?.rate === 4, JSON.stringify(rates(read)[0]));
check('and understood as miles', rates(read)[0]?.reward_type === 'miles', '');
check('the category comes from the words around it', rates(read)[0]?.category === 'online', String(rates(read)[0]?.category));
check('the cap is read in cents', rates(read)[0]?.cap_cents === 100000, String(rates(read)[0]?.cap_cents));
check('and so is the window it resets on', rates(read)[0]?.cap_window === 'calendar_month', String(rates(read)[0]?.cap_window));
check('the page title is kept', read.title === 'Citi Rewards Card', read.title);

// A sentence that states two rates is two rules, and taking only the first
// loses the base rate — the one that applies to most spend.
read = readCardPage(page('<p>Earn 4 mpd on dining and 0.4 mpd on all other spend.</p>'), 'u');
check('both rates in one sentence are read', rates(read).length === 2, String(rates(read).length));
check('the first keeps its own category', rates(read)[0]?.category === 'dining', String(rates(read)[0]?.category));
check('the second does not inherit it', rates(read)[1]?.category !== 'dining', String(rates(read)[1]?.category));

read = readCardPage(page('<p>Get 5% cashback on groceries.</p>'), 'u');
check('a percentage is cashback, not miles', rates(read)[0]?.reward_type === 'cashback', '');
check('and keeps its number', rates(read)[0]?.rate === 5, String(rates(read)[0]?.rate));

// A marketing page repeats its headline; five rows to tick is not five pieces
// of information.
read = readCardPage(
  page('<p>Earn 4 mpd online.</p><p>Earn 4 mpd online.</p><p>Earn 4 mpd online.</p>'),
  'u'
);
check('a repeated claim collapses into one candidate', rates(read).length === 1, String(rates(read).length));
check('and counts how often it was said', rates(read)[0]?.occurrences === 3, String(rates(read)[0]?.occurrences));

// --- what earns nothing ---------------------------------------------------

read = readCardPage(
  page('<p>The following MCCs are excluded: 4900, 9311 and 6513. No miles will be awarded.</p>'),
  'u'
);
const ex = read.candidates.find((c) => c.kind === 'exclusion');
check('an exclusion sentence is recognised', !!ex, JSON.stringify(read.candidates));
check('with every code it names', ex?.mccs?.join(',') === '4900,9311,6513', String(ex?.mccs));

read = readCardPage(page('<p>Eligible transactions are MCC 5262, 5964, 5969.</p>'), 'u');
const inc = read.candidates.find((c) => c.kind === 'mcc');
check('a plain code list is not read as an exclusion', !!inc, JSON.stringify(read.candidates));

read = readCardPage(page('<p>A minimum spend of S$800 per calendar month is required.</p>'), 'u');
const min = read.candidates.find((c) => c.kind === 'minspend');
check('a minimum spend is read', min?.min_spend_cents === 80000, String(min?.min_spend_cents));

// A price is not a rate. Anything absurd is rejected rather than offered.
read = readCardPage(page('<p>Annual fee of 194.40 miles per dollar equivalent value 1000 mpd.</p>'), 'u');
check('an absurd rate is refused', rates(read).every((c) => (c.rate ?? 0) <= 100), JSON.stringify(rates(read)));

// --- what the app already knows about those codes -------------------------

const scan = await scanCardPage(
  env,
  'crw',
  '',
  'Earn 4 mpd on online shopping. The following MCCs are excluded: 4900, 9311.'
);
check('pasted text is read without any fetch', scan.error === null, String(scan.error));
check('and is labelled as pasted', scan.url === 'pasted text', scan.url);
const c4900 = scan.codes.find((c) => c.mcc === '4900');
check('every code named is described', !!c4900?.description, JSON.stringify(scan.codes));
check('and marked as excluded on this page', c4900?.excluded_here === true, JSON.stringify(c4900));

// HTML in pasted text must not become markup.
const injected = await scanCardPage(env, 'crw', '', 'Earn 4 mpd <b>online</b> today.');
check('pasted markup is escaped, not parsed', rates(injected as any).length === 1, JSON.stringify(injected.candidates));

const empty = await scanCardPage(env, 'crw', '', '   ');
check('nothing to read is said plainly', empty.error === 'give a URL or paste the page text', String(empty.error));

// --- the prompt -----------------------------------------------------------

const prompt = cardRulesPrompt('crw', 'Rewards', { source: 'https://example.test/rw', text: 'Earn 4 mpd online.' });
check('the prompt names the card', prompt.includes('/addearn crw'), '');
check('and insists on a base rate', prompt.includes('/addearn crw * <rate>'), '');
check('and asks for the merchant codes too', prompt.includes('/exclude <mcc> crw'), '');
check('and carries the page text', prompt.includes('Earn 4 mpd online.'), '');

// Nothing above wrote a rule: that is the whole point of the design.
const ruleCount = db.prepare(`SELECT COUNT(*) AS n FROM earn_rules`).get() as { n: number };
check('reading a page never writes a rule', Number(ruleCount.n) === 0, String(ruleCount.n));

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
