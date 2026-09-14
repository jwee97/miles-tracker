import { evaluateOffer } from './eligibility';
import type { EligibilityResult, Env } from './types';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export interface ExtractionResult {
  rules_saved: number;
  decisions_kept: number;
  eligibility: EligibilityResult;
}

/**
 * Store what Claude extracted from a T&C. Rules are replaced wholesale, which
 * would otherwise throw away answers you already gave — so decisions are keyed
 * by the clause they belong to and restored onto the matching new rule. A
 * re-extraction that changes a clause correctly loses that clause's answer.
 */
export async function saveExtraction(env: Env, offerId: number, data: any): Promise<ExtractionResult> {
  const offer = await env.DB.prepare(`SELECT id FROM offers WHERE id = ?`).bind(offerId).first<{ id: number }>();
  if (!offer) throw new Error(`no such offer: ${offerId}`);

  await env.DB.prepare(
    `UPDATE offers SET issuer=?, product=?, product_key=?, bonus_miles=?, bonus_note=?,
       min_spend_cents=?, spend_window_days=?, valid_from=?, valid_until=?,
       status='tracked', extracted_at=datetime('now') WHERE id = ?`
  )
    .bind(
      data.issuer ?? null,
      data.product ?? null,
      data.product_key ?? (data.issuer && data.product ? slug(`${data.issuer}_${data.product}`) : null),
      data.bonus_miles ?? null,
      data.bonus_note ?? null,
      data.min_spend != null ? Math.round(Number(data.min_spend) * 100) : null,
      data.spend_window_days ?? null,
      data.valid_from ?? null,
      data.valid_until ?? null,
      offerId
    )
    .run();

  const { results: old } = await env.DB.prepare(
    `SELECT predicate, quote, decision, decided_at, note FROM offer_rules WHERE offer_id = ? AND decision IS NOT NULL`
  )
    .bind(offerId)
    .all<{ predicate: string; quote: string | null; decision: string; decided_at: string | null; note: string | null }>();
  const kept = new Map((old ?? []).map((r) => [`${r.predicate}|${r.quote ?? ''}`, r]));

  await env.DB.prepare(`DELETE FROM offer_rules WHERE offer_id = ?`).bind(offerId).run();

  let saved = 0;
  let restored = 0;
  for (const r of data.rules ?? []) {
    const predicate = JSON.stringify(r.predicate ?? r);
    const quote = r.quote ?? null;
    const prior = kept.get(`${predicate}|${quote ?? ''}`);
    await env.DB.prepare(
      `INSERT INTO offer_rules (offer_id, predicate, quote, decision, decided_at, note) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(offerId, predicate, quote, prior?.decision ?? null, prior?.decided_at ?? null, prior?.note ?? null)
      .run();
    saved++;
    if (prior) restored++;
  }

  return { rules_saved: saved, decisions_kept: restored, eligibility: await evaluateOffer(env, offerId) };
}

/** Parse the JSON Claude returned, tolerating a fenced code block around it. */
export function parseExtraction(raw: string): any {
  const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  return JSON.parse(text);
}

export const OFFER_STATUSES = ['pending', 'tracked', 'applied', 'dismissed', 'expired'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** Days until an offer's end date, negative once it has passed. */
export function daysUntil(dateIso: string | null, today: string): number | null {
  if (!dateIso) return null;
  const t = Date.parse(dateIso + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.parse(today + 'T00:00:00Z')) / 86_400_000);
}

export interface OfferSweep {
  expired: number;
  deleted: number;
  retention_days: number;
}

/**
 * An offer with a past end date is no longer a decision you can make. It is
 * marked expired rather than deleted on the day, so a bonus you already applied
 * for keeps its record, and removed once it is old enough to be useless.
 *
 * An offer you marked applied is never swept: that one is your own history.
 */
export async function sweepExpiredOffers(env: Env, todayIso: string): Promise<OfferSweep> {
  const marked = await env.DB.prepare(
    `UPDATE offers SET status = 'expired'
      WHERE valid_until IS NOT NULL AND valid_until < ?
        AND status IN ('pending', 'tracked')`
  )
    .bind(todayIso)
    .run();

  const days = offerRetentionDays(env);
  let deleted = 0;
  if (days > 0) {
    const cutoff = new Date(Date.parse(todayIso + 'T00:00:00Z') - days * 86_400_000).toISOString().slice(0, 10);
    const res = await env.DB.prepare(
      `DELETE FROM offers WHERE status = 'expired' AND valid_until IS NOT NULL AND valid_until < ?`
    )
      .bind(cutoff)
      .run();
    deleted = res.meta.changes ?? 0;
  }

  return { expired: marked.meta.changes ?? 0, deleted, retention_days: days };
}

export function offerRetentionDays(env: Env): number {
  const n = parseInt(env.OFFER_RETENTION_DAYS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 90;
}
