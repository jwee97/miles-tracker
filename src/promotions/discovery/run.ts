import { canonicalUrl, parseFeed } from '../../rss';
import { today } from '../../spend';
import type { Env } from '../../types';
import { classify, shouldExtract } from './classify';
import { corroborate, claimsFor } from './corroborate';
import { diffAgainstPrevious, expireFinished } from './diff';
import { extractDocument, type PromotionCandidate } from './extract';
import { contentHash, fetchArticle, USER_AGENT } from './fetch';
import { fingerprintOf } from './fingerprint';
import { publishCandidate } from './publish';
import { resolveBest } from './resolve';
import { plannedQueries } from './search';
import { dueSources, recordScan, type DiscoverySource } from './sources';

/**
 * The discovery pipeline, run in bounded pieces.
 *
 * Every stage is a separate, resumable step writing its state to the database,
 * because a Worker invocation is short and a scan that has to finish in one go
 * is a scan that fails as soon as there is enough to do. Nothing here is
 * long-running; each call does a little and leaves a record.
 */

export interface DiscoveryReport {
  stage: string;
  sources_scanned: number;
  items_found: number;
  items_classified: number;
  candidates_created: number;
  published: number;
  held_for_review: number;
  expired: number;
  notes: string[];
  as_of: string;
}

const blank = (env: Env, stage: string): DiscoveryReport => ({
  stage,
  sources_scanned: 0,
  items_found: 0,
  items_classified: 0,
  candidates_created: 0,
  published: 0,
  held_for_review: 0,
  expired: 0,
  notes: [],
  as_of: today(env),
});

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
      // Search discovery needs a search API key; without one the stage is
      // skipped rather than failing, because feeds alone already work.
      const plan = await plannedQueries(env, 'daily');
      report.notes.push(
        `Search: ${plan.queries.length} queries planned within a budget of ${plan.budget.limit} (${plan.budget.reason}).`
      );
      await recordScan(env, source, { ok: true, note: 'queries planned' });
      continue;
    }
    if (!source.feed_url) {
      await recordScan(env, source, { ok: false, note: 'no feed url' });
      continue;
    }

    const found = await scanFeed(env, source, f);
    report.items_found += found.added;
    await recordScan(env, source, { ok: found.ok, items_found: found.added, note: found.note });
    if (found.note) report.notes.push(`${source.name}: ${found.note}`);
  }

  return report;
}

async function scanFeed(
  env: Env,
  source: DiscoverySource,
  f: typeof fetch
): Promise<{ ok: boolean; added: number; note: string }> {
  let body: string;
  try {
    const res = await f(source.feed_url!, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, added: 0, note: `the feed returned ${res.status}` };
    body = (await res.text()).slice(0, 600_000);
  } catch {
    return { ok: false, added: 0, note: 'the feed could not be reached' };
  }

  const items = parseFeed(body);
  let added = 0;
  for (const item of items.slice(0, 40)) {
    const url = canonicalUrl(item.link ?? '');
    if (!url) continue;

    const verdict = classify(item.title ?? '', item.summary ?? '');
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO discovery_items (source_id, url, canonical_url, title, published_at, item_type, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        source.id,
        item.link ?? url,
        url,
        item.title ?? null,
        item.published_at ?? null,
        verdict.type,
        shouldExtract(verdict) ? 'new' : 'irrelevant'
      )
      .run();
    if (inserted.meta.changes) added++;
  }

  return { ok: true, added, note: added ? `${added} new article(s)` : 'nothing new' };
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
      await env.DB.prepare(`UPDATE discovery_items SET status = 'failed', fetch_note = ? WHERE id = ?`)
        .bind(`${fetched.status}: ${fetched.note}`, item.id)
        .run();
      report.notes.push(`${item.title ?? item.url}: ${fetched.note}`);
      continue;
    }

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

    for (const c of candidates) {
      await saveCandidate(env, item, c, item.trust_tier ?? 5);
      report.candidates_created++;
    }

    await env.DB.prepare(
      `UPDATE discovery_items SET status = 'processed', content_hash = ?, item_type = ?, fetch_note = NULL WHERE id = ?`
    )
      .bind(hash, roundup ? 'roundup' : verdict.type, item.id)
      .run();

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
        report.notes.push(`Candidate #${row.id} is the same campaign as #${twin.id}; its claims were added to it.`);
        continue;
      }
    }

    const evidence = corroborate(await claimsFor(env, row.id));
    await env.DB.prepare(`UPDATE promotion_candidates SET status = 'corroborating' WHERE id = ?`).bind(row.id).run();

    const result = await publishCandidate(env, row.id);
    if (result.auto && result.ok) report.published++;
    else report.held_for_review++;
    if (evidence.conflicts.length) report.notes.push(`Candidate #${row.id}: ${evidence.conflicts[0]}`);
  }

  const swept = await expireFinished(env);
  report.expired = swept.expired.length;
  for (const k of swept.kept) report.notes.push(`${k.title} kept: ${k.reason}.`);

  return report;
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
