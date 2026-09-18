import { linkApplicability, savePromotion, type PromotionType } from '../model';
import { syncTransferBonuses } from '../bridge';
import { today } from '../../spend';
import type { Env } from '../../types';
import { corroborate, claimsFor, type Corroboration, type VerificationState } from './corroborate';
import { canAutoPublish } from './corroborate';
import { looksExtended, type FingerprintInput } from './fingerprint';
import { audienceOf, saveVariant, type VariantReward } from '../variants';

/**
 * Turning corroborated claims into the promotion the rest of the app consumes.
 *
 * The point of the whole pipeline is here: discovery happens once, and the
 * acquisition simulator, the card advisor, the requirement tracker, the rewards
 * check and the transfer optimiser all read the same record. Nothing downstream
 * knows or cares that an article was involved.
 */

export type ChangeType =
  | 'created'
  | 'extended'
  | 'reward_changed'
  | 'spend_changed'
  | 'eligibility_changed'
  | 'expired'
  | 'withdrawn'
  | 'terms_changed';

export interface PublishResult {
  ok: boolean;
  error?: string;
  promotion_id?: number;
  version?: number;
  /** What happened, for the daily report. */
  change: ChangeType | null;
  auto: boolean;
  verification_state: VerificationState;
  review_reasons: string[];
}

const termsFromClaims = (c: Corroboration) => {
  const t: Record<string, unknown> = {};
  const map: Record<string, string> = {
    reward_miles: 'reward_miles',
    reward_points: 'reward_points',
    reward_cashback_cents: 'reward_cashback_cents',
    bonus_pct: 'bonus_pct',
    minimum_spend_cents: 'minimum_spend_cents',
    registration_required: 'registration_required',
  };
  for (const [from, to] of Object.entries(map)) if (c.terms[from] !== undefined) t[to] = c.terms[from];

  const window = c.terms.spend_window as { type?: string; value?: number } | undefined;
  if (window?.type === 'days_from_approval' && window.value) t.window_days = window.value;
  if (window?.type === 'months_from_approval' && window.value) t.window_days = window.value * 30;
  return t;
};

export async function recordChange(
  env: Env,
  promotionId: number,
  type: ChangeType,
  oldValue: unknown,
  newValue: unknown,
  sourceUrl: string | null
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO promotion_change_events (promotion_id, change_type, old_value_json, new_value_json, detected_at, source_url)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      promotionId,
      type,
      oldValue === undefined ? null : JSON.stringify(oldValue),
      newValue === undefined ? null : JSON.stringify(newValue),
      today(env),
      sourceUrl
    )
    .run();
}

async function nextVersion(env: Env, promotionId: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT MAX(version) AS v FROM promotion_versions WHERE promotion_id = ?`)
    .bind(promotionId)
    .first<{ v: number | null }>();
  return (row?.v ?? 0) + 1;
}

/**
 * Write a version of what a promotion currently says.
 *
 * Versions rather than edits, for the same reason reward rules are versioned: a
 * tracked requirement and a reconciled reward both point back at what the offer
 * said when they were created, and overwriting it makes those unexplainable.
 */
export async function writeVersion(
  env: Env,
  promotionId: number,
  terms: Record<string, unknown>,
  state: VerificationState,
  validity: { from: string | null; until: string | null }
): Promise<number> {
  const version = await nextVersion(env, promotionId);
  await env.DB.prepare(
    `INSERT INTO promotion_versions (promotion_id, version, valid_from, valid_until, terms_json, verification_status, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(promotionId, version, validity.from, validity.until, JSON.stringify(terms), state, today(env))
    .run();
  return version;
}

/** What changed between two sets of terms, in the language of change events. */
export function changeBetween(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  dates: { before_end: string | null; after_end: string | null }
): { type: ChangeType; field: string | null } | null {
  const rewardKeys = ['reward_miles', 'reward_points', 'reward_cashback_cents', 'bonus_pct'];
  for (const k of rewardKeys) {
    if (after[k] !== undefined && before[k] !== undefined && after[k] !== before[k]) {
      return { type: 'reward_changed', field: k };
    }
  }
  if (
    after.minimum_spend_cents !== undefined &&
    before.minimum_spend_cents !== undefined &&
    after.minimum_spend_cents !== before.minimum_spend_cents
  ) {
    return { type: 'spend_changed', field: 'minimum_spend_cents' };
  }
  if (dates.after_end && dates.before_end && dates.after_end > dates.before_end) {
    return { type: 'extended', field: 'end_at' };
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) return { type: 'terms_changed', field: null };
  return null;
}

export interface CandidateRow {
  id: number;
  promotion_type: string | null;
  issuer: string | null;
  raw_product_name: string | null;
  resolved_product_id: number | null;
  fingerprint: string | null;
  terms_json: string | null;
  application_channel: string;
  extraction_confidence: string;
  status: string;
  promotion_id: number | null;
  discovery_id: number | null;
}

/**
 * Decide what to do with one candidate.
 *
 * Match it against what is already known first: a new article about a known
 * offer should add evidence to that offer, not create a second one. Only then
 * is publication considered, and only where the evidence carries it.
 */
export async function publishCandidate(env: Env, candidateId: number): Promise<PublishResult> {
  const c = await env.DB.prepare(`SELECT * FROM promotion_candidates WHERE id = ?`)
    .bind(candidateId)
    .first<CandidateRow>();
  if (!c) return { ok: false, error: 'no such candidate', change: null, auto: false, verification_state: 'needs_review', review_reasons: [] };

  const claims = await claimsFor(env, candidateId);
  if (!claims.length) {
    return { ok: false, error: 'nothing was read out of any source', change: null, auto: false, verification_state: 'needs_review', review_reasons: ['nothing extracted'] };
  }

  const evidence = corroborate(claims);
  const terms = termsFromClaims(evidence);
  const extracted = c.terms_json ? (JSON.parse(c.terms_json) as Record<string, any>) : {};
  const endAt = (evidence.terms.application_end as string) ?? extracted.application_end ?? null;
  const startAt = extracted.application_start ?? null;
  const sourceUrl = claims[0]?.source_url ?? null;

  const shape: FingerprintInput = {
    issuer: c.issuer,
    product_id: c.resolved_product_id,
    product_name: c.raw_product_name,
    promotion_type: c.promotion_type,
    application_channel: c.application_channel,
    application_start: startAt,
    application_end: endAt,
    minimum_spend_cents: (terms.minimum_spend_cents as number) ?? null,
    reward: {
      miles: terms.reward_miles as number,
      points: terms.reward_points as number,
      cashback_cents: terms.reward_cashback_cents as number,
      bonus_pct: terms.bonus_pct as number,
    },
  };

  const existing = await matchExisting(env, c, shape);
  const isExtension = !!existing && looksExtended(existing.shape, shape);
  const decision = canAutoPublish(evidence, {
    known_promotion: !!existing,
    only_extension: isExtension,
  });

  // Held back for a person. The candidate keeps everything it learned, so the
  // review screen shows the evidence rather than asking someone to go and read
  // the articles themselves.
  if (!decision.auto) {
    await env.DB.prepare(
      `UPDATE promotion_candidates SET status = 'review', review_reason = ?, promotion_id = ? WHERE id = ?`
    )
      .bind(decision.review_reasons.join('; ') || decision.reason, existing?.id ?? null, candidateId)
      .run();
    return {
      ok: true,
      promotion_id: existing?.id,
      change: null,
      auto: false,
      verification_state: evidence.verification_state,
      review_reasons: decision.review_reasons,
    };
  }

  return await applyCandidate(env, c, evidence, {
    terms,
    startAt,
    endAt,
    sourceUrl,
    existingId: existing?.id ?? null,
    existingTerms: existing?.terms ?? null,
    existingEnd: existing?.shape.application_end ?? null,
    auto: true,
  });
}

/**
 * Write a candidate into the promotions table, as a new offer or a new version.
 *
 * Shared by the automatic path and the review screen, so a promotion published
 * by hand is identical to one published automatically — two code paths writing
 * the same record is how they drift.
 */
export async function applyCandidate(
  env: Env,
  c: CandidateRow,
  evidence: Corroboration,
  opts: {
    terms: Record<string, unknown>;
    startAt: string | null;
    endAt: string | null;
    sourceUrl: string | null;
    existingId: number | null;
    existingTerms: Record<string, unknown> | null;
    existingEnd: string | null;
    auto: boolean;
  }
): Promise<PublishResult> {
  const title = `${c.issuer ?? ''} ${c.raw_product_name ?? ''}`.trim() || 'Promotion';

  if (opts.existingId) {
    const change = changeBetween(opts.existingTerms ?? {}, opts.terms, {
      before_end: opts.existingEnd,
      after_end: opts.endAt,
    });

    await env.DB.prepare(
      `UPDATE promotions SET terms_json = ?, end_at = COALESCE(?, end_at), verification_state = ?,
         last_verified_at = ?, independent_sources = ?, status = 'published' WHERE id = ?`
    )
      .bind(
        JSON.stringify(opts.terms),
        opts.endAt,
        evidence.verification_state,
        today(env),
        evidence.independent_sources,
        opts.existingId
      )
      .run();

    const version = await writeVersion(env, opts.existingId, opts.terms, evidence.verification_state, {
      from: opts.startAt,
      until: opts.endAt,
    });
    if (change) await recordChange(env, opts.existingId, change.type, opts.existingTerms, opts.terms, opts.sourceUrl);

    await recordVariant(env, opts.existingId, c, opts.terms);
    await moveClaims(env, c.id, opts.existingId);
    await env.DB.prepare(
      `UPDATE promotion_candidates
          SET status = 'published', promotion_id = ?, published_at = ?, auto_published = ?
        WHERE id = ?`
    )
      .bind(opts.existingId, today(env), opts.auto ? 1 : 0, c.id)
      .run();
    if (c.promotion_type === 'transfer_bonus') await syncTransferBonuses(env);

    return {
      ok: true,
      promotion_id: opts.existingId,
      version,
      change: change?.type ?? null,
      auto: opts.auto,
      verification_state: evidence.verification_state,
      review_reasons: [],
    };
  }

  const saved = await savePromotion(env, {
    promotion_type: (c.promotion_type ?? 'bank_campaign') as PromotionType,
    issuer: c.issuer,
    title,
    start_at: opts.startAt,
    end_at: opts.endAt,
    registration_required: !!opts.terms.registration_required,
    source_url: opts.sourceUrl,
    source_type: 'discovery',
    source_quote: evidence.fields.find((f) => f.excerpt)?.excerpt ?? null,
    confidence: evidence.confidence,
    terms: opts.terms,
    status: 'published',
  });
  if (!saved.ok || !saved.id) {
    // Refused because a term that decides money is unknown, which is the
    // publishing rule doing its job rather than a failure to work around.
    await env.DB.prepare(`UPDATE promotion_candidates SET status = 'review', review_reason = ? WHERE id = ?`)
      .bind(`missing terms: ${(saved.missing ?? []).join(', ')}`, c.id)
      .run();
    return {
      ok: false,
      error: saved.error,
      change: null,
      auto: false,
      verification_state: evidence.verification_state,
      review_reasons: saved.missing ?? [],
    };
  }

  await env.DB.prepare(
    `UPDATE promotions SET verification_state = ?, application_channel = ?, fingerprint = ?,
       last_verified_at = ?, independent_sources = ? WHERE id = ?`
  )
    .bind(
      evidence.verification_state,
      c.application_channel,
      c.fingerprint,
      today(env),
      evidence.independent_sources,
      saved.id
    )
    .run();

  if (c.resolved_product_id) {
    const product = await env.DB.prepare(`SELECT product_key FROM card_products WHERE id = ?`)
      .bind(c.resolved_product_id)
      .first<{ product_key: string }>();
    if (product) await linkApplicability(env, saved.id, { product_keys: [product.product_key] });
  }

  const version = await writeVersion(env, saved.id, opts.terms, evidence.verification_state, {
    from: opts.startAt,
    until: opts.endAt,
  });
  await recordChange(env, saved.id, 'created', null, opts.terms, opts.sourceUrl);
  await recordVariant(env, saved.id, c, opts.terms);
  await moveClaims(env, c.id, saved.id);
  // Whether nobody looked at this before it went live is an audit fact, kept
  // on the candidate. Deriving it from change events counted every creation,
  // including the ones a person approved.
  await env.DB.prepare(
    `UPDATE promotion_candidates
        SET status = 'published', promotion_id = ?, published_at = ?, auto_published = ?
      WHERE id = ?`
  )
    .bind(saved.id, today(env), opts.auto ? 1 : 0, c.id)
    .run();
  if (c.promotion_type === 'transfer_bonus') await syncTransferBonuses(env);

  return {
    ok: true,
    promotion_id: saved.id,
    version,
    change: 'created',
    auto: opts.auto,
    verification_state: evidence.verification_state,
    review_reasons: [],
  };
}

/**
 * Record the shape this source described, beside the promotion itself.
 *
 * The promotion row carries the headline; this carries which channel and which
 * audience that headline was true for. When a second source describes the same
 * campaign through a comparison site with a different number, the two sit side
 * by side instead of one overwriting the other — which is what actually
 * happens with these offers, and what a person needs to see before applying.
 */
async function recordVariant(
  env: Env,
  promotionId: number,
  c: CandidateRow,
  terms: Record<string, unknown>
): Promise<void> {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  const reward: VariantReward = {
    miles: num(terms.reward_miles),
    points: num(terms.reward_points),
    cashback_cents: num(terms.reward_cashback_cents),
    bonus_pct: num(terms.bonus_pct),
    gift: typeof terms.reward_gift === 'string' ? terms.reward_gift : undefined,
  };
  // Nothing to record without a reward: a variant with no number says only
  // that a channel exists, which is not worth a row.
  if (!reward.miles && !reward.points && !reward.cashback_cents && !reward.bonus_pct && !reward.gift) return;

  const audience = audienceOf(String(terms.eligibility_text ?? ''));
  await saveVariant(env, promotionId, {
    audience,
    application_channel: c.application_channel || 'unknown',
    minimum_spend_cents: num(terms.minimum_spend_cents) ?? null,
    reward,
    annual_fee_required: typeof terms.annual_fee_required === 'boolean' ? terms.annual_fee_required : null,
  });
  if (audience !== 'everyone') {
    await env.DB.prepare(`UPDATE promotions SET audience = ? WHERE id = ? AND audience = 'everyone'`)
      .bind(audience, promotionId)
      .run();
  }
}

/** Claims follow the promotion they became evidence for. */
async function moveClaims(env: Env, candidateId: number, promotionId: number): Promise<void> {
  await env.DB.prepare(`UPDATE promotion_claims SET promotion_id = ? WHERE candidate_id = ?`)
    .bind(promotionId, candidateId)
    .run();
}

export interface ExistingMatch {
  id: number;
  terms: Record<string, unknown>;
  shape: FingerprintInput;
}

/**
 * The promotion this candidate is probably about.
 *
 * Fingerprint first, then a similarity pass over live promotions from the same
 * issuer. Without this, every weekly article about a running offer would create
 * another copy of it.
 */
export async function matchExisting(
  env: Env,
  c: CandidateRow,
  shape: FingerprintInput
): Promise<ExistingMatch | null> {
  const byPrint = c.fingerprint
    ? await env.DB.prepare(
        `SELECT * FROM promotions WHERE fingerprint = ? AND duplicate_of IS NULL ORDER BY id DESC LIMIT 1`
      )
        .bind(c.fingerprint)
        .first<any>()
    : null;
  if (byPrint) return asMatch(byPrint);

  const { results } = await env.DB.prepare(
    `SELECT * FROM promotions
      WHERE duplicate_of IS NULL AND status IN ('published', 'draft')
        AND COALESCE(issuer, '') = COALESCE(?, '')
        AND promotion_type = ?
      ORDER BY id DESC LIMIT 20`
  )
    .bind(c.issuer, c.promotion_type ?? 'bank_campaign')
    .all<any>();

  const { similarity } = await import('./fingerprint');
  for (const p of results ?? []) {
    const other = asMatch(p);
    const sim = similarity(other.shape, shape);
    if (sim.same || looksExtended(other.shape, shape)) return other;
  }
  return null;
}

function asMatch(p: any): ExistingMatch {
  let terms: Record<string, unknown> = {};
  try {
    terms = p.terms_json ? JSON.parse(p.terms_json) : {};
  } catch {
    terms = {};
  }
  return {
    id: p.id,
    terms,
    shape: {
      issuer: p.issuer,
      product_id: null,
      product_name: p.title,
      promotion_type: p.promotion_type,
      application_channel: p.application_channel ?? 'unknown',
      application_start: p.start_at,
      application_end: p.end_at,
      minimum_spend_cents: (terms.minimum_spend_cents as number) ?? null,
      reward: {
        miles: terms.reward_miles as number,
        points: terms.reward_points as number,
        cashback_cents: terms.reward_cashback_cents as number,
        bonus_pct: terms.bonus_pct as number,
      },
    },
  };
}
