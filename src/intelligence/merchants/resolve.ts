import { candidates as mccCandidates, deriveMcc } from '../../merchants/evidence';
import { merchantByKey, resolveMerchant, similarMerchants } from '../../merchants/lookup';
import { today } from '../../spend';
import type { Env } from '../../types';
import { classify } from '../models/classifier';
import { activeModel } from '../models/registry';
import { parseDescriptor, type NormalizedDescriptor } from './normalize';
import {
  decideReview,
  policyFrom,
  rewardImpactOfUncertainty,
  type ReviewDecision,
  type RewardSpread,
} from './reward-impact';

/**
 * Turning what a bank printed into what the rules engine needs.
 *
 * The ordering is the whole design. Evidence a person supplied outranks
 * evidence the app inferred, always, and no later step may overturn an earlier
 * one — a model that silently replaced a confirmed code would make the app's
 * memory worse than the person's.
 *
 *   1. user-confirmed evidence
 *   2. exact alias
 *   3. this person's own transaction history
 *   4. accumulated merchant evidence
 *   5. deterministic normalisation
 *   6. fuzzy match
 *   7. a trained model            — interface present, no model yet
 *   8. external evidence          — not configured
 *   9. ask
 *
 * Steps 7 and 8 are stubs on purpose. `docs/intelligence-architecture.md`
 * records why: there are zero labelled descriptors to train on, and the
 * Workers AI catalogue contains no merchant or MCC classifier. The slots exist
 * so adding one later is a function body rather than a redesign.
 */

export type PredictionSource =
  | 'user_confirmed'
  | 'exact_alias'
  | 'user_history'
  | 'merchant_evidence'
  | 'fuzzy'
  | 'self_trained_ml'
  | 'workers_ai'
  | 'external'
  | 'none';

export interface MccCandidateOut {
  mcc: string;
  probability: number;
  description: string | null;
  evidence: string;
}

export interface MerchantResolution {
  descriptor: NormalizedDescriptor;
  merchant: { id: number; name: string; confidence: number } | null;
  category: { value: string | null; confidence: number };
  mcc_candidates: MccCandidateOut[];
  needs_review: boolean;
  review_reason: string | null;
  /** What the person would be shown when asked. Null when nobody is being asked. */
  explanation: string | null;
  reward_impact: RewardSpread | null;
  provenance: {
    prediction_source: PredictionSource;
    model_key: string | null;
    model_version: number | null;
    predicted_at: string;
    /** Every step that was tried, in order, and what it produced. */
    trail: { step: string; outcome: string }[];
  };
}

/** Confidence bands, so a screen never has to interpret a raw probability. */
export const band = (p: number): 'high' | 'medium' | 'low' =>
  p >= 0.85 ? 'high' : p >= 0.5 ? 'medium' : 'low';

export interface ResolveInput {
  descriptor: string;
  amount_cents?: number;
  channel?: string | null;
  card_id?: number | null;
  occurred_at?: string | null;
}

export async function resolveMerchantIntelligence(env: Env, input: ResolveInput): Promise<MerchantResolution> {
  const now = today(env);
  const descriptor = parseDescriptor(input.descriptor);
  const trail: { step: string; outcome: string }[] = [];

  let source: PredictionSource = 'none';
  let merchant: { id: number; name: string; confidence: number } | null = null;

  // --- 2. exact alias -------------------------------------------------------
  // Step 1 (user-confirmed) is not a separate lookup: a confirmation writes an
  // alias with confidence 'confirmed', so it arrives here already outranking
  // everything below.
  const exact = descriptor.key ? await merchantByKey(env, descriptor.key) : null;
  if (exact) {
    const confirmed = await env.DB.prepare(
      `SELECT confidence FROM merchant_aliases WHERE alias_key = ? AND merchant_id = ?`
    )
      .bind(descriptor.key, exact.id)
      .first<{ confidence: string }>();
    const isConfirmed = confirmed?.confidence === 'confirmed';
    merchant = { id: exact.id, name: exact.canonical_name, confidence: isConfirmed ? 1 : 0.9 };
    source = isConfirmed ? 'user_confirmed' : 'exact_alias';
    trail.push({ step: isConfirmed ? 'user_confirmed' : 'exact_alias', outcome: `matched ${exact.canonical_name}` });
  } else {
    trail.push({ step: 'exact_alias', outcome: 'no alias for this descriptor' });
  }

  // --- 5/6. normalisation, then fuzzy --------------------------------------
  if (!merchant) {
    // `create: false` matters more than it looks. Resolving is a question,
    // not an assertion, and the default would invent a merchant row for every
    // descriptor ever asked about — including the ones the app is about to
    // admit it does not recognise.
    const guess = await resolveMerchant(env, input.descriptor, { create: false });
    if (guess) {
      merchant = { id: guess.id, name: guess.canonical_name, confidence: 0.75 };
      source = 'merchant_evidence';
      trail.push({ step: 'normalisation', outcome: `resolved to ${guess.canonical_name}` });
    } else {
      trail.push({ step: 'normalisation', outcome: 'nothing matched' });

      const near = await similarMerchants(env, descriptor.normalized, { limit: 3 });
      const best = near[0];
      if (best && best.score >= 0.82) {
        merchant = { id: best.merchant.id, name: best.merchant.canonical_name, confidence: best.score * 0.8 };
        source = 'fuzzy';
        trail.push({
          step: 'fuzzy',
          outcome: `closest is ${best.merchant.canonical_name} at ${Math.round(best.score * 100)}%`,
        });
      } else {
        trail.push({
          step: 'fuzzy',
          outcome: best ? `closest is ${best.merchant.canonical_name} at ${Math.round(best.score * 100)}% — too far` : 'nothing close',
        });
      }
    }
  }

  // --- MCC, as a distribution, never as a fact -----------------------------
  let mccOut: MccCandidateOut[] = [];
  let category: { value: string | null; confidence: number } = { value: null, confidence: 0 };

  if (merchant) {
    const cands = await mccCandidates(env, merchant.id, input.channel ?? null);
    const total = cands.reduce((s, c) => s + c.weight, 0) || 1;
    mccOut = cands.map((c) => ({
      mcc: c.mcc,
      probability: Math.round((c.weight / total) * 1000) / 1000,
      description: null,
      evidence: `${c.observations} observation${c.observations === 1 ? '' : 's'}${c.confirmed ? ', confirmed' : ''}`,
    }));

    // The category comes from the code's own dictionary entry rather than
    // being predicted: mcc_codes already maps all 924 codes to the app's 18
    // categories, so a category "model" would be re-deriving a lookup.
    const derived = await deriveMcc(env, merchant.id, input.channel ?? null);
    if (derived.mcc) {
      const row = await env.DB.prepare(`SELECT category FROM mcc_codes WHERE code = ?`)
        .bind(derived.mcc)
        .first<{ category: string | null }>();
      if (row?.category) {
        category = {
          value: row.category,
          // A category is only as certain as the code it was read from, and
          // an ambiguous code makes the category a guess too.
          confidence: derived.ambiguous ? merchant.confidence * 0.6 : merchant.confidence,
        };
      }
    }
    trail.push({
      step: 'merchant_evidence',
      outcome: mccOut.length ? `${mccOut.length} candidate code(s)` : 'merchant known, no code evidence yet',
    });
  }

  // --- 7. the trained model ------------------------------------------------
  //
  // Consulted ONLY where evidence found nothing. This ordering is the whole
  // safety property: a model can never overturn a code a person confirmed or
  // a bank printed, because by the time it is asked, neither exists. The worst
  // it can do is offer an answer where the alternative was no answer at all.
  //
  // It is also allowed to decline. `classify` returns null when the model has
  // seen too little of the descriptor to have an opinion, which is the case
  // that matters — a softmax will hand back a confident-looking number for a
  // string it has never seen anything like.
  let modelKey: string | null = null;
  let modelVersion: number | null = null;

  if (!mccOut.length) {
    const model = await activeModel(env, 'merchant_mcc');
    if (!model) {
      trail.push({ step: 'self_trained_ml', outcome: 'no model deployed — see docs/intelligence-model-decision.md' });
    } else {
      const guess = await classify(env, input.descriptor, { model });
      if (!guess) {
        trail.push({
          step: 'self_trained_ml',
          outcome: `${model.model_key} v${model.version} has not seen enough of this descriptor to answer`,
        });
      } else if (guess.probability < model.high_confidence) {
        // Below its own measured threshold the model is not better than
        // asking, and the precision figure it was promoted on was measured
        // above that line, not below it.
        trail.push({
          step: 'self_trained_ml',
          outcome: `${model.model_key} v${model.version} suggests ${guess.label} at ${Math.round(
            guess.probability * 100
          )}%, below its ${Math.round(model.high_confidence * 100)}% bar — not used`,
        });
      } else {
        source = 'self_trained_ml';
        modelKey = guess.model_key;
        modelVersion = guess.model_version;
        mccOut = guess.distribution.map((d) => ({
          mcc: d.label,
          probability: d.probability,
          description: null,
          evidence: `predicted by ${guess.model_key} v${guess.model_version} from ${guess.matched_features} of ${guess.total_features} fragments`,
        }));
        trail.push({
          step: 'self_trained_ml',
          outcome: `${guess.label} at ${Math.round(guess.probability * 100)}% from ${model.model_key} v${model.version}`,
        });

        const row = await env.DB.prepare(`SELECT category FROM mcc_codes WHERE code = ?`)
          .bind(guess.label)
          .first<{ category: string | null }>();
        if (row?.category) {
          // A predicted category is only as good as the predicted code it was
          // read from, so it inherits the model's own confidence rather than
          // the merchant's.
          category = { value: row.category, confidence: guess.probability };
        }
      }
    }
    // A code could not be predicted, but the category still might be. There
    // are over nine hundred codes and eighteen categories, so the same ledger
    // is routinely too thin for one and thick enough for the other — and most
    // earn rules are keyed on category, so this is often the answer that
    // actually prices the purchase.
    if (!category.value) {
      const catModel = await activeModel(env, 'merchant_category');
      if (catModel) {
        const guess = await classify(env, input.descriptor, { model: catModel });
        if (guess && guess.probability >= catModel.high_confidence) {
          category = { value: guess.label, confidence: guess.probability };
          if (source === 'none') source = 'self_trained_ml';
          modelKey = modelKey ?? guess.model_key;
          modelVersion = modelVersion ?? guess.model_version;
          trail.push({
            step: 'category_model',
            outcome: `${guess.label} at ${Math.round(guess.probability * 100)}% from ${catModel.model_key} v${catModel.version}`,
          });
        } else {
          trail.push({
            step: 'category_model',
            outcome: guess
              ? `${catModel.model_key} suggests ${guess.label} at ${Math.round(guess.probability * 100)}%, below its bar`
              : `${catModel.model_key} has not seen enough of this descriptor`,
          });
        }
      }
    }

    trail.push({ step: 'external', outcome: 'not configured' });
  }

  // --- is it worth asking? -------------------------------------------------
  const policy = policyFrom(env);
  let spread: RewardSpread | null = null;
  let decision: ReviewDecision | null = null;

  if (mccOut.length && input.amount_cents) {
    spread = await rewardImpactOfUncertainty(
      env,
      { amount_cents: input.amount_cents, channel: input.channel, on: input.occurred_at ?? now },
      mccOut.map((m) => ({ mcc: m.mcc, probability: m.probability }))
    );
    decision = decideReview(
      mccOut.length ? { mcc: mccOut[0].mcc, probability: mccOut[0].probability } : null,
      spread,
      policy
    );
  }

  const needsReview = decision ? decision.verdict === 'needs_answer' : !merchant || !mccOut.length;
  const reason = decision
    ? decision.reason
    : !merchant
      ? 'the merchant is not recognised'
      : 'no code has been observed for this merchant';

  return {
    descriptor,
    merchant,
    category,
    mcc_candidates: mccOut,
    needs_review: needsReview,
    review_reason: needsReview ? reason : null,
    explanation: decision?.explanation ?? null,
    reward_impact: spread,
    provenance: {
      prediction_source: source,
      model_key: modelKey,
      model_version: modelVersion,
      predicted_at: now,
      trail,
    },
  };
}

/** Write the resolution down, so a decision made today can be explained later. */
export async function recordPrediction(
  env: Env,
  r: MerchantResolution,
  transactionId?: number | null
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO merchant_predictions
       (transaction_id, raw_descriptor, normalized_descriptor, merchant_id, predicted_mcc, predicted_category,
        confidence, prediction_source, model_key, model_version, candidate_distribution_json,
        needs_review, review_reason, reward_spread_cents, predicted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      transactionId ?? null,
      r.descriptor.raw,
      r.descriptor.normalized,
      r.merchant?.id ?? null,
      r.mcc_candidates[0]?.mcc ?? null,
      r.category.value,
      r.merchant?.confidence ?? 0,
      r.provenance.prediction_source,
      r.provenance.model_key,
      r.provenance.model_version,
      JSON.stringify(r.mcc_candidates),
      r.needs_review ? 1 : 0,
      r.review_reason,
      r.reward_impact?.spread_cents ?? null,
      r.provenance.predicted_at
    )
    .run();
}
