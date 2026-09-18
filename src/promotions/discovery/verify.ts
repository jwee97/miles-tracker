import { extractLinks, pickApplyUrl } from '../../rss';
import { today } from '../../spend';
import type { Env } from '../../types';
import { fetchArticle, type FetchStatus } from './fetch';
import { domainFor, officialQueries } from './search';
import { TIER } from './sources';

/**
 * Trying to hear it from the bank.
 *
 * An official source is the strongest evidence available, so it is worth one
 * attempt — and exactly one. If the issuer's site declines, that is the end of
 * it: the promotion stays secondary-verified, the UI says so in those words,
 * and nothing retries, bypasses or pretends.
 *
 * The design assumes this fails often. It is not a failure path.
 */

export interface VerificationAttempt {
  attempted: boolean;
  official_verified: boolean;
  url: string | null;
  status: FetchStatus | null;
  /** Why it did not work, in words a person can read. */
  reason: string | null;
  /** Searches worth running to find an official page, when none was linked. */
  suggested_queries: string[];
}

const NOT_ATTEMPTED: VerificationAttempt = {
  attempted: false,
  official_verified: false,
  url: null,
  status: null,
  reason: null,
  suggested_queries: [],
};

/** Links in an article that point at the issuer's own terms. */
export function officialLinks(html: string, base: string, issuer: string | null): string[] {
  const domain = domainFor(issuer);
  const links = extractLinks(html, base);
  const out: string[] = [];

  for (const l of links) {
    let host: string;
    try {
      host = new URL(l.url).host.replace(/^www\./, '');
    } catch {
      continue;
    }
    if (domain && (host === domain || host.endsWith(`.${domain}`))) out.push(l.url);
  }

  // The apply/terms link an article offers is usually the issuer's page, and
  // the existing scanner already knows how to pick one out.
  const apply = pickApplyUrl(links, base);
  if (apply && !out.includes(apply)) {
    try {
      const host = new URL(apply).host.replace(/^www\./, '');
      if (domain && (host === domain || host.endsWith(`.${domain}`))) out.push(apply);
    } catch {
      /* ignore */
    }
  }
  return [...new Set(out)].slice(0, 3);
}

/**
 * One attempt at the issuer's own page.
 *
 * Deliberately capped at a couple of URLs and never retried. A site that said
 * no once will say no again, and asking repeatedly is the behaviour this whole
 * architecture exists to avoid.
 */
export async function verifyOfficial(
  env: Env,
  candidate: { issuer: string | null; product_name?: string | null; reward?: string | null; ends?: string | null },
  links: string[],
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<VerificationAttempt> {
  const domain = domainFor(candidate.issuer);
  if (!domain) return { ...NOT_ATTEMPTED, reason: 'no official domain is known for this issuer' };

  const queries = officialQueries(domain, {
    product: candidate.product_name ?? undefined,
    reward: candidate.reward ?? undefined,
    ends: candidate.ends ?? undefined,
  }).map((q) => q.query);

  if (!links.length) {
    return {
      ...NOT_ATTEMPTED,
      reason: 'the article did not link to the issuer’s own page',
      suggested_queries: queries,
    };
  }

  for (const url of links.slice(0, 2)) {
    const res = await fetchArticle(url, { fetchImpl: opts.fetchImpl });
    if (res.status === 'ok') {
      return {
        attempted: true,
        official_verified: true,
        url: res.final_url ?? url,
        status: 'ok',
        reason: null,
        suggested_queries: [],
      };
    }
    // A refusal ends it for this URL. The next link is tried only because it
    // may be a different page, not as a retry of the same one.
    if (res.status === 'robots_disallowed' || res.status === 'fetch_blocked') {
      return {
        attempted: true,
        official_verified: false,
        url,
        status: res.status,
        reason: res.note,
        suggested_queries: queries,
      };
    }
  }

  return {
    attempted: true,
    official_verified: false,
    url: links[0],
    status: 'fetch_unavailable',
    reason: 'the issuer’s page could not be read',
    suggested_queries: queries,
  };
}

/** Record an official page as a claim, so it weighs as tier 1 evidence. */
export async function recordOfficialClaims(
  env: Env,
  candidateId: number,
  url: string,
  fields: { field_name: string; value: unknown; excerpt: string }[]
): Promise<void> {
  for (const f of fields) {
    await env.DB.prepare(
      `INSERT INTO promotion_claims
         (candidate_id, field_name, value_json, source_url, source_type, source_tier, extracted_at, confidence, supporting_excerpt)
       VALUES (?, ?, ?, ?, 'official_page', ?, ?, 'high', ?)`
    )
      .bind(candidateId, f.field_name, JSON.stringify(f.value), url, TIER.official, today(env), f.excerpt.slice(0, 240))
      .run();
  }
}

/**
 * Whether it is worth searching further for confirmation.
 *
 * Once two trusted sources agree, more searching buys nothing and costs money.
 * The escalation stops there deliberately: this is the single most expensive
 * part of the system and the cheapest place to waste a budget.
 */
export function shouldEscalate(evidence: { independent_sources: number; official_source: boolean }): {
  escalate: boolean;
  reason: string;
} {
  if (evidence.official_source) return { escalate: false, reason: 'the issuer already confirms it' };
  if (evidence.independent_sources >= 2) {
    return { escalate: false, reason: 'two independent sources already agree' };
  }
  return { escalate: true, reason: 'only one source so far, so an official page is worth looking for' };
}
