import { canonicalUrl, parseFeed } from '../../rss';
import { today } from '../../spend';
import type { Env } from '../../types';
import { classify, shouldExtract } from './classify';
import { corroborate, claimsFor } from './corroborate';
import { diffAgainstPrevious, expireFinished } from './diff';
import { extractDocument, type PromotionCandidate } from './extract';
import { contentHash, fetchArticle, USER_AGENT } from './fetch';
import { fingerprintOf } from './fingerprint';
import { trustTierForUrl } from './domains';
import { publishCandidate } from './publish';
import { resolveBest } from './resolve';
import { scanSearchSource } from './search-runner';
import { dueSources, recordScan, type DiscoverySource } from './sources';

/**
 * The discovery pipeline, run in bounded pieces.
 *
 * Every stage is a separate, resumable step writing its state to the database,
 * because a Worker invocation is short and a scan that has to finish in one go
 * is a scan that fails as soon as there is enough to do. Nothing here is
 * long-running; each call does a little and leaves a record.
 */

/**
 * What a run did, at every step of the funnel.
 *
 * Deliberately granular. "Nothing new" is the answer that hides eight
 * different failures, and each of these numbers separates two of them: a feed
 * that returned nothing from one nobody read, an article that was fetched from
 * one that refused, a candidate that was created from one that merged into an
 * offer already known.
 */
export interface DiscoveryReport {
  stage: string;
  sources_scanned: number;

  /** Feed entries offered, new or not. */
  feed_items_seen: number;

  search_queries_planned: number;
  search_queries_executed: number;
  search_results_seen: number;

  /** URLs nobody had seen before. */
  items_found: number;
  /** Of those, the ones that looked like they were about an offer. */
  relevant_items_found: number;
  items_classified: number;

  articles_fetched: number;
  articles_failed: number;

  candidates_created: number;
  /** Candidates that turned out to be a campaign already known. */
  candidates_merged: number;

  published: number;
  held_for_review: number;
  expired: number;

  notes: string[];
  as_of: string;
}

export const blankReport = (env: Env, stage: string): DiscoveryReport => ({
  stage,
  sources_scanned: 0,
  feed_items_seen: 0,
  search_queries_planned: 0,
  search_queries_executed: 0,
  search_results_seen: 0,
  items_found: 0,
  relevant_items_found: 0,
  items_classified: 0,
  articles_fetched: 0,
  articles_failed: 0,
  candidates_created: 0,
  candidates_merged: 0,
  published: 0,
  held_for_review: 0,
  expired: 0,
  notes: [],
  as_of: today(env),
});

const blank = blankReport;

/**
 * Stage one: find URLs.
 *
 * Feeds are preferred over pages wherever a publication offers one — cheap,
 * predictable, designed for exactly this, and immune to a redesign breaking the
 * parser. Nothing is fetched beyond the feed itself.
 */
export async function discover(env: Env, opts: { limit?: number; fetchImpl?: typeof fetch } = {}): Promise<DiscoveryReport> {
  const report = blank(env, 'discover');
  const f = opts.fetchImpl ?? fetch;

  for (const source of await dueSources(env, opts.limit ?? 5)) {
    report.sources_scanned++;
    if (source.source_type === 'search') {
      const searched = await scanSearchSource(env, source, { fetchImpl: opts.fetchImpl });
      report.search_queries_planned += searched.queries_planned;
      report.search_queries_executed += searched.queries_executed;
      report.search_results_seen += searched.results_seen;
      report.items_found += searched.urls_new;
      report.relevant_items_found += searched.relevant_new;
      report.notes.push(`${source.name}: ${searched.note}`);

      // Not configured is not a failed scan. Counting it as one would back the
      // source off for missing an API key it was never given, and then report
      // the backoff as a failing source.
      if (searched.configured) {
        await recordScan(env, source, {
          ok: searched.ok,
          items_seen: searched.results_seen,
          items_found: searched.urls_new,
          relevant_items_found: searched.relevant_new,
          note: searched.note,
        });
      }
      continue;
    }
    if (!source.feed_url) {
      await recordScan(env, source, { ok: false, note: 'no feed url' });
      continue;
    }

    const found = await scanFeed(env, source, f);
    report.feed_items_seen += found.items_seen;
    report.items_found += found.items_new;
    report.relevant_items_found += found.relevant_new;

    // The counts recordScan needs are the ones scanFeed measured. Passing only
    // the new-URL count here used to make every scan read as zero-yield, which
    // is how the most productive feed in the system got demoted to monthly.
    await recordScan(env, source, {
      ok: found.ok,
      items_seen: found.items_seen,
      items_found: found.items_new,
      relevant_items_found: found.relevant_new,
      note: found.note,
    });
    if (found.note) report.notes.push(`${source.name}: ${found.note}`);
  }

  return report;
}

export interface FeedScanResult {
  ok: boolean;
  /** Entries the feed offered. */
  items_seen: number;
  /** Of those, URLs nobody had seen before. */
  items_new: number;
  /** Of the new ones, those worth reading. This is what earns a source its cadence. */
  relevant_new: number;
  note: string;
}

export async function scanFeed(env: Env, source: DiscoverySource, f: typeof fetch): Promise<FeedScanResult> {
  const empty = (note: string): FeedScanResult => ({ ok: false, items_seen: 0, items_new: 0, relevant_new: 0, note });

  let body: string;
  try {
    const res = await f(source.feed_url!, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return empty(`the feed returned ${res.status}`);
    body = (await res.text()).slice(0, 600_000);
  } catch {
    return empty('the feed could not be reached');
  }

  const items = parseFeed(body);
  if (!items.length) {
    // A feed that parses to nothing is a different problem from one that
    // returned an error, and neither is "nothing new".
    return { ok: true, items_seen: 0, items_new: 0, relevant_new: 0, note: 'the feed parsed but listed no entries' };
  }

  let seen = 0;
  let added = 0;
  let relevant = 0;

  for (const item of items.slice(0, 40)) {
    const url = canonicalUrl(item.link ?? '');
    if (!url) continue;
    seen++;

    const verdict = classify(item.title ?? '', item.summary ?? '');
    const worth = shouldExtract(verdict);
    const inserted = await recordDiscoveryItem(env, {
      source_id: source.id,
      url: item.link ?? url,
      canonical_url: url,
      title: item.title ?? null,
      published_at: item.published_at ?? null,
      item_type: verdict.type,
      status: worth ? 'new' : 'irrelevant',
      classification_score: verdict.score,
      classification_signals: verdict.signals,
    });

    if (inserted.created) {
      added++;
      if (worth) relevant++;
    }
  }

  return {
    ok: true,
    items_seen: seen,
    items_new: added,
    relevant_new: relevant,
    note: added
      ? `${seen} entries, ${added} new, ${relevant} about offers`
      : `${seen} entries, all seen before`,
  };
}

/**
 * Record one article, however it was found.
 *
 * The canonical URL is unique across every source, so an article carried by
 * both a feed and a search is one row with two ways in — not two rows, two
 * fetches and a corroboration step that counts one publication twice.
 */
export async function recordDiscoveryItem(
  env: Env,
  item: {
    source_id: number;
    url: string;
    canonical_url: string;
    title: string | null;
    published_at: string | null;
    item_type: string;
    status: string;
    classification_score?: number;
    classification_signals?: string[];
    search_query?: string | null;
  }
): Promise<{ id: number | null; created: boolean }> {
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO discovery_items
       (source_id, url, canonical_url, title, published_at, item_type, status,
        classification_score, classification_signals_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      item.source_id,
      item.url,
      item.canonical_url,
      item.title,
      item.published_at,
      item.item_type,
      item.status,
      item.classification_score ?? null,
      item.classification_signals ? JSON.stringify(item.classification_signals) : null
    )
    .run();

  const created = !!ins.meta.changes;
  const row = created
    ? { id: ins.meta.last_row_id }
    : await env.DB.prepare(`SELECT id FROM discovery_items WHERE canonical_url = ?`)
        .bind(item.canonical_url)
        .first<{ id: number }>();
  if (!row) return { id: null, created };

  // How it was found is its own fact, kept even when the article itself was
  // already known: a search that keeps rediscovering what the feed already
  // carries is a query worth retiring, and this is what shows that.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO discovery_item_sources (discovery_item_id, source_id, search_query) VALUES (?, ?, ?)`
  )
    .bind(row.id, item.source_id, item.search_query ?? null)
    .run();

  return { id: row.id, created };
}

/**
 * Stage two: read the articles worth reading.
 *
 * One document can yield many candidates. A roundup listing fifteen offers is
 * the cheapest discovery there is — fifteen candidates for one fetch, against
 * fifteen attempts to read fifteen bank sites.
 */
export async function extractPending(
  env: Env,
  opts: { limit?: number; fetchImpl?: typeof fetch } = {}
): Promise<DiscoveryReport> {
  const report = blank(env, 'extract');

  const { results } = await env.DB.prepare(
    `SELECT d.*, s.trust_tier, s.name AS source_name
       FROM discovery_items d JOIN discovery_sources s ON s.id = d.source_id
      WHERE d.status = 'new' ORDER BY d.discovered_at DESC LIMIT ?`
  )
    .bind(opts.limit ?? 5)
    .all<any>();

  for (const item of results ?? []) {
    report.items_classified++;
    const fetched = await fetchArticle(item.canonical_url ?? item.url, { fetchImpl: opts.fetchImpl });

    if (fetched.status !== 'ok' || !fetched.text) {
      report.articles_failed++;
      await env.DB.prepare(`UPDATE discovery_items SET status = 'failed', fetch_note = ? WHERE id = ?`)
        .bind(`${fetched.status}: ${fetched.note}`, item.id)
        .run();
      report.notes.push(`${item.title ?? item.url}: ${fetched.note}`);
      continue;
    }

    report.articles_fetched++;
    const hash = contentHash(fetched.text);
    if (item.content_hash === hash) {
      await env.DB.prepare(`UPDATE discovery_items SET status = 'processed' WHERE id = ?`).bind(item.id).run();
      continue;
    }

    const verdict = classify(item.title ?? fetched.title ?? '', fetched.text.slice(0, 2000));
    const { candidates, roundup } = extractDocument(
      {
        title: item.title ?? fetched.title ?? '',
        url: item.canonical_url ?? item.url,
        source_id: item.source_id,
        published_at: item.published_at,
        text: fetched.text,
      },
      { roundup: verdict.roundup || item.item_type === 'roundup' }
    );

    // Trust belongs to the destination, never to the route. A MileLion article
    // is a specialist source whether a feed listed it or a search engine
    // surfaced it — scoring it as a search result would stop anything found
    // that way from ever reaching secondary verification.
    const articleUrl = item.canonical_url ?? item.url;
    const byDomain = trustTierForUrl(articleUrl);
    const tier = Math.min(byDomain, item.trust_tier ?? 5);

    for (const c of candidates) {
      await saveCandidate(env, item, c, tier);
      report.candidates_created++;
    }

    // An article read correctly that named no offer is a real outcome and used
    // to be indistinguishable from one nobody read. Saying why is what makes an
    // extractor miss debuggable instead of invisible.
    const extractionNote = candidates.length
      ? null
      : roundup
        ? 'Read as a roundup, but no card headings were found to split it on.'
        : verdict.type === 'irrelevant'
          ? 'The full text did not look like it was about an offer.'
          : 'No reward or spending figure was found in the text.';

    await env.DB.prepare(
      `UPDATE discovery_items
          SET status = 'processed', content_hash = ?, item_type = ?, fetch_note = NULL,
              extraction_note = ?, classification_score = ?, classification_signals_json = ?
        WHERE id = ?`
    )
      .bind(
        hash,
        roundup ? 'roundup' : verdict.type,
        extractionNote,
        verdict.score,
        JSON.stringify(verdict.signals),
        item.id
      )
      .run();

    if (extractionNote) report.notes.push(`${item.title ?? item.url}: ${extractionNote}`);

    if (roundup) {
      const diffs = await diffAgainstPrevious(env, item.id);
      if (diffs) {
        const interesting = diffs.filter((d) => d.change !== 'unchanged');
        report.notes.push(
          `${item.title}: ${interesting.length} of ${diffs.length} entries differ from the previous roundup.`
        );
      }
    }
  }

  return report;
}

/** Write one candidate and its claims. */
export async function saveCandidate(
  env: Env,
  item: { id: number; canonical_url: string | null; url: string; source_id: number },
  c: PromotionCandidate,
  tier: number
): Promise<number> {
  const resolution = await resolveBest(env, c.product_names, c.issuer);
  const terms: Record<string, unknown> = {
    reward_miles: c.reward.miles,
    reward_points: c.reward.points,
    reward_cashback_cents: c.reward.cashback_cents,
    bonus_pct: c.reward.bonus_pct,
    minimum_spend_cents: c.minimum_spend_cents,
    application_start: c.application_start,
    application_end: c.application_end,
    registration_required: c.registration_required,
  };

  const ins = await env.DB.prepare(
    `INSERT INTO promotion_candidates
       (discovery_id, promotion_type, issuer, raw_product_name, resolved_product_id, fingerprint,
        terms_json, application_channel, extraction_confidence, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracted')`
  )
    .bind(
      item.id,
      c.promotion_type,
      c.issuer,
      resolution.raw_product_name || c.segment_title || null,
      resolution.resolved_product_id,
      fingerprintOf(c, resolution.resolved_product_id),
      JSON.stringify(terms),
      c.application_channel,
      c.extraction_confidence
    )
    .run();

  const candidateId = ins.meta.last_row_id;
  const url = item.canonical_url ?? item.url;
  for (const claim of c.source_claims) {
    await env.DB.prepare(
      `INSERT INTO promotion_claims
         (candidate_id, field_name, value_json, source_url, source_type, source_tier, extracted_at, confidence, supporting_excerpt)
       VALUES (?, ?, ?, ?, 'article', ?, ?, ?, ?)`
    )
      .bind(candidateId, claim.field_name, JSON.stringify(claim.value), url, tier, today(env), claim.confidence, claim.supporting_excerpt)
      .run();
  }

  if (resolution.needs_review) {
    await env.DB.prepare(`UPDATE promotion_candidates SET review_reason = ? WHERE id = ?`)
      .bind(`the card could not be identified from "${resolution.raw_product_name}"`, candidateId)
      .run();
  }
  return candidateId;
}

/**
 * Stage three: weigh the evidence and either publish or ask.
 *
 * Candidates about the same campaign are folded together first, so a third
 * article about a running offer strengthens it rather than duplicating it.
 */
export async function corroboratePending(env: Env, opts: { limit?: number } = {}): Promise<DiscoveryReport> {
  const report = blank(env, 'corroborate');

  const { results } = await env.DB.prepare(
    `SELECT id, fingerprint FROM promotion_candidates WHERE status = 'extracted' ORDER BY id LIMIT ?`
  )
    .bind(opts.limit ?? 10)
    .all<{ id: number; fingerprint: string | null }>();

  for (const row of results ?? []) {
    // Another candidate with the same fingerprint is the same campaign seen by
    // another publication: its claims join this one rather than competing.
    if (row.fingerprint) {
      const twin = await env.DB.prepare(
        `SELECT id FROM promotion_candidates
          WHERE fingerprint = ? AND id <> ? AND status IN ('published', 'review', 'corroborating')
          ORDER BY id LIMIT 1`
      )
        .bind(row.fingerprint, row.id)
        .first<{ id: number }>();
      if (twin) {
        await env.DB.prepare(`UPDATE promotion_claims SET candidate_id = ? WHERE candidate_id = ?`)
          .bind(twin.id, row.id)
          .run();
        await env.DB.prepare(`UPDATE promotion_candidates SET status = 'rejected', review_reason = ? WHERE id = ?`)
          .bind(`folded into candidate #${twin.id}, which is the same campaign`, row.id)
          .run();
        report.candidates_merged++;
        report.notes.push(`Candidate #${row.id} is the same campaign as #${twin.id}; its claims were added to it.`);
        continue;
      }
    }

    const evidence = corroborate(await claimsFor(env, row.id));
    await env.DB.prepare(`UPDATE promotion_candidates SET status = 'corroborating' WHERE id = ?`).bind(row.id).run();

    const result = await publishCandidate(env, row.id);
    // applyCandidate records auto_published and published_at on the candidate,
    // so both paths write the same audit trail.
    if (result.auto && result.ok) report.published++;
    else report.held_for_review++;
    if (evidence.conflicts.length) report.notes.push(`Candidate #${row.id}: ${evidence.conflicts[0]}`);
  }

  const swept = await expireFinished(env);
  report.expired = swept.expired.length;
  for (const k of swept.kept) report.notes.push(`${k.title} kept: ${k.reason}.`);

  return report;
}

/**
 * The whole pipeline, in bounded cycles, behind one action.
 *
 * The three stages exist because a Worker invocation is short and each stage
 * has to be independently resumable. But three buttons is a debugging
 * interface, not a way to ask "is there anything new?" — and running them in
 * the wrong order, or once each, means an article discovered this minute waits
 * a day to be read.
 *
 * So this loops: discover, extract, corroborate, repeat while any of them is
 * still doing work. It stops on a quiet cycle or at the cycle limit, never on
 * its own judgement about how long it has been running.
 */
export interface PipelineOptions {
  max_cycles?: number;
  discover_limit?: number;
  extract_limit?: number;
  corroborate_limit?: number;
  fetchImpl?: typeof fetch;
}

export interface DiscoveryPipelineReport {
  discover: DiscoveryReport;
  extract: DiscoveryReport;
  corroborate: DiscoveryReport;
  summary: DiscoveryReport;
  cycles: number;
  stopped_because: 'no_work_left' | 'cycle_limit';
}

/** Fold one stage's numbers into a running total. Notes accumulate; the stage name does not. */
function merge(into: DiscoveryReport, from: DiscoveryReport): void {
  const keys: (keyof DiscoveryReport)[] = [
    'sources_scanned', 'feed_items_seen', 'search_queries_planned', 'search_queries_executed',
    'search_results_seen', 'items_found', 'relevant_items_found', 'items_classified',
    'articles_fetched', 'articles_failed', 'candidates_created', 'candidates_merged',
    'published', 'held_for_review', 'expired',
  ];
  for (const k of keys) (into[k] as number) += from[k] as number;
  into.notes.push(...from.notes);
}

export async function runDiscoveryPipeline(env: Env, opts: PipelineOptions = {}): Promise<DiscoveryPipelineReport> {
  const maxCycles = Math.max(1, Math.min(5, opts.max_cycles ?? 3));
  const discovered = blankReport(env, 'discover');
  const extracted = blankReport(env, 'extract');
  const corroborated = blankReport(env, 'corroborate');
  const summary = blankReport(env, 'run-all');

  const run = await startRun(env, 'run-all');
  let cycles = 0;
  let stopped: DiscoveryPipelineReport['stopped_because'] = 'cycle_limit';
  let error: string | null = null;

  try {
    for (let i = 0; i < maxCycles; i++) {
      cycles++;

      const d = await discover(env, { limit: opts.discover_limit ?? 8, fetchImpl: opts.fetchImpl });
      merge(discovered, d);
      merge(summary, d);

      const e = await extractPending(env, { limit: opts.extract_limit ?? 8, fetchImpl: opts.fetchImpl });
      merge(extracted, e);
      merge(summary, e);

      const c = await corroboratePending(env, { limit: opts.corroborate_limit ?? 16 });
      merge(corroborated, c);
      merge(summary, c);

      // A cycle that moved nothing anywhere means there is nothing left to do,
      // not that something went wrong.
      const moved =
        d.items_found > 0 ||
        e.items_classified > 0 ||
        e.candidates_created > 0 ||
        c.published > 0 ||
        c.held_for_review > 0 ||
        c.candidates_merged > 0;
      if (!moved) {
        stopped = 'no_work_left';
        break;
      }
    }
  } catch (ex) {
    error = (ex as Error).message;
    summary.notes.push(`The run stopped early: ${error}`);
  }

  await finishRun(env, run, summary, error);
  return { discover: discovered, extract: extracted, corroborate: corroborated, summary, cycles, stopped_because: stopped };
}

/**
 * Run history, so "when did discovery stop working" has an answer.
 *
 * Today's counters say whether it is working now. They cannot say that the last
 * successful run was three weeks ago, which is the question actually asked when
 * somebody notices no new offers.
 */
export async function startRun(env: Env, stage: string): Promise<number | null> {
  try {
    const r = await env.DB.prepare(`INSERT INTO discovery_runs (stage, started_at) VALUES (?, ?)`)
      .bind(stage, new Date().toISOString())
      .run();
    return r.meta.last_row_id;
  } catch {
    // History is diagnostics. Losing it must never stop a run.
    return null;
  }
}

export async function finishRun(
  env: Env,
  id: number | null,
  report: DiscoveryReport,
  error: string | null = null
): Promise<void> {
  if (id === null) return;
  try {
    await env.DB.prepare(
      `UPDATE discovery_runs
          SET finished_at = ?, success = ?, sources_scanned = ?, items_seen = ?, items_found = ?,
              relevant_items_found = ?, articles_fetched = ?, candidates_created = ?,
              published = ?, held_for_review = ?, error = ?
        WHERE id = ?`
    )
      .bind(
        new Date().toISOString(),
        error ? 0 : 1,
        report.sources_scanned,
        report.feed_items_seen + report.search_results_seen,
        report.items_found,
        report.relevant_items_found,
        report.articles_fetched,
        report.candidates_created,
        report.published,
        report.held_for_review,
        error,
        id
      )
      .run();
  } catch {
    /* diagnostics only */
  }
}

export interface DiscoveryRun {
  id: number;
  stage: string;
  started_at: string;
  finished_at: string | null;
  success: number;
  sources_scanned: number;
  items_seen: number;
  items_found: number;
  relevant_items_found: number;
  articles_fetched: number;
  candidates_created: number;
  published: number;
  held_for_review: number;
  error: string | null;
}

export async function recentRuns(env: Env, limit = 20): Promise<DiscoveryRun[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM discovery_runs ORDER BY id DESC LIMIT ?`)
    .bind(limit)
    .all<DiscoveryRun>();
  return results ?? [];
}

export interface DiscoveryStatus {
  sources: { total: number; active: number; ailing: number };
  items: Record<string, number>;
  candidates: Record<string, number>;
  today: { new: number; changed: number; auto_published: number; awaiting_review: number };
  as_of: string;
}

/** What the system did, in the shape of the morning report it exists to produce. */
export async function discoveryStatus(env: Env): Promise<DiscoveryStatus> {
  const now = today(env);
  const counts = async (sql: string, args: unknown[] = []) => {
    const { results } = await env.DB.prepare(sql).bind(...args).all<{ k: string; n: number }>();
    const out: Record<string, number> = {};
    for (const r of results ?? []) out[r.k] = r.n;
    return out;
  };

  const sources = await env.DB.prepare(
    `SELECT COUNT(*) AS total, SUM(active) AS active, SUM(CASE WHEN failure_count >= 3 THEN 1 ELSE 0 END) AS ailing
       FROM discovery_sources`
  ).first<{ total: number; active: number; ailing: number }>();

  const changed = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM promotion_change_events WHERE detected_at = ? AND change_type <> 'created'`
  )
    .bind(now)
    .first<{ n: number }>();
  const created = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM promotion_change_events WHERE detected_at = ? AND change_type = 'created'`
  )
    .bind(now)
    .first<{ n: number }>();
  const review = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM promotion_candidates WHERE status = 'review'`
  ).first<{ n: number }>();

  return {
    sources: { total: sources?.total ?? 0, active: sources?.active ?? 0, ailing: sources?.ailing ?? 0 },
    items: await counts(`SELECT status AS k, COUNT(*) AS n FROM discovery_items GROUP BY status`),
    candidates: await counts(`SELECT status AS k, COUNT(*) AS n FROM promotion_candidates GROUP BY status`),
    today: {
      new: created?.n ?? 0,
      changed: changed?.n ?? 0,
      auto_published: created?.n ?? 0,
      awaiting_review: review?.n ?? 0,
    },
    as_of: now,
  };
}
