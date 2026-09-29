import { recommendV2 } from '../../recommendations/recommend';
import { EFFECTIVE_DATE, money, resolveRange, today } from '../../spend';
import type { Env } from '../../types';

/**
 * What using the wrong card actually cost.
 *
 * Every posted transaction is replayed through the same engine that would have
 * advised on it, **priced against the rules in force on its own date**. That
 * last part is why this is worth building here rather than anywhere else: the
 * rule sets are versioned with effective dates, so an August purchase is
 * judged by August's rates rather than by whatever the bank publishes today.
 * Without that the report would invent losses every time a card changed.
 *
 * Two rules this obeys, because a report like this is easy to make dishonest:
 *
 *  - **Hindsight is declared, not hidden.** The engine sees each purchase in
 *    isolation and a cap it would have filled differently. So the figure is
 *    what a perfectly-informed person would have earned, and the text says so
 *    rather than implying the difference was all avoidable.
 *  - **It does not tell anyone to spend.** It compares cards on spending that
 *    already happened. Nothing here suggests buying anything.
 */

export interface LeakageRow {
  transaction_id: number;
  occurred_at: string;
  merchant: string | null;
  category: string | null;
  amount_cents: number;
  used_card: string;
  used_value_cents: number;
  best_card: string;
  best_value_cents: number;
  /** Always ≥ 0: the engine cannot do worse than what happened. */
  lost_cents: number;
  /** Null when nothing was lost, so the list of regrets is only regrets. */
  reason: string | null;
}

export interface LeakagePattern {
  used_card: string;
  better_card: string;
  category: string;
  occurrences: number;
  lost_cents: number;
  summary: string;
}

export interface LeakageReport {
  from: string | null;
  to: string | null;
  label: string;
  transactions_examined: number;
  priced: number;
  /** Rows the engine could not price, and why — silence here would be a lie. */
  unpriced: { reason: string; count: number }[];
  actual_value_cents: number;
  best_value_cents: number;
  leakage_cents: number;
  /** Of everything that could have been earned, the share actually earned. */
  capture_rate: number;
  by_category: { category: string; lost_cents: number; occurrences: number }[];
  patterns: LeakagePattern[];
  worst: LeakageRow[];
  caveats: string[];
  as_of: string;
}

/** Below this a difference is rounding, not a decision. */
export const MATERIAL_LOSS_CENTS = 20;

export async function rewardLeakage(
  env: Env,
  opts: { range?: string | null; from?: string | null; to?: string | null; limit?: number } = {}
): Promise<LeakageReport> {
  // An explicit window wins. Defaulting the named range unconditionally made
  // `from`/`to` silently ignored, so a caller asking about January was
  // answered about last month — with numbers that looked entirely plausible.
  const named = opts.from || opts.to ? (opts.range ?? null) : (opts.range ?? 'lastmonth');
  const { from, to, label } = resolveRange(env, named, opts.from ?? null, opts.to ?? null);
  const limit = Math.min(400, opts.limit ?? 300);

  const wheres = [`t.amount_cents > 0`, `t.status <> 'refund'`];
  const args: unknown[] = [];
  if (from) {
    wheres.push(`${EFFECTIVE_DATE} >= ?`);
    args.push(from);
  }
  if (to) {
    wheres.push(`${EFFECTIVE_DATE} <= ?`);
    args.push(to);
  }

  const { results } = await env.DB.prepare(
    `SELECT t.id, t.amount_cents, t.occurred_at, t.posted_at, t.merchant, t.mcc, t.category, t.channel,
            c.nickname, c.product
       FROM transactions t JOIN cards c ON c.id = t.card_id
      WHERE ${wheres.join(' AND ')}
      ORDER BY ${EFFECTIVE_DATE} DESC
      LIMIT ?`
  )
    .bind(...args, limit)
    .all<any>();

  const rows: LeakageRow[] = [];
  const unpriced = new Map<string, number>();
  let actual = 0;
  let best = 0;

  for (const t of results ?? []) {
    // The date the purchase was judged on, so a versioned rule set resolves to
    // the version that was in force — not the one published since.
    const on = t.posted_at ?? t.occurred_at;

    let rec;
    try {
      rec = await recommendV2(
        env,
        { amount_cents: t.amount_cents, mcc: t.mcc, category: t.category, channel: t.channel },
        { on }
      );
    } catch (e) {
      // The reason, not just the fact. A count of unexplained failures is a
      // report nobody can act on, and "the engine could not price it" was
      // exactly as useful as silence.
      const reason = `the engine could not price it: ${(e as Error).message}`;
      unpriced.set(reason, (unpriced.get(reason) ?? 0) + 1);
      continue;
    }

    const top = rec.recommendation;
    if (!top) {
      unpriced.set('no card could be recommended for it', (unpriced.get('no card could be recommended for it') ?? 0) + 1);
      continue;
    }

    // What the card actually used would have earned, taken from the same run
    // rather than from the stored expectation: the stored figure was priced by
    // whatever the app believed at the time, and comparing two different
    // engines would report their disagreement as a loss.
    const used = [top, ...rec.alternatives, ...rec.ineligible].find((p) => p.card?.nickname === t.nickname);
    if (!used) {
      unpriced.set('the card it was put on is closed or unknown to the engine', (unpriced.get('the card it was put on is closed or unknown to the engine') ?? 0) + 1);
      continue;
    }

    const usedValue = used.reward?.value_cents ?? 0;
    const bestValue = top.reward?.value_cents ?? 0;
    const lost = Math.max(0, bestValue - usedValue);

    actual += usedValue;
    best += bestValue;

    rows.push({
      transaction_id: t.id,
      occurred_at: on,
      merchant: t.merchant,
      category: t.category,
      amount_cents: t.amount_cents,
      used_card: t.nickname,
      used_value_cents: usedValue,
      best_card: top.card?.nickname ?? '',
      best_value_cents: bestValue,
      lost_cents: lost,
      reason:
        lost >= MATERIAL_LOSS_CENTS
          ? `${top.card?.product ?? 'another card'} would have earned $${money(lost)} more here`
          : null,
    });
  }

  // --- where it went ---------------------------------------------------------
  const byCategory = new Map<string, { lost_cents: number; occurrences: number }>();
  for (const r of rows) {
    if (r.lost_cents < MATERIAL_LOSS_CENTS) continue;
    const key = r.category ?? 'uncategorised';
    const cur = byCategory.get(key) ?? { lost_cents: 0, occurrences: 0 };
    cur.lost_cents += r.lost_cents;
    cur.occurrences++;
    byCategory.set(key, cur);
  }

  // The repeated mistake is worth more than the expensive one-off: it is the
  // only kind a person can do something about next month.
  const byPattern = new Map<string, LeakagePattern>();
  for (const r of rows) {
    if (r.lost_cents < MATERIAL_LOSS_CENTS || r.used_card === r.best_card) continue;
    const key = `${r.used_card}|${r.best_card}|${r.category ?? 'uncategorised'}`;
    const cur =
      byPattern.get(key) ??
      ({
        used_card: r.used_card,
        better_card: r.best_card,
        category: r.category ?? 'uncategorised',
        occurrences: 0,
        lost_cents: 0,
        summary: '',
      } as LeakagePattern);
    cur.occurrences++;
    cur.lost_cents += r.lost_cents;
    byPattern.set(key, cur);
  }

  const patterns = [...byPattern.values()]
    .filter((p) => p.occurrences >= 2)
    .sort((a, b) => b.lost_cents - a.lost_cents)
    .slice(0, 5)
    .map((p) => ({
      ...p,
      summary:
        `You used ${p.used_card} for ${p.occurrences} ${p.category} purchase${p.occurrences === 1 ? '' : 's'} ` +
        `where ${p.better_card} would have earned more — $${money(p.lost_cents)} in total.`,
    }));

  const leakage = Math.max(0, best - actual);
  const caveats: string[] = [
    'Judged against the rules that were in force on each purchase’s own date, not today’s.',
    'This is what perfect foresight would have earned. Each purchase is priced on its own, so a cap a different card would have filled is not accounted for — the real avoidable figure is smaller.',
  ];
  if (unpriced.size) {
    caveats.push('Some purchases could not be priced and are left out rather than counted as no loss.');
  }

  return {
    from,
    to,
    label,
    transactions_examined: (results ?? []).length,
    priced: rows.length,
    unpriced: [...unpriced.entries()].map(([reason, count]) => ({ reason, count })),
    actual_value_cents: actual,
    best_value_cents: best,
    leakage_cents: leakage,
    capture_rate: best > 0 ? Math.round((actual / best) * 1000) / 1000 : 1,
    by_category: [...byCategory.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.lost_cents - a.lost_cents),
    patterns,
    worst: rows
      .filter((r) => r.lost_cents >= MATERIAL_LOSS_CENTS)
      .sort((a, b) => b.lost_cents - a.lost_cents)
      .slice(0, 10),
    caveats,
    as_of: today(env),
  };
}
