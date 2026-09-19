/**
 * Who a promotion is for, and whether this person can use it.
 *
 * The bug that prompted this file: an OCBC Rewards welcome offer, for a card
 * the person did not hold, was reported as "not applicable — it is for the
 * Rewards Card, which you do not hold." That is the correct answer for an
 * existing-cardholder offer and exactly backwards for a welcome offer, where
 * not holding the card is the precondition rather than the disqualification.
 *
 * One fact was doing the work of six: owning the card, needing to own it,
 * being able to qualify, being worth showing, being an acquisition
 * opportunity, and how sure any of that was. These tests hold those apart,
 * and most of them assert a NEGATIVE — what the app must not conclude from
 * evidence that establishes nothing.
 */
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { classifyAudience, isAcquisitionPromotion, backfillAudience, type PromotionAudience } from '../src/promotions/audience';
import { evaluatePromotionEligibility, predicatesFor } from '../src/promotions/eligibility';
import { resolvePromotionRelationship } from '../src/promotions/relationship';
import { linkApplicability, publishPromotion, savePromotion } from '../src/promotions/model';
import { rate } from '../src/promotions/relevance';
import { inbox, sectionsFor } from '../src/promotions/inbox';
import { analyseAcquisition } from '../src/promotions/acquire';
import { trackPromotion, activateWatchedPromotions } from '../src/promotions/tracking';
import { corroborate, type StoredClaim } from '../src/promotions/discovery/corroborate';
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
const all = (s: string, ...a: unknown[]) => db.prepare(s).all(...(a as any)) as any[];
Date.now = () => Date.parse('2026-09-19T04:00:00Z');

await runMigrations(env);
await runSeed(env);

const product = (key: string, issuer: string, name: string): number => {
  sql(`INSERT OR IGNORE INTO card_products (product_key, issuer, product_name, reward_type) VALUES (?,?,?,'miles')`, key, issuer, name);
  return one(`SELECT id FROM card_products WHERE product_key = ?`, key).id;
};
const ocbcRewards = product('ocbc_rewards', 'OCBC', 'Rewards Card');
const ocbcInfinity = product('ocbc_infinity', 'OCBC', 'INFINITY Cashback Card');
const uobOne = product('uob_one_x', 'UOB', 'One Card');

const holdCard = (nickname: string, issuer: string, name: string, key: string, productId: number, opened = '2024-01-01', closed: string | null = null) => {
  sql(
    `INSERT INTO cards (issuer, product, product_key, nickname, credit_limit_cents, statement_day, opened_at, closed_at, product_id)
     VALUES (?,?,?,?,500000,15,?,?,?)`,
    issuer,
    name,
    key,
    nickname,
    opened,
    closed,
    productId
  );
  return one(`SELECT id FROM cards WHERE nickname = ?`, nickname).id;
};

const makePromotion = async (opts: {
  title: string;
  type?: string;
  issuer?: string;
  audience?: PromotionAudience;
  products?: string[];
  programmes?: string[];
  terms?: Record<string, unknown>;
  end_at?: string | null;
}) => {
  const saved = await savePromotion(env, {
    promotion_type: (opts.type ?? 'welcome_offer') as any,
    issuer: opts.issuer ?? 'OCBC',
    title: opts.title,
    end_at: opts.end_at === undefined ? '2026-12-31' : opts.end_at,
    registration_required: false,
    terms: { reward_miles: 20000, minimum_spend_cents: 80000, window_days: 60, ...(opts.terms ?? {}), ...(opts.audience ? { audience: opts.audience } : {}) },
    status: 'draft',
  });
  if (!saved.ok || !saved.id) throw new Error(saved.error ?? 'could not save');
  if (opts.products?.length) await linkApplicability(env, saved.id, { product_keys: opts.products });
  if (opts.programmes?.length) await linkApplicability(env, saved.id, { programmes: opts.programmes.map((key) => ({ key })) });
  await publishPromotion(env, saved.id);
  return one(`SELECT * FROM promotions WHERE id = ?`, saved.id);
};

// ============================ TEST 19 — audience extraction =================
check('"new-to-bank customers" is read as new-to-bank', classifyAudience('New-to-bank customers only.').type === 'new_to_bank');
check('"existing cardmembers" is read as existing', classifyAudience('For existing cardmembers of the bank.').type === 'existing_cardholder', classifyAudience('For existing cardmembers of the bank.').type);
check('"selected cardmembers" is read as targeted', classifyAudience('Selected cardmembers only.').type === 'targeted');
check('"new cardmembers" is a new applicant', classifyAudience('New cardmembers who apply by 30 September.').type === 'new_applicant');
check('"apply for the card" is too', classifyAudience('Apply for the OCBC Rewards Card today.').type === 'new_applicant');
check('"existing OCBC Rewards cardmembers" names a product', classifyAudience('Existing OCBC Rewards cardmembers receive $20.').type === 'specific_product_holder', classifyAudience('Existing OCBC Rewards cardmembers receive $20.').type);
check('"all cardholders" is issuer-wide', classifyAudience('All OCBC cardholders enjoy this.').type === 'issuer_cardholder', classifyAudience('All OCBC cardholders enjoy this.').type);

// ============ TEST 13 — silence is not evidence of openness =================
// This is the rule the whole redesign turns on.
check('no restriction found is unknown, not public', classifyAudience('Terms and conditions apply.').type === 'unknown');
check('and an empty sentence is unknown', classifyAudience('').type === 'unknown');
check('and nothing in the app ever infers public from silence', classifyAudience('Spend $800 and get 20,000 miles.').type === 'unknown');
check('public needs positive evidence', classifyAudience('This offer is open to all customers.').type === 'public');
check('the raw wording is always kept', (classifyAudience('New-to-bank customers only.').raw_text ?? '').includes('New-to-bank'));

// ============================ acquisition detection =========================
check('a welcome offer is an acquisition offer', isAcquisitionPromotion({ promotion_type: 'welcome_offer' }, null));
check('so is a spend bonus restricted to new applicants', isAcquisitionPromotion({ promotion_type: 'spend_bonus' }, { type: 'new_applicant' }));
check('a welcome offer for existing holders is not', !isAcquisitionPromotion({ promotion_type: 'welcome_offer' }, { type: 'specific_product_holder' }));
check('and neither is a targeted one', !isAcquisitionPromotion({ promotion_type: 'welcome_offer' }, { type: 'targeted' }));
check('an ordinary merchant offer is not', !isAcquisitionPromotion({ promotion_type: 'merchant_offer' }, { type: 'public' }));

// ======================== TEST 1 + §26 — the reported bug ===================
const welcome = await makePromotion({
  title: 'OCBC Rewards welcome offer',
  type: 'welcome_offer',
  audience: { type: 'new_applicant', confidence: 'high', raw_text: 'New cardmembers who apply by 30 September.' },
  products: ['ocbc_rewards'],
});
let r = await rate(env, welcome);

check('a welcome offer for a card you do not hold is an acquisition opportunity', r.relationship === 'acquisition_opportunity', r.relationship);
check('it is not dismissed as irrelevant', r.relevance !== 'not_relevant', r.relevance);
check('nor ruled ineligible without a rule saying so', r.eligibility.status !== 'ineligible', r.eligibility.status);
check('the card being offered is named', r.acquisition_product?.product_id === ocbcRewards, JSON.stringify(r.acquisition_product));
check('and the reason says it is for new applicants', r.why.some((w) => w.includes('new applicants')), JSON.stringify(r.why));

// The exact sentence the bug produced, which must never appear again.
check(
  'the old rejection sentence is gone',
  ![...r.why, ...r.blockers].some((x) => /which you do not hold\.$/.test(x)),
  JSON.stringify(r.blockers)
);
check('and nothing says it is not applicable', r.relevance !== ('not_applicable' as never));

// ================== TEST 2/3 — existing-cardholder offers ===================
const existingOnly = await makePromotion({
  title: 'OCBC Rewards cardholder spend bonus',
  type: 'spend_bonus',
  audience: { type: 'specific_product_holder', confidence: 'high', raw_text: 'Existing OCBC Rewards cardmembers spend $500 and receive $20 cashback.' },
  products: ['ocbc_rewards'],
  terms: { reward_cashback_cents: 2000, minimum_spend_cents: 50000 },
});
r = await rate(env, existingOnly);
check('an existing-cardholder offer you cannot use is not relevant', r.relationship === 'not_relevant', r.relationship);
check('and that is an eligibility failure, computed', r.eligibility.status === 'ineligible', r.eligibility.status);
check('with the requirement named', r.eligibility.failed.some((f) => f.includes('Rewards Card')), JSON.stringify(r.eligibility.failed));
check('so relevance follows', r.relevance === 'not_relevant', r.relevance);
check('and the wording explains the requirement, not just the absence', r.blockers.some((b) => b.includes('only for existing')), JSON.stringify(r.blockers));

// TEST 3 — the same offer, now held.
holdCard('ocbcrw', 'OCBC', 'Rewards Card', 'ocbc_rewards', ocbcRewards);
r = await rate(env, existingOnly);
check('holding the card makes it a held-card offer', r.relationship === 'held_card', r.relationship);
check('and it is no longer ineligible', r.eligibility.status !== 'ineligible', r.eligibility.status);

// The welcome offer for a card now held is a held-card offer, not an
// acquisition one: you cannot acquire what you have.
r = await rate(env, welcome);
check('a welcome offer for a card you now hold is not an acquisition offer', r.relationship === 'held_card', r.relationship);

// ==================== TEST 4/5 — new-to-bank arithmetic =====================
const cards = (): Card[] => all(`SELECT * FROM cards`) as Card[];

const newToBank: PromotionAudience = { type: 'new_to_bank', issuer: 'UOB', confidence: 'high', exclusion_months: null, raw_text: 'New-to-bank customers only.' };
let elig = evaluatePromotionEligibility({
  env,
  audience: newToBank,
  relationship: 'acquisition_opportunity',
  linkedProducts: [{ product_id: uobOne, product_name: 'One Card', issuer: 'UOB' }],
  productKeys: ['uob_one_x'],
  issuer: 'UOB',
  cards: cards(),
});
check('no card from that bank means new-to-bank passes', elig.status !== 'ineligible', elig.status);
check('with the check named', elig.confirmed.some((c) => c.includes('UOB')), JSON.stringify(elig.confirmed));

// TEST 5 — a card closed inside the exclusion window.
holdCard('uobold', 'UOB', 'Old Card', 'uob_old', uobOne, '2023-01-01', '2026-05-19');
elig = evaluatePromotionEligibility({
  env,
  audience: { ...newToBank, exclusion_months: 12 },
  relationship: 'acquisition_opportunity',
  linkedProducts: [{ product_id: uobOne, product_name: 'One Card', issuer: 'UOB' }],
  productKeys: ['uob_one_x'],
  issuer: 'UOB',
  cards: cards(),
});
check('a card closed four months ago fails a 12-month rule', elig.status === 'ineligible', elig.status);
check('and the reason identifies the window', elig.failed.some((f) => f.includes('12 months')), JSON.stringify(elig.failed));
check('naming when they become eligible', elig.failed.some((f) => f.includes('Eligible from')), JSON.stringify(elig.failed));

check('a stated window becomes a window predicate', predicatesFor({ type: 'new_to_bank', issuer: 'UOB', exclusion_months: 12 }, { issuer: 'UOB', productKeys: [] })[0].type === 'no_issuer_card_within_months');
check('and no stated window means never held, not a guessed window', predicatesFor({ type: 'new_to_bank', issuer: 'UOB' }, { issuer: 'UOB', productKeys: [] })[0].type === 'new_to_bank');

// ============================ TEST 6 — targeted =============================
const targeted = await makePromotion({
  title: 'Selected cardmembers bonus',
  type: 'cardholder_offer',
  audience: { type: 'targeted', confidence: 'high', raw_text: 'Selected cardmembers only.' },
  products: ['ocbc_infinity'],
});
r = await rate(env, targeted);
check('a targeted offer is its own relationship', r.relationship === 'targeted_offer', r.relationship);
check('and eligibility is not assumed', r.eligibility.status === 'needs_review', r.eligibility.status);
check('because an invitation cannot be computed', r.eligibility.unresolved.some((u) => u.includes('cannot be checked')), JSON.stringify(r.eligibility.unresolved));
check('the person is asked to confirm', r.blockers.some((b) => b.includes('Confirm you received it')), JSON.stringify(r.blockers));

// ========================= TEST 7/8 — transfer offers =======================
sql(`INSERT OR IGNORE INTO programs (key, name, kind, unit) VALUES ('kf','KrisFlyer','airline','miles')`);
sql(`INSERT OR IGNORE INTO programs (key, name, kind, unit) VALUES ('ocbc_pts','OCBC Points','bank','points')`);
const transfer = await makePromotion({
  title: '20% KrisFlyer transfer bonus',
  type: 'transfer_bonus',
  programmes: ['ocbc_pts'],
  terms: { bonus_pct: 20, reward_miles: undefined, minimum_spend_cents: undefined },
  audience: { type: 'public', confidence: 'low', raw_text: null },
});

sql(`INSERT INTO balance_tranches (program_key, points, earned_at, source) VALUES ('ocbc_pts', 50000, '2026-06-01', 'manual')`);
r = await rate(env, transfer);
check('a transfer offer is a programme offer', r.relationship === 'programme_offer', r.relationship);
check('with a balance it ranks worth showing', ['high', 'medium'].includes(r.relevance), r.relevance);
check('and it is never treated as a card-ownership offer', r.relationship !== ('held_card' as never));

sql(`DELETE FROM balance_tranches`);
r = await rate(env, transfer);
check('with no balance it is still a programme offer', r.relationship === 'programme_offer', r.relationship);
check('ranked low rather than removed', r.relevance === 'low', r.relevance);
check('and an empty balance is NOT ineligibility', r.eligibility.status !== 'ineligible', r.eligibility.status);

// ===================== TEST 9 — unknown audience ============================
const unknownAudience = await makePromotion({
  title: 'OCBC INFINITY offer of some kind',
  type: 'spend_bonus',
  products: ['ocbc_infinity'],
  terms: { reward_cashback_cents: 40000, minimum_spend_cents: 500000 },
});
r = await rate(env, unknownAudience);
check('a linked card with no established audience is unknown', r.relationship === 'unknown', r.relationship);
check('NOT not-relevant', r.relationship !== 'not_relevant');
check('eligibility says it needs a look', ['unknown', 'needs_review'].includes(r.eligibility.status), r.eligibility.status);
check('it is still shown, at low relevance', r.relevance === 'low', r.relevance);
check('never automatically high', r.relevance !== 'high');
check(
  'and the wording says what could not be determined',
  r.blockers.some((b) => b.includes('could not determine whether it is for existing cardholders or new applicants')),
  JSON.stringify(r.blockers)
);

// ===================== TEST 10/11 — issuer-wide offers ======================
const issuerWide = await makePromotion({
  title: 'All OCBC cardholders dining offer',
  type: 'merchant_offer',
  issuer: 'OCBC',
  audience: { type: 'issuer_cardholder', confidence: 'medium', raw_text: 'All OCBC cardholders enjoy 10% off.' },
  terms: { reward_pct: 10, minimum_spend_cents: undefined, reward_miles: undefined },
});
r = await rate(env, issuerWide);
check('holding any card from the issuer makes it an issuer offer', r.relationship === 'issuer_offer', r.relationship);

const uobWide = await makePromotion({
  title: 'All Maybank cardholders offer',
  type: 'merchant_offer',
  issuer: 'Maybank',
  audience: { type: 'issuer_cardholder', confidence: 'medium', raw_text: 'All Maybank cardholders.' },
  terms: { reward_pct: 10, minimum_spend_cents: undefined, reward_miles: undefined },
});
r = await rate(env, uobWide);
check('holding none from that issuer makes it not relevant', r.relationship === 'not_relevant', r.relationship);
check('and ineligible, with the reason', r.eligibility.status === 'ineligible' && r.blockers.some((b) => b.includes('Maybank')), JSON.stringify(r.blockers));

// ======================== TEST 12 — public offer ============================
const publicOffer = await makePromotion({
  title: 'Anyone can use this at FairPrice',
  type: 'merchant_offer',
  issuer: null as unknown as string,
  audience: { type: 'public', confidence: 'medium', raw_text: 'Open to all customers.' },
  terms: { reward_pct: 5, minimum_spend_cents: undefined, reward_miles: undefined },
});
r = await rate(env, publicOffer);
check('an offer with no ownership requirement is a general offer', r.relationship === 'general_offer', r.relationship);
check('and it does not claim to apply to any cardholder', !r.why.some((w) => w.includes('applies to any cardholder')), JSON.stringify(r.why));
check(
  'it says what was checked instead',
  r.why.some((w) => w.includes('No card-specific ownership requirement was identified')),
  JSON.stringify(r.why)
);

// ===================== TEST 14/15 — the inbox sections ======================
const box = await inbox(env);
check('the acquisition section exists', Array.isArray(box.acquisition));
check('a welcome offer for a card you lack appears in it', true); // asserted below on a fresh product

const freshWelcome = await makePromotion({
  title: 'UOB One welcome offer',
  type: 'welcome_offer',
  issuer: 'UOB',
  audience: { type: 'new_applicant', confidence: 'high', raw_text: 'New cardmembers.' },
  products: ['uob_one_x'],
});
const box2 = await inbox(env);
const inAcq = box2.acquisition.some((x) => x.promotion.id === freshWelcome.id);
check('a new-card offer lands in the acquisition section', inAcq, box2.acquisition.map((x) => x.promotion.title).join(' | '));
check('and is not buried under Everything alone', inAcq && box2.everything.some((x) => x.promotion.id === freshWelcome.id));

const acqIds = box2.acquisition.map((x) => x.promotion.id);
check('an existing-cardholder-only offer never appears there', !acqIds.includes(existingOnly.id), JSON.stringify(acqIds));
check('nor does a targeted one', !acqIds.includes(targeted.id));
check('nor a transfer bonus', !acqIds.includes(transfer.id));
check('your_cards holds the ones you actually hold', box2.your_cards.every((x) => x.relationship === 'held_card' || x.relationship === 'issuer_offer'));
check('transfers holds only programme transfer offers', box2.transfers.every((x) => x.relationship === 'programme_offer'));

// ===================== TEST 18 — expired stays auditable ====================
const expired = await makePromotion({
  title: 'Expired welcome offer',
  type: 'welcome_offer',
  issuer: 'HSBC',
  audience: { type: 'new_applicant', confidence: 'high', raw_text: 'New cardmembers.' },
  end_at: '2026-01-01',
});
r = await rate(env, expired);
check('an expired acquisition offer is not relevant', r.relevance === 'not_relevant', r.relevance);
const box3 = await inbox(env);
check('but it remains in Everything for history', box3.everything.some((x) => x.promotion.id === expired.id));
check('and out of the acquisition section', !box3.acquisition.some((x) => x.promotion.id === expired.id));
check('the promotion row itself is untouched', !!one(`SELECT id FROM promotions WHERE id = ?`, expired.id));

// ===================== TEST 16/17 — the acquisition analysis ================
const analysis = await analyseAcquisition(env, { product_id: uobOne, promotion_id: freshWelcome.id });
check('analysis accepts a card and an offer together', !('error' in analysis));
if (!('error' in analysis)) {
  check('it carries the card', analysis.product.product_id === uobOne);
  check('and the offer that prompted it', analysis.promotion?.id === freshWelcome.id, JSON.stringify(analysis.promotion));
  check('the one-off value is reported apart from the annual one', analysis.value.welcome_once_cents > 0, JSON.stringify(analysis.value));
  check(
    'the annual figure excludes it',
    analysis.value.after_offer_annual_cents === analysis.value.ongoing_annual_cents,
    JSON.stringify(analysis.value)
  );
  check(
    'and the first year is the two added, stated as a year rather than a rate',
    analysis.value.first_year_cents === analysis.value.ongoing_annual_cents + analysis.value.welcome_once_cents
  );
  check('it says so out loud', analysis.notes.some((n) => n.includes('does not repeat')), JSON.stringify(analysis.notes));
  check('the offer expiry is visible', analysis.promotion?.end_at !== undefined);
  check('and eligibility is the promotion’s own, not a second opinion', analysis.eligibility !== null);
}
check('a card that does not exist is refused', 'error' in (await analyseAcquisition(env, { product_id: 999999 })));

// ===================== TEST 20 — conflicting audience claims ================
const claim = (value: string, url: string, tier: number): StoredClaim =>
  ({
    field_name: 'audience_type',
    value_json: JSON.stringify(value),
    source_url: url,
    source_type: 'article',
    source_tier: tier,
    confidence: 'medium',
    supporting_excerpt: value,
  }) as unknown as StoredClaim;

const conflict = corroborate([claim('new_applicant', 'https://a.test/x', 2), claim('existing_cardholder', 'https://b.test/y', 2)]);
check('two sources disagreeing about the audience is a conflict', conflict.conflicts.length > 0, JSON.stringify(conflict.conflicts));
check('named as the audience field', conflict.conflicts.some((c) => c.includes('audience_type')), JSON.stringify(conflict.conflicts));
check('and it is not published on that evidence', conflict.verification_state === 'conflicting', conflict.verification_state);

const agreed = corroborate([claim('new_to_bank', 'https://a.test/x', 2), claim('new_to_bank', 'https://b.test/y', 2)]);
check('two sources agreeing raises confidence', agreed.conflicts.length === 0 && agreed.independent_sources >= 2, JSON.stringify(agreed));

// ===================== §29 — tracking an acquisition offer ==================
const tracked = await trackPromotion(env, freshWelcome.id);
check('an acquisition offer can be saved', tracked.ok === true, JSON.stringify(tracked));
check('and it says spend is not being counted yet', (tracked.summary ?? '').includes('once you add the card'), String(tracked.summary));
check('no requirement is invented', all(`SELECT * FROM requirements WHERE promotion_id = ?`, freshWelcome.id).length === 0);
check('it is watched rather than tracked', one(`SELECT status FROM promotion_tracking WHERE promotion_id = ?`, freshWelcome.id).status === 'watching');

const uobCardId = holdCard('uobone', 'UOB', 'One Card', 'uob_one_x', uobOne, '2026-09-19');
const activated = await activateWatchedPromotions(env, uobCardId);
check('adding the card activates the saved offer', activated.activated === 1, JSON.stringify(activated));
check('and only then is a requirement created', all(`SELECT * FROM requirements WHERE promotion_id = ?`, freshWelcome.id).length === 1);
check('on the right card', one(`SELECT card_id FROM requirements WHERE promotion_id = ?`, freshWelcome.id).card_id === uobCardId);
check('with the tracking now measuring', one(`SELECT status FROM promotion_tracking WHERE promotion_id = ?`, freshWelcome.id).status === 'tracked');

// ===================== §20 — migration stays conservative ===================
check('a welcome offer can be inferred as new-applicant', backfillAudience('welcome_offer').type === 'new_applicant');
check('a transfer bonus is about points, not ownership', backfillAudience('transfer_bonus').type === 'public');
check('a spend bonus is left unknown rather than guessed', backfillAudience('spend_bonus').type === 'unknown');
check('and so is a cardholder offer', backfillAudience('cardholder_offer').type === 'unknown');
check('nothing in the backfill marks an unknown promotion public', backfillAudience('merchant_offer').type !== 'public');

const backfilled = all(`SELECT audience_type FROM promotions`);
check('every promotion has an audience recorded', backfilled.every((b) => typeof b.audience_type === 'string'));
check('and none defaulted to public without evidence', one(`SELECT COUNT(*) AS n FROM promotions WHERE audience_type = 'public' AND terms_json NOT LIKE '%audience%'`).n === 0);

// ===================== relationship resolver, directly ======================
// Asserted at the unit level too, because the resolver is the single place
// this question is answered and a regression here is a regression everywhere.
const base = {
  terms: {},
  linkedProgrammes: [],
  userProgrammes: [],
  userCards: [] as Card[],
};
check(
  'a product link alone never implies you must own it',
  resolvePromotionRelationship({
    ...base,
    promotion: { promotion_type: 'welcome_offer', issuer: 'DBS' },
    audience: { type: 'new_applicant' },
    linkedProducts: [{ product_id: 1, product_name: 'Altitude', issuer: 'DBS' }],
  }).relationship === 'acquisition_opportunity'
);
check(
  'and the same link with an ownership audience does',
  resolvePromotionRelationship({
    ...base,
    promotion: { promotion_type: 'spend_bonus', issuer: 'DBS' },
    audience: { type: 'specific_product_holder' },
    linkedProducts: [{ product_id: 1, product_name: 'Altitude', issuer: 'DBS' }],
  }).relationship === 'not_relevant'
);

// ===================== §27 — nothing issuer-specific ========================
for (const issuer of ['DBS', 'UOB', 'Citi', 'OCBC', 'HSBC', 'Standard Chartered', 'Maybank', 'American Express']) {
  const res = resolvePromotionRelationship({
    ...base,
    promotion: { promotion_type: 'welcome_offer', issuer },
    audience: { type: 'new_applicant' },
    linkedProducts: [{ product_id: 1, product_name: `${issuer} Card`, issuer }],
  });
  check(`${issuer} behaves the same as every other issuer`, res.relationship === 'acquisition_opportunity', res.relationship);
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
