import { addMonths, today } from './spend';
import type { Card, EligibilityResult, Env, Predicate, RuleDecision, RuleResult, RuleVerdict } from './types';

/**
 * Deterministic evaluator. Claude's job (done by hand, in the Pro app) is only to
 * turn T&C prose into predicates; the verdict itself is computed here from your
 * own card history. A wrong "eligible" costs a hard pull and a 12-month cooldown,
 * so anything the rules cannot decide returns `unknown` and surfaces for review
 * rather than being guessed.
 */
export function evaluateRule(pred: Predicate, cards: Card[], env: Env): { verdict: RuleResult['verdict']; reason: string } {
  const now = today(env);
  const sameIssuer = (i: string) => cards.filter((c) => c.issuer.toLowerCase() === i.toLowerCase());
  const sameProduct = (k: string) => cards.filter((c) => c.product_key === k);
  const held = (c: Card) => c.opened_at != null;

  switch (pred.type) {
    case 'never_held_product': {
      const hits = sameProduct(pred.product_key).filter(held);
      return hits.length
        ? { verdict: 'fail', reason: `You have held ${pred.product_key} (opened ${hits[0].opened_at}).` }
        : { verdict: 'pass', reason: `No record of ever holding ${pred.product_key}.` };
    }

    case 'no_product_within_months': {
      const cutoff = addMonths(now, -pred.months);
      const hits = sameProduct(pred.product_key).filter((c) => held(c) && (c.closed_at ?? now) >= cutoff);
      return hits.length
        ? {
            verdict: 'fail',
            reason: `Held ${pred.product_key} within the last ${pred.months} months (closed ${hits[0].closed_at ?? 'still open'}). Eligible from ${addMonths(hits[0].closed_at ?? now, pred.months)}.`,
          }
        : { verdict: 'pass', reason: `No ${pred.product_key} in the last ${pred.months} months.` };
    }

    case 'no_issuer_card_within_months': {
      const cutoff = addMonths(now, -pred.months);
      const hits = sameIssuer(pred.issuer).filter((c) => held(c) && (c.closed_at ?? now) >= cutoff);
      if (!hits.length) return { verdict: 'pass', reason: `No ${pred.issuer} card in the last ${pred.months} months.` };
      const latest = hits.reduce((a, b) => ((a.closed_at ?? now) > (b.closed_at ?? now) ? a : b));
      return {
        verdict: 'fail',
        reason: `Held ${pred.issuer} ${latest.product} within ${pred.months} months. Eligible from ${addMonths(latest.closed_at ?? now, pred.months)}.`,
      };
    }

    case 'new_to_bank': {
      const hits = sameIssuer(pred.issuer).filter(held);
      return hits.length
        ? { verdict: 'fail', reason: `Not new-to-bank: you hold or held ${pred.issuer} ${hits[0].product}.` }
        : { verdict: 'pass', reason: `No ${pred.issuer} card on record.` };
    }

    case 'no_signup_bonus_within_months': {
      const cutoff = addMonths(now, -pred.months);
      const hits = sameIssuer(pred.issuer).filter((c) => c.signup_bonus_at && c.signup_bonus_at >= cutoff);
      return hits.length
        ? {
            verdict: 'fail',
            reason: `Took a ${pred.issuer} sign-up bonus on ${hits[0].signup_bonus_at}. Eligible from ${addMonths(hits[0].signup_bonus_at!, pred.months)}.`,
          }
        : { verdict: 'pass', reason: `No ${pred.issuer} sign-up bonus in the last ${pred.months} months.` };
    }

    // Income and any free-text clause are not knowable from card history alone.
    case 'min_income':
      return { verdict: 'unknown', reason: `Requires income of $${(pred.amount_cents / 100).toLocaleString()}/${pred.period} — confirm yourself.` };

    case 'manual_review':
      return { verdict: 'unknown', reason: pred.note };

    default:
      return { verdict: 'unknown', reason: 'Unrecognized clause type — review the T&C directly.' };
  }
}

export async function evaluateOffer(env: Env, offerId: number): Promise<EligibilityResult> {
  const { results: rows } = await env.DB.prepare(
    `SELECT id, predicate, quote, decision, decided_at, note FROM offer_rules WHERE offer_id = ? ORDER BY id`
  )
    .bind(offerId)
    .all<{
      id: number;
      predicate: string;
      quote: string | null;
      decision: RuleDecision | null;
      decided_at: string | null;
      note: string | null;
    }>();

  // All cards, including closed ones — history is exactly what eligibility turns on.
  const { results: cards } = await env.DB.prepare(`SELECT * FROM cards`).all<Card>();

  const rules: RuleResult[] = (rows ?? []).map((r) => {
    let pred: Predicate;
    try {
      pred = JSON.parse(r.predicate);
    } catch {
      pred = { type: 'manual_review', note: 'Malformed predicate JSON.' };
    }
    const { verdict: computed, reason } = evaluateRule(pred, cards ?? [], env);

    // Your answer wins, because you can see things the card table cannot — an
    // income figure, a card closed before you started tracking. It is recorded
    // as yours, with the computed verdict kept beside it.
    const decided: RuleVerdict | null =
      r.decision === 'fail' ? 'fail' : r.decision === 'pass' || r.decision === 'na' ? 'pass' : null;

    return {
      id: r.id,
      verdict: decided ?? computed,
      computed,
      reason,
      decision: r.decision ?? null,
      decided_at: r.decided_at ?? null,
      note: r.note ?? null,
      overridden: decided != null && computed !== 'unknown' && decided !== computed,
      predicate: pred,
      quote: r.quote,
    };
  });

  const verdict = rules.some((r) => r.verdict === 'fail')
    ? 'not_eligible'
    : rules.some((r) => r.verdict === 'unknown') || rules.length === 0
      ? 'needs_review'
      : 'eligible';

  return {
    verdict,
    rules,
    open_questions: rules.filter((r) => r.verdict === 'unknown').length,
    decided_by_you: rules.filter((r) => r.decision != null).length,
  };
}

/** Record (or with `null`, withdraw) your answer to one clause. */
export async function decideRule(
  env: Env,
  ruleId: number,
  decision: RuleDecision | null,
  note?: string | null
): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT offer_id FROM offer_rules WHERE id = ?`)
    .bind(ruleId)
    .first<{ offer_id: number }>();
  if (!row) return null;

  await env.DB.prepare(
    `UPDATE offer_rules SET decision = ?, decided_at = ?, note = ? WHERE id = ?`
  )
    .bind(decision, decision ? today(env) : null, note ?? null, ruleId)
    .run();
  return row.offer_id;
}
