import type { Env } from '../types';
import type { EarnRule } from '../rules';

/**
 * Versioned reward rules.
 *
 * The rule is simple and the whole point of this module: a published rule set
 * is never edited when the economics change. It is closed off on the day before
 * the new one opens, and every calculation — historical or current — picks the
 * version that was in force on the day it is asking about. A bank moving its
 * rates in October must not silently rewrite what August earned.
 */

export interface RuleSet {
  id: number;
  product_id: number;
  version: number;
  effective_from: string;
  effective_until: string | null;
  published_at: string | null;
  status: 'draft' | 'published' | 'superseded' | 'withdrawn';
  source_id: number | null;
  verified_at: string | null;
  notes: string | null;
}

export interface RuleExclusion {
  id: number;
  rule_set_id: number;
  mcc: string;
  reason: string | null;
  scope: string;
}

/** Publishing refused because two versions would both cover the same day. */
export class RuleVersionOverlap extends Error {
  readonly code = 'RULE_VERSION_OVERLAP';
  constructor(
    message: string,
    readonly conflicts: { version: number; effective_from: string; effective_until: string | null }[]
  ) {
    super(message);
  }
}

const dayBefore = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * The rule set in force for a product on a given date.
 *
 * Superseded versions are included deliberately: a transaction from August has
 * to find August's rules, and by now those have been superseded. Drafts and
 * withdrawn versions are not — a draft has never applied to anything.
 */
export async function ruleSetOn(env: Env, productId: number, date: string): Promise<RuleSet | null> {
  return (
    (await env.DB.prepare(
      `SELECT * FROM rule_sets
        WHERE product_id = ?
          AND status IN ('published', 'superseded')
          AND effective_from <= ?
          AND (effective_until IS NULL OR effective_until >= ?)
        ORDER BY effective_from DESC
        LIMIT 1`
    )
      .bind(productId, date, date)
      .first<RuleSet>()) ?? null
  );
}

export async function rulesIn(env: Env, ruleSetId: number): Promise<EarnRule[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM earn_rules WHERE rule_set_id = ? ORDER BY priority DESC, id`
  )
    .bind(ruleSetId)
    .all<EarnRule>();
  return results ?? [];
}

export async function exclusionsIn(env: Env, ruleSetId: number): Promise<RuleExclusion[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM rule_exclusions WHERE rule_set_id = ?`)
    .bind(ruleSetId)
    .all<RuleExclusion>();
  return results ?? [];
}

export async function versionsOf(env: Env, productId: number): Promise<RuleSet[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM rule_sets WHERE product_id = ? ORDER BY version`
  )
    .bind(productId)
    .all<RuleSet>();
  return results ?? [];
}

/**
 * Start a new version for a product. Draft until published, so it can be built
 * up a rule at a time without ever being reachable by a calculation.
 */
export async function draftRuleSet(
  env: Env,
  productId: number,
  effectiveFrom: string,
  opts: { notes?: string | null; source_id?: number | null } = {}
): Promise<RuleSet> {
  const top = await env.DB.prepare(`SELECT MAX(version) AS v FROM rule_sets WHERE product_id = ?`)
    .bind(productId)
    .first<{ v: number | null }>();
  const version = (top?.v ?? 0) + 1;

  const ins = await env.DB.prepare(
    `INSERT INTO rule_sets (product_id, version, effective_from, status, notes, source_id)
     VALUES (?, ?, ?, 'draft', ?, ?)`
  )
    .bind(productId, version, effectiveFrom, opts.notes ?? null, opts.source_id ?? null)
    .run();

  const made = await env.DB.prepare(`SELECT * FROM rule_sets WHERE id = ?`)
    .bind(ins.meta.last_row_id)
    .first<RuleSet>();
  if (!made) throw new Error('could not create rule set');
  return made;
}

/**
 * Publish a draft, closing off whatever it replaces.
 *
 * Two invariants are enforced here rather than hoped for:
 *
 *  - No two published versions may cover the same day. An overlap is not a
 *    smaller problem than a gap; it is an ambiguous answer to "what did this
 *    card pay on the 14th", and the calculation would pick one silently.
 *  - At most one version may be open-ended. The version it replaces is closed
 *    the day before the new one opens.
 *
 * D1 has no interactive transactions, so the close and the publish are ordered
 * so that a failure between them leaves a gap rather than an overlap: a missing
 * answer is recoverable, a wrong one is not noticed.
 */
export async function publishRuleSet(env: Env, ruleSetId: number, publishedAt: string): Promise<RuleSet> {
  const set = await env.DB.prepare(`SELECT * FROM rule_sets WHERE id = ?`).bind(ruleSetId).first<RuleSet>();
  if (!set) throw new Error('no such rule set');
  if (set.status === 'published') return set;
  if (set.status !== 'draft') throw new Error(`a ${set.status} rule set cannot be published`);

  const { results: others } = await env.DB.prepare(
    `SELECT * FROM rule_sets
      WHERE product_id = ? AND id <> ? AND status IN ('published', 'superseded')
      ORDER BY effective_from`
  )
    .bind(set.product_id, set.id)
    .all<RuleSet>();

  // The version this one takes over from: the open-ended current one, if it
  // starts earlier. Closing it is expected, not a conflict.
  const openEnded = (others ?? []).filter((o) => o.effective_until === null);
  const predecessor = openEnded.find((o) => o.effective_from < set.effective_from) ?? null;

  const covers = (a: RuleSet, day: string) =>
    a.effective_from <= day && (a.effective_until === null || a.effective_until >= day);

  const conflicts = (others ?? []).filter((o) => {
    if (o === predecessor) return false;
    // Two closed ranges overlap unless one ends before the other starts.
    const aEnd = set.effective_until ?? '9999-12-31';
    const bEnd = o.effective_until ?? '9999-12-31';
    return set.effective_from <= bEnd && o.effective_from <= aEnd;
  });

  if (conflicts.length) {
    throw new RuleVersionOverlap(
      `version ${set.version} covers days already covered by version${conflicts.length > 1 ? 's' : ''} ` +
        conflicts.map((c) => c.version).join(', '),
      conflicts.map((c) => ({ version: c.version, effective_from: c.effective_from, effective_until: c.effective_until }))
    );
  }

  // A predecessor that already runs past the new start is closed the day
  // before it, which is what makes the handover exact rather than overlapping.
  if (predecessor && (predecessor.effective_until === null || predecessor.effective_until >= set.effective_from)) {
    const close = dayBefore(set.effective_from);
    if (close < predecessor.effective_from) {
      throw new RuleVersionOverlap(
        `version ${set.version} would start on or before version ${predecessor.version} does`,
        [{ version: predecessor.version, effective_from: predecessor.effective_from, effective_until: predecessor.effective_until }]
      );
    }
    await env.DB.prepare(`UPDATE rule_sets SET effective_until = ?, status = 'superseded' WHERE id = ?`)
      .bind(close, predecessor.id)
      .run();
  }

  await env.DB.prepare(`UPDATE rule_sets SET status = 'published', published_at = ? WHERE id = ?`)
    .bind(publishedAt, set.id)
    .run();

  const out = await env.DB.prepare(`SELECT * FROM rule_sets WHERE id = ?`).bind(set.id).first<RuleSet>();
  if (!out) throw new Error('rule set vanished while publishing');
  void covers;
  return out;
}

/** Every day covered twice for a product — the invariant, checkable after the fact. */
export async function overlaps(
  env: Env,
  productId: number
): Promise<{ a: number; b: number; from: string; until: string | null }[]> {
  const sets = (await versionsOf(env, productId)).filter((s) => s.status === 'published' || s.status === 'superseded');
  const out: { a: number; b: number; from: string; until: string | null }[] = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i];
      const b = sets[j];
      const aEnd = a.effective_until ?? '9999-12-31';
      const bEnd = b.effective_until ?? '9999-12-31';
      if (a.effective_from <= bEnd && b.effective_from <= aEnd) {
        out.push({
          a: a.version,
          b: b.version,
          from: a.effective_from > b.effective_from ? a.effective_from : b.effective_from,
          until: aEnd < bEnd ? a.effective_until : b.effective_until,
        });
      }
    }
  }
  return out;
}
