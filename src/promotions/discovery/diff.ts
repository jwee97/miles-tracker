import { today } from '../../spend';
import type { Env } from '../../types';
import { recordChange } from './publish';

/**
 * What changed since last month.
 *
 * A monthly roundup is a snapshot of the market. Diffing October's against
 * September's turns fifteen offers into four things worth reading — and that is
 * the difference between a system that reduces work and one that produces a
 * longer list every month.
 */

export type RoundupChange = 'new' | 'changed' | 'unchanged' | 'possibly_expired';

export interface RoundupEntry {
  key: string;
  title: string;
  issuer: string | null;
  product_id: number | null;
  reward: string;
  minimum_spend_cents: number | null;
  end_at: string | null;
}

export interface RoundupDiff {
  change: RoundupChange;
  entry: RoundupEntry;
  previous?: RoundupEntry;
  /** Said the way a person would say it. */
  detail: string;
}

const keyOf = (e: { issuer: string | null; product_id: number | null; title: string }) =>
  `${(e.issuer ?? '?').toLowerCase()}|${e.product_id ?? e.title.toLowerCase().slice(0, 40)}`;

/**
 * Compare two snapshots.
 *
 * An offer missing from the newer roundup is `possibly_expired`, never
 * `expired`: a roundup is one publication's view, and an offer it stopped
 * listing may simply not have fitted. Ending an offer on that evidence alone
 * would remove a live campaign from someone's recommendations.
 */
export function diffRoundups(previous: RoundupEntry[], current: RoundupEntry[]): RoundupDiff[] {
  const before = new Map(previous.map((e) => [keyOf(e), e]));
  const out: RoundupDiff[] = [];

  for (const entry of current) {
    const k = keyOf(entry);
    const old = before.get(k);
    if (!old) {
      out.push({ change: 'new', entry, detail: `${entry.title} — ${entry.reward}, not in the previous roundup.` });
      continue;
    }
    before.delete(k);

    const rewardChanged = old.reward !== entry.reward;
    const spendChanged = (old.minimum_spend_cents ?? null) !== (entry.minimum_spend_cents ?? null);
    const endChanged = (old.end_at ?? null) !== (entry.end_at ?? null);

    if (!rewardChanged && !spendChanged && !endChanged) {
      out.push({ change: 'unchanged', entry, previous: old, detail: `${entry.title} — unchanged.` });
      continue;
    }

    const bits: string[] = [];
    if (rewardChanged) bits.push(`${old.reward} → ${entry.reward}`);
    if (spendChanged) {
      bits.push(
        `minimum ${old.minimum_spend_cents ? `$${(old.minimum_spend_cents / 100).toFixed(2)}` : 'none'} → ${
          entry.minimum_spend_cents ? `$${(entry.minimum_spend_cents / 100).toFixed(2)}` : 'none'
        }`
      );
    }
    if (endChanged) bits.push(`ends ${old.end_at ?? 'open'} → ${entry.end_at ?? 'open'}`);
    out.push({ change: 'changed', entry, previous: old, detail: `${entry.title} — ${bits.join('; ')}.` });
  }

  for (const gone of before.values()) {
    out.push({
      change: 'possibly_expired',
      entry: gone,
      detail: `${gone.title} — in the previous roundup and not this one. It may have ended, or simply not been listed.`,
    });
  }

  const order: RoundupChange[] = ['new', 'changed', 'possibly_expired', 'unchanged'];
  return out.sort((a, b) => order.indexOf(a.change) - order.indexOf(b.change));
}

/** The entries of a roundup, as stored candidates. */
export async function roundupEntries(env: Env, discoveryId: number): Promise<RoundupEntry[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, issuer, raw_product_name, resolved_product_id, terms_json
       FROM promotion_candidates WHERE discovery_id = ? ORDER BY id`
  )
    .bind(discoveryId)
    .all<any>();

  return (results ?? []).map((r) => {
    let terms: any = {};
    try {
      terms = r.terms_json ? JSON.parse(r.terms_json) : {};
    } catch {
      terms = {};
    }
    const reward = terms.reward_miles
      ? `${terms.reward_miles} miles`
      : terms.reward_points
        ? `${terms.reward_points} points`
        : terms.reward_cashback_cents
          ? `$${(terms.reward_cashback_cents / 100).toFixed(2)}`
          : terms.bonus_pct
            ? `${terms.bonus_pct}%`
            : 'no reward read';
    return {
      key: String(r.id),
      title: `${r.issuer ?? ''} ${r.raw_product_name ?? ''}`.trim() || 'unnamed',
      issuer: r.issuer,
      product_id: r.resolved_product_id,
      reward,
      minimum_spend_cents: terms.minimum_spend_cents ?? null,
      end_at: terms.application_end ?? null,
    };
  });
}

/** The roundup before this one, from the same source. */
export async function previousRoundup(env: Env, discoveryId: number): Promise<number | null> {
  const item = await env.DB.prepare(`SELECT source_id, discovered_at FROM discovery_items WHERE id = ?`)
    .bind(discoveryId)
    .first<{ source_id: number; discovered_at: string }>();
  if (!item) return null;

  const prev = await env.DB.prepare(
    `SELECT id FROM discovery_items
      WHERE source_id = ? AND item_type = 'roundup' AND id <> ? AND discovered_at < ?
      ORDER BY discovered_at DESC LIMIT 1`
  )
    .bind(item.source_id, discoveryId, item.discovered_at)
    .first<{ id: number }>();
  return prev?.id ?? null;
}

export async function diffAgainstPrevious(env: Env, discoveryId: number): Promise<RoundupDiff[] | null> {
  const prevId = await previousRoundup(env, discoveryId);
  if (!prevId) return null;
  return diffRoundups(await roundupEntries(env, prevId), await roundupEntries(env, discoveryId));
}

export interface ExpiryReport {
  expired: { id: number; title: string; end_at: string }[];
  kept: { id: number; title: string; reason: string }[];
}

/**
 * Offers that have run out.
 *
 * Expired, never deleted: tracked requirements, expected rewards and past
 * reconciliations all point back at the promotion that caused them. An offer
 * with a live extension candidate is held rather than expired, because an
 * extension arriving a day late should not make a running campaign disappear
 * and then reappear.
 */
export async function expireFinished(env: Env): Promise<ExpiryReport> {
  const now = today(env);
  const report: ExpiryReport = { expired: [], kept: [] };

  const { results } = await env.DB.prepare(
    `SELECT id, title, end_at FROM promotions
      WHERE status = 'published' AND end_at IS NOT NULL AND end_at < ?`
  )
    .bind(now)
    .all<{ id: number; title: string; end_at: string }>();

  for (const p of results ?? []) {
    const extension = await env.DB.prepare(
      `SELECT id FROM promotion_candidates
        WHERE promotion_id = ? AND status IN ('review', 'corroborating', 'extracted')`
    )
      .bind(p.id)
      .first();
    if (extension) {
      report.kept.push({ id: p.id, title: p.title, reason: 'an extension is waiting to be reviewed' });
      continue;
    }

    await env.DB.prepare(`UPDATE promotions SET status = 'expired' WHERE id = ?`).bind(p.id).run();
    await recordChange(env, p.id, 'expired', { end_at: p.end_at }, null, null);
    report.expired.push(p);
  }
  return report;
}
