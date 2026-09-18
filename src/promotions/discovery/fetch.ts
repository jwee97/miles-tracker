import { canonicalUrl, htmlToText, pageMeta } from '../../rss';

/**
 * Reading a page, politely, or not at all.
 *
 * The rule the whole system is built around: if a site does not want to be read
 * by software, it is not read. No CAPTCHA solving, no login, no anti-bot
 * evasion, no header games, no retry storms. A blocked issuer is an ordinary
 * outcome — it costs a promotion its "official" badge and nothing else, because
 * discovery never depended on that site in the first place.
 *
 * This is also why the fetcher is boring: a normal user agent, one request, a
 * timeout, a size cap. Anything cleverer would be the thing this design exists
 * to avoid.
 */

export const USER_AGENT =
  'MilesTracker/1.0 (personal credit-card tracker; contact via the repository)';

/** Past this, it is not an article. */
export const MAX_BYTES = 600_000;
export const TIMEOUT_MS = 10_000;

export type FetchStatus =
  | 'ok'
  | 'fetch_blocked'
  | 'fetch_unavailable'
  | 'robots_disallowed'
  | 'not_html'
  | 'too_large';

export interface FetchResult {
  status: FetchStatus;
  url: string;
  final_url: string | null;
  title: string | null;
  text: string | null;
  content_type: string | null;
  /** In words, for a status line a person can read. */
  note: string;
}

/** A refusal, said the same way every time. */
const refused = (url: string, status: FetchStatus, note: string): FetchResult => ({
  status,
  url,
  final_url: null,
  title: null,
  text: null,
  content_type: null,
  note,
});

/**
 * The robots rules for a host, as far as they concern this fetcher.
 *
 * Only the wildcard group is read. A file that names this agent specifically is
 * unlikely, and reading the generic rules is the conservative reading anyway:
 * it can only ever make the fetcher decline more than it strictly must.
 */
export function disallowedPaths(robotsTxt: string): string[] {
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());
  const out: string[] = [];
  let inWildcard = false;

  for (const line of lines) {
    const ua = line.match(/^user-agent:\s*(.+)$/i);
    if (ua) {
      inWildcard = ua[1].trim() === '*';
      continue;
    }
    if (!inWildcard) continue;
    const dis = line.match(/^disallow:\s*(.*)$/i);
    if (dis) {
      const path = dis[1].trim();
      // "Disallow:" with nothing after it means the opposite of a ban.
      if (path) out.push(path);
    }
  }
  return out;
}

export function robotsAllows(robotsTxt: string, url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return !disallowedPaths(robotsTxt).some((d) => path.startsWith(d.replace(/\*$/, '')));
}

const robotsCache = new Map<string, { paths: string[]; at: number }>();
const ROBOTS_TTL_MS = 60 * 60 * 1000;

/**
 * Whether robots.txt permits this.
 *
 * A robots file that cannot be read is treated as permitting: a site with no
 * robots.txt has not said no, and refusing everything on a network error would
 * make the system silently stop working.
 */
export async function robotsPermits(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }

  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.at < ROBOTS_TTL_MS) {
    return !cached.paths.some((d) => new URL(url).pathname.startsWith(d.replace(/\*$/, '')));
  }

  try {
    const res = await fetchImpl(`${origin}/robots.txt`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      robotsCache.set(origin, { paths: [], at: Date.now() });
      return true;
    }
    const body = (await res.text()).slice(0, 100_000);
    const paths = disallowedPaths(body);
    robotsCache.set(origin, { paths, at: Date.now() });
    return robotsAllows(body, url);
  } catch {
    robotsCache.set(origin, { paths: [], at: Date.now() });
    return true;
  }
}

/**
 * Fetch one page.
 *
 * Every refusal is a named outcome rather than an exception, because the caller
 * has to record WHY something is unverified — "the bank blocked us" and "the
 * page was not there" mean different things to a person reading a promotion.
 */
export async function fetchArticle(
  url: string,
  opts: { fetchImpl?: typeof fetch; checkRobots?: boolean } = {}
): Promise<FetchResult> {
  const f = opts.fetchImpl ?? fetch;

  if (opts.checkRobots !== false) {
    const allowed = await robotsPermits(url, f);
    if (!allowed) {
      return refused(url, 'robots_disallowed', 'The site’s robots.txt asks software not to read this page.');
    }
  }

  let res: Response;
  try {
    res = await f(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return refused(url, 'fetch_unavailable', 'The page could not be reached.');
  }

  // 403 and 429 are a site saying no. They are recorded and not retried; the
  // promotion simply stays unverified, which the design already allows for.
  if (res.status === 403 || res.status === 401) {
    return refused(url, 'fetch_blocked', 'The site refused the request. Not retried.');
  }
  if (res.status === 429) {
    return refused(url, 'fetch_blocked', 'The site asked for fewer requests. Not retried.');
  }
  if (!res.ok) {
    return refused(url, 'fetch_unavailable', `The page returned ${res.status}.`);
  }

  const type = res.headers.get('Content-Type') ?? '';
  if (/(image|video|audio|octet-stream)/i.test(type)) {
    return { ...refused(url, 'not_html', 'Not a readable page.'), content_type: type };
  }

  const length = Number(res.headers.get('Content-Length') ?? '0');
  if (length > MAX_BYTES) {
    return { ...refused(url, 'too_large', 'The page is larger than this fetcher will read.'), content_type: type };
  }

  let body: string;
  try {
    body = (await res.text()).slice(0, MAX_BYTES);
  } catch {
    return refused(url, 'fetch_unavailable', 'The page could not be read.');
  }

  // A challenge page returns 200 and looks like HTML. Recognising one is not
  // circumventing it — it is the difference between "no promotion here" and
  // "we were not allowed to look".
  if (looksLikeChallenge(body)) {
    return { ...refused(url, 'fetch_blocked', 'The site returned a bot check. Not retried.'), content_type: type };
  }

  const meta = pageMeta(body);
  return {
    status: 'ok',
    url,
    final_url: canonicalUrl(res.url || url),
    title: meta.title || null,
    text: htmlToText(body, 40_000),
    content_type: type,
    note: 'Read normally.',
  };
}

/** The usual shapes of a "prove you are human" page. */
export function looksLikeChallenge(html: string): boolean {
  const head = html.slice(0, 4000).toLowerCase();
  return (
    /just a moment|checking your browser|cf-browser-verification|captcha|are you a robot|enable javascript and cookies/i.test(
      head
    ) ||
    /<title>\s*(access denied|forbidden|attention required)/i.test(head)
  );
}

/** A stable fingerprint of a page's text, so an unchanged article is skipped. */
export function contentHash(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim().toLowerCase();
  let h1 = 2166136261;
  let h2 = 5381;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 16777619);
    h2 = (h2 * 33) ^ s.charCodeAt(i);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

/**
 * The short quote kept as evidence for a claim.
 *
 * Bounded deliberately: enough to check that a number was read out of the right
 * sentence, and nowhere near enough to be a copy of somebody's article. The app
 * has no licence to archive other people's writing and does not want one.
 */
export const MAX_EXCERPT = 240;

export function excerptAround(text: string, needle: string, width = MAX_EXCERPT): string {
  const at = text.indexOf(needle);
  if (at < 0) return text.slice(0, width).trim();
  const from = Math.max(0, at - Math.floor((width - needle.length) / 2));
  return text.slice(from, from + width).replace(/\s+/g, ' ').trim();
}
