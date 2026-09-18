import type { EarnRule } from '../rules';
import type { Env } from '../types';
import { productById, STALE_AFTER_DAYS, type CardProduct } from './products';
import { draftRuleSet, exclusionsIn, publishRuleSet, ruleSetOn, rulesIn, versionsOf, type RuleSet } from './rulesets';

/**
 * Getting a rate change into the app without breaking what came before.
 *
 * The workflow is fixed, and the order matters:
 *
 *   a source changes → draft a new version → compare it to the live one
 *                    → a person reads the comparison → publish
 *
 * Automated extraction may write the draft. It may never write the published
 * version. Everything in this module is arranged so that the only way rules
 * that a calculation can reach have changed is that someone looked at a diff
 * and pressed a button.
 */

export type VerificationStatus = 'verified' | 'needs_review' | 'stale' | 'draft' | 'migrated_unverified';

export const VERIFICATION_STATUSES: VerificationStatus[] = [
  'verified',
  'needs_review',
  'stale',
  'draft',
  'migrated_unverified',
];

/**
 * Copy the live version into a new draft, so a change is an edit of what is
 * actually in force rather than a blank page. Starting from blank is how a rule
 * nobody meant to remove disappears.
 */
export async function draftFromCurrent(
  env: Env,
  productId: number,
  effectiveFrom: string,
  opts: { notes?: string | null; source_id?: number | null; today?: string } = {}
): Promise<{ draft: RuleSet; copied_rules: number; copied_exclusions: number; based_on: number | null }> {
  const live = await ruleSetOn(env, productId, opts.today ?? effectiveFrom);
  const draft = await draftRuleSet(env, productId, effectiveFrom, {
    notes: opts.notes ?? (live ? `based on version ${live.version}` : 'first version'),
    source_id: opts.source_id ?? null,
  });

  let copiedRules = 0;
  let copiedExclusions = 0;
  if (live) {
    for (const r of await rulesIn(env, live.id)) {
      await env.DB.prepare(
        `INSERT INTO earn_rules (rule_set_id, category, mpd, reward_type, mcc_include, mcc_exclude, channel,
           priority, min_txn_cents, min_tier_cents, program_key, cap_cents, cap_group, cap_window, note, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      )
        .bind(
          draft.id,
          r.category,
          r.mpd,
          r.reward_type,
          r.mcc_include ?? null,
          r.mcc_exclude ?? null,
          r.channel ?? null,
          (r as any).priority ?? 0,
          (r as any).min_txn_cents ?? null,
          (r as any).min_tier_cents ?? null,
          (r as any).program_key ?? null,
          r.cap_cents ?? null,
          (r as any).cap_group ?? null,
          (r as any).cap_window ?? null,
          r.note ?? null
        )
        .run();
      copiedRules++;
    }
    for (const e of await exclusionsIn(env, live.id)) {
      await env.DB.prepare(`INSERT INTO rule_exclusions (rule_set_id, mcc, reason) VALUES (?, ?, ?)`)
        .bind(draft.id, e.mcc, e.reason)
        .run();
      copiedExclusions++;
    }
  }

  return { draft, copied_rules: copiedRules, copied_exclusions: copiedExclusions, based_on: live?.id ?? null };
}

export interface RuleChange {
  kind: 'added' | 'removed' | 'changed';
  category: string;
  /** A sentence, because a diff nobody reads is a diff that approves itself. */
  summary: string;
  before?: string;
  after?: string;
}

export interface RuleSetDiff {
  from: { id: number; version: number } | null;
  to: { id: number; version: number };
  rules: RuleChange[];
  exclusions: RuleChange[];
  /** True when nothing about what the card pays would change. */
  identical: boolean;
}

const rateOf = (r: EarnRule) => (r.reward_type === 'cashback' ? `${r.mpd}%` : `${r.mpd} mpd`);

const describe = (r: EarnRule) => {
  const bits = [rateOf(r)];
  if (r.cap_cents) bits.push(`capped at $${(r.cap_cents / 100).toFixed(2)}`);
  if (r.mcc_include) bits.push(`codes ${r.mcc_include}`);
  if (r.mcc_exclude) bits.push(`except ${r.mcc_exclude}`);
  if (r.channel) bits.push(r.channel);
  if ((r as any).min_tier_cents) bits.push(`from the $${((r as any).min_tier_cents / 100).toFixed(0)} tier`);
  return bits.join(', ');
};

/** What identifies a rule across versions: the thing it pays on. */
const ruleKey = (r: EarnRule) => `${r.category}|${r.channel ?? ''}|${(r as any).min_tier_cents ?? ''}`;

/**
 * What would change if this draft were published.
 *
 * Written to be read aloud. The point is not to show that two rows differ but
 * to let a person say "no, they did not cut the online rate to 1.2" before it
 * becomes the number every recommendation is made from.
 */
export async function diffRuleSets(env: Env, toId: number, fromId?: number | null): Promise<RuleSetDiff> {
  const to = await env.DB.prepare(`SELECT * FROM rule_sets WHERE id = ?`).bind(toId).first<RuleSet>();
  if (!to) throw new Error('no such rule set');

  const from = fromId
    ? await env.DB.prepare(`SELECT * FROM rule_sets WHERE id = ?`).bind(fromId).first<RuleSet>()
    : await ruleSetOn(env, to.product_id, to.effective_from);

  const after = await rulesIn(env, to.id);
  const before = from && from.id !== to.id ? await rulesIn(env, from.id) : [];

  const beforeBy = new Map(before.map((r) => [ruleKey(r), r]));
  const afterBy = new Map(after.map((r) => [ruleKey(r), r]));

  const rules: RuleChange[] = [];
  for (const [key, r] of afterBy) {
    const old = beforeBy.get(key);
    if (!old) {
      rules.push({ kind: 'added', category: r.category, summary: `${r.category} now earns ${describe(r)}`, after: describe(r) });
    } else if (describe(old) !== describe(r)) {
      rules.push({
        kind: 'changed',
        category: r.category,
        summary: `${r.category} goes from ${describe(old)} to ${describe(r)}`,
        before: describe(old),
        after: describe(r),
      });
    }
  }
  for (const [key, r] of beforeBy) {
    if (!afterBy.has(key)) {
      rules.push({
        kind: 'removed',
        category: r.category,
        summary: `${r.category} no longer earns ${describe(r)}`,
        before: describe(r),
      });
    }
  }

  const beforeEx = new Set((from && from.id !== to.id ? await exclusionsIn(env, from.id) : []).map((e) => e.mcc));
  const afterEx = new Set((await exclusionsIn(env, to.id)).map((e) => e.mcc));
  const exclusions: RuleChange[] = [];
  for (const mcc of afterEx) {
    if (!beforeEx.has(mcc)) exclusions.push({ kind: 'added', category: mcc, summary: `${mcc} now earns nothing` });
  }
  for (const mcc of beforeEx) {
    if (!afterEx.has(mcc)) exclusions.push({ kind: 'removed', category: mcc, summary: `${mcc} is no longer excluded` });
  }

  return {
    from: from && from.id !== to.id ? { id: from.id, version: from.version } : null,
    to: { id: to.id, version: to.version },
    rules,
    exclusions,
    identical: rules.length === 0 && exclusions.length === 0,
  };
}

export interface PublishOutcome {
  rule_set: RuleSet;
  diff: RuleSetDiff;
  product: CardProduct | null;
}

/**
 * Publish a draft and record that a person stood behind it.
 *
 * Publishing is what marks a product verified — not a separate button someone
 * might press without looking. The claim being made is "these rules are what
 * the bank says", and the only moment anyone is in a position to make it is
 * after reading the comparison.
 */
export async function reviewAndPublish(
  env: Env,
  ruleSetId: number,
  today: string,
  opts: { verified?: boolean } = {}
): Promise<PublishOutcome> {
  const diff = await diffRuleSets(env, ruleSetId);
  const set = await publishRuleSet(env, ruleSetId, today);

  await env.DB.prepare(`UPDATE rule_sets SET verified_at = ? WHERE id = ?`).bind(today, set.id).run();

  if (opts.verified !== false) {
    await env.DB.prepare(
      `UPDATE card_products SET verification_status = 'verified', last_verified_at = ? WHERE id = ?`
    )
      .bind(today, set.product_id)
      .run();
  }

  return { rule_set: set, diff, product: await productById(env, set.product_id) };
}

export interface ConfirmResult {
  ok: boolean;
  error?: string;
  product?: CardProduct;
  rules_confirmed?: number;
}

/**
 * Confirming that a product's published rules are what the bank says.
 *
 * Publishing a rule set marks a product verified, and that is the right
 * default — the claim "these rules are what the bank says" should be made at
 * the moment somebody has read the comparison, not by a button pressed in
 * passing. But it left no route at all for the commonest case: the rules
 * already published are correct, somebody has just re-read the bank's page,
 * and nothing needs to change. Those products stayed "never checked" forever,
 * with the app telling their holder something was wrong and offering no way to
 * put it right.
 *
 * So this is the other route, and it keeps the same standard rather than
 * lowering it. A URL is required, because the claim is about a document; it is
 * recorded as a source, so the confirmation is auditable afterwards; and it
 * refuses a product that has no published rules, where there is nothing to
 * confirm and the real answer is to enter them.
 */
export async function confirmProductRates(
  env: Env,
  productId: number,
  today: string,
  opts: { source_url: string; note?: string | null }
): Promise<ConfirmResult> {
  const product = await productById(env, productId);
  if (!product) return { ok: false, error: 'no such product' };

  const url = (opts.source_url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: "a link to the page you read is required — the claim is that these rules match a bank document" };
  }

  const current = await env.DB.prepare(
    `SELECT id FROM rule_sets WHERE product_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1`
  )
    .bind(productId)
    .first<{ id: number }>();
  if (!current) {
    return {
      ok: false,
      error: 'this product has no published rules yet, so there is nothing to confirm — add them first',
    };
  }

  const rules = await env.DB.prepare(`SELECT COUNT(*) AS n FROM earn_rules WHERE rule_set_id = ?`)
    .bind(current.id)
    .first<{ n: number }>();

  await env.DB.prepare(
    `INSERT INTO product_sources (product_id, source_type, source_url, title, retrieved_at)
     VALUES (?, 'manual_verified', ?, ?, ?)`
  )
    .bind(productId, url, (opts.note ?? 'Confirmed against the bank by hand').slice(0, 200), today)
    .run();

  await env.DB.prepare(
    `UPDATE card_products SET verification_status = 'verified', last_verified_at = ? WHERE id = ?`
  )
    .bind(today, productId)
    .run();

  await env.DB.prepare(`UPDATE rule_sets SET verified_at = ? WHERE id = ?`).bind(today, current.id).run();

  return { ok: true, product: (await productById(env, productId)) ?? undefined, rules_confirmed: rules?.n ?? 0 };
}

export interface StaleProduct {
  product: CardProduct;
  reason: string;
  days_since: number | null;
  held_by: string[];
}

/**
 * Products whose numbers should not be trusted without another look.
 *
 * Reported rather than hidden. A stale rule is still the best answer the app
 * has, and refusing to use it would leave a card that earns nothing at all —
 * so it is used, and the recommendation made from it says it is uncertain.
 */
export async function staleProducts(env: Env, today: string): Promise<StaleProduct[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.* FROM card_products p
      WHERE EXISTS (SELECT 1 FROM cards c WHERE c.product_id = p.id AND c.closed_at IS NULL)
      ORDER BY p.issuer, p.product_name`
  ).all<CardProduct>();

  const out: StaleProduct[] = [];
  for (const p of results ?? []) {
    const days = p.last_verified_at
      ? Math.round((Date.parse(today) - Date.parse(p.last_verified_at)) / 86_400_000)
      : null;

    let reason: string | null = null;
    if (p.verification_status === 'needs_review') reason = 'its source page has changed since it was read';
    else if (p.verification_status === 'draft' || p.verification_status === 'migrated_unverified')
      reason = 'it has never been checked against a bank document';
    else if (days !== null && days > STALE_AFTER_DAYS) reason = `last checked ${days} days ago`;
    else if (days === null) reason = 'it has never been checked against a bank document';
    if (!reason) continue;

    const { results: holders } = await env.DB.prepare(
      `SELECT nickname FROM cards WHERE product_id = ? AND closed_at IS NULL ORDER BY nickname`
    )
      .bind(p.id)
      .all<{ nickname: string }>();

    out.push({ product: p, reason, days_since: days, held_by: (holders ?? []).map((h) => h.nickname) });
  }

  // The ones you actually hold matter most, and among those the oldest.
  return out.sort((a, b) => b.held_by.length - a.held_by.length || (b.days_since ?? 1e9) - (a.days_since ?? 1e9));
}

/** Every version of a product, for the admin view. */
export const allVersions = versionsOf;
