import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { ensureProduct, isStale, productKeyOf } from '../src/catalog/products';
import { draftRuleSet, overlaps, publishRuleSet, ruleSetOn, RuleVersionOverlap, versionsOf } from '../src/catalog/rulesets';
import { migrateCardsToProducts } from '../src/catalog/migrate-products';
import { evaluate } from '../src/rules';
import type { Card, Env } from '../src/types';

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

// ---------------------------------------------------------------------------
// A database that predates the product model, exactly as one in use would be.
// ---------------------------------------------------------------------------
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd,program_key)
     VALUES ('DBS','Woman''s World','dbs_womans_world','wwmc',800000,18,'2025-06-01',0.3,'dbs_points')`);
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('Citi','Rewards','citi_rewards','crw',500000,15,'2025-01-10',0.4)`);
const wwmc = one(`SELECT * FROM cards WHERE nickname='wwmc'`) as Card;
const crw = one(`SELECT * FROM cards WHERE nickname='crw'`) as Card;

sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type,cap_cents,cap_window) VALUES (?,'online',4,'miles',200000,'calendar_month')`, wwmc.id);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',0.3,'miles')`, wwmc.id);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'shopping',4,'miles')`, crw.id);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',0.4,'miles')`, crw.id);
sql(`INSERT INTO exclusions (card_id,mcc,reason,source,active) VALUES (?, '4900', 'utilities', 'user', 1)`, wwmc.id);

const countsBefore = {
  cards: one(`SELECT COUNT(*) AS n FROM cards`).n,
  rules: one(`SELECT COUNT(*) AS n FROM earn_rules`).n,
  txns: one(`SELECT COUNT(*) AS n FROM transactions`).n,
  reqs: one(`SELECT COUNT(*) AS n FROM requirements`).n,
};

const online = { amount_cents: 10000, category: 'online', mcc: null, channel: null as null };
const beforeMigration = await evaluate(env, wwmc, online);

// --- §58: migration must not lose anything ----------------------------------
{
  const r = await migrateCardsToProducts(env, '2026-09-18');
  check('every card gets a product', r.products_created === 2, JSON.stringify(r));
  check('and is linked to it', r.cards_linked === 2, JSON.stringify(r));
  check('each product gets a version of its rules', r.rule_sets_created === 2, JSON.stringify(r));
  check('every loose rule is attached to one', r.rules_attached === 4, JSON.stringify(r));
  check('card exclusions are versioned with them', r.exclusions_copied === 1, JSON.stringify(r));
  check('nothing is skipped without saying so', r.skipped.length === 0, JSON.stringify(r.skipped));

  check('no card is lost', one(`SELECT COUNT(*) AS n FROM cards`).n === countsBefore.cards, '');
  check('no rule is lost', one(`SELECT COUNT(*) AS n FROM earn_rules`).n === countsBefore.rules, '');
  check('no transaction is lost', one(`SELECT COUNT(*) AS n FROM transactions`).n === countsBefore.txns, '');
  check('no requirement is lost', one(`SELECT COUNT(*) AS n FROM requirements`).n === countsBefore.reqs, '');
  check('every card reference resolves', one(`SELECT COUNT(*) AS n FROM cards WHERE product_id IS NULL`).n === 0, '');
  check('every rule belongs to a version', one(`SELECT COUNT(*) AS n FROM earn_rules WHERE rule_set_id IS NULL`).n === 0, '');

  // The point of the whole phase: the same purchase, same answer.
  const after = await evaluate(env, one(`SELECT * FROM cards WHERE nickname='wwmc'`) as Card, online);
  check('the same purchase still earns the same', after.miles === beforeMigration.miles, `${beforeMigration.miles} -> ${after.miles}`);
  check('at the same rate', after.bonus_rate === beforeMigration.bonus_rate, `${beforeMigration.bonus_rate} -> ${after.bonus_rate}`);
  check('but now names the version it used', after.rule_set_id !== null, String(after.rule_set_id));

  const again = await migrateCardsToProducts(env, '2026-09-18');
  check('running it twice is a no-op', again.alreadyDone === true, JSON.stringify(again));
  check('and creates no duplicate product', one(`SELECT COUNT(*) AS n FROM card_products`).n === 2, '');
}

// --- §55: the version in force on a date ------------------------------------
const wwmcCard = () => one(`SELECT * FROM cards WHERE nickname='wwmc'`) as Card;
const product = one(`SELECT * FROM card_products WHERE product_key='dbs_womans_world'`);

{
  // The bank cuts the rate from 1 October. The old version is closed on the
  // 30th; nothing about September changes.
  const draft = await draftRuleSet(env, product.id, '2026-10-01', { notes: 'rate cut' });
  check('a new version starts as a draft', draft.status === 'draft', draft.status);
  check('a draft never applies', (await ruleSetOn(env, product.id, '2026-10-05'))?.id !== draft.id, '');

  sql(`INSERT INTO earn_rules (rule_set_id,category,mpd,reward_type) VALUES (?,'online',2,'miles')`, draft.id);
  sql(`INSERT INTO earn_rules (rule_set_id,category,mpd,reward_type) VALUES (?,'*',0.3,'miles')`, draft.id);

  const published = await publishRuleSet(env, draft.id, '2026-09-18');
  check('publishing makes it live', published.status === 'published', published.status);

  const sets = await versionsOf(env, product.id);
  const v1 = sets.find((s) => s.version === 1)!;
  check('the version it replaced is closed the day before', v1.effective_until === '2026-09-30', String(v1.effective_until));
  check('and marked superseded', v1.status === 'superseded', v1.status);
  check('only one version is left open-ended', sets.filter((s) => s.effective_until === null && s.status === 'published').length === 1, JSON.stringify(sets));

  check('30 September finds the old version', (await ruleSetOn(env, product.id, '2026-09-30'))?.version === 1, '');
  check('1 October finds the new one', (await ruleSetOn(env, product.id, '2026-10-01'))?.version === 2, '');

  // The reason any of this exists: a purchase keeps the rate it earned.
  const sept = await evaluate(env, wwmcCard(), online, { on: '2026-09-30' });
  const oct = await evaluate(env, wwmcCard(), online, { on: '2026-10-01' });
  check('a September purchase still earns 4 mpd', sept.bonus_rate === 4, String(sept.bonus_rate));
  check('an October one earns the new rate', oct.bonus_rate === 2, String(oct.bonus_rate));
  check('and each says which version it used', sept.rule_set_id !== oct.rule_set_id, `${sept.rule_set_id} / ${oct.rule_set_id}`);

  // A version that has not started yet never applies early.
  const future = await draftRuleSet(env, product.id, '2027-01-01');
  sql(`INSERT INTO earn_rules (rule_set_id,category,mpd,reward_type) VALUES (?,'online',9,'miles')`, future.id);
  await publishRuleSet(env, future.id, '2026-09-18');
  const now = await evaluate(env, wwmcCard(), online, { on: '2026-11-01' });
  check('a future version does not apply early', now.bonus_rate === 2, String(now.bonus_rate));
  const later = await evaluate(env, wwmcCard(), online, { on: '2027-02-01' });
  check('but does once it starts', later.bonus_rate === 9, String(later.bonus_rate));
}

// --- §27: overlapping published versions are refused ------------------------
{
  const citi = one(`SELECT * FROM card_products WHERE product_key='citi_rewards'`);
  const a = await draftRuleSet(env, citi.id, '2027-01-01');
  await publishRuleSet(env, a.id, '2026-09-18');

  // Starting before the version already in force would leave both covering the
  // same days, and a calculation would have to pick one silently.
  const clash = await draftRuleSet(env, citi.id, '2026-06-01');
  let thrown: unknown = null;
  try {
    await publishRuleSet(env, clash.id, '2026-09-18');
  } catch (e) {
    thrown = e;
  }
  check('an overlapping version is refused', thrown instanceof RuleVersionOverlap, String(thrown));
  check('with a code a caller can act on', (thrown as RuleVersionOverlap)?.code === 'RULE_VERSION_OVERLAP', '');
  check('naming the version it clashes with', ((thrown as RuleVersionOverlap)?.conflicts ?? []).length > 0, JSON.stringify((thrown as RuleVersionOverlap)?.conflicts));
  check('and the draft stays a draft', one(`SELECT status FROM rule_sets WHERE id = ?`, clash.id).status === 'draft', '');
  check('no product ends up with overlapping days', (await overlaps(env, citi.id)).length === 0, JSON.stringify(await overlaps(env, citi.id)));
  check('nor does the first one', (await overlaps(env, product.id)).length === 0, JSON.stringify(await overlaps(env, product.id)));
}

// --- products -------------------------------------------------------------
{
  // The key has to match what /api/card has always generated, or a card added
  // before this change would stop finding its own product.
  const appKey = (issuer: string, product: string) =>
    `${issuer}_${product}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  check(
    'a product key matches the one the app already generates',
    productKeyOf('DBS', "Woman's World") === appKey('DBS', "Woman's World"),
    `${productKeyOf('DBS', "Woman's World")} vs ${appKey('DBS', "Woman's World")}`
  );
  check('and is stable', productKeyOf('UOB', 'One Card') === 'uob_one_card', productKeyOf('UOB', 'One Card'));

  const custom = await ensureProduct(env, {
    product_key: 'my_own_card',
    issuer: 'Some Bank',
    product_name: 'A card the catalogue never heard of',
    source: 'user',
  });
  check('a card outside the catalogue is still a product', custom.source === 'user', custom.source);
  const twice = await ensureProduct(env, { product_key: 'my_own_card', issuer: 'x', product_name: 'y' });
  check('and creating it again returns the same one', twice.id === custom.id, `${custom.id} / ${twice.id}`);
  check('without overwriting what was there', twice.issuer === 'Some Bank', twice.issuer);

  // Migrated numbers were never checked against a bank document, and the
  // product says so rather than presenting itself as verified.
  check('a migrated product admits it is unverified', product.verification_status === 'migrated_unverified', product.verification_status);
  check('and reads as stale', isStale(product, '2026-09-18'), '');
  check('a verified one does not', !isStale({ ...product, verification_status: 'verified', last_verified_at: '2026-09-01' }, '2026-09-18'), '');
  check('until it ages out', isStale({ ...product, verification_status: 'verified', last_verified_at: '2025-01-01' }, '2026-09-18'), '');
}

// --- a card with no product at all still works ------------------------------
{
  sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
       VALUES ('Old','Legacy','legacy_card','old',100000,1,'2025-01-01',1)`);
  const legacy = one(`SELECT * FROM cards WHERE nickname='old'`) as Card;
  sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',1.2,'miles')`, legacy.id);
  const e = await evaluate(env, legacy, { amount_cents: 10000, category: null, mcc: null, channel: null });
  check('a card not yet on the model falls back to its own rules', e.bonus_rate === 1.2, String(e.bonus_rate));
  check('and reports no version, rather than a wrong one', e.rule_set_id === null, String(e.rule_set_id));
}

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
