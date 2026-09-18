/**
 * The discovery vocabulary, written down once.
 *
 * The Worker and the web app disagreed about this before: the backend wrote
 * `new` and the screen counted `pending`, so a queue of articles waiting to be
 * read displayed as zero and the pipeline looked idle while it was working.
 * Nothing in either type system objected, because each side had invented its
 * own strings.
 *
 * So the states live here, both sides import them, and a contract test asserts
 * the sets match. A mismatch is now a compile error or a failing test rather
 * than a screen that quietly lies.
 */

/** Where an article is in the pipeline. */
export const DISCOVERY_ITEM_STATUSES = ['new', 'processed', 'irrelevant', 'failed'] as const;
export type DiscoveryItemStatus = (typeof DISCOVERY_ITEM_STATUSES)[number];

/** Where an extracted offer is in the pipeline. */
export const CANDIDATE_STATUSES = ['extracted', 'corroborating', 'review', 'published', 'rejected'] as const;
export type PromotionCandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const SCAN_FREQUENCIES = ['daily', 'every3days', 'weekly', 'monthly'] as const;
export type ScanFrequency = (typeof SCAN_FREQUENCIES)[number];

/**
 * How a source is doing, in words the screen can act on.
 *
 * `quiet` and `not_configured` are the two that matter most. A feed that reads
 * fine but has carried nothing relevant is working; a search source with no API
 * key has never run at all. Collapsing either into "nothing new" is exactly the
 * failure this vocabulary exists to prevent.
 */
export const SOURCE_STATES = ['never_scanned', 'healthy', 'quiet', 'degraded', 'failing', 'not_configured'] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

export const DISCOVERY_HEALTH = ['healthy', 'degraded', 'failing', 'not_configured'] as const;
export type DiscoveryHealth = (typeof DISCOVERY_HEALTH)[number];

/** How an article was found. */
export const DISCOVERY_CHANNELS = ['rss', 'search', 'manual'] as const;
export type DiscoveryChannel = (typeof DISCOVERY_CHANNELS)[number];

/**
 * The failure codes the discovery API returns.
 *
 * Named rather than free text so a screen can say the right thing and a test
 * can assert on the distinction. "Nothing was searched" and "nothing was found"
 * are different answers.
 */
export const DISCOVERY_ERRORS = {
  SEARCH_NOT_CONFIGURED: 'Search discovery requires SEARCH_API_KEY.',
  SEARCH_RATE_LIMITED: 'The search provider asked for fewer requests.',
  SEARCH_PROVIDER_ERROR: 'The search provider returned an error.',
  SOURCE_FETCH_BLOCKED: 'The source refused the request.',
  SOURCE_FETCH_TIMEOUT: 'The source did not respond in time.',
  SOURCE_INVALID_FEED: 'The response could not be parsed as a feed.',
  ARTICLE_FETCH_FAILED: 'The article could not be read.',
  EXTRACTION_NO_CANDIDATE: 'The article was read but named no offer.',
} as const;

export type DiscoveryErrorCode = keyof typeof DISCOVERY_ERRORS;

export interface DiscoveryError {
  error: { code: DiscoveryErrorCode; message: string };
}

export const discoveryError = (code: DiscoveryErrorCode, message?: string): DiscoveryError => ({
  error: { code, message: message ?? DISCOVERY_ERRORS[code] },
});
