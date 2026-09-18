import { localNow, today } from '../../spend';
import type { Env } from '../../types';

/**
 * What to search for, generated rather than maintained.
 *
 * A hand-written list of queries goes stale the moment a card is added to the
 * catalogue, and nobody remembers to update it. These come from the catalogue
 * itself, so a new product is searched for from the day it exists.
 *
 * Search is also the most expensive component, so the generator is explicit
 * about budget: a broad roundup article can replace dozens of direct queries,
 * and the cheapest search is the one that is not run.
 */

export type QueryKind = 'broad' | 'issuer' | 'product' | 'programme' | 'official' | 'series';

export interface SearchQuery {
  kind: QueryKind;
  query: string;
  /** Why this one exists, so a budget can be argued about. */
  rationale: string;
  /** The tier a result from this query starts at. */
  trust_tier: number;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const monthYear = (env: Env, offsetMonths = 0) => {
  const d = localNow(env);
  d.setUTCMonth(d.getUTCMonth() + offsetMonths);
  return { month: MONTHS[d.getUTCMonth()], year: d.getUTCFullYear() };
};

/**
 * The handful of queries worth running every few days.
 *
 * Both this month and next: promotion turnover clusters at month boundaries,
 * and an article about October appears in late September.
 */
export function broadQueries(env: Env): SearchQuery[] {
  const now = monthYear(env);
  const next = monthYear(env, 1);
  const out: SearchQuery[] = [];

  for (const { month, year } of [now, next]) {
    out.push({
      kind: 'broad',
      query: `Singapore credit card sign-up bonus ${month} ${year}`,
      rationale: 'monthly roundups, which carry many offers in one article',
      trust_tier: 4,
    });
    out.push({
      kind: 'broad',
      query: `Singapore credit card promotion bonus miles ${month} ${year}`,
      rationale: 'general promotion coverage',
      trust_tier: 4,
    });
  }
  out.push({
    kind: 'broad',
    query: 'KrisFlyer transfer bonus Singapore',
    rationale: 'transfer bonuses, which change the transfer planner',
    trust_tier: 4,
  });
  return out;
}

/** One query per issuer that actually appears in the catalogue. */
export async function issuerQueries(env: Env): Promise<SearchQuery[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT issuer FROM card_products WHERE issuer IS NOT NULL ORDER BY issuer`
  ).all<{ issuer: string }>();
  const { month, year } = monthYear(env);

  return (results ?? []).map((r) => ({
    kind: 'issuer' as const,
    query: `${r.issuer} credit card promotion Singapore ${month} ${year}`,
    rationale: `${r.issuer} is in the catalogue`,
    trust_tier: 4,
  }));
}

/**
 * Card-specific queries, for cards worth the search budget.
 *
 * Cards you hold first: a promotion on a card in your wallet is actionable
 * today, and one on a card you do not hold is only ever advice.
 */
export async function productQueries(env: Env, limit = 8): Promise<SearchQuery[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.product_name, p.issuer,
            (SELECT COUNT(*) FROM cards c WHERE c.product_id = p.id AND c.closed_at IS NULL) AS held
       FROM card_products p
      ORDER BY held DESC, p.issuer, p.product_name
      LIMIT ?`
  )
    .bind(limit)
    .all<{ product_name: string; issuer: string; held: number }>();

  return (results ?? []).map((r) => ({
    kind: 'product' as const,
    query: `"${r.issuer} ${r.product_name}" promotion bonus miles`,
    rationale: r.held ? 'a card you hold' : 'a card in the catalogue',
    trust_tier: 4,
  }));
}

export async function programmeQueries(env: Env): Promise<SearchQuery[]> {
  const { results } = await env.DB.prepare(
    `SELECT name FROM programs WHERE COALESCE(status, 'active') = 'active' AND kind = 'airline' ORDER BY name`
  ).all<{ name: string }>();

  return (results ?? []).map((r) => ({
    kind: 'programme' as const,
    query: `"${r.name}" transfer bonus Singapore`,
    rationale: 'a programme you can transfer into',
    trust_tier: 4,
  }));
}

/**
 * A query aimed at the issuer's own domain.
 *
 * Search engines index bank pages and PDFs that are awkward to navigate to
 * directly, and an indexed official PDF is the strongest evidence this system
 * can get without anyone's cooperation. This is not a way around a blocked
 * site: if the result cannot then be fetched normally, it stays unverified.
 */
export function officialQueries(
  issuerDomain: string,
  terms: { product?: string; reward?: string; ends?: string }
): SearchQuery[] {
  const bits = [
    terms.product ? `"${terms.product}"` : '',
    terms.reward ? `"${terms.reward}"` : '',
    terms.ends ? `"${terms.ends}"` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return [
    {
      kind: 'official',
      query: `site:${issuerDomain} ${bits}`.trim(),
      rationale: 'the issuer’s own words, if the page is indexed',
      trust_tier: 1,
    },
    {
      kind: 'official',
      query: `site:${issuerDomain} filetype:pdf ${bits}`.trim(),
      rationale: 'official PDFs are more machine-readable than marketing pages',
      trust_tier: 1,
    },
  ];
}

/** The domains the app will accept as an issuer speaking for itself. */
export const ISSUER_DOMAINS: Record<string, string> = {
  DBS: 'dbs.com.sg',
  POSB: 'posb.com.sg',
  UOB: 'uob.com.sg',
  Citi: 'citibank.com.sg',
  OCBC: 'ocbc.com',
  HSBC: 'hsbc.com.sg',
  'Standard Chartered': 'sc.com',
  Maybank: 'maybank2u.com.sg',
  'American Express': 'americanexpress.com',
  BOC: 'bankofchina.com',
  CIMB: 'cimb.com.sg',
};

export const domainFor = (issuer: string | null | undefined): string | null => {
  if (!issuer) return null;
  const exact = ISSUER_DOMAINS[issuer];
  if (exact) return exact;
  const key = Object.keys(ISSUER_DOMAINS).find((k) => k.toLowerCase() === issuer.toLowerCase());
  return key ? ISSUER_DOMAINS[key] : null;
};

/**
 * The next issue of a recurring article.
 *
 * "Credit Card Sign-up Bonuses — September 2026" implies an October one, and
 * looking for it by name near month-end is the cheapest discovery mechanism
 * there is: one query, fifteen offers.
 */
export function seriesQueries(env: Env, previousTitles: string[]): SearchQuery[] {
  const { month, year } = monthYear(env, 1);
  const out: SearchQuery[] = [];

  for (const title of previousTitles.slice(0, 5)) {
    // Replace whatever month the last issue named with the next one.
    const next = title.replace(new RegExp(`(${MONTHS.join('|')})\\s+\\d{4}`, 'i'), `${month} ${year}`);
    if (next === title) continue;
    out.push({
      kind: 'series',
      query: `"${next.slice(0, 80)}"`,
      rationale: `the next issue of a series whose last one was "${title.slice(0, 60)}"`,
      trust_tier: 2,
    });
  }
  return out;
}

export interface Budget {
  /** How many queries this run may make. */
  limit: number;
  reason: string;
}

/** The busiest stretch: offers turn over at the month boundary. */
export const DEEP_SCAN_FROM_DAY = 26;
export const DEEP_SCAN_TO_DAY = 5;

export function isDeepScanWindow(env: Env): boolean {
  const day = Number(today(env).slice(8, 10));
  return day >= DEEP_SCAN_FROM_DAY || day <= DEEP_SCAN_TO_DAY;
}

/**
 * What this run may spend.
 *
 * Search is the component that costs real money, so the budget is explicit and
 * small. The escalation rule elsewhere matters more: once two trusted sources
 * agree, searching further buys nothing.
 */
export function budgetFor(env: Env, kind: 'daily' | 'every3days' | 'weekly'): Budget {
  if (isDeepScanWindow(env)) {
    return { limit: 15, reason: 'month boundary, when promotions turn over' };
  }
  if (kind === 'daily') return { limit: 5, reason: 'the broad daily sweep' };
  if (kind === 'every3days') return { limit: 10, reason: 'issuer queries' };
  return { limit: 12, reason: 'the weekly card and programme sweep' };
}

/**
 * The queries to run now, already trimmed to budget.
 *
 * Ordered by what each is likely to return per query rather than by
 * completeness: a roundup covering fifteen offers beats fifteen card searches.
 */
export async function plannedQueries(env: Env, kind: 'daily' | 'every3days' | 'weekly'): Promise<{
  queries: SearchQuery[];
  budget: Budget;
}> {
  const budget = budgetFor(env, kind);
  const out: SearchQuery[] = [...broadQueries(env)];

  if (kind !== 'daily') out.push(...(await issuerQueries(env)));
  if (kind === 'weekly') {
    out.push(...(await productQueries(env)));
    out.push(...(await programmeQueries(env)));
  }

  const { results: recent } = await env.DB.prepare(
    `SELECT title FROM discovery_items
      WHERE title IS NOT NULL AND item_type = 'roundup'
      ORDER BY discovered_at DESC LIMIT 5`
  ).all<{ title: string }>();
  out.push(...seriesQueries(env, (recent ?? []).map((r) => r.title)));

  return { queries: out.slice(0, budget.limit), budget };
}
