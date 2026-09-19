import { money } from '../spend';
import type { Env } from '../types';
import type { ApplicationChannel } from './discovery/extract';

/**
 * The several shapes one promotion comes in.
 *
 * The same campaign is rarely one offer. A welcome bonus pays one number
 * through the bank's own page and a different number through a comparison
 * site; it pays new customers and not existing ones; and some of it arrives by
 * email to a list nobody outside the bank can see. Flattening that into a
 * single row forces a choice between showing a number this person cannot get
 * and hiding one they can.
 *
 * So a promotion carries variants, and three rules hold for all of them:
 *
 * A variant is never invented. One exists because a source said so, or because
 * the person reported receiving it.
 *
 * A targeted offer is never presented as generally available. It is real — the
 * person holding the email can take it — but it is theirs, and the app says so
 * rather than implying anyone can.
 *
 * And the headline never quietly becomes the best variant. What a promotion
 * pays is a range when the variants disagree, and the range is shown.
 */

export type Audience = 'everyone' | 'new_customer' | 'existing' | 'targeted';

export const AUDIENCES: Audience[] = ['everyone', 'new_customer', 'existing', 'targeted'];

/** How each audience reads in front of a person. */
export const AUDIENCE_LABEL: Record<Audience, string> = {
  everyone: 'anyone',
  new_customer: 'new customers only',
  existing: 'existing customers only',
  targeted: 'targeted — by invitation',
};

export const CHANNEL_LABEL: Record<string, string> = {
  issuer_direct: 'applying through the bank',
  moneysmart: 'applying through MoneySmart',
  singsaver: 'applying through SingSaver',
  third_party: 'applying through a third party',
  unknown: 'an unknown channel',
};

export interface VariantReward {
  miles?: number;
  points?: number;
  cashback_cents?: number;
  bonus_pct?: number;
  gift?: string;
}

export interface Variant {
  id: number;
  promotion_id: number;
  variant_key: string;
  audience: Audience;
  minimum_spend_cents: number | null;
  reward_json: string | null;
  annual_fee_required: number | null;
  application_channel: string;
  terms_json: string | null;
}

export interface VariantInput {
  audience?: Audience | null;
  application_channel?: ApplicationChannel | string | null;
  minimum_spend_cents?: number | null;
  reward?: VariantReward | null;
  annual_fee_required?: boolean | null;
  terms?: Record<string, unknown> | null;
  variant_key?: string | null;
}

/**
 * A stable name for one variant.
 *
 * Audience and channel together, because those are the two things that change
 * what a person can actually get. Keying on the reward instead would make
 * every correction a new variant rather than an edit to one.
 */
export function variantKey(v: { audience?: string | null; application_channel?: string | null }): string {
  return `${v.audience || 'everyone'}@${v.application_channel || 'unknown'}`;
}

export function rewardOf(v: Pick<Variant, 'reward_json'>): VariantReward {
  if (!v.reward_json) return {};
  try {
    return JSON.parse(v.reward_json) as VariantReward;
  } catch {
    return {};
  }
}

/** What a variant pays, in words. Null when it pays nothing we can name. */
export function rewardText(r: VariantReward): string | null {
  if (r.miles) return `${r.miles.toLocaleString()} miles`;
  if (r.points) return `${r.points.toLocaleString()} points`;
  if (r.cashback_cents) return `$${money(r.cashback_cents)} cashback`;
  if (r.bonus_pct) return `${r.bonus_pct}% bonus`;
  if (r.gift) return r.gift;
  return null;
}

/** A comparable size for a reward, used only to order variants against each other. */
export function rewardRank(r: VariantReward, mileValueCents: number): number {
  if (r.miles) return Math.round(r.miles * mileValueCents);
  if (r.points) return Math.round(r.points * mileValueCents);
  if (r.cashback_cents) return r.cashback_cents;
  if (r.bonus_pct) return r.bonus_pct * 100;
  return 0;
}

export async function variantsFor(env: Env, promotionId: number): Promise<Variant[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM promotion_variants WHERE promotion_id = ? ORDER BY
       CASE audience WHEN 'everyone' THEN 0 WHEN 'new_customer' THEN 1 WHEN 'existing' THEN 2 ELSE 3 END,
       variant_key`
  )
    .bind(promotionId)
    .all<Variant>();
  return results ?? [];
}

/**
 * Record a variant, or update the one already under that key.
 *
 * Upsert rather than insert, because the same variant is seen again every time
 * the campaign is re-read, and a second row would be read as a second offer.
 */
export async function saveVariant(env: Env, promotionId: number, v: VariantInput): Promise<Variant> {
  const key = v.variant_key || variantKey({ audience: v.audience, application_channel: v.application_channel });
  await env.DB.prepare(
    `INSERT INTO promotion_variants
       (promotion_id, variant_key, audience, minimum_spend_cents, reward_json, annual_fee_required, application_channel, terms_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(promotion_id, variant_key) DO UPDATE SET
       audience = excluded.audience,
       minimum_spend_cents = COALESCE(excluded.minimum_spend_cents, promotion_variants.minimum_spend_cents),
       reward_json = COALESCE(excluded.reward_json, promotion_variants.reward_json),
       annual_fee_required = COALESCE(excluded.annual_fee_required, promotion_variants.annual_fee_required),
       application_channel = excluded.application_channel,
       terms_json = COALESCE(excluded.terms_json, promotion_variants.terms_json)`
  )
    .bind(
      promotionId,
      key,
      v.audience || 'everyone',
      v.minimum_spend_cents ?? null,
      v.reward ? JSON.stringify(v.reward) : null,
      v.annual_fee_required === null || v.annual_fee_required === undefined ? null : v.annual_fee_required ? 1 : 0,
      String(v.application_channel || 'unknown'),
      v.terms ? JSON.stringify(v.terms) : null
    )
    .run();

  const row = await env.DB.prepare(`SELECT * FROM promotion_variants WHERE promotion_id = ? AND variant_key = ?`)
    .bind(promotionId, key)
    .first<Variant>();
  return row!;
}

export async function removeVariant(env: Env, promotionId: number, variantKeyToRemove: string): Promise<boolean> {
  const r = await env.DB.prepare(`DELETE FROM promotion_variants WHERE promotion_id = ? AND variant_key = ?`)
    .bind(promotionId, variantKeyToRemove)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * What the promotion pays, across its variants.
 *
 * A single number when they agree and a range when they do not — never the
 * biggest one on its own, which is the number that gets someone to apply and
 * then find out it was for new customers through a site they did not use.
 */
export function spread(
  variants: Variant[],
  mileValueCents: number
): { text: string | null; varies: boolean; best: Variant | null; worst: Variant | null } {
  const named = variants
    .map((v) => ({ v, r: rewardOf(v), rank: rewardRank(rewardOf(v), mileValueCents) }))
    .filter((x) => rewardText(x.r) !== null);
  if (!named.length) return { text: null, varies: false, best: null, worst: null };

  named.sort((a, b) => a.rank - b.rank);
  const low = named[0];
  const high = named[named.length - 1];
  const lowText = rewardText(low.r)!;
  const highText = rewardText(high.r)!;
  if (lowText === highText) return { text: lowText, varies: false, best: high.v, worst: low.v };
  return { text: `${lowText} to ${highText}`, varies: true, best: high.v, worst: low.v };
}

export interface VariantView {
  variant: Variant;
  reward: VariantReward;
  reward_text: string | null;
  audience_label: string;
  channel_label: string;
  /** True when this person could take this variant today. */
  available: boolean;
  /** Why not, when they could not. */
  blocker: string | null;
}

export interface Holder {
  /** True when they already hold a card the promotion applies to. */
  holds_card: boolean;
  /** True when they already bank with the issuer in some form. */
  existing_customer: boolean;
  /** Variant keys the person has said they were personally offered. */
  invited_keys: string[];
}

/**
 * Sort the variants into what this person can take and what they cannot.
 *
 * A new-customer bonus shown to someone who already holds the card is the most
 * common way these apps mislead, and the fix is not to hide it — it is to show
 * it with the sentence that explains why it is not theirs.
 */
export function viewVariants(variants: Variant[], holder: Holder): VariantView[] {
  return variants.map((v) => {
    const r = rewardOf(v);
    let blocker: string | null = null;

    if (v.audience === 'new_customer' && holder.holds_card) {
      blocker = 'New customers only, and you already hold this card.';
    } else if (v.audience === 'existing' && !holder.existing_customer) {
      blocker = 'For existing customers of this bank.';
    } else if (v.audience === 'targeted' && !holder.invited_keys.includes(v.variant_key)) {
      blocker = 'Targeted — only people the bank invited can take it.';
    }

    return {
      variant: v,
      reward: r,
      reward_text: rewardText(r),
      audience_label: AUDIENCE_LABEL[v.audience as Audience] ?? v.audience,
      channel_label: CHANNEL_LABEL[v.application_channel] ?? v.application_channel,
      available: blocker === null,
      blocker,
    };
  });
}

/**
 * A targeted offer the person received.
 *
 * This is the one place a promotion's terms come from the person rather than a
 * source, and it is trusted, because they are holding the email. It is stored
 * as its own variant so it never changes what the app believes the public
 * offer to be, and it is marked as theirs so no other surface presents it as
 * generally available.
 */
export async function contributeTargeted(
  env: Env,
  promotionId: number,
  input: {
    minimum_spend_cents?: number | null;
    reward?: VariantReward | null;
    application_channel?: string | null;
    note?: string | null;
    received_at?: string | null;
  }
): Promise<{ ok: true; variant: Variant } | { ok: false; error: string }> {
  const promo = await env.DB.prepare(`SELECT id FROM promotions WHERE id = ?`).bind(promotionId).first<{ id: number }>();
  if (!promo) return { ok: false, error: 'no such promotion' };
  if (!input.reward || rewardText(input.reward) === null) {
    return { ok: false, error: 'a targeted offer needs a reward — what does it pay?' };
  }

  const variant = await saveVariant(env, promotionId, {
    audience: 'targeted',
    application_channel: input.application_channel || 'issuer_direct',
    minimum_spend_cents: input.minimum_spend_cents ?? null,
    reward: input.reward,
    terms: {
      contributed: true,
      note: input.note ?? null,
      received_at: input.received_at ?? null,
    },
  });

  // Recorded as evidence too: the person is a first-hand source, and a later
  // reader of the claim table should be able to see where this came from.
  await env.DB.prepare(
    `INSERT INTO promotion_claims
       (promotion_id, field_name, value_json, source_url, source_type, source_tier, extracted_at, confidence, supporting_excerpt)
     VALUES (?, 'targeted_variant', ?, 'app://contributed', 'user', 1, date('now'), 'high', ?)`
  )
    .bind(promotionId, JSON.stringify(input.reward), (input.note ?? 'Reported by the cardholder').slice(0, 240))
    .run();

  return { ok: true, variant };
}

/** Variant keys this person reported being offered, for one promotion. */
export async function invitedKeys(env: Env, promotionId: number): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT variant_key FROM promotion_variants WHERE promotion_id = ? AND audience = 'targeted'`
  )
    .bind(promotionId)
    .all<{ variant_key: string }>();
  // Every targeted variant in this database is one the person put there —
  // discovery never writes one, because an invitation is not something a
  // public article can establish for an individual.
  return (results ?? []).map((r) => r.variant_key);
}

/**
 * Read variants out of what an extractor found.
 *
 * Only the channel variant is inferred, and only when the article says it: a
 * comparison site's exclusive is a different offer from the bank's own, and
 * that difference is what these rows exist to keep.
 */
export function variantsFromCandidate(c: {
  application_channel?: string | null;
  eligibility_text?: string | null;
  minimum_spend_cents?: number | null;
  reward?: VariantReward;
}): VariantInput[] {
  const audience = variantAudienceOf(c.eligibility_text ?? '');
  const channel = c.application_channel || 'unknown';
  if (audience === 'everyone' && channel === 'unknown') return [];
  return [
    {
      audience,
      application_channel: channel,
      minimum_spend_cents: c.minimum_spend_cents ?? null,
      reward: c.reward && rewardText(c.reward) !== null ? c.reward : null,
    },
  ];
}

/**
 * Who an eligibility sentence is talking about.
 *
 * Deliberately narrow. "New to bank" has an unambiguous meaning and is worth
 * reading; anything vaguer stays 'everyone', because guessing that an offer
 * excludes someone is as harmful as guessing that it includes them.
 */
/**
 * Which variant audience a sentence describes.
 *
 * Named apart from the promotion-level `audienceOf` in audience.ts, which
 * answers a different question: that one says who the *offer* is for, this one
 * says which *shape* of a multi-shape offer a sentence belongs to. Sharing a
 * name made them look interchangeable, and conflating two audience concepts is
 * the mistake this whole area is being cleaned up for.
 */
export function variantAudienceOf(text: string): Audience {
  const t = text.toLowerCase();
  if (/\b(targeted|by invitation|invitation only|if you (were|are) invited|emailed to selected)\b/.test(t)) {
    return 'targeted';
  }
  if (/\b(new[- ]to[- ]bank|new customers? only|first[- ]time (card ?holders?|applicants?)|principal card ?holders? who (have|has) not)\b/.test(t)) {
    return 'new_customer';
  }
  if (/\b(existing (customers?|card ?holders?) only|for existing (customers?|card ?holders?))\b/.test(t)) {
    return 'existing';
  }
  return 'everyone';
}
