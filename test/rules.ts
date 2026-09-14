import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { evaluate, lookupMerchant, recommend } from '../src/rules';
import { buildAudit } from '../src/audit';
import type { Card, Env } from '../src/types';

const db = new DatabaseSync(':memory:');
const wrap = (sql: string, args: unknown[] = []): any => ({
  bind: (...a: unknown[]) => wrap(sql, a),
  first: async () => db.prepare(sql).get(...(args as any)) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...(args as any)) }),
  run: async () => { const r = db.prepare(sql).run(...(args as any)); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
});
const env = {
  DB: { prepare: (s: string) => wrap(s) },
  TZ_OFFSET_MINUTES: '480', MILE_VALUE_CENTS: '1.5',
  MIN_SPEND_WARN_DAYS: '7', POSTING_LAG_DAYS: '3', OBJECTIVE: 'balanced',
} as unknown as Env;
Date.now = () => Date.parse('2026-09-11T04:00:00Z');

let fails = 0;
const check = (l: string, c: boolean, d = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`); };
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));
const card = (n: string) => db.prepare(`SELECT * FROM cards WHERE nickname = ?`).get(n) as Card;

await runMigrations(env);
await runSeed(env);

sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('UOB','UOB Lady''s','uob_lady','lady',800000,15,'2026-01-01',0.4)`);
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('DBS','DBS Woman''s World','dbs_wwmc','wwmc',800000,18,'2026-01-01',0.4)`);
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('Citi','Citi PremierMiles','citi_pm','pm',900000,20,'2026-01-01',1.4)`);
const lady = card('lady'), wwmc = card('wwmc'), pm = card('pm');

// Lady's: 4 mpd on dining, capped at $1,000 a calendar month.
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type,cap_cents,cap_window) VALUES (?,'dining',4,'miles',100000,'calendar_month')`, lady.id);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',0.4,'miles')`, lady.id);
// WWMC: 4 mpd online only, by MCC and channel.
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type,cap_cents,cap_window,mcc_include,channel)
     VALUES (?,'online',4,'miles',150000,'calendar_month','5262,5964,5969','online')`, wwmc.id);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',0.4,'miles')`, wwmc.id);
// PremierMiles: flat general spend.
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',1.4,'miles')`, pm.id);

// --- merchant to MCC --------------------------------------------------------
const dtf = await lookupMerchant(env, 'Din Tai Fung');
check('finds a seeded merchant', dtf.mcc === '5812', JSON.stringify(dtf));
check('names the code', dtf.description === 'Eating Places and Restaurants', String(dtf.description));
check('maps it to a category', dtf.category === 'dining', String(dtf.category));
check('and is honest that it is a guess', dtf.confidence === 'guess', dtf.confidence);

const partial = await lookupMerchant(env, 'Din Tai Fung Jewel');
check('matches on a longer merchant string', partial.mcc === '5812', JSON.stringify(partial));
check('an unknown merchant returns unknown', (await lookupMerchant(env, 'Zzz Nowhere')).confidence === 'unknown', '');

// A code confirmed from a statement outranks the seeded guess.
sql(`UPDATE merchant_mcc SET mcc='5814', confidence='confirmed', source='user' WHERE merchant='din tai fung'`);
const confirmed = await lookupMerchant(env, 'Din Tai Fung');
check('a confirmed code replaces the guess', confirmed.mcc === '5814' && confirmed.confidence === 'confirmed', JSON.stringify(confirmed));
sql(`UPDATE merchant_mcc SET mcc='5812', confidence='guess', source='seed' WHERE merchant='din tai fung'`);

// --- the worked example from the spec ---------------------------------------
// $850 of the $1,000 dining cap already used, then a $200 dinner.
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,category) VALUES (?,85000,'2026-09-03','dining')`, lady.id);

const dinner = await recommend(env, { amount_cents: 20000 }, { merchantQuery: 'Din Tai Fung' });
check('resolves the merchant into the purchase', dinner.purchase.mcc === '5812' && dinner.purchase.category === 'dining', JSON.stringify(dinner.purchase));
const top = dinner.picks[0];
check("Lady's wins on dining", top.card.nickname === 'lady', dinner.picks.map((p) => p.card.nickname).join(','));
check('only the remaining cap earns the bonus', top.bonus_portion_cents === 15000, `got ${top.bonus_portion_cents}`);
check('and the rest drops to the base rate', top.base_portion_cents === 5000, `got ${top.base_portion_cents}`);
// 150 at 4 mpd = 600, plus 50 at 0.4 = 20.
check('miles are blended across the cap', top.miles === 620, `got ${top.miles}`);
check('the blended rate is reported, not the headline', top.effective_rate === 3.1, `got ${top.effective_rate}`);

// The advice the spec asks for: what to do with the $50.
check('advises on the remainder', dinner.split_advice !== null, JSON.stringify(dinner.split_advice));
check('naming a card that does better on it', dinner.split_advice!.use.includes('PremierMiles'), JSON.stringify(dinner.split_advice));
check('and the split amounts', dinner.split_advice!.bonus_cents === 15000 && dinner.split_advice!.remainder_cents === 5000, '');

// --- the trace --------------------------------------------------------------
const steps = top.trace.map((s) => s.check);
check('the answer explains itself', steps.includes('Earn rule') && steps.includes('Bonus cap'), steps.join(','));
check('showing the cap state', top.trace.some((s) => /available/.test(s.detail)), JSON.stringify(top.trace));
check('and the split', top.trace.some((s) => s.check === 'Split at the cap'), JSON.stringify(top.trace));

// --- exclusions -------------------------------------------------------------
// 6300 is insurance, excluded for every card by the seed.
const ins = await recommend(env, { amount_cents: 50000, mcc: '6300' });
check('an excluded code earns nothing anywhere', ins.picks.every((p) => p.excluded), JSON.stringify(ins.picks.map((p) => [p.card.nickname, p.excluded])));
check('and says why', /excluded|commonly excluded/i.test(ins.picks[0].exclusion_reason ?? ''), String(ins.picks[0].exclusion_reason));

// A card-specific exclusion hits only that card.
sql(`INSERT INTO exclusions (card_id,mcc,reason,source) VALUES (?, '5812', 'This card excludes restaurants', 'user')`, lady.id);
const afterExcl = await recommend(env, { amount_cents: 10000, mcc: '5812', category: 'dining' });
check("a card-specific exclusion applies to that card", afterExcl.picks.find((p) => p.card.nickname === 'lady')!.excluded, '');
check('but not to the others', !afterExcl.picks.find((p) => p.card.nickname === 'pm')!.excluded, '');
sql(`DELETE FROM exclusions WHERE source='user'`);

// --- MCC and channel conditions --------------------------------------------
const shopee = await recommend(env, { amount_cents: 30000 }, { merchantQuery: 'Shopee' });
check('an online MCC picks the online card', shopee.picks[0].card.nickname === 'wwmc', shopee.picks.map((p) => p.card.nickname).join(','));

// The same category in store must not earn the online bonus.
const offline = await recommend(env, { amount_cents: 30000, category: 'online', mcc: '5651', channel: 'offline' });
const wwmcOffline = offline.picks.find((p) => p.card.nickname === 'wwmc')!;
check('an MCC outside the rule list falls back', wwmcOffline.rule?.category === '*', JSON.stringify(wwmcOffline.rule?.category));
check('and the trace says which list it missed', wwmcOffline.trace.some((s) => s.check === 'Rule MCC list' && s.pass === false), JSON.stringify(wwmcOffline.trace));

// --- objectives -------------------------------------------------------------
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('UOB','UOB One','uob_one','one',600000,10,'2026-01-01',0)`);
const one = card('one');
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',5,'cashback')`, one.id);

const balanced = await recommend(env, { amount_cents: 10000, category: 'groceries' }, { objective: 'balanced' });
check('balanced compares in dollars', balanced.picks[0].card.nickname === 'one', balanced.picks.map((p) => `${p.card.nickname}:${p.value_cents}`).join(','));
const milesFirst = await recommend(env, { amount_cents: 10000, category: 'groceries' }, { objective: 'miles' });
check('a miles objective refuses the cashback card', milesFirst.picks[0].reward_type === 'miles', milesFirst.picks[0].card.nickname);

// minspend: a card short of its minimum comes first even on a worse rate.
sql(`INSERT INTO requirements (card_id,kind,amount_cents,window) VALUES (?,'monthly_min',50000,'calendar_month')`, pm.id);
const minspend = await recommend(env, { amount_cents: 10000, category: 'groceries' }, { objective: 'minspend' });
check('minspend puts the unmet card first', minspend.picks[0].card.nickname === 'pm', minspend.picks.map((p) => p.card.nickname).join(','));
check('and the trace says how short it is', minspend.picks[0].trace.some((s) => s.check === 'Minimum spend'), '');

// --- reward audit -----------------------------------------------------------
sql(`DELETE FROM transactions`);
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,category,merchant,mcc,expected_miles)
     VALUES (?,11500,'2026-08-05','travel','Agoda','4722',460)`, pm.id);
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,category,merchant,expected_miles,actual_miles)
     VALUES (?,20000,'2026-08-06','dining','Restaurant',800,800)`, lady.id);

let audit = await buildAudit(env, { from: '2026-08-01', to: '2026-08-31' });
check('an unchecked transaction is reported as such', audit.totals.unrecorded === 1, `got ${audit.totals.unrecorded}`);
check('a matching one is checked', audit.totals.checked === 1, `got ${audit.totals.checked}`);
check('and reported as matched', audit.rows.find((r) => r.merchant === 'Restaurant')!.status === 'matched', '');

// Now record that Agoda credited nothing — the spec's example.
sql(`UPDATE transactions SET actual_miles = 0 WHERE merchant = 'Agoda'`);
audit = await buildAudit(env, { from: '2026-08-01', to: '2026-08-31' });
const agoda = audit.rows.find((r) => r.merchant === 'Agoda')!;
check('a shortfall is detected', agoda.status === 'short', agoda.status);
check('and quantified', agoda.shortfall_miles === 460, `got ${agoda.shortfall_miles}`);
check('the period total adds up', audit.totals.shortfall_miles === 460, `got ${audit.totals.shortfall_miles}`);
check('and a likely cause is offered', /excluded|cap/i.test(agoda.reason ?? ''), String(agoda.reason));
check('the findings name the gap', audit.findings.some((f) => /460 miles short/.test(f)), JSON.stringify(audit.findings));
check('and the largest offender', audit.findings.some((f) => /Agoda/.test(f)), JSON.stringify(audit.findings));

// More than expected is flagged too, not silently ignored.
sql(`UPDATE transactions SET actual_miles = 1200 WHERE merchant = 'Restaurant'`);
audit = await buildAudit(env, { from: '2026-08-01', to: '2026-08-31' });
check('over-crediting is flagged', audit.rows.find((r) => r.merchant === 'Restaurant')!.status === 'over', '');

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall passed');
process.exit(fails ? 1 : 0);
