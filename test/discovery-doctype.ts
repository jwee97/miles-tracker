/**
 * Telling a card review apart from a promotion.
 *
 * The bug these exist for, in full: "DBS Chromo Card Review: Up to 5% Cashback
 * or 1.3 Miles per Dollar" was published as a transfer bonus paying 1.3 miles,
 * with a $150 cashback reward taken from the card's monthly cap and a bonus
 * percentage taken from a rate. Every number was real and every one of them
 * described what the card always does.
 *
 * So the tests here are mostly about what must NOT happen. A promotion missed
 * is a discovery that may come again; a card's earn rate published as an offer
 * is a wrong number in the rules engine that nobody thinks to question.
 */
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { classifyDocument } from '../src/promotions/discovery/document-type';
import { maskCardFeatures, isCardFeature, implausibleReward } from '../src/promotions/discovery/features';
import { promotionEvidence, validateTransferBonus } from '../src/promotions/discovery/evidence';
import { extractDocument, extractOne } from '../src/promotions/discovery/extract';
import {
  rejectCandidate,
  retypeCandidate,
  unmatchedProducts,
  reviewQueue,
  NOT_A_PROMOTION_REASON,
} from '../src/promotions/discovery/review';
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
  DB: { prepare: (s: string) => wrap(s), batch: async (ss: any[]) => Promise.all(ss.map((x) => x.all())) },
  TZ_OFFSET_MINUTES: '480',
  MILE_VALUE_CENTS: '1.5',
} as unknown as Env;
Date.now = () => Date.parse('2026-09-27T04:00:00Z');

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));

await runMigrations(env);
await runSeed(env);

// --- the article that started it --------------------------------------------

const CHROMO_TITLE = 'DBS Chromo Card Review: Up to 5% Cashback or 1.3 Miles per Dollar';
const CHROMO_BODY = `The DBS Chromo Card lets you choose between up to 5% cashback or 1.3 miles per
dollar on local spending. The monthly cashback cap is $150. Overseas spend earns 1.3 mpd.
The annual fee is $196.80, waived for the first year. Income requirement is $30,000.`;

// TEST 1 — it is a card review, and no transfer bonus comes out of it.
const doc = classifyDocument(CHROMO_TITLE, CHROMO_BODY);
check('a card review is read as a card review', doc.document_type === 'card_review', doc.document_type);
check('confidently', doc.confidence === 'high', doc.confidence);
check('naming what decided it', doc.signals.length > 0, JSON.stringify(doc.signals));

const chromo = extractDocument({ url: 'https://x.invalid/chromo', title: CHROMO_TITLE, text: CHROMO_BODY });
check('and produces no promotion at all', chromo.candidates.length === 0, JSON.stringify(chromo.candidates));
check(
  'specifically not a transfer bonus from "1.3 miles per dollar"',
  !chromo.candidates.some((c) => c.promotion_type === 'transfer_bonus') &&
    !chromo.rejected.some((c) => c.promotion_type === 'transfer_bonus'),
  JSON.stringify(chromo.rejected.map((c) => c.promotion_type))
);
check('and says why it produced nothing', (chromo.rejected[0]?.rejected_because ?? []).length > 0, '');
check(
  'in words naming the document, not a shrug',
  /card review/.test((chromo.rejected[0]?.rejected_because ?? []).join(' ')),
  (chromo.rejected[0]?.rejected_because ?? []).join(' ')
);

// The three numbers that became an offer, each set aside for a stated reason.
const set = chromo.rejected[0]?.masked_features ?? [];
// Whitespace-tolerant: the phrase wraps across a line in the article, which is
// exactly why the masker matches on a pattern rather than a fixed string.
check('the earn rate is set aside', set.some((m) => /1\.3\s+miles\s+per\s+dollar/i.test(m)), JSON.stringify(set));
check('the cashback rate too', set.some((m) => /5%\s*cashback/i.test(m)), JSON.stringify(set));
check('and the monthly cap, which is a ceiling and not a reward', set.some((m) => /cap/i.test(m) && /150/.test(m)), JSON.stringify(set));
check('so no reward was read at all', Object.keys(chromo.rejected[0]?.reward ?? {}).length === 0, JSON.stringify(chromo.rejected[0]?.reward));

// TEST 2 — the bare rate, on its own, is not an offer.
const bare = extractOne('Earn 1.3 mpd on all your spending.', 'https://x.invalid/a', 'Card earns miles');
check('"earn 1.3 mpd" yields no reward', !bare.reward.miles, String(bare.reward.miles));
check('and no promotion type', bare.promotion_type === null, String(bare.promotion_type));
check('and is refused as a candidate', (bare.rejected_because ?? []).length > 0, '');

// TEST 5 — the same in the words the spec used.
const perDollar = extractDocument({
  url: 'https://x.invalid/b',
  title: 'Earn miles on everything',
  text: 'Earn 1.3 miles per dollar.',
});
check('"1.3 miles per dollar" is not a transfer bonus', !perDollar.candidates.some((c) => c.promotion_type === 'transfer_bonus'), '');
check('and yields no candidate', perDollar.candidates.length === 0, '');

// TEST 3 — a review that DOES carry an offer still yields it.
const withOffer = extractDocument({
  url: 'https://x.invalid/chromo',
  title: CHROMO_TITLE,
  text: `${CHROMO_BODY}\nApply by 31 Oct and spend $500 within 60 days to receive $288 cashback.`,
});
check('a review carrying a real offer still yields one', withOffer.candidates.length === 1, JSON.stringify(withOffer.rejected.map((r) => r.rejected_because)));
const offer = withOffer.candidates[0];
check('typed as a welcome offer', offer?.promotion_type === 'welcome_offer', String(offer?.promotion_type));
check('with the minimum spend', offer?.minimum_spend_cents === 50000, String(offer?.minimum_spend_cents));
check('the window', offer?.spend_window?.type === 'days_from_approval' && offer.spend_window.value === 60, JSON.stringify(offer?.spend_window));
check('and the cashback it actually pays', offer?.reward.cashback_cents === 28800, String(offer?.reward.cashback_cents));
check('while the card’s own rate stays out of it', !offer?.reward.miles, String(offer?.reward.miles));
check('and the $150 cap is not mistaken for the reward', offer?.reward.cashback_cents !== 15000, String(offer?.reward.cashback_cents));
check('the document is still a card review', withOffer.document_type === 'card_review', withOffer.document_type);

// TEST 4 — a real transfer bonus.
const transfer = extractDocument({
  url: 'https://x.invalid/t',
  title: 'Transfer DBS Points to KrisFlyer with a 20% bonus',
  text: 'Transfer DBS Points to KrisFlyer and receive 20% bonus miles until 31 Oct 2026.',
});
check('a real transfer bonus is read as one', transfer.candidates[0]?.promotion_type === 'transfer_bonus', String(transfer.candidates[0]?.promotion_type));
check('and the article as a transfer article', transfer.document_type === 'transfer_article', transfer.document_type);
check('carrying the bonus percentage', transfer.candidates[0]?.reward.bonus_pct === 20, String(transfer.candidates[0]?.reward.bonus_pct));

// --- the pieces, directly ----------------------------------------------------

const v1 = validateTransferBonus('Transfer DBS Points to KrisFlyer and receive 20% bonus miles until 31 Oct.');
check('transfer validation passes a real one', v1.ok, JSON.stringify(v1.missing));
check('and names the programmes it found', v1.programmes.length >= 1, JSON.stringify(v1.programmes));

const v2 = validateTransferBonus('The DBS Chromo earns 1.3 miles per dollar.');
check('and refuses one that is only about miles', !v2.ok, '');
check('saying what was missing', v2.missing.length >= 2, JSON.stringify(v2.missing));

const v3 = validateTransferBonus('Transfer DBS Points to KrisFlyer. Standard conversion applies.');
check('a transfer with no bonus is not a transfer BONUS', !v3.ok, JSON.stringify(v3.missing));
check('because nothing extra is paid', v3.missing.some((m) => /bonus/.test(m)), JSON.stringify(v3.missing));

const e1 = promotionEvidence('Spend $500 within 60 days and receive $288 cashback. Apply by 31 Oct.');
check('an offer has condition and reward', e1.conditional && e1.incremental, JSON.stringify(e1));
check('and is temporary', e1.temporary, '');
check('so it clears even the review bar', e1.sufficient_for_review, JSON.stringify(e1.reasons));

const e2 = promotionEvidence('Earn 1.3 miles per dollar on all spending, with no cap.');
check('a standing rate clears nothing', !e2.sufficient && !e2.sufficient_for_review, JSON.stringify(e2));
check('and says why', e2.reasons.length > 0, JSON.stringify(e2.reasons));

check('a rate is recognised as a card feature', isCardFeature('1.3 miles per dollar'), '');
check('a cap too', isCardFeature('monthly cashback cap of $150'), '');
check('a bonus is not', !isCardFeature('receive 10,000 bonus miles'), '');
check('masking keeps the offsets, so quotes still line up', maskCardFeatures('a 1.3 mpd b').text.length === 'a 1.3 mpd b'.length, '');
check('a bonus of 1.3 miles is implausible', implausibleReward('miles', 1.3), '');
check('a bonus of 10,000 is not', !implausibleReward('miles', 10000), '');

// --- what a reviewer can say -------------------------------------------------

sql(
  `INSERT INTO discovery_items (url, canonical_url, title, status, item_type, document_type)
   VALUES ('https://x.invalid/chromo', 'https://x.invalid/chromo', ?, 'processed', 'promotion_related', 'promotion')`,
  CHROMO_TITLE
);
const itemId = (db.prepare(`SELECT id FROM discovery_items`).get() as any).id;
sql(
  `INSERT INTO promotion_candidates (discovery_id, promotion_type, issuer, raw_product_name, status, terms_json)
   VALUES (?, 'transfer_bonus', 'DBS', 'DBS Chromo Card', 'review', '{"reward_miles":1.3}')`,
  itemId
);
const candId = (db.prepare(`SELECT id FROM promotion_candidates`).get() as any).id;

const queued = await reviewQueue(env);
check('the queue shows what the article was read as', queued[0]?.document_type === 'promotion', String(queued[0]?.document_type));
check('and that the card is not in the catalogue', queued[0]?.unmatched_product?.name === 'DBS Chromo Card', JSON.stringify(queued[0]?.unmatched_product));

const unmatched = await unmatchedProducts(env);
check('which is also listed on its own', unmatched.some((u) => u.name === 'DBS Chromo Card'), JSON.stringify(unmatched));
check(
  'and nothing was created in the catalogue',
  (db.prepare(`SELECT COUNT(*) AS n FROM card_products WHERE product_name LIKE '%Chromo%'`).get() as any).n === 0,
  'a product invented from an article is one the rules engine prices against'
);

// TEST 6 — "not a promotion" sticks.
const rejected = await rejectCandidate(env, candId);
check('a reviewer can say it was never a promotion', rejected.ok, JSON.stringify(rejected));
check(
  'the candidate is rejected',
  (db.prepare(`SELECT status FROM promotion_candidates WHERE id = ?`).get(candId) as any).status === 'rejected',
  ''
);
check(
  'with the reason kept',
  (db.prepare(`SELECT review_reason FROM promotion_candidates WHERE id = ?`).get(candId) as any).review_reason ===
    NOT_A_PROMOTION_REASON,
  ''
);
const after = db.prepare(`SELECT status, document_type, extraction_note FROM discovery_items WHERE id = ?`).get(itemId) as any;
check('and the article recorded as what it actually was', after.document_type === 'card_review', after.document_type);
check('marked so nothing re-reads it', after.status === 'irrelevant', after.status);
check('with a note saying a person decided', /reviewer/i.test(after.extraction_note ?? ''), String(after.extraction_note));
check('and it is gone from the queue', (await reviewQueue(env)).length === 0, '');

// TEST 6b — and it does not come back on the next pass.
const { requeueForExtraction } = await import('../src/promotions/discovery/reclassify');
await requeueForExtraction(env, 50).catch(() => void 0);
check(
  'a re-queue does not resurrect it',
  (db.prepare(`SELECT status FROM discovery_items WHERE id = ?`).get(itemId) as any).status === 'irrelevant',
  'rejecting the candidate alone would leave the article looking unread'
);

// A reviewer correcting the type, rather than rejecting it.
sql(
  `INSERT INTO promotion_candidates (discovery_id, promotion_type, issuer, raw_product_name, status, terms_json)
   VALUES (?, 'transfer_bonus', 'DBS', 'DBS Altitude', 'review', '{"reward_miles":10000}')`,
  itemId
);
const second = (db.prepare(`SELECT id FROM promotion_candidates ORDER BY id DESC LIMIT 1`).get() as any).id;

const retyped = await retypeCandidate(env, second, 'welcome_offer');
check('a reviewer can correct the type', retyped.ok, JSON.stringify(retyped));
check(
  'and it is stored',
  (db.prepare(`SELECT promotion_type FROM promotion_candidates WHERE id = ?`).get(second) as any).promotion_type ===
    'welcome_offer',
  ''
);
check(
  'recorded as coming from a person, so corroboration cannot undo it',
  (db.prepare(`SELECT source_type FROM promotion_claims WHERE candidate_id = ? AND field_name = 'promotion_type'`).get(second) as any)
    ?.source_type === 'manual_verified',
  ''
);

const retypedAway = await retypeCandidate(env, second, 'not_a_promotion');
check('choosing "card review" from the type list rejects it', retypedAway.ok, '');
check(
  'by the same path as the button',
  (db.prepare(`SELECT status, review_reason FROM promotion_candidates WHERE id = ?`).get(second) as any).review_reason ===
    NOT_A_PROMOTION_REASON,
  ''
);

check('an unknown type is refused', !(await retypeCandidate(env, second, 'nonsense' as never)).ok, '');

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
