import { evaluate, type EarnRule } from './rules';
import { money, statementCycle, today, EFFECTIVE_DATE } from './spend';
import type { Card, Env } from './types';

export interface AuditRow {
  id: number;
  occurred_at: string;
  posted_at: string | null;
  merchant: string | null;
  category: string | null;
  mcc: string | null;
  amount_cents: number;
  card: string;
  expected_miles: number;
  expected_cashback_cents: number;
  actual_miles: number | null;
  actual_cashback_cents: number | null;
  /** Positive means the bank gave less than expected. */
  shortfall_miles: number;
  shortfall_cents: number;
  status: 'matched' | 'short' | 'over' | 'unrecorded';
  reason: string | null;
}

export interface Audit {
  period: { start: string; end: string; label: string };
  card_id: number | null;
  totals: {
    expected_miles: number;
    actual_miles: number;
    expected_cashback_cents: number;
    actual_cashback_cents: number;
    shortfall_miles: number;
    shortfall_cents: number;
    checked: number;
    unrecorded: number;
  };
  rows: AuditRow[];
  findings: string[];
}

/**
 * Did the bank actually pay what the rules said it would? This is the check
 * nothing else in the app performs: every other number is a prediction, and a
 * prediction nobody reconciles is just a guess with a decimal point.
 */
export async function buildAudit(
  env: Env,
  opts: { cardId?: number; from?: string; to?: string } = {}
): Promise<Audit> {
  const { results: cards } = await env.DB.prepare(`SELECT * FROM cards`).all<Card>();
  const card = opts.cardId ? (cards ?? []).find((c) => c.id === opts.cardId) : undefined;

  // Default to the statement cycle that most recently closed — the period a
  // bank has actually finished paying out on.
  let start = opts.from ?? null;
  let end = opts.to ?? null;
  let label = 'custom';
  if (!start || !end) {
    const ref = card ?? (cards ?? [])[0];
    if (ref) {
      const cycle = statementCycle(ref.statement_day, env);
      const prevEnd = new Date(Date.parse(cycle.start) - 86400_000).toISOString().slice(0, 10);
      const prevStart = new Date(Date.parse(prevEnd) - 30 * 86400_000).toISOString().slice(0, 10);
      start = prevStart;
      end = prevEnd;
      label = 'last closed cycle';
    } else {
      start = today(env).slice(0, 8) + '01';
      end = today(env);
      label = 'this month';
    }
  }

  const where = [`t.amount_cents > 0`, `${EFFECTIVE_DATE.replace(/posted_at/g, 't.posted_at').replace(/occurred_at/g, 't.occurred_at')} >= ?`,
                 `${EFFECTIVE_DATE.replace(/posted_at/g, 't.posted_at').replace(/occurred_at/g, 't.occurred_at')} <= ?`];
  const binds: unknown[] = [start, end];
  if (opts.cardId) {
    where.push('t.card_id = ?');
    binds.push(opts.cardId);
  }

  const { results: txns } = await env.DB.prepare(
    `SELECT t.*, c.product FROM transactions t JOIN cards c ON c.id = t.card_id
     WHERE ${where.join(' AND ')} ORDER BY t.occurred_at, t.id`
  )
    .bind(...binds)
    .all<any>();

  const { results: rules } = await env.DB.prepare(`SELECT * FROM earn_rules WHERE active = 1`).all<EarnRule>();
  const { results: exclusions } = await env.DB.prepare(
    `SELECT card_id, mcc, reason FROM exclusions WHERE active = 1`
  ).all<any>();

  const rows: AuditRow[] = [];
  const totals = {
    expected_miles: 0,
    actual_miles: 0,
    expected_cashback_cents: 0,
    actual_cashback_cents: 0,
    shortfall_miles: 0,
    shortfall_cents: 0,
    checked: 0,
    unrecorded: 0,
  };

  for (const t of txns ?? []) {
    const c = (cards ?? []).find((x) => x.id === t.card_id);
    if (!c) continue;

    // Prefer what was recorded at the time; recompute only when it is absent,
    // since caps mean a figure computed today is not the figure that applied.
    let expMiles = t.expected_miles;
    let expCash = t.expected_cashback_cents;
    if (expMiles === null && expCash === null) {
      const e = await evaluate(
        env,
        c,
        { amount_cents: t.amount_cents, mcc: t.mcc, category: t.category, channel: t.channel },
        { rules: rules ?? [], exclusions: exclusions ?? [] }
      );
      expMiles = e.miles;
      expCash = e.cashback_cents;
    }
    expMiles = expMiles ?? 0;
    expCash = expCash ?? 0;

    const hasActual = t.actual_miles !== null || t.actual_cashback_cents !== null;
    const actMiles = t.actual_miles;
    const actCash = t.actual_cashback_cents;

    const shortMiles = hasActual ? Math.max(0, expMiles - (actMiles ?? 0)) : 0;
    const shortCash = hasActual ? Math.max(0, expCash - (actCash ?? 0)) : 0;
    const overMiles = hasActual ? Math.max(0, (actMiles ?? 0) - expMiles) : 0;

    let status: AuditRow['status'] = 'unrecorded';
    let reason: string | null = null;
    if (hasActual) {
      if (shortMiles > 0 || shortCash > 0) {
        status = 'short';
        // The likeliest explanations, in the order worth checking.
        if (expMiles > 0 && (actMiles ?? 0) === 0) {
          reason = t.mcc
            ? `No bonus credited. MCC ${t.mcc} may be excluded on this card, or the cap was already used.`
            : 'No bonus credited. The merchant code may not qualify, or the cap was already used.';
        } else {
          reason = 'Credited less than expected — likely a cap reached part-way, or a rate that has changed.';
        }
      } else if (overMiles > 0) {
        status = 'over';
        reason = 'Credited more than expected — a promotion, or a rate better than recorded.';
      } else {
        status = 'matched';
      }
      totals.checked++;
    } else {
      totals.unrecorded++;
    }

    totals.expected_miles += expMiles;
    totals.expected_cashback_cents += expCash;
    if (hasActual) {
      totals.actual_miles += actMiles ?? 0;
      totals.actual_cashback_cents += actCash ?? 0;
      totals.shortfall_miles += shortMiles;
      totals.shortfall_cents += shortCash;
    }

    rows.push({
      id: t.id,
      occurred_at: t.occurred_at,
      posted_at: t.posted_at,
      merchant: t.merchant,
      category: t.category,
      mcc: t.mcc,
      amount_cents: t.amount_cents,
      card: t.product,
      expected_miles: expMiles,
      expected_cashback_cents: expCash,
      actual_miles: actMiles,
      actual_cashback_cents: actCash,
      shortfall_miles: shortMiles,
      shortfall_cents: shortCash,
      status,
      reason,
    });
  }

  const findings: string[] = [];
  if (totals.checked === 0) {
    findings.push(
      'Nothing to compare yet. Record what the bank credited against a transaction and the audit can check it.'
    );
  } else {
    if (totals.shortfall_miles > 0) {
      findings.push(`${totals.shortfall_miles.toLocaleString()} miles short of what the rules predicted.`);
    }
    if (totals.shortfall_cents > 0) {
      findings.push(`$${money(totals.shortfall_cents)} of cashback short of what the rules predicted.`);
    }
    if (!totals.shortfall_miles && !totals.shortfall_cents) {
      findings.push(`All ${totals.checked} checked transaction(s) credited as expected.`);
    }
    const worst = rows.filter((r) => r.status === 'short').sort((a, b) => b.shortfall_miles - a.shortfall_miles)[0];
    if (worst) {
      findings.push(
        `Largest gap: $${money(worst.amount_cents)} at ${worst.merchant ?? 'an unnamed merchant'} — expected ` +
          `${worst.expected_miles.toLocaleString()} miles, received ${(worst.actual_miles ?? 0).toLocaleString()}.`
      );
    }
  }
  if (totals.unrecorded > 0) {
    findings.push(`${totals.unrecorded} transaction(s) have no credited figure recorded, so they were not checked.`);
  }

  return {
    period: { start: start!, end: end!, label },
    card_id: opts.cardId ?? null,
    totals,
    rows,
    findings,
  };
}
