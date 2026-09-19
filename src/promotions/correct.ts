import { today } from '../spend';
import type { Env } from '../types';
import { changeBetween, promotionTitle, recordChange, writeVersion } from './discovery/publish';
import { PROMOTION_TYPES, termsOf, type Promotion, type PromotionType } from './model';
import { AUDIENCE_TYPES, audienceOf, type PromotionAudienceType } from './audience';

/**
 * Correcting an offer that is already published.
 *
 * Until now the only way to fix a wrong number was to reject the promotion and
 * hope discovery found it again — which loses the tracking, the history and
 * anything already spent against it. That is the wrong shape for the most
 * likely correction of all: the terms are right in substance and one figure is
 * out, because a source misread it or because somebody typed dollars into a
 * field that meant cents.
 *
 * So a correction is an ordinary edit, and it goes through the same machinery
 * every other change does. It writes a version, records a change event, and
 * files a claim attributed to the person at the highest trust tier — because a
 * human reading the bank's page and typing what it says is the best evidence
 * this system can hold, and the next corroboration pass must not quietly
 * overwrite it with an article.
 */

/** The fields a person may correct. Deliberately the ones that decide money. */
export const CORRECTABLE = [
  'reward_miles',
  'reward_points',
  'reward_cashback_cents',
  'bonus_pct',
  'minimum_spend_cents',
  'window_days',
  'registration_required',
] as const;

export type CorrectableField = (typeof CORRECTABLE)[number];

export interface CorrectionResult {
  ok: boolean;
  error?: string;
  promotion_id?: number;
  version?: number;
  changed?: { field: string; before: unknown; after: unknown }[];
}

/**
 * What an offer IS, as opposed to what it pays.
 *
 * These are correctable for the same reason the figures are: an extractor can
 * read a cashback welcome offer as a transfer bonus, and then it appears under
 * "Point transfers" where nobody looking for it will find it. Nothing else in
 * the app could put that right — the type decides which section an offer lives
 * in, and it was write-once.
 */
export interface IdentityEdits {
  title?: string | null;
  promotion_type?: string | null;
  /**
   * Who the offer is for.
   *
   * Correctable because an extractor reading "existing cardmembers" as "new
   * applicants" is the single most consequential mistake it can make — one
   * direction sends a person to apply for a card they cannot benefit from,
   * the other hides an offer they could take.
   */
  audience_type?: string | null;
}

async function applyIdentity(
  env: Env,
  promo: Promotion,
  edits: IdentityEdits
): Promise<{ changed: { field: string; before: unknown; after: unknown }[]; error?: string }> {
  const changed: { field: string; before: unknown; after: unknown }[] = [];

  if (typeof edits.promotion_type === 'string' && edits.promotion_type.trim()) {
    const type = edits.promotion_type.trim() as PromotionType;
    if (!PROMOTION_TYPES.includes(type)) {
      return { changed, error: `${type} is not a kind of promotion this app knows` };
    }
    if (type !== promo.promotion_type) {
      await env.DB.prepare(`UPDATE promotions SET promotion_type = ? WHERE id = ?`).bind(type, promo.id).run();
      changed.push({ field: 'promotion_type', before: promo.promotion_type, after: type });
    }
  }

  if (typeof edits.audience_type === 'string' && edits.audience_type.trim()) {
    const type = edits.audience_type.trim() as PromotionAudienceType;
    if (!AUDIENCE_TYPES.includes(type)) {
      return { changed, error: `${type} is not an audience this app knows` };
    }
    const terms = termsOf(promo) as unknown as Record<string, unknown>;
    const current = audienceOf(terms);
    if (current.type !== type) {
      // The raw wording is preserved: a person re-classifying a sentence is
      // disagreeing with the reading, not claiming the sentence said something
      // else, and the next reviewer needs to see what they were looking at.
      const next = { ...current, type, confidence: 'high' as const };
      await env.DB.prepare(`UPDATE promotions SET terms_json = ?, audience_type = ? WHERE id = ?`)
        .bind(JSON.stringify({ ...terms, audience: next }), type, promo.id)
        .run();
      await recordChange(env, promo.id, 'audience_changed', current, next, 'app://correction');
      changed.push({ field: 'audience_type', before: current.type, after: type });
    }
  }

  if (typeof edits.title === 'string' && edits.title.trim()) {
    // Through the same tidier new offers get, so correcting a title cannot
    // reintroduce the doubled issuer it is usually being corrected for.
    const title = promotionTitle(promo.issuer, edits.title.trim());
    if (title !== promo.title) {
      await env.DB.prepare(`UPDATE promotions SET title = ? WHERE id = ?`).bind(title, promo.id).run();
      changed.push({ field: 'title', before: promo.title, after: title });
    }
  }

  return { changed };
}

const isMoney = (field: string) => field.endsWith('_cents');

/**
 * Sanity limits, so a units mistake is caught rather than stored.
 *
 * These are not opinions about what a bank might offer; they are the bounds
 * outside which a number is certainly a typo. A $4 cashback bonus with a $4
 * minimum spend is not a real offer, and it is exactly what a dollars-into-a-
 * cents-field mistake produces.
 */
export const LIMITS: Record<string, { min: number; max: number; says: string }> = {
  reward_miles: { min: 100, max: 500_000, says: 'miles' },
  reward_points: { min: 100, max: 500_000, says: 'points' },
  reward_cashback_cents: { min: 500, max: 2_000_000, says: 'cashback in cents' },
  bonus_pct: { min: 1, max: 200, says: 'a percentage' },
  minimum_spend_cents: { min: 500, max: 10_000_000, says: 'a spend threshold in cents' },
  window_days: { min: 1, max: 730, says: 'a number of days' },
};

export function implausible(field: string, value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const limit = LIMITS[field];
  if (!limit) return null;
  if (value < limit.min) {
    return isMoney(field)
      ? `$${(value / 100).toFixed(2)} looks too small for ${limit.says.replace(' in cents', '')} — did you mean $${value.toFixed(2)}? Amounts are entered in dollars.`
      : `${value} looks too small for ${limit.says}.`;
  }
  if (value > limit.max) {
    return isMoney(field)
      ? `$${(value / 100).toFixed(2)} looks too large. Amounts are entered in dollars, not cents.`
      : `${value} looks too large for ${limit.says}.`;
  }
  return null;
}

export async function correctPromotion(
  env: Env,
  promotionId: number,
  edits: Record<string, unknown>,
  opts: {
    note?: string | null;
    source_url?: string | null;
    allow_implausible?: boolean;
    identity?: IdentityEdits;
  } = {}
): Promise<CorrectionResult> {
  const promo = await env.DB.prepare(`SELECT * FROM promotions WHERE id = ?`).bind(promotionId).first<Promotion>();
  if (!promo) return { ok: false, error: 'no such offer' };

  // What it is, before what it pays: an offer filed as the wrong kind is
  // invisible in the section a person would look in, however right its
  // numbers are.
  const identity = opts.identity ? await applyIdentity(env, promo, opts.identity) : { changed: [] };
  if (identity.error) return { ok: false, error: identity.error };

  const before = termsOf(promo) as unknown as Record<string, unknown>;
  const after = { ...before };
  const changed: { field: string; before: unknown; after: unknown }[] = [];

  for (const [field, value] of Object.entries(edits)) {
    if (!(CORRECTABLE as readonly string[]).includes(field)) continue;
    if (value === null || value === undefined || value === '') continue;

    const parsed = typeof value === 'boolean' ? value : Number(value);
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) {
      return { ok: false, error: `${field} is not a number` };
    }

    // Refused rather than stored. The whole point of this path is fixing a
    // number that went in wrong, so letting it accept an obviously wrong one
    // would be the same mistake with an extra step.
    if (!opts.allow_implausible) {
      const complaint = implausible(field, parsed);
      if (complaint) return { ok: false, error: complaint };
    }

    if (JSON.stringify(before[field]) === JSON.stringify(parsed)) continue;
    changed.push({ field, before: before[field] ?? null, after: parsed });
    after[field] = parsed;
  }

  if (!changed.length) {
    return { ok: true, promotion_id: promotionId, changed: identity.changed };
  }

  await env.DB.prepare(
    `UPDATE promotions SET terms_json = ?, verified_at = ?, last_verified_at = ?, confidence = 'high' WHERE id = ?`
  )
    .bind(JSON.stringify(after), today(env), today(env), promotionId)
    .run();

  const version = await writeVersion(env, promotionId, after, 'official_verified', {
    from: promo.start_at,
    until: promo.end_at,
  });

  const kind = changeBetween(before, after, { before_end: promo.end_at, after_end: promo.end_at });
  await recordChange(env, promotionId, kind?.type ?? 'terms_changed', before, after, opts.source_url ?? 'app://correction');

  // Attributed to the person, at the tier an issuer would get. A later article
  // disagreeing must not silently win against someone who read the terms.
  for (const c of changed) {
    await env.DB.prepare(
      `INSERT INTO promotion_claims
         (promotion_id, field_name, value_json, source_url, source_type, source_tier, extracted_at, confidence, supporting_excerpt)
       VALUES (?, ?, ?, ?, 'user', 1, ?, 'high', ?)`
    )
      .bind(
        promotionId,
        c.field,
        JSON.stringify(c.after),
        opts.source_url ?? 'app://correction',
        today(env),
        (opts.note ?? 'Corrected by hand').slice(0, 240)
      )
      .run();
  }

  return { ok: true, promotion_id: promotionId, version, changed: [...identity.changed, ...changed] };
}
