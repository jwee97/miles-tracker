/**
 * Correcting what the app got wrong, and confirming what it got right.
 *
 * Both of these existed as problems the app could state and not solve. It said
 * "2 cards you hold have rates nobody has checked" and offered no way to check
 * them. It published an offer reading "Spend $4.00 → $4.00 cashback" — a $400
 * bonus entered through a field that silently meant cents — and the only
 * remedy was to reject the whole promotion and hope discovery found it again,
 * losing the tracking and the history with it.
 *
 * The unit mistake is the one worth testing hardest, because it is silent:
 * nothing about $4.00 looks like a bug rather than a bad source.
 */
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { confirmProductRates, staleProducts } from '../src/catalog/publish';
import { correctPromotion, implausible, LIMITS } from '../src/promotions/correct';
import { savePromotion } from '../src/promotions/model';
import { promotionTitle } from '../src/promotions/discovery/publish';
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
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));
const one = (s: string, ...a: unknown[]) => db.prepare(s).get(...(a as any)) as any;
const all = (s: string, ...a: unknown[]) => db.prepare(s).all(...(a as any)) as any[];
Date.now = () => Date.parse('2026-09-18T04:00:00Z');

await runMigrations(env);
await runSeed(env);

// ------------------------------------------------------- the units mistake
// $400 typed into a field that meant cents becomes $4.00, and nothing on the
// screen distinguishes that from a source that really said four dollars.
check('a four dollar cashback bonus is refused', implausible('reward_cashback_cents', 400) !== null);
check('and the message says which unit to use', (implausible('reward_cashback_cents', 400) ?? '').includes('dollars'), String(implausible('reward_cashback_cents', 400)));
check('it even guesses what was meant', (implausible('reward_cashback_cents', 400) ?? '').includes('$400'), String(implausible('reward_cashback_cents', 400)));
check('a four dollar minimum spend is refused too', implausible('minimum_spend_cents', 400) !== null);
check('a real $400 bonus passes', implausible('reward_cashback_cents', 40000) === null);
check('a real $800 threshold passes', implausible('minimum_spend_cents', 80000) === null);
check('and the other direction is caught as well', implausible('reward_cashback_cents', 900_000_000) !== null);
check('sixteen miles is not a welcome offer', implausible('reward_miles', 16) !== null);
check('sixteen thousand is', implausible('reward_miles', 16000) === null);
check('every money field has a floor', LIMITS.reward_cashback_cents.min >= 500 && LIMITS.minimum_spend_cents.min >= 500);

// ------------------------------------------------------ correcting an offer
const saved = await savePromotion(env, {
  promotion_type: 'welcome_offer',
  issuer: 'OCBC',
  title: 'OCBC INFINITY Cashback Credit Card',
  start_at: '2026-09-01',
  end_at: '2026-12-31',
  registration_required: false,
  source_url: 'https://milelion.test/ocbc',
  source_type: 'discovery',
  source_quote: 'spend $4 for $4 cashback',
  confidence: 'low',
  terms: { minimum_spend_cents: 400, reward_cashback_cents: 400 },
  status: 'published',
});
check('the wrongly-valued offer exists to be fixed', saved.ok === true, JSON.stringify(saved));
const pid = saved.id!;

let fixed = await correctPromotion(env, pid, { reward_cashback_cents: 400 });
check('correcting it to another four dollars is refused', fixed.ok === false, JSON.stringify(fixed));
check('rather than storing the same mistake again', JSON.parse(one(`SELECT terms_json FROM promotions WHERE id=?`, pid).terms_json).reward_cashback_cents === 400);

fixed = await correctPromotion(env, pid, { reward_cashback_cents: 40000, minimum_spend_cents: 500000 });
check('the real figures are accepted', fixed.ok === true, JSON.stringify(fixed));
check('both changes are reported', fixed.changed?.length === 2, JSON.stringify(fixed.changed));
const terms = JSON.parse(one(`SELECT terms_json FROM promotions WHERE id=?`, pid).terms_json);
check('and stored in cents, as the rest of the app expects', terms.reward_cashback_cents === 40000 && terms.minimum_spend_cents === 500000, JSON.stringify(terms));

check('the offer itself survives the correction', one(`SELECT status FROM promotions WHERE id=?`, pid).status === 'published');
check('with a new version rather than a silent overwrite', all(`SELECT * FROM promotion_versions WHERE promotion_id=?`, pid).length >= 1);
check('and the change recorded', all(`SELECT * FROM promotion_change_events WHERE promotion_id=?`, pid).length >= 1);

const claims = all(`SELECT * FROM promotion_claims WHERE promotion_id=? AND source_url='app://correction'`, pid);
check('the person is recorded as the source', claims.length === 2, String(claims.length));
check('at the tier an issuer would get', claims.every((c) => c.source_tier === 1));
check('so a later article cannot quietly overwrite them', claims.every((c) => c.confidence === 'high'));

const unchanged = await correctPromotion(env, pid, { reward_cashback_cents: 40000 });
check('re-submitting the same value changes nothing', unchanged.ok === true && unchanged.changed?.length === 0, JSON.stringify(unchanged));
check('and writes no second version for it', all(`SELECT * FROM promotion_versions WHERE promotion_id=?`, pid).length === 1);

check('a field nobody may edit is ignored', (await correctPromotion(env, pid, { status: 'rejected' } as any)).changed?.length === 0);
check('the offer is still published', one(`SELECT status FROM promotions WHERE id=?`, pid).status === 'published');
check('an offer that does not exist is not invented', (await correctPromotion(env, 999999, { reward_miles: 16000 })).ok === false);

// A deliberate override exists, because a bank can run a genuinely tiny offer.
const odd = await correctPromotion(env, pid, { reward_cashback_cents: 400 }, { allow_implausible: true });
check('an override exists for a genuinely small offer', odd.ok === true, JSON.stringify(odd));
await correctPromotion(env, pid, { reward_cashback_cents: 40000 }, { allow_implausible: true });

// ------------------------------------------------------------- the title
// Card names as articles write them usually carry the issuer already, so
// prefixing it produced "OCBC OCBC INFINITY Cashback Credit Card".
check('the bank is not named twice', promotionTitle('OCBC', 'OCBC INFINITY Cashback Credit Card') === 'OCBC INFINITY Cashback Credit Card');
check('but is added when the name lacks it', promotionTitle('Citi', 'Rewards Card') === 'Citi Rewards Card');
check('case does not matter', promotionTitle('DBS', 'dbs Altitude') === 'dbs Altitude');
check('a partial word is not mistaken for the bank', promotionTitle('Citi', 'Citibank Cash Back') === 'Citibank Cash Back');
check('an unrelated name keeps the prefix', promotionTitle('UOB', "Lady's Card") === "UOB Lady's Card");
check('a missing name falls back to the bank', promotionTitle('HSBC', null) === 'HSBC');
check('and a missing both to something readable', promotionTitle(null, null) === 'Promotion');

// ------------------------------------------------- confirming a card's rates
sql(`INSERT INTO cards (issuer, product, product_key, nickname, credit_limit_cents, statement_day, opened_at)
     VALUES ('Citi','Rewards','citi_rewards','citirw',500000,15,'2026-01-10')`);
const product = one(`SELECT * FROM card_products WHERE product_key = 'citi_rewards'`);
sql(`UPDATE cards SET product_id = ? WHERE nickname = 'citirw'`, product.id);
sql(`UPDATE card_products SET verification_status = 'migrated_unverified', last_verified_at = NULL WHERE id = ?`, product.id);

let before = await staleProducts(env, '2026-09-18');
check('a card nobody has checked is reported', before.some((s) => s.product.id === product.id), String(before.length));
check('with the reason in words', (before.find((s) => s.product.id === product.id)?.reason ?? '').includes('never been checked'));

// Nothing to confirm without published rules: the answer there is to enter them.
let confirmed = await confirmProductRates(env, product.id, '2026-09-18', { source_url: 'https://citibank.test/rewards' });
check('a product with no rules cannot be confirmed', confirmed.ok === false, JSON.stringify(confirmed));
check('and it says what to do instead', (confirmed.error ?? '').includes('add them first'), String(confirmed.error));

sql(`INSERT INTO rule_sets (product_id, version, status, effective_from, published_at)
     VALUES (?, 1, 'published', '2025-03-02', '2025-03-02')`, product.id);
const rsId = one(`SELECT id FROM rule_sets WHERE product_id = ? ORDER BY id DESC LIMIT 1`, product.id).id;
sql(`INSERT INTO earn_rules (rule_set_id, category, mpd, reward_type) VALUES (?, 'online', 4, 'miles')`, rsId);

confirmed = await confirmProductRates(env, product.id, '2026-09-18', { source_url: 'not a url' });
check('confirming without a link is refused', confirmed.ok === false, JSON.stringify(confirmed));
check('because the claim is about a document', (confirmed.error ?? '').includes('bank document'), String(confirmed.error));

confirmed = await confirmProductRates(env, product.id, '2026-09-18', {
  source_url: 'https://citibank.test/rewards-terms',
});
check('with the page read, the card is confirmed', confirmed.ok === true, JSON.stringify(confirmed));
check('and it says how many rules that covered', confirmed.rules_confirmed === 1, String(confirmed.rules_confirmed));
check('the product is verified', one(`SELECT verification_status FROM card_products WHERE id=?`, product.id).verification_status === 'verified');
check('and dated', one(`SELECT last_verified_at FROM card_products WHERE id=?`, product.id).last_verified_at === '2026-09-18');

const source = one(`SELECT * FROM product_sources WHERE product_id = ? ORDER BY id DESC LIMIT 1`, product.id);
check('the page read is kept, so the claim is auditable', source.source_url === 'https://citibank.test/rewards-terms');
check('marked as a person having checked it', source.source_type === 'manual_verified');
check('the rule set carries the date too', one(`SELECT verified_at FROM rule_sets WHERE id=?`, rsId).verified_at === '2026-09-18');

const after = await staleProducts(env, '2026-09-18');
check('and the warning is gone', !after.some((s) => s.product.id === product.id), JSON.stringify(after.map((s) => s.product.product_name)));

// It comes back when it should: confirmation is dated, not permanent.
const later = await staleProducts(env, '2027-09-18');
check('a confirmation goes stale again with time', later.some((s) => s.product.id === product.id));
check('saying how long ago it was checked', (later.find((s) => s.product.id === product.id)?.reason ?? '').includes('last checked'), String(later.find((s) => s.product.id === product.id)?.reason));

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
