import { today } from '../spend';
import type { Env } from '../types';
import { termsOf, type Promotion } from './model';
import { currencyOf, type PromotionCurrency } from './relevance';
import { rewardOf, rewardText, variantsFor, type Variant } from './variants';

/**
 * Why the app believes an offer is current.
 *
 * Everything on this screen exists because the numbers came from somewhere the
 * person did not choose. They did not read The MileLion; the app did, and then
 * told them a bank is paying 16,000 miles. That is only usable if they can see
 * who said it, when, whether anyone else agreed, and what has changed since —
 * which is exactly what this returns.
 *
 * It never asserts more than it has. "One blog said this three weeks ago" is a
 * legitimate answer, and printing it plainly is more useful than a confidence
 * percentage that hides it.
 */

export interface EvidenceSource {
  url: string;
  host: string;
  tier: number;
  type: string;
  /** What that source actually said, in its own sentence. */
  excerpt: string | null;
  seen_at: string | null;
  /** The fields this source is evidence for. */
  fields: string[];
}

export interface EvidenceField {
  field: string;
  label: string;
  value: unknown;
  /** Every distinct value claimed for this field, and who claimed each. */
  claims: { value: unknown; hosts: string[]; tier: number }[];
  agreed: boolean;
}

export interface EvidenceTimeline {
  at: string;
  change_type: string;
  detail: string;
  source_url: string | null;
}

export interface PromotionEvidence {
  promotion: Promotion;
  terms: Record<string, unknown>;
  currency: PromotionCurrency;
  /** The one-line answer, for the top of the screen. */
  headline: string;
  sources: EvidenceSource[];
  fields: EvidenceField[];
  timeline: EvidenceTimeline[];
  variants: { variant: Variant; reward_text: string | null }[];
  /** True when nothing but the app's own record backs this. */
  unsourced: boolean;
  as_of: string;
}

const FIELD_LABEL: Record<string, string> = {
  reward_miles: 'Miles paid',
  reward_points: 'Points paid',
  reward_cashback_cents: 'Cashback paid',
  bonus_pct: 'Bonus',
  minimum_spend_cents: 'Minimum spend',
  window_days: 'Spending window',
  application_end: 'Applications close',
  application_start: 'Applications open',
  registration_required: 'Registration',
  eligibility_text: 'Who it is for',
  targeted_variant: 'A targeted offer you reported',
};

export const hostOf = (url: string): string => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const parse = (json: string | null): unknown => {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
};

/** A change event, said as a sentence rather than two JSON blobs. */
export function changeSentence(e: {
  change_type: string;
  old_value_json: string | null;
  new_value_json: string | null;
}): string {
  const before = parse(e.old_value_json) as Record<string, unknown> | null;
  const after = parse(e.new_value_json) as Record<string, unknown> | null;
  switch (e.change_type) {
    case 'created':
      return 'First recorded.';
    case 'extended':
      return `Extended to ${String(after?.application_end ?? after?.end_at ?? 'a later date')}.`;
    case 'expired':
      return 'Ended.';
    case 'withdrawn':
      return 'Withdrawn before it was due to end.';
    case 'reward_changed':
      return `The reward moved from ${String(before?.reward_miles ?? before?.reward_cashback_cents ?? '?')} to ${String(
        after?.reward_miles ?? after?.reward_cashback_cents ?? '?'
      )}.`;
    case 'spend_changed':
      return `The spending requirement moved from ${String(before?.minimum_spend_cents ?? '?')} to ${String(
        after?.minimum_spend_cents ?? '?'
      )} cents.`;
    case 'eligibility_changed':
      return 'Who can take it changed.';
    default:
      return 'The terms changed.';
  }
}

export async function promotionEvidence(env: Env, promotionId: number): Promise<PromotionEvidence | null> {
  const p = await env.DB.prepare(`SELECT * FROM promotions WHERE id = ?`).bind(promotionId).first<Promotion>();
  if (!p) return null;

  const now = today(env);
  const currency = currencyOf(p, now);

  const { results: claims } = await env.DB.prepare(
    `SELECT * FROM promotion_claims WHERE promotion_id = ? ORDER BY source_tier, id`
  )
    .bind(promotionId)
    .all<{
      field_name: string;
      value_json: string | null;
      source_url: string;
      source_type: string;
      source_tier: number;
      extracted_at: string | null;
      supporting_excerpt: string | null;
    }>();

  // Sources, one per URL. The same article claiming five fields is one source,
  // not five — counting otherwise is how a single blog post starts to look
  // like a consensus.
  const byUrl = new Map<string, EvidenceSource>();
  for (const c of claims ?? []) {
    const existing = byUrl.get(c.source_url);
    if (existing) {
      if (!existing.fields.includes(c.field_name)) existing.fields.push(c.field_name);
      if (!existing.excerpt && c.supporting_excerpt) existing.excerpt = c.supporting_excerpt;
      continue;
    }
    byUrl.set(c.source_url, {
      url: c.source_url,
      host: hostOf(c.source_url),
      tier: c.source_tier,
      type: c.source_type,
      excerpt: c.supporting_excerpt,
      seen_at: c.extracted_at,
      fields: [c.field_name],
    });
  }
  const sources = [...byUrl.values()].sort((a, b) => a.tier - b.tier);

  // Fields, with every value anyone claimed. Disagreement is kept visible:
  // two sources saying different numbers is information, and picking one
  // silently is the thing this whole system exists not to do.
  const terms = termsOf(p) as unknown as Record<string, unknown>;
  const fieldMap = new Map<string, Map<string, { value: unknown; hosts: Set<string>; tier: number }>>();
  for (const c of claims ?? []) {
    const key = c.value_json ?? 'null';
    let values = fieldMap.get(c.field_name);
    if (!values) fieldMap.set(c.field_name, (values = new Map()));
    const seen = values.get(key);
    if (seen) {
      seen.hosts.add(hostOf(c.source_url));
      seen.tier = Math.min(seen.tier, c.source_tier);
    } else {
      values.set(key, { value: parse(c.value_json), hosts: new Set([hostOf(c.source_url)]), tier: c.source_tier });
    }
  }

  const fields: EvidenceField[] = [...fieldMap.entries()].map(([field, values]) => {
    const list = [...values.values()]
      .map((v) => ({ value: v.value, hosts: [...v.hosts].sort(), tier: v.tier }))
      .sort((a, b) => a.tier - b.tier || b.hosts.length - a.hosts.length);
    return {
      field,
      label: FIELD_LABEL[field] ?? field.replace(/_/g, ' '),
      value: terms[field] ?? list[0]?.value ?? null,
      claims: list,
      agreed: list.length <= 1,
    };
  });

  const { results: events } = await env.DB.prepare(
    `SELECT * FROM promotion_change_events WHERE promotion_id = ? ORDER BY id DESC LIMIT 20`
  )
    .bind(promotionId)
    .all<{
      change_type: string;
      old_value_json: string | null;
      new_value_json: string | null;
      source_url: string | null;
      detected_at: string | null;
      created_at: string | null;
    }>();

  const timeline: EvidenceTimeline[] = (events ?? []).map((e) => ({
    at: e.detected_at ?? (e.created_at ?? '').slice(0, 10),
    change_type: e.change_type,
    detail: changeSentence(e),
    source_url: e.source_url,
  }));

  const variants = (await variantsFor(env, promotionId)).map((v) => ({
    variant: v,
    reward_text: rewardText(rewardOf(v)),
  }));

  const hosts = new Set(sources.map((s) => s.host));
  const official = sources.some((s) => s.tier === 1);
  const headline = official
    ? `Confirmed on the bank's own page.`
    : hosts.size >= 2
      ? `${hosts.size} independent sites say this. The bank's own page has not been read.`
      : hosts.size === 1
        ? `One site says this: ${[...hosts][0]}. Nobody else has been found repeating it.`
        : `No source is recorded for this offer — it was entered by hand.`;

  return {
    promotion: p,
    terms,
    currency,
    headline,
    sources,
    fields,
    timeline,
    variants,
    unsourced: sources.length === 0,
    as_of: now,
  };
}
