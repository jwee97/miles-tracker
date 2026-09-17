/**
 * Catalogue operations.
 *
 * The property being tested throughout is that the only way rules a
 * calculation can reach have changed is that a person read a comparison and
 * said yes. Everything else — drafting, copying, extracting, noticing a page
 * has moved — is allowed to be automatic precisely because it cannot reach a
 * published version.
 */
import { DatabaseSync } from 'node:sqlite';
import { ensureProduct, productByKey } from '../src/catalog/products';
import { diffRuleSets, draftFromCurrent, reviewAndPublish, staleProducts } from '../src/catalog/publish';
import { ruleSetOn, rulesIn, versionsOf } from '../src/catalog/rulesets';
import { addSource, checkSource, contentHash, sourcesFor } from '../src/catalog/sources';
import { runMigrations, runSeed } from '../src/migrate';
import { evaluate } from '../src/rules';
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
  MIN_SPEND_WARN_DAYS: '7',
  POSTING_LAG_DAYS: '0',
} as unknown as Env;

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));
const one = (s: string, ...a: unknown[]) => db.prepare(s).get(...(a as any)) as any;
Date.now = () => Date.parse('2026-09-18T04:00:00Z');

await runMigrations(env);
await runSeed(env);

const product = await productByKey(env, 'dbs_womans_world');
check('the seeded catalogue is there to work on', !!product, 'no product');
check('and it arrives with no rules at all', (await versionsOf(env, product!.id)).length === 0);
check('which is a draft, not a finished product', product!.verification_status === 'draft', product?.verification_status);

// --- version one ----------------------------------------------------------
const src = await addSource(env, product!.id, {
  source_type: 'bank_rewards_terms',
  source_url: 'https://example.invalid/wwmc-terms',
  title: "Woman's World Card rewards terms",
  retrieved_at: '2026-01-05',
  content_hash: contentHash('4 mpd on online spend, capped at $1,000 a month.'),
});
check('a source can be recorded', !!src.id);

const v1 = await draftFromCurrent(env, product!.id, '2026-01-01', { source_id: src.id, today: '2026-01-01' });
check('the first version starts empty, because there is nothing to copy', v1.copied_rules === 0);
check('and it is a draft', v1.draft.status === 'draft', v1.draft.status);

sql(`INSERT INTO earn_rules (rule_set_id,category,mpd,reward_type,cap_cents,active) VALUES (?,?,?,?,?,1)`, v1.draft.id, 'online', 4, 'miles', 100000);
sql(`INSERT INTO earn_rules (rule_set_id,category,mpd,reward_type,active) VALUES (?,?,?,?,1)`, v1.draft.id, '*', 0.4, 'miles');

check('a draft is invisible to a calculation', (await ruleSetOn(env, product!.id, '2026-06-01')) === null);

const pub1 = await reviewAndPublish(env, v1.draft.id, '2026-01-05');
check('publishing makes it live', pub1.rule_set.status === 'published', pub1.rule_set.status);
check('and marks the product verified, because someone stood behind it', pub1.product!.verification_status === 'verified', pub1.product?.verification_status);
check('with the date they did', pub1.product!.last_verified_at === '2026-01-05', String(pub1.product?.last_verified_at));
check('now a calculation can see it', (await ruleSetOn(env, product!.id, '2026-06-01'))?.id === v1.draft.id);

// --- a rate change --------------------------------------------------------
const v2 = await draftFromCurrent(env, product!.id, '2026-10-01', { notes: 'October repricing', today: '2026-09-18' });
check('a new version starts from what is live', v2.copied_rules === 2, String(v2.copied_rules));
check('rather than from a blank page', (await rulesIn(env, v2.draft.id)).length === 2);
check('and says what it was based on', v2.based_on === v1.draft.id);

const online = one(`SELECT id FROM earn_rules WHERE rule_set_id = ? AND category = 'online'`, v2.draft.id);
sql(`UPDATE earn_rules SET mpd = 1.2, cap_cents = 50000 WHERE id = ?`, online.id);
sql(`INSERT INTO earn_rules (rule_set_id,category,mpd,reward_type,active) VALUES (?,?,?,?,1)`, v2.draft.id, 'dining', 3, 'miles');
sql(`INSERT INTO rule_exclusions (rule_set_id,mcc,reason) VALUES (?,?,?)`, v2.draft.id, '4900', 'utilities');

const diff = await diffRuleSets(env, v2.draft.id);
check('the comparison is against what is live', diff.from?.version === 1, JSON.stringify(diff.from));
check('a cut rate is reported', diff.rules.some((r) => r.kind === 'changed' && r.category === 'online'), JSON.stringify(diff.rules));
check(
  'in a sentence a person can check',
  diff.rules.find((r) => r.category === 'online')!.summary === 'online goes from 4 mpd, capped at $1000.00 to 1.2 mpd, capped at $500.00',
  diff.rules.find((r) => r.category === 'online')!.summary
);
check('a new category is reported as added', diff.rules.some((r) => r.kind === 'added' && r.category === 'dining'));
check('and a new exclusion too', diff.exclusions.some((e) => e.kind === 'added' && e.category === '4900'));
check('so the change is not identical to what came before', diff.identical === false);

// The old rules still apply while the draft is a draft.
const card = (() => {
  sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,product_id)
       VALUES ('DBS','Woman''s World Card','dbs_womans_world','wwmc',900000,18,'2025-01-01',?)`, product!.id);
  return one(`SELECT * FROM cards WHERE nickname = 'wwmc'`);
})();

const before = await evaluate(env, card, { amount_cents: 10000, mcc: null, category: 'online', channel: null }, { on: '2026-09-20' });
check('a draft cannot change what a card pays today', before.effective_rate === 4, String(before.effective_rate));

await reviewAndPublish(env, v2.draft.id, '2026-09-18');

const sept = await evaluate(env, card, { amount_cents: 10000, mcc: null, category: 'online', channel: null }, { on: '2026-09-20' });
check('September still earns the old rate after publishing', sept.effective_rate === 4, String(sept.effective_rate));
const oct = await evaluate(env, card, { amount_cents: 10000, mcc: null, category: 'online', channel: null }, { on: '2026-10-02' });
check('and October earns the new one', oct.effective_rate === 1.2, String(oct.effective_rate));

const closed = one(`SELECT * FROM rule_sets WHERE id = ?`, v1.draft.id);
check('the version it replaced is closed the day before', closed.effective_until === '2026-09-30', String(closed.effective_until));
check('and marked superseded rather than deleted', closed.status === 'superseded', closed.status);

// --- a published version is not editable ----------------------------------
const live = await ruleSetOn(env, product!.id, '2026-10-05');
check('the live version is version 2', live?.version === 2, String(live?.version));
let refused = false;
try {
  await reviewAndPublish(env, v1.draft.id, '2026-09-18');
} catch {
  refused = true;
}
check('republishing a superseded version is refused', refused);

// --- an overlap is refused, not resolved ----------------------------------
const clash = await draftFromCurrent(env, product!.id, '2026-11-01', { today: '2026-09-18' });
sql(`UPDATE rule_sets SET effective_until = '2026-12-31' WHERE id = ?`, clash.draft.id);
sql(`UPDATE rule_sets SET effective_until = '2027-12-31' WHERE id = ?`, live!.id);
let overlapCode = '';
try {
  await reviewAndPublish(env, clash.draft.id, '2026-09-18');
} catch (e) {
  overlapCode = (e as any).code ?? '';
}
check('two versions covering one day is refused', overlapCode === 'RULE_VERSION_OVERLAP', overlapCode);
check('and nothing was published', one(`SELECT status FROM rule_sets WHERE id = ?`, clash.draft.id).status === 'draft');

// --- a source that moved --------------------------------------------------
sql(`UPDATE card_products SET verification_status = 'verified' WHERE id = ?`, product!.id);
const same = await checkSource(env, src.id, '4 mpd on online spend,  capped at $1,000 a month. ', '2026-09-18');
check('reflowed whitespace is not a change', same!.changed === false);
check('and the product stays verified', one(`SELECT verification_status FROM card_products WHERE id = ?`, product!.id).verification_status === 'verified');

const moved = await checkSource(env, src.id, '1.2 mpd on online spend, capped at $500 a month.', '2026-09-18');
check('a real change is noticed', moved!.changed === true);
check('the product is flagged for review', one(`SELECT verification_status FROM card_products WHERE id = ?`, product!.id).verification_status === 'needs_review');
check(
  'but the live rules are untouched, because a page is not an approval',
  (await rulesIn(env, live!.id)).find((r) => r.category === 'online')!.mpd === 1.2
);

check('sources are listed with the most official first', (await sourcesFor(env, product!.id))[0].source_type === 'bank_rewards_terms');

// --- what should not be trusted -------------------------------------------
const stale = await staleProducts(env, '2026-09-18');
check('a product whose page moved is called out', stale.some((s) => s.product.id === product!.id), JSON.stringify(stale.map((s) => s.product.product_key)));
check('with the reason in words', stale.find((s) => s.product.id === product!.id)!.reason.includes('source page has changed'));
check('and who holds it', stale.find((s) => s.product.id === product!.id)!.held_by.includes('wwmc'));

// A product nobody holds is not a job, however unverified it is.
await ensureProduct(env, { product_key: 'zz_unheld', issuer: 'ZZ', product_name: 'Unheld', verification_status: 'draft' });
const stale2 = await staleProducts(env, '2026-09-18');
check('a product nobody holds is not chased', !stale2.some((s) => s.product.product_key === 'zz_unheld'));

// Age alone is enough, once nothing else is wrong.
sql(`UPDATE card_products SET verification_status = 'verified', last_verified_at = '2025-01-01' WHERE id = ?`, product!.id);
const aged = await staleProducts(env, '2026-09-18');
check('a card checked long ago is called stale', aged.find((s) => s.product.id === product!.id)!.reason.includes('last checked'));

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
