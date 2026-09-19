/**
 * Reading the numbers an article actually writes.
 *
 * Every miss here has the same shape: the article was found, fetched and
 * correctly classified, and then produced nothing, because the reward was
 * written "16K" or the threshold was written "S$800". Publication is refused
 * while a money term is unknown — correctly — so these articles cost a fetch
 * and yielded silence.
 *
 * The dangerous direction is the other one, and it is tested too: reading "16K"
 * as sixteen thousand is right for miles and catastrophic for dollars.
 */
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { extractOne, findDate, parseCompactNumber, END_PHRASES, OPEN_ENDED } from '../src/promotions/discovery/extract';
import {
  backfillClassification,
  extractionMisses,
  reclassifyItem,
  requeueForExtraction,
} from '../src/promotions/discovery/reclassify';
import { variantAudienceOf } from '../src/promotions/variants';
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
const env = { DB: { prepare: (s: string) => wrap(s) }, TZ_OFFSET_MINUTES: '480' } as unknown as Env;

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));
const one = (s: string, ...a: unknown[]) => db.prepare(s).get(...(a as any)) as any;
const all = (s: string, ...a: unknown[]) => db.prepare(s).all(...(a as any)) as any[];
Date.now = () => Date.parse('2026-09-18T04:00:00Z');

await runMigrations(env);
await runSeed(env);

const read = (text: string, title = 'Citi Rewards promotion') =>
  extractOne(text, 'https://milelion.test/a', title);

// ------------------------------------------------------------ compact numbers
check('a plain number is itself', parseCompactNumber('16000') === 16000);
check('so is one with separators', parseCompactNumber('16,000') === 16000);
check('a K suffix means thousands', parseCompactNumber('16K') === 16000);
check('lower case too', parseCompactNumber('16k') === 16000);
check('and a fraction of a thousand rounds', parseCompactNumber('16.8k') === 16800);
check('spacing does not matter', parseCompactNumber('20 k') === 20000);
check('and nonsense is null, not zero', parseCompactNumber('lots') === null);
check('an empty string is null', parseCompactNumber('') === null);

let c = read('Citi Rewards Card: earn 16K bonus miles when you spend $800 within 30 days.');
check('16K bonus miles is sixteen thousand', c.reward.miles === 16000, String(c.reward.miles));
check('not sixteen', c.reward.miles !== 16);

c = read('Get 16.8K miles with the DBS Altitude when you spend $500.');
check('16.8K miles is sixteen thousand eight hundred', c.reward.miles === 16800, String(c.reward.miles));

c = read('Earn 20k bonus points on approval.');
check('20k points is twenty thousand', c.reward.points === 20000, String(c.reward.points));

c = read('Earn 16,000 bonus miles when you spend $800.');
check('the ordinary spelling still works', c.reward.miles === 16000, String(c.reward.miles));

// The dangerous direction. A dollar figure must never be multiplied.
c = read('Spend $800 and get $150 cashback.');
check('cashback is read in cents', c.reward.cashback_cents === 15000, String(c.reward.cashback_cents));
check('and the threshold with it', c.minimum_spend_cents === 80000, String(c.minimum_spend_cents));

// ---------------------------------------------------------------- local money
c = read('Spend S$800 within 30 days to receive 16,000 bonus miles.');
check('S$800 is eight hundred dollars', c.minimum_spend_cents === 80000, String(c.minimum_spend_cents));

c = read('Minimum spend of SGD 1,500 in the first two months earns 30,000 miles.');
check('SGD 1,500 is fifteen hundred', c.minimum_spend_cents === 150000, String(c.minimum_spend_cents));

c = read('Spend S $2,000 for 40,000 miles.');
check('a space after the S is still dollars', c.minimum_spend_cents === 200000, String(c.minimum_spend_cents));

c = read('Spend $800 for 16,000 miles.');
check('and a bare dollar sign is unchanged', c.minimum_spend_cents === 80000, String(c.minimum_spend_cents));

c = read('Get S$120 cashback with a minimum spend of S$600.');
check('local money works for cashback too', c.reward.cashback_cents === 12000, String(c.reward.cashback_cents));

// ----------------------------------------------------------------- the dates
check('"apply by" names a deadline', END_PHRASES.test('apply by '));
check('so does "valid till"', END_PHRASES.test('valid till '));
check('and "applications close"', END_PHRASES.test('applications close '));
check('and "last day to apply is"', END_PHRASES.test('last day to apply is '));

c = read('Spend $800 for 16,000 miles. Apply by 30 September 2026.');
check('an application deadline is read', c.application_end === '2026-09-30', String(c.application_end));

c = read('Spend $800 for 16,000 miles. Valid till 30 Sep 2026.');
check('an abbreviated month is read', c.application_end === '2026-09-30', String(c.application_end));

c = read('Spend $800 for 16,000 miles. Applications submitted before 1 October 2026 qualify.');
check('a submission deadline is read', c.application_end === '2026-10-01', String(c.application_end));

c = read('Spend $800 for 16,000 miles. Offer ends on the 30th of September 2026.');
check('an ordinal with "of" is read', c.application_end === '2026-09-30', String(c.application_end));

c = read('Spend $800 for 16,000 miles. Ends September 30, 2026.');
check('and the American ordering too', c.application_end === '2026-09-30', String(c.application_end));

// The one that must NOT produce a date.
check('"until further notice" is recognised', OPEN_ENDED.test('valid until further notice'));
c = read('Spend $800 for 16,000 miles. This offer runs until further notice.');
check('an open-ended offer gets no end date', c.application_end === undefined, String(c.application_end));
check('and none is invented from the text', !c.source_claims.some((x) => x.field_name === 'application_end'));
check(
  'but the reason the field is empty is recorded',
  c.source_claims.some((x) => x.field_name === 'application_end_note'),
  JSON.stringify(c.source_claims.map((x) => x.field_name))
);

c = read('Spend $800 for 16,000 miles. Ends 30 September.');
check('a date with no year is still refused', c.application_end === undefined, String(c.application_end));
check('because the wrong year is worse than none', findDate('ends 30 September', END_PHRASES) === null);

c = read('Spend $800 for 16,000 miles. While stocks last.');
check('"while stocks last" is open-ended too', c.application_end === undefined);

// ------------------------------------------------------- a whole offer reads
c = read(
  'Citi Rewards Card: apply by 30 September 2026 and spend S$800 within 30 days to earn 16K bonus miles. New-to-bank customers only. Registration required.'
);
check('the reward is read', c.reward.miles === 16000, String(c.reward.miles));
check('the threshold is read', c.minimum_spend_cents === 80000, String(c.minimum_spend_cents));
check('the window is read', c.spend_window?.value === 30, JSON.stringify(c.spend_window));
check('the deadline is read', c.application_end === '2026-09-30', String(c.application_end));
// Kept in the article's own words — hyphens and all — because the sentence is
// the evidence. What it means is decided separately, by audienceOf.
check('who it is for is read', /new-to-bank/i.test(c.eligibility_text ?? ''), String(c.eligibility_text));
check('and it resolves to an audience', variantAudienceOf(c.eligibility_text ?? '') === 'new_customer', String(c.eligibility_text));
check('registration is not assumed away', c.registration_required === true);
check('and knowing all of it earns high confidence', c.extraction_confidence === 'high', c.extraction_confidence);
check('every reading carries the sentence it came from', c.source_claims.every((x) => x.supporting_excerpt.length > 0));

// ----------------------------------------------------------- reclassification
sql(`INSERT INTO discovery_sources (source_key, name, source_type, feed_url, trust_tier, scan_frequency)
     VALUES ('t','T','rss','https://t.test/feed',2,'daily')`);
const sid = one(`SELECT id FROM discovery_sources WHERE source_key='t'`).id;

sql(
  `INSERT INTO discovery_items (source_id, url, canonical_url, title, item_type, status, discovered_at)
   VALUES (?, 'https://t.test/1','https://t.test/1','Citi Rewards: 16,000 bonus miles with $800 spend','irrelevant','irrelevant','2026-09-10')`,
  sid
);
const missedId = one(`SELECT id FROM discovery_items WHERE canonical_url='https://t.test/1'`).id;

let re = (await reclassifyItem(env, missedId))!;
check('an article filed away can be judged again', re.changed === true, JSON.stringify(re));
check('and requeued to be read', re.after.status === 'new', re.after.status);
check('with the reason it changed', re.note.includes('queued to be read'), re.note);
check('and the words behind it kept', re.signals.length > 0);
check('no request was needed to do it', one(`SELECT content_hash FROM discovery_items WHERE id = ?`, missedId).content_hash === null);

re = (await reclassifyItem(env, missedId))!;
check('judging it twice reaches the same answer', re.changed === false || re.after.status === 'new');
check('and says so plainly', re.note.length > 0);
check('an article that does not exist is not invented', (await reclassifyItem(env, 999999)) === null);

// The backfill is bounded by age, not by patience.
sql(
  `INSERT INTO discovery_items (source_id, url, canonical_url, title, item_type, status, discovered_at)
   VALUES (?, 'https://t.test/old','https://t.test/old','Citi Rewards: 16,000 bonus miles with $800 spend','irrelevant','irrelevant','2025-01-01')`,
  sid
);
sql(
  `INSERT INTO discovery_items (source_id, url, canonical_url, title, item_type, status, discovered_at)
   VALUES (?, 'https://t.test/2','https://t.test/2','DBS: 20K bonus miles when you spend $500','irrelevant','irrelevant','2026-09-12')`,
  sid
);

const filled = await backfillClassification(env);
check('the backfill only looks at a recent window', filled.window_days === 90);
check('so an article from last year is left alone', one(`SELECT status FROM discovery_items WHERE canonical_url='https://t.test/old'`).status === 'irrelevant');
check('a recent miss is reconsidered', filled.considered >= 1, JSON.stringify(filled));
check('and requeued when the answer changed', filled.requeued >= 1, JSON.stringify(filled));

// Extraction misses are listed, not silently re-fetched.
sql(
  `INSERT INTO discovery_items (source_id, url, canonical_url, title, item_type, status, content_hash, extraction_note, discovered_at)
   VALUES (?, 'https://t.test/3','https://t.test/3','A roundup with no headings','roundup','processed','abc','Read as a roundup, but no card headings were found to split it on.','2026-09-15')`,
  sid
);
const misses = await extractionMisses(env);
check('an article read successfully that named no offer is listed', misses.length === 1, String(misses.length));
check('with why the extractor found nothing', misses[0].extraction_note!.includes('no card headings'), String(misses[0].extraction_note));
check('rather than disappearing silently', misses[0].url.includes('t.test/3'));

const requeued = await requeueForExtraction(env, misses[0].id);
check('re-reading one is a deliberate act', requeued.ok === true);
check('and it is queued', one(`SELECT status FROM discovery_items WHERE id = ?`, misses[0].id).status === 'new');
check(
  'with the content hash cleared so it is not skipped as unchanged',
  one(`SELECT content_hash FROM discovery_items WHERE id = ?`, misses[0].id).content_hash === null
);
check('an article that does not exist cannot be requeued', (await requeueForExtraction(env, 999999)).ok === false);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
