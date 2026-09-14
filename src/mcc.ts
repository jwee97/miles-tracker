import { ruleMatches, type EarnRule } from './rules';
import type { Card, Env } from './types';

/**
 * The merchant-code table, seen from your own cards.
 *
 * Every figure here is computed with the same `ruleMatches` the earn engine
 * uses, so the table cannot drift away from what a purchase would actually
 * earn. What it adds is the other direction: instead of asking "what does this
 * purchase earn", it asks "which codes does this card treat differently".
 */

export type CellState = 'excluded' | 'bonus' | 'base' | 'none';

export interface MccCell {
  card_id: number;
  nickname: string;
  state: CellState;
  /** Miles per dollar, or percent back when reward_type is 'cashback'. */
  rate: number;
  reward_type: 'miles' | 'cashback';
  category: string | null;
  cap_cents: number | null;
  cap_window: string | null;
  /** Why this code earns nothing, when it earns nothing. */
  reason: string | null;
}

export interface MccRow {
  code: string;
  description: string;
  category: string;
  /** Excluded on every card, rather than on some of them. */
  excluded_everywhere: boolean;
  exclusion_reason: string | null;
  cells: MccCell[];
  /** Your own spend on this code, so the common ones can be sorted first. */
  spend_cents: number;
  txn_count: number;
}

export interface MccMatrix {
  cards: { id: number; nickname: string; product: string; issuer: string; base_mpd: number }[];
  rows: MccRow[];
  categories: string[];
  summary: {
    codes: number;
    excluded_everywhere: number;
    excluded_somewhere: number;
    bonus_codes: number;
    codes_you_have_used: number;
    /** Spend in the last 12 months on codes excluded by the card it was on. */
    excluded_spend_cents: number;
  };
  /** Whether excluded spend counts toward a minimum on this deployment. */
  min_spend_counts_excluded: boolean;
}

export interface MatrixOptions {
  /** Substring match on code, description or category. */
  q?: string;
  /** 'excluded' | 'bonus' | 'used' | 'all' */
  filter?: string;
  category?: string;
}

export async function mccMatrix(env: Env, opts: MatrixOptions = {}): Promise<MccMatrix> {
  const { results: cards } = await env.DB.prepare(
    `SELECT * FROM cards WHERE closed_at IS NULL ORDER BY issuer, product`
  ).all<Card>();
  const { results: rules } = await env.DB.prepare(`SELECT * FROM earn_rules WHERE active = 1`).all<EarnRule>();
  const { results: exclusions } = await env.DB.prepare(
    `SELECT card_id, mcc, reason FROM exclusions WHERE active = 1`
  ).all<{ card_id: number | null; mcc: string; reason: string | null }>();
  const { results: codes } = await env.DB.prepare(
    `SELECT code, description, category FROM mcc_codes ORDER BY category, code`
  ).all<{ code: string; description: string; category: string }>();

  // Your own history, so the codes you actually use can be found first.
  const { results: used } = await env.DB.prepare(
    `SELECT mcc, SUM(amount_cents) AS spend, COUNT(*) AS n
       FROM transactions WHERE mcc IS NOT NULL GROUP BY mcc`
  ).all<{ mcc: string; spend: number; n: number }>();
  const usage = new Map((used ?? []).map((u) => [u.mcc, u]));

  const mileValue = parseFloat(env.MILE_VALUE_CENTS || '1.5') || 1.5;
  const rows: MccRow[] = [];

  for (const c of codes ?? []) {
    const blanket = (exclusions ?? []).filter((e) => e.mcc === c.code);
    const everywhere = blanket.some((e) => e.card_id === null);

    const cells: MccCell[] = (cards ?? []).map((card) => {
      const hit = blanket.find((e) => e.card_id === null || e.card_id === card.id);
      if (hit) {
        return {
          card_id: card.id,
          nickname: card.nickname,
          state: 'excluded',
          rate: 0,
          reward_type: 'miles',
          category: null,
          cap_cents: null,
          cap_window: null,
          reason: hit.reason ?? 'excluded',
        };
      }

      // The same matching the engine does, minus the cap state — a cap is about
      // how much you have already spent this month, not about the code.
      const mine = (rules ?? []).filter((r) => r.card_id === card.id);
      const purchase = { amount_cents: null, mcc: c.code, category: c.category, channel: null };
      const matching = mine.filter((r) => (r.category === '*' || r.category === c.category) && ruleMatches(r, purchase));

      const worth = (r: EarnRule) => (r.reward_type === 'cashback' ? r.mpd * 100 : r.mpd * mileValue);
      const best = matching.sort((a, b) => worth(b) - worth(a))[0];
      const fallback = mine.find((r) => r.category === '*');

      if (!best) {
        return {
          card_id: card.id,
          nickname: card.nickname,
          state: 'none',
          rate: 0,
          reward_type: 'miles',
          category: null,
          cap_cents: null,
          cap_window: null,
          reason: mine.length ? 'no rule covers this code' : 'no earn rules recorded for this card',
        };
      }

      return {
        card_id: card.id,
        nickname: card.nickname,
        // A bonus is anything above what the card pays on everything else.
        state: fallback && best.id !== fallback.id && worth(best) > worth(fallback) ? 'bonus' : 'base',
        rate: best.mpd,
        reward_type: best.reward_type,
        category: best.category,
        cap_cents: best.cap_cents,
        cap_window: best.cap_window,
        reason: null,
      };
    });

    const u = usage.get(c.code);
    rows.push({
      code: c.code,
      description: c.description,
      category: c.category,
      excluded_everywhere: everywhere,
      exclusion_reason: blanket[0]?.reason ?? null,
      cells,
      spend_cents: u?.spend ?? 0,
      txn_count: u?.n ?? 0,
    });
  }

  const filtered = rows.filter((r) => {
    if (opts.category && r.category !== opts.category) return false;
    if (opts.filter === 'excluded' && !r.cells.some((c) => c.state === 'excluded')) return false;
    if (opts.filter === 'bonus' && !r.cells.some((c) => c.state === 'bonus')) return false;
    if (opts.filter === 'used' && r.txn_count === 0) return false;
    const q = (opts.q ?? '').trim().toLowerCase();
    if (!q) return true;
    return (
      r.code.includes(q) || r.description.toLowerCase().includes(q) || r.category.toLowerCase().includes(q)
    );
  });

  // What excluded codes have actually cost you, rather than in the abstract.
  const spent = await env.DB.prepare(
    `SELECT COALESCE(SUM(t.amount_cents), 0) AS cents
       FROM transactions t
       JOIN exclusions x ON x.mcc = t.mcc AND x.active = 1 AND (x.card_id IS NULL OR x.card_id = t.card_id)
      WHERE COALESCE(t.posted_at, t.occurred_at) >= DATE('now', '-365 days')`
  ).first<{ cents: number }>();

  return {
    cards: (cards ?? []).map((c) => ({
      id: c.id,
      nickname: c.nickname,
      product: c.product,
      issuer: c.issuer,
      base_mpd: c.base_mpd,
    })),
    rows: filtered,
    categories: [...new Set(rows.map((r) => r.category))].sort(),
    summary: {
      codes: rows.length,
      excluded_everywhere: rows.filter((r) => r.excluded_everywhere).length,
      excluded_somewhere: rows.filter((r) => !r.excluded_everywhere && r.cells.some((c) => c.state === 'excluded')).length,
      bonus_codes: rows.filter((r) => r.cells.some((c) => c.state === 'bonus')).length,
      codes_you_have_used: rows.filter((r) => r.txn_count > 0).length,
      excluded_spend_cents: spent?.cents ?? 0,
    },
    min_spend_counts_excluded: (env.MIN_SPEND_COUNTS_EXCLUDED ?? '').toLowerCase() === 'true',
  };
}
