import { readCardPage, type Candidate } from '../../cardscan';
import { contentHash, fetchArticle } from '../../promotions/discovery/fetch';
import { money, today } from '../../spend';
import type { Env } from '../../types';
import { ruleSetOn } from '../rulesets';

/**
 * Noticing that a bank changed its own card.
 *
 * Maintaining rates by hand is the largest standing burden in this app, and it
 * fails quietly: a card's cap drops from $1,500 to $1,000 and every
 * recommendation stays confidently wrong until somebody happens to read the
 * page. The machinery to fix that already exists — promotion discovery
 * watches pages, notices changes, extracts claims and asks a person — and this
 * is that machinery pointed at product pages instead of blog posts.
 *
 * The architecture matters more than the extraction. **Nothing here writes a
 * rule set.** A bank's page is a claim like any other; rates are the numbers
 * every recommendation is built on, so a claim becomes a rule only when a
 * person has looked at the diff and agreed. What this produces is a question
 * with the comparison already done.
 *
 * And it only asks when something that decides money moved. A page rewritten
 * around the same rates is not a change, and asking about one teaches people
 * to dismiss the question without reading it.
 */

export interface ProposedRule {
  category: string;
  mpd: number | null;
  reward_type: 'miles' | 'cashback' | null;
  cap_cents: number | null;
  cap_window: string | null;
  quote: string;
}

export interface RuleDiff {
  field: string;
  category: string | null;
  before: unknown;
  after: unknown;
  /** True when this changes what a purchase earns. */
  material: boolean;
  summary: string;
}

export interface ChangeCandidate {
  id: number;
  product_id: number;
  product_name: string;
  issuer: string;
  source_url: string;
  detected_at: string;
  effective_from: string | null;
  material: boolean;
  proposed: ProposedRule[];
  diff: RuleDiff[];
  status: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Fold a page's separate claims into one rule per category.
 *
 * The scanner reports a rate and a cap as two findings, because a page states
 * them in two sentences. A rule holds both, so they are joined on the category
 * they describe — and a cap mentioned with no rate beside it still lands on
 * the right rule rather than becoming a rule of its own.
 */
export function mergeCandidates(candidates: Candidate[]): ProposedRule[] {
  const byCategory = new Map<string, ProposedRule>();

  for (const c of candidates) {
    if (c.kind !== 'rate' && c.kind !== 'cap') continue;
    const category = c.category ?? '*';
    const cur =
      byCategory.get(category) ??
      ({ category, mpd: null, reward_type: null, cap_cents: null, cap_window: null, quote: c.quote } as ProposedRule);

    if (c.kind === 'rate' && c.rate !== undefined) {
      // A page repeats its headline rate; the one it says most often is the
      // one it means. Ties keep the first, which is the earliest on the page.
      if (cur.mpd === null || (c.occurrences ?? 1) > 1) {
        cur.mpd = c.rate;
        cur.reward_type = c.reward_type ?? cur.reward_type;
        cur.quote = c.quote;
      }
    }
    if (c.kind === 'cap' && c.cap_cents !== undefined) {
      cur.cap_cents = c.cap_cents;
      cur.cap_window = c.cap_window ?? cur.cap_window;
    }
    byCategory.set(category, cur);
  }

  return [...byCategory.values()];
}

/** Fields whose movement changes what a purchase earns. */
const MATERIAL_FIELDS = new Set(['mpd', 'cap_cents', 'reward_type', 'cap_window']);

const label = (field: string) =>
  ({ mpd: 'rate', cap_cents: 'cap', reward_type: 'reward type', cap_window: 'cap window' })[field] ?? field;

const show = (field: string, v: unknown) => {
  if (v === null || v === undefined) return 'none';
  if (field === 'cap_cents') return `$${money(Number(v))}`;
  return String(v);
};

/**
 * Compare what a page now says against the rules in force.
 *
 * Per category, because that is the unit a rule is written in. A category the
 * page no longer mentions is reported as removed rather than silently kept:
 * a card that dropped its dining bonus is exactly the case this exists for,
 * and it shows up as an absence rather than as a changed number.
 */
export function diffRules(current: ProposedRule[], proposed: ProposedRule[]): RuleDiff[] {
  const diffs: RuleDiff[] = [];
  const categories = new Set([...current.map((r) => r.category), ...proposed.map((r) => r.category)]);

  for (const category of categories) {
    const before = current.find((r) => r.category === category);
    const after = proposed.find((r) => r.category === category);

    if (before && !after) {
      diffs.push({
        field: 'category',
        category,
        before: `${before.mpd ?? '?'} on ${category}`,
        after: null,
        material: true,
        summary: `${category} is no longer mentioned — the bonus may have been withdrawn`,
      });
      continue;
    }
    if (!before && after) {
      diffs.push({
        field: 'category',
        category,
        before: null,
        after: `${after.mpd ?? '?'} on ${category}`,
        material: true,
        summary: `${category} appears to be new: ${after.mpd ?? '?'}`,
      });
      continue;
    }
    if (!before || !after) continue;

    for (const field of ['mpd', 'reward_type', 'cap_cents', 'cap_window'] as const) {
      const b = before[field] ?? null;
      const a = after[field] ?? null;
      // An unread field is not a change. A page that does not state a cap is
      // silent about it, and reading silence as "no cap" would remove a real
      // one on every rewording.
      if (a === null) continue;
      if (b === a) continue;
      diffs.push({
        field,
        category,
        before: b,
        after: a,
        material: MATERIAL_FIELDS.has(field),
        summary: `${category}: ${label(field)} ${show(field, b)} → ${show(field, a)}`,
      });
    }
  }

  return diffs;
}

/** The rules currently in force, in the shape a page's claims are read into. */
export async function currentRules(env: Env, productId: number, on: string): Promise<ProposedRule[]> {
  const set = await ruleSetOn(env, productId, on);
  if (!set) return [];
  const { results } = await env.DB.prepare(
    `SELECT category, mpd, reward_type, cap_cents, cap_window FROM earn_rules WHERE rule_set_id = ? AND active = 1`
  )
    .bind(set.id)
    .all<any>();
  return (results ?? []).map((r) => ({ ...r, quote: '' }));
}

/** When a page says the new rates begin, if it says at all. */
export function effectiveFrom(text: string): string | null {
  const m = text.match(
    /\b(?:with effect from|effective(?: from)?|from|starting)\s+(\d{1,2}\s+[a-z]{3,9}\s+20\d\d)/i
  );
  if (!m) return null;
  const parsed = Date.parse(m[1]);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

export interface WatchReport {
  checked: number;
  unchanged: number;
  changed: number;
  material: number;
  failed: { url: string; reason: string }[];
  candidates: number[];
  as_of: string;
}

/**
 * Check every watched product page for change.
 *
 * Bounded per run, like every other fetching stage here: a Worker invocation
 * is short, and the state lives in the database so the next run continues
 * rather than restarting.
 */
export async function watchProductPages(env: Env, opts: { limit?: number } = {}): Promise<WatchReport> {
  const now = today(env);
  const limit = Math.min(20, opts.limit ?? 5);

  const { results } = await env.DB.prepare(
    `SELECT s.id, s.product_id, s.source_url, s.content_hash, p.product_name, p.issuer
       FROM product_sources s JOIN card_products p ON p.id = s.product_id
      WHERE s.active = 1 AND s.source_type IN ('bank_product_page', 'bank_rewards_terms', 'bank_terms')
      ORDER BY COALESCE(s.retrieved_at, '') ASC
      LIMIT ?`
  )
    .bind(limit)
    .all<any>();

  const report: WatchReport = {
    checked: 0,
    unchanged: 0,
    changed: 0,
    material: 0,
    failed: [],
    candidates: [],
    as_of: now,
  };

  for (const source of results ?? []) {
    report.checked++;
    let fetched;
    try {
      fetched = await fetchArticle(source.source_url);
    } catch (e) {
      report.failed.push({ url: source.source_url, reason: (e as Error).message });
      continue;
    }
    // Bank sites routinely refuse anything that is not a browser, and that is
    // an expected outcome rather than a bug. Reported in words so the screen
    // can say "this one has to be pasted in" instead of quietly never
    // checking it — a page that is never read looks identical to a page that
    // never changes, and only one of those is safe.
    if (!fetched?.text) {
      report.failed.push({ url: source.source_url, reason: fetched?.note ?? 'the page could not be read' });
      continue;
    }

    const hash = contentHash(fetched.text);
    await env.DB.prepare(`UPDATE product_sources SET retrieved_at = ? WHERE id = ?`).bind(now, source.id).run();

    if (hash === source.content_hash) {
      report.unchanged++;
      continue;
    }
    report.changed++;

    // The page moved. What it now says, read with the same extractor the
    // catalogue uses when a person pastes a page in by hand — so a rule read
    // automatically and a rule read manually cannot disagree about the same text.
    const scanned = readCardPage(`<body>${escapeHtml(fetched.text)}</body>`, source.source_url);
    const proposed = mergeCandidates(scanned.candidates);

    const current = await currentRules(env, source.product_id, now);
    const diff = diffRules(current, proposed);
    const material = diff.some((d) => d.material);
    if (material) report.material++;

    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO rule_change_candidates
         (product_id, source_id, source_url, detected_at, content_hash, proposed_json, diff_json,
          material, effective_from, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
      .bind(
        source.product_id,
        source.id,
        source.source_url,
        now,
        hash,
        JSON.stringify(proposed),
        JSON.stringify(diff),
        material ? 1 : 0,
        effectiveFrom(fetched.text)
      )
      .run();

    if (res.meta?.last_row_id) report.candidates.push(Number(res.meta.last_row_id));

    // The hash moves only once the change is recorded, so a run that dies
    // between fetching and writing re-reads the page rather than losing it.
    await env.DB.prepare(`UPDATE product_sources SET content_hash = ? WHERE id = ?`).bind(hash, source.id).run();
  }

  return report;
}

/** Changes waiting for a person, worst first. */
export async function pendingChanges(env: Env, limit = 20): Promise<ChangeCandidate[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.*, p.product_name, p.issuer
       FROM rule_change_candidates c JOIN card_products p ON p.id = c.product_id
      WHERE c.status = 'pending'
      ORDER BY c.material DESC, c.detected_at DESC
      LIMIT ?`
  )
    .bind(limit)
    .all<any>();

  const parse = <T>(s: string | null): T[] => {
    try {
      const v = JSON.parse(s ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };

  return (results ?? []).map((r) => ({
    id: r.id,
    product_id: r.product_id,
    product_name: r.product_name,
    issuer: r.issuer,
    source_url: r.source_url,
    detected_at: r.detected_at,
    effective_from: r.effective_from,
    material: !!r.material,
    proposed: parse<ProposedRule>(r.proposed_json),
    diff: parse<RuleDiff>(r.diff_json),
    status: r.status,
  }));
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
  rule_set_id?: number;
  version?: number;
  effective_from?: string;
  applied?: string;
}

/**
 * Accept a detected change: close the old rates, open the new ones.
 *
 * Goes through `draftRuleSet` and `publishRuleSet` rather than writing
 * `rule_sets` directly, because those already enforce the two invariants that
 * matter — no two published versions covering the same day, and at most one
 * open-ended version. A second code path writing the same tables is how they
 * drift apart, and the failure mode here is an ambiguous answer to "what did
 * this card pay on the 14th".
 *
 * The reviewer supplies the rules, not the page. What was extracted is the
 * starting point on the screen; what gets written is what a person agreed to,
 * which is why this takes `rules` rather than reading `proposed_json`.
 */
export async function applyChange(
  env: Env,
  candidateId: number,
  rules: ProposedRule[],
  opts: { effective_from?: string; note?: string } = {}
): Promise<ApplyResult> {
  const { draftRuleSet, publishRuleSet } = await import('../rulesets');

  const c = await env.DB.prepare(
    `SELECT * FROM rule_change_candidates WHERE id = ? AND status = 'pending'`
  )
    .bind(candidateId)
    .first<any>();
  if (!c) return { ok: false, error: 'no such pending change' };
  if (!rules.length) return { ok: false, error: 'a rule set with no rules would earn nothing' };

  const from = opts.effective_from ?? c.effective_from ?? today(env);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return { ok: false, error: 'a date the new rates start from is required' };

  const set = await draftRuleSet(env, c.product_id, from, {
    notes: opts.note ?? `from ${c.source_url}, detected ${c.detected_at}`,
    source_id: c.source_id,
  });

  for (const r of rules) {
    if (r.mpd === null) continue;
    await env.DB.prepare(
      `INSERT INTO earn_rules (rule_set_id, card_id, category, mpd, reward_type, cap_cents, cap_window, note, active)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 1)`
    )
      .bind(
        set.id,
        r.category,
        r.mpd,
        r.reward_type ?? 'miles',
        r.cap_cents,
        r.cap_window,
        r.quote ? `read from the card's own page: “${r.quote.slice(0, 180)}”` : null
      )
      .run();
  }

  const published = await publishRuleSet(env, set.id, today(env));

  await env.DB.prepare(
    `UPDATE rule_change_candidates
        SET status = 'applied', applied_rule_set_id = ?, resolved_at = ?, review_note = ?
      WHERE id = ?`
  )
    .bind(published.id, today(env), opts.note ?? null, candidateId)
    .run();

  return {
    ok: true,
    rule_set_id: published.id,
    version: published.version,
    effective_from: from,
    applied: `version ${published.version} is in force from ${from}; the version it replaces was closed the day before`,
  };
}

/** Decline a detected change, keeping why so it is not re-asked. */
export async function dismissChange(env: Env, candidateId: number, note?: string): Promise<ApplyResult> {
  const r = await env.DB.prepare(
    `UPDATE rule_change_candidates
        SET status = 'dismissed', resolved_at = ?, review_note = ?
      WHERE id = ? AND status = 'pending'`
  )
    .bind(today(env), note ?? 'the page changed but the rates did not', candidateId)
    .run();

  if (!r.meta?.changes) return { ok: false, error: 'no such pending change' };
  return { ok: true, applied: 'left as it is' };
}
