import { resolveRange, tzOffset } from './spend';
import type { Env } from './types';

/**
 * Feed and page reader. Workers have no DOMParser and a full XML/HTML parser is
 * far heavier than this needs, so everything here is regex-driven over the few
 * shapes that actually turn up: RSS 2.0, Atom, and ordinary blog index pages.
 */
export interface FeedItem {
  guid: string;
  title: string;
  link: string;
  published_at: string | null;
  summary: string;
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  ndash: '-',
  mdash: '—',
  hellip: '…',
  middot: '·',
};

/** Entity decoding, including numeric refs — bank pages are full of &#8217;. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/**
 * Typographic punctuation folded to ASCII. Publishers write "UOB Lady's" with a
 * curly apostrophe while the card is stored with a straight one, and a watch
 * term that does not match is a promo that never reaches you.
 */
export function normalizeText(s: string): string {
  return s
    .replace(/[\u2018\u2019\u02bc\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00a0/g, ' ');
}

const strip = (s: string) =>
  normalizeText(
    decodeEntities(
      s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, ' ')
    )
  )
    .replace(/\s+/g, ' ')
    .trim();

function tag(block: string, ...names: string[]): string {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
    if (m) return strip(m[1]);
  }
  return '';
}

function atomLink(block: string): string {
  // Prefer rel="alternate"; a feed entry often carries several <link> elements.
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (alt) return decodeEntities(alt[1]);
  const m = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return m ? decodeEntities(m[1]) : '';
}

// --- URL handling ----------------------------------------------------------

/** Query parameters that identify the click, not the page. */
const TRACKING = /^(utm_|fbclid$|gclid$|gbraid$|wbraid$|msclkid$|yclid$|mc_cid$|mc_eid$|igshid$|ref_src$|_ga$|spm$|__twitter_impression$|at_medium$|at_campaign$)/i;

/** Wrappers that carry the real destination in a query parameter. */
const REDIRECT_PARAMS = ['url', 'u', 'q', 'target', 'dest', 'redirect'];

/**
 * Resolve a possibly-relative href, unwrap redirector links and drop tracking
 * parameters, so the same article found through two feeds compares equal.
 */
export function canonicalUrl(raw: string, base?: string): string | null {
  let current = (raw ?? '').trim();
  if (!current || /^(javascript|mailto|tel|#)/i.test(current)) return null;

  for (let hop = 0; hop < 3; hop++) {
    let u: URL;
    try {
      u = new URL(decodeEntities(current), base);
    } catch {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

    // Unwrap ?url=https%3A%2F%2F… style redirectors before cleaning.
    let unwrapped: string | null = null;
    for (const p of REDIRECT_PARAMS) {
      const v = u.searchParams.get(p);
      if (v && /^https?:\/\//i.test(v)) {
        unwrapped = v;
        break;
      }
    }
    if (unwrapped) {
      current = unwrapped;
      base = undefined;
      continue;
    }

    for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./i, '');
    let out = u.toString();
    if (u.search === '') out = out.replace(/\?$/, '');
    // Trailing slash on a path carries no meaning and splits duplicates.
    if (!u.search && u.pathname !== '/' && out.endsWith('/')) out = out.slice(0, -1);
    return out;
  }
  return null;
}

/** Every <a href> on a page, absolute and de-duplicated, with its anchor text. */
export function extractLinks(html: string, base: string): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const url = canonicalUrl(m[1], base);
    if (!url) continue;
    const text = strip(m[2]).slice(0, 200);
    const key = `${url}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, text });
  }
  return out;
}

/** Issuer domains — a link into one of these is where an offer is actually claimed. */
const ISSUER_HOSTS =
  /(^|\.)(dbs\.com\.sg|posb\.com\.sg|uob\.com\.sg|ocbc\.com|citibank\.com\.sg|citi\.com|hsbc\.com\.sg|sc\.com|standardchartered\.com|maybank2u\.com\.sg|americanexpress\.com|amex\.co|trustbank\.sg|gxs\.com\.sg|cimb\.com\.sg|bankofchina\.com|singsaver\.com\.sg|heymax\.ai)$/i;

const APPLY_HINT = /\b(apply|application|sign[- ]?up|promotion|promo|offer|credit[- ]cards?|eligibility|terms)\b/i;

/**
 * The link a reader would click to take up the offer. Blog posts bury it among
 * navigation and related-post links, so rank rather than take the first match.
 */
export function pickApplyUrl(links: { url: string; text: string }[], articleUrl?: string): string | null {
  let host = '';
  try {
    if (articleUrl) host = new URL(articleUrl).hostname.replace(/^www\./i, '');
  } catch {
    /* articleUrl is advisory only */
  }

  let best: { url: string; score: number } | null = null;
  for (const l of links) {
    let h: string;
    try {
      h = new URL(l.url).hostname;
    } catch {
      continue;
    }
    if (h === host) continue; // an internal link is not where you apply
    let score = 0;
    if (ISSUER_HOSTS.test(h)) score += 10;
    if (APPLY_HINT.test(l.url)) score += 3;
    if (APPLY_HINT.test(l.text)) score += 2;
    if (/\b(apply now|apply here|find out more|learn more)\b/i.test(l.text)) score += 2;
    if (score < 5) continue; // an issuer host, or several strong hints
    if (!best || score > best.score) best = { url: l.url, score };
  }
  return best?.url ?? null;
}

// --- HTML to text ----------------------------------------------------------

const JUNK = /<(script|style|noscript|template|svg|head|nav|footer|form|aside|iframe)\b[\s\S]*?<\/\1>/gi;
const BLOCK_END = /<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>|<br\s*\/?>/gi;

/** Readable text from an HTML document, preferring the article body when marked. */
export function htmlToText(html: string, limit = 40000): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(JUNK, ' ');

  // Prefer <article>/<main> when present — it drops menus and related posts.
  const bodies = [...s.matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  const body = bodies.sort((a, b) => b.length - a.length)[0];
  if (body && body.length > 500) s = body;

  s = s.replace(BLOCK_END, '\n');
  s = normalizeText(decodeEntities(s.replace(/<[^>]+>/g, ' ')));
  return s
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n')
    .trim()
    .slice(0, limit);
}

/** The content of one <meta> tag, by property or name. */
function metaContent(html: string, prop: string): string {
  const re = new RegExp(
    `<meta[^>]*(?:property|name|itemprop)=["']${prop}["'][^>]*content=["']([^"']*)["']|` +
      `<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${prop}["']`,
    'i'
  );
  const m = html.match(re);
  return m ? strip(m[1] ?? m[2] ?? '') : '';
}

/** <title>, og:title and the meta description of a page — or any named tag. */
export function pageMeta(html: string): { title: string; description: string };
export function pageMeta(html: string, prop: string): string;
export function pageMeta(html: string, prop?: string): { title: string; description: string } | string {
  if (prop) return metaContent(html, prop);
  return {
    title: metaContent(html, 'og:title') || tag(html, 'title'),
    description:
      metaContent(html, 'og:description') || metaContent(html, 'description') || metaContent(html, 'twitter:description'),
  };
}

/**
 * When an article was published, from whatever the page will admit to: the
 * meta tags first, then a <time> element, then the date most blogs put in the
 * URL. Index pages carry no dates at all, so without this every harvested link
 * would look undated and slip past the scan window.
 */
export function articleDate(html: string, url = '', offsetMinutes = 0): string | null {
  const metas = [
    'article:published_time',
    'article:modified_time',
    'og:published_time',
    'datePublished',
    'publish-date',
    'date',
  ];
  for (const m of metas) {
    const iso = toIsoDate(pageMeta(html, m), offsetMinutes);
    if (iso) return iso;
  }

  const timeTag = html.match(/<time[^>]*datetime=["']([^"']+)["']/i);
  const fromTime = toIsoDate(timeTag?.[1] ?? '', offsetMinutes);
  if (fromTime) return fromTime;

  // JSON-LD is common on news sites and cheap to look for.
  const ld = html.match(/"datePublished"\s*:\s*"([^"]+)"/i);
  const fromLd = toIsoDate(ld?.[1] ?? '', offsetMinutes);
  if (fromLd) return fromLd;

  return dateFromUrl(url);
}

/** The /2026/09/12/ or /2026-09-12- shape most blogs use in their permalinks. */
export function dateFromUrl(url: string): string | null {
  const m = url.match(/\/(20\d{2})[/-](0[1-9]|1[0-2])(?:[/-](0[1-9]|[12]\d|3[01]))?(?:[/-]|$)/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3] ?? '01'}`;
}

/**
 * A timestamp reduced to the date it falls on *here*. Without the offset, a
 * post published at 00:30 on the 1st in Singapore is 16:30 on the last of the
 * previous month in UTC — and a "this month" window would throw it away.
 */
function toIsoDate(raw: string, offsetMinutes = 0): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  const iso = new Date(t + offsetMinutes * 60_000).toISOString().slice(0, 10);
  // A date far in the future is a parse accident, not a publication date.
  return iso > '2100-01-01' || iso < '1990-01-01' ? null : iso;
}

export function parseFeed(xml: string): FeedItem[] {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? [];
  return blocks.map((b) => {
    const link = atomLink(b) || tag(b, 'link') || tag(b, 'guid');
    const published = tag(b, 'pubDate', 'published', 'updated', 'dc:date');
    let iso: string | null = null;
    if (published) {
      const t = Date.parse(published);
      if (!Number.isNaN(t)) iso = new Date(t).toISOString();
    }
    return {
      guid: tag(b, 'guid', 'id') || link,
      title: tag(b, 'title'),
      link,
      published_at: iso,
      // content:encoded carries the full post on WordPress feeds; prefer it.
      summary: tag(b, 'content:encoded', 'description', 'summary', 'content'),
    };
  });
}

export function looksLikeFeed(body: string, contentType = ''): boolean {
  if (/(rss|atom|xml)/i.test(contentType)) return true;
  return /<(rss|feed)\b/i.test(body.slice(0, 2000));
}

/**
 * Treat an ordinary HTML page as a source of items. A bank's "promotions"
 * listing or a blog's card section has no feed, and those are exactly the pages
 * worth watching, so harvest the headline links instead.
 */
export function parseIndexPage(html: string, base: string): FeedItem[] {
  const self = canonicalUrl(base, base);
  const items: FeedItem[] = [];
  const seen = new Set<string>();

  for (const l of extractLinks(html, base)) {
    if (l.url === self) continue;
    const title = l.text;
    // Navigation links are short; article links read like a headline.
    if (title.length < 20 || title.length > 200) continue;
    if (!/[a-z]/.test(title)) continue;
    if (seen.has(l.url)) continue;
    seen.add(l.url);
    items.push({ guid: l.url, title, link: l.url, published_at: dateFromUrl(l.url), summary: '' });
  }
  return items.slice(0, 60);
}

// --- Relevance -------------------------------------------------------------

/**
 * Keyword gate. Deliberately broad on the promo side and narrowed by requiring a
 * card/miles term too, so general personal-finance posts do not flood the bot.
 */
const PROMO =
  /\b(sign[- ]?up|welcome (?:offer|gift|bonus)|new[- ]to[- ]bank|bonus miles|promo(?:tion)?|cashback offer|apply and (?:get|receive)|limited[- ]time|first[- ]?year fee waiver|annual fee waiv\w*|referral bonus|spend .{0,15}(?:and|to) (?:get|receive|earn))\b/i;
const CONTEXT =
  /\b(card|miles|krisflyer|asia miles|points|mpd|annual fee|issuer|amex|american express|citi|dbs|posb|uob|ocbc|hsbc|maybank|standard chartered|scb|trust bank|gxs|cimb|heymax)\b/i;

/** A concrete reward figure — the strongest signal that a page is an offer. */
const REWARD_FIGURE =
  /(\b\d{1,3}(?:,\d{3})+\s*(?:bonus\s*)?(?:miles|points)\b|\b\d{1,3}k\s*(?:miles|points)\b|\bS?\$\d[\d,]*\s*(?:cash\s?back|cashback|rebate|voucher|credit)\b|\bup to \d[\d,.]*\s*(?:mpd|miles|points|%)\b)/i;

/** Transfer bonuses, ratio changes and fee moves — the things that make a
 *  stored conversion rate wrong. Deliberately separate from sign-up promos. */
const RATE_NEWS =
  /\b(transfer bonus|conversion (?:rate|bonus|fee)|points?[- ]to[- ]miles|devalu\w*|revalu\w*|earn rate|mile ?rate|redemption rate|fee (?:increase|hike|change)|(?:raising|hiking|lowering) .{0,20}fee)\b/i;

/** Matched phrases can contain commas ("30,000 bonus miles"), so the stored
 *  list uses a separator that cannot appear inside one. */
export const TERM_SEP = ' | ';

export interface Verdict {
  promo: boolean;
  rates: boolean;
  watched: boolean;
  score: number;
  terms: string[];
}

/** One place where the decision is made, so the trace matches the outcome. */
export function classify(text: string, watchTerms: string[] = []): Verdict {
  const terms: string[] = [];
  const hit = (re: RegExp, label?: string) => {
    const m = text.match(re);
    if (m) terms.push(label ?? m[0].toLowerCase().trim());
    return !!m;
  };

  const promoWord = hit(PROMO);
  const context = hit(CONTEXT);
  const figure = hit(REWARD_FIGURE);
  const rates = hit(RATE_NEWS);
  const lower = text.toLowerCase();
  const watched = watchTerms.some((t) => {
    if (!t || t.length < 3 || !lower.includes(t.toLowerCase())) return false;
    terms.push(t.toLowerCase());
    return true;
  });

  // A reward figure next to a card term is an offer even without promo wording.
  const promo = watched || (context && (promoWord || figure));
  const score = (promoWord ? 2 : 0) + (context ? 1 : 0) + (figure ? 3 : 0) + (watched ? 2 : 0) + (rates ? 1 : 0);
  return { promo, rates, watched, score, terms: [...new Set(terms)].slice(0, 8) };
}

export function isRateNews(item: FeedItem): boolean {
  return RATE_NEWS.test(`${item.title} ${item.summary}`);
}

export function isRelevant(item: FeedItem, watchTerms: string[] = []): boolean {
  return classify(`${item.title} ${item.summary}`, watchTerms).promo;
}

// --- Fetching --------------------------------------------------------------

const UA = 'miles-tracker/0.2 (personal use)';

async function fetchText(url: string, accept: string): Promise<{ body: string; type: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const type = res.headers.get('Content-Type') ?? '';
    if (/(image|video|audio|pdf|octet-stream)/i.test(type)) return null;
    const body = await res.text();
    // Bound the work: 600 KB is far past any article and keeps CPU predictable.
    return { body: body.slice(0, 600_000), type };
  } catch {
    return null; // one unreachable page must never abort a scan
  }
}

export interface PageRead {
  url: string;
  title: string;
  text: string;
  excerpt: string;
  apply_url: string | null;
  published_at: string | null;
  links: { url: string; text: string }[];
}

/** Fetch one page and reduce it to the parts the classifier and the bot use. */
export async function readPage(rawUrl: string, offsetMinutes = 0): Promise<PageRead | null> {
  const url = canonicalUrl(rawUrl);
  if (!url) return null;
  const got = await fetchText(url, 'text/html,application/xhtml+xml');
  if (!got) return null;

  const meta = pageMeta(got.body);
  const text = htmlToText(got.body);
  const links = extractLinks(got.body, url);
  return {
    url,
    title: meta.title,
    text,
    excerpt: (meta.description || text.replace(/\n/g, ' ')).slice(0, 400).trim(),
    apply_url: pickApplyUrl(links, url),
    published_at: articleDate(got.body, url, offsetMinutes),
    links,
  };
}

// --- Scanning --------------------------------------------------------------

export interface ScanResult {
  id: number;
  title: string;
  link: string;
  feed: string;
  topic: 'promo' | 'rates';
  score: number;
  terms: string[];
  excerpt: string | null;
  apply_url: string | null;
  deep: boolean;
  published_at: string | null;
}

export interface ScanOptions {
  /** Fetch the linked article when the feed summary alone is inconclusive. */
  deep?: boolean;
  /** Hard ceiling on article fetches per scan, so a big feed day stays cheap. */
  budget?: number;
  /** Ignore anything published before this date. `null` accepts everything;
   *  omit it to use the configured scan window. */
  since?: string | null;
}

export interface ScanSummary {
  fresh: ScanResult[];
  feeds_read: number;
  feeds_failed: string[];
  items_seen: number;
  pages_fetched: number;
  /** Items dated before the window — seen once, then left alone. */
  skipped_old: number;
  since: string | null;
}

async function watchTerms(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT DISTINCT product FROM cards WHERE closed_at IS NULL`).all<{
    product: string;
  }>();
  return (results ?? []).map((c) => c.product).filter(Boolean);
}

/** Fetch every active source, store unseen items, return only the new relevant ones. */
export async function scanFeeds(env: Env, opts: ScanOptions = {}): Promise<ScanResult[]> {
  return (await scanFeedsDetailed(env, opts)).fresh;
}

export async function scanFeedsDetailed(env: Env, opts: ScanOptions = {}): Promise<ScanSummary> {
  const deep = opts.deep !== false; // deep by default: it is what finds the rest
  let budget = opts.budget ?? 12;

  const { results: feeds } = await env.DB.prepare(`SELECT url, label, kind FROM feeds WHERE active = 1`).all<{
    url: string;
    label: string;
    kind: string | null;
  }>();
  const watch = await watchTerms(env);
  // Anything published before this is history: stored so it is judged once and
  // never re-read, but never pushed at you.
  const window = opts.since === undefined ? scanWindow(env).from : opts.since;

  const summary: ScanSummary = {
    fresh: [],
    feeds_read: 0,
    feeds_failed: [],
    items_seen: 0,
    pages_fetched: 0,
    skipped_old: 0,
    since: window,
  };

  for (const feed of feeds ?? []) {
    const got = await fetchText(feed.url, 'application/rss+xml, application/xml, text/xml, text/html;q=0.8');
    if (!got) {
      summary.feeds_failed.push(feed.label ?? feed.url);
      continue;
    }
    summary.feeds_read++;

    const asFeed = feed.kind === 'page' ? false : feed.kind === 'rss' || looksLikeFeed(got.body, got.type);
    const items = asFeed ? parseFeed(got.body) : parseIndexPage(got.body, feed.url);

    for (const item of items) {
      const link = canonicalUrl(item.link, feed.url) ?? item.link;
      const guid = item.guid && item.guid !== item.link ? item.guid : link;
      if (!guid) continue;
      summary.items_seen++;

      const ins = await env.DB.prepare(
        `INSERT OR IGNORE INTO feed_items (guid, feed, title, link, published_at) VALUES (?, ?, ?, ?, ?)`
      )
        .bind(guid, feed.label ?? feed.url, item.title, link, item.published_at)
        .run();

      // changes === 0 means we have shown this item before.
      if ((ins.meta.changes ?? 0) === 0) continue;
      const id = ins.meta.last_row_id as number;

      // A feed gives a date; a harvested link usually carries one in its URL.
      // When neither does, the article itself is asked below.
      let published = item.published_at ?? dateFromUrl(link);
      if (window && published && published.slice(0, 10) < window) {
        await env.DB.prepare(`UPDATE feed_items SET action = 'stale', published_at = ? WHERE id = ?`)
          .bind(published, id)
          .run();
        summary.skipped_old++;
        continue;
      }

      const shallow = classify(`${item.title} ${item.summary}`, watch);
      let verdict = shallow;
      let excerpt: string | null = item.summary ? item.summary.slice(0, 400) : null;
      let applyUrl: string | null = null;
      let read: PageRead | null = null;

      // Worth opening when it already looks like an offer (to capture the apply
      // link and a real excerpt) or when it mentions a card but the summary was
      // too thin to judge — which is most index-page and truncated feeds.
      const thin = (item.summary ?? '').length < 200;
      const worthReading = shallow.promo || shallow.rates || (thin && CONTEXT.test(`${item.title} ${item.summary}`));

      if (deep && budget > 0 && worthReading && link) {
        read = await readPage(link, tzOffset(env));
        if (read) {
          budget--;
          summary.pages_fetched++;
          verdict = classify(`${item.title} ${read.title} ${read.text.slice(0, 12_000)}`, watch);
          excerpt = read.excerpt || excerpt;
          applyUrl = read.apply_url;
          published = published ?? read.published_at;

          // The page can date itself out of the window even when the link could
          // not: an undated index link to a two-year-old post.
          if (window && published && published < window) {
            await env.DB.prepare(`UPDATE feed_items SET action = 'stale', published_at = ? WHERE id = ?`)
              .bind(published, id)
              .run();
            summary.skipped_old++;
            continue;
          }
        }
      }

      const topic: 'promo' | 'rates' = verdict.promo ? 'promo' : 'rates';
      await env.DB.prepare(
        `UPDATE feed_items
            SET topic = ?, score = ?, terms = ?, excerpt = ?, apply_url = ?, deep = ?, published_at = COALESCE(?, published_at)
          WHERE id = ?`
      )
        .bind(
          verdict.promo || verdict.rates ? topic : null,
          verdict.score,
          verdict.terms.join(TERM_SEP) || null,
          excerpt,
          applyUrl,
          read ? 1 : 0,
          published,
          id
        )
        .run();

      if (!verdict.promo && !verdict.rates) continue;
      // Rate news is reported in the daily review, not pushed as a card offer.
      if (!verdict.promo) continue;

      summary.fresh.push({
        id,
        title: item.title || read?.title || link,
        link,
        feed: feed.label ?? feed.url,
        topic,
        score: verdict.score,
        terms: verdict.terms,
        excerpt,
        apply_url: applyUrl,
        deep: !!read,
        published_at: published,
      });
    }
  }
  return summary;
}

/**
 * Parse one URL on demand — paste a promo page into the bot or the dashboard
 * and get the same judgement a feed item would receive, without waiting for a
 * feed to carry it. The scan window does not apply: asking for a page is a
 * deliberate act, and refusing it because it is old would be surprising.
 */
export async function scanUrl(env: Env, rawUrl: string): Promise<ScanResult | null> {
  const read = await readPage(rawUrl, tzOffset(env));
  if (!read) return null;
  const watch = await watchTerms(env);
  const verdict = classify(`${read.title} ${read.text.slice(0, 12_000)}`, watch);
  const topic: 'promo' | 'rates' = verdict.promo ? 'promo' : 'rates';

  await env.DB.prepare(
    `INSERT OR IGNORE INTO feed_items (guid, feed, title, link, published_at) VALUES (?, 'manual', ?, ?, ?)`
  )
    .bind(read.url, read.title || read.url, read.url, read.published_at)
    .run();
  const row = await env.DB.prepare(`SELECT id FROM feed_items WHERE guid = ?`).bind(read.url).first<{ id: number }>();
  if (!row) return null;

  await env.DB.prepare(
    `UPDATE feed_items SET title = ?, topic = ?, score = ?, terms = ?, excerpt = ?, apply_url = ?, deep = 1 WHERE id = ?`
  )
    .bind(
      read.title || read.url,
      verdict.promo || verdict.rates ? topic : null,
      verdict.score,
      verdict.terms.join(TERM_SEP) || null,
      read.excerpt,
      read.apply_url,
      row.id
    )
    .run();

  return {
    id: row.id,
    title: read.title || read.url,
    link: read.url,
    feed: 'manual',
    topic,
    score: verdict.score,
    terms: verdict.terms,
    excerpt: read.excerpt,
    apply_url: read.apply_url,
    deep: true,
    published_at: read.published_at,
  };
}

// --- Acting on an item -----------------------------------------------------

/** Promote a feed item to a tracked offer. Shared by the bot and the dashboard. */
export async function trackFeedItem(env: Env, id: number): Promise<number | null> {
  const item = await env.DB.prepare(`SELECT * FROM feed_items WHERE id = ?`).bind(id).first<any>();
  if (!item) return null;
  if (item.offer_id) return item.offer_id as number;

  const ins = await env.DB.prepare(
    `INSERT INTO offers (status, source_url, source_title) VALUES ('pending', ?, ?)`
  )
    .bind(item.apply_url || item.link, item.title)
    .run();
  const offerId = ins.meta.last_row_id as number;
  await env.DB.prepare(`UPDATE feed_items SET action = 'tracked', offer_id = ? WHERE id = ?`)
    .bind(offerId, id)
    .run();
  return offerId;
}

export async function ignoreFeedItem(env: Env, id: number): Promise<void> {
  await env.DB.prepare(`UPDATE feed_items SET action = 'ignored' WHERE id = ?`).bind(id).run();
}

// --- housekeeping ----------------------------------------------------------

export interface FeedStorage {
  total: number;
  undecided: number;
  tracked: number;
  ignored: number;
  /** Bytes of text actually stored in feed_items — the part that grows. */
  text_bytes: number;
  /** What compacting every decided item older than the retention window frees. */
  reclaimable_bytes: number;
  compactable: number;
  retention_days: number;
}

const TEXT_BYTES = `SUM(
  LENGTH(COALESCE(guid,'')) + LENGTH(COALESCE(feed,'')) + LENGTH(COALESCE(title,'')) +
  LENGTH(COALESCE(link,'')) + LENGTH(COALESCE(apply_url,'')) + LENGTH(COALESCE(excerpt,'')) +
  LENGTH(COALESCE(terms,''))
)`;

/** What the scanner's history costs, and what could be given back. */
export async function feedStorage(env: Env): Promise<FeedStorage> {
  const days = retentionDays(env);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN action IS NULL THEN 1 ELSE 0 END) AS undecided,
            SUM(CASE WHEN action = 'tracked' THEN 1 ELSE 0 END) AS tracked,
            SUM(CASE WHEN action = 'ignored' THEN 1 ELSE 0 END) AS ignored,
            ${TEXT_BYTES} AS text_bytes
     FROM feed_items`
  ).first<any>();

  // Compacting keeps guid, feed and a short title; everything else goes.
  const spare = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            SUM(LENGTH(COALESCE(excerpt,'')) + LENGTH(COALESCE(terms,'')) + LENGTH(COALESCE(apply_url,''))
                + MAX(LENGTH(COALESCE(title,'')) - 60, 0)) AS bytes
     FROM feed_items
     WHERE action IS NOT NULL
       AND DATE(COALESCE(published_at, seen_at)) < DATE('now', ?)
       AND (excerpt IS NOT NULL OR terms IS NOT NULL OR apply_url IS NOT NULL OR LENGTH(COALESCE(title,'')) > 60)`
  )
    .bind(`-${days} days`)
    .first<any>();

  return {
    total: row?.total ?? 0,
    undecided: row?.undecided ?? 0,
    tracked: row?.tracked ?? 0,
    ignored: row?.ignored ?? 0,
    text_bytes: row?.text_bytes ?? 0,
    reclaimable_bytes: spare?.bytes ?? 0,
    compactable: spare?.n ?? 0,
    retention_days: days,
  };
}

/**
 * How far back a scan looks. The default is the current calendar month: a blog
 * category page lists years of posts, and an offer from 2024 is noise, not news.
 */
export function scanWindow(env: Env): { from: string | null; label: string } {
  const raw = (env.SCAN_WINDOW ?? 'month').trim().toLowerCase();
  const { from, label } = resolveRange(env, raw === '' ? 'month' : raw);
  return { from, label };
}

export function retentionDays(env: Env): number {
  const n = parseInt(env.FEED_RETENTION_DAYS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 180;
}

export interface PurgeOptions {
  /** `compact` keeps the row and drops its bulk; `delete` removes it outright. */
  mode: 'compact' | 'delete';
  /** Which rows: judged items, ignored ones only, or specific ids. */
  scope: 'ignored' | 'decided';
  older_than_days?: number;
  ids?: number[];
}

export interface PurgeResult {
  mode: 'compact' | 'delete';
  affected: number;
  bytes_before: number;
  bytes_after: number;
  freed_bytes: number;
}

/**
 * Compacting strips the bulk — excerpt, matched terms, the issuer link and a
 * long title — but keeps guid and action, so a compacted item is still
 * recognised on the next scan and never shown again.
 *
 * Deleting removes the row entirely, which also removes that memory: anything
 * still present in a feed will be re-inserted and re-notified. That is the
 * trade, and the caller is told about it rather than finding out later.
 */
export async function purgeFeedItems(env: Env, opts: PurgeOptions): Promise<PurgeResult> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (opts.ids?.length) {
    where.push(`id IN (${opts.ids.map(() => '?').join(',')})`);
    binds.push(...opts.ids);
  }
  where.push(opts.scope === 'ignored' ? `action = 'ignored'` : `action IS NOT NULL`);
  if (opts.older_than_days && opts.older_than_days > 0) {
    where.push(`DATE(COALESCE(published_at, seen_at)) < DATE('now', ?)`);
    binds.push(`-${Math.round(opts.older_than_days)} days`);
  }
  const clause = `WHERE ${where.join(' AND ')}`;

  const before = await env.DB.prepare(`SELECT COUNT(*) AS n, ${TEXT_BYTES} AS bytes FROM feed_items ${clause}`)
    .bind(...binds)
    .first<any>();
  const bytesBefore = before?.bytes ?? 0;

  let affected = 0;
  if (opts.mode === 'delete') {
    const res = await env.DB.prepare(`DELETE FROM feed_items ${clause}`).bind(...binds).run();
    affected = res.meta.changes ?? 0;
    return { mode: 'delete', affected, bytes_before: bytesBefore, bytes_after: 0, freed_bytes: bytesBefore };
  }

  const res = await env.DB.prepare(
    `UPDATE feed_items
        SET excerpt = NULL, terms = NULL, apply_url = NULL, title = SUBSTR(COALESCE(title,''), 1, 60)
      ${clause}`
  )
    .bind(...binds)
    .run();
  affected = res.meta.changes ?? 0;

  const after = await env.DB.prepare(`SELECT ${TEXT_BYTES} AS bytes FROM feed_items ${clause}`)
    .bind(...binds)
    .first<any>();
  const bytesAfter = after?.bytes ?? 0;
  return {
    mode: 'compact',
    affected,
    bytes_before: bytesBefore,
    bytes_after: bytesAfter,
    freed_bytes: Math.max(0, bytesBefore - bytesAfter),
  };
}
