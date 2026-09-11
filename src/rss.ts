import type { Env } from './types';

/**
 * Minimal RSS 2.0 + Atom reader. Workers have no DOMParser and a full XML parser
 * is overkill for feeds this regular, so this pulls the four fields we use and
 * ignores the rest.
 */
export interface FeedItem {
  guid: string;
  title: string;
  link: string;
  published_at: string | null;
  summary: string;
}

const strip = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ')
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
  const m = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return m ? m[1] : '';
}

export function parseFeed(xml: string): FeedItem[] {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? [];
  return blocks.map((b) => {
    const link = tag(b, 'link') || atomLink(b);
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
      summary: tag(b, 'description', 'summary', 'content'),
    };
  });
}

/**
 * Keyword gate. Deliberately broad on the promo side and narrowed by requiring a
 * card/miles term too, so general personal-finance posts do not flood the bot.
 */
const PROMO = /\b(sign[- ]?up|welcome (?:offer|gift|bonus)|new[- ]to[- ]bank|bonus miles|promo(?:tion)?|cashback offer|apply and (?:get|receive)|limited[- ]time)\b/i;
const CONTEXT = /\b(card|miles|krisflyer|asia miles|points|mpd|annual fee|issuer|amex|citi|dbs|posb|uob|ocbc|hsbc|maybank|standard chartered|scb|trust bank)\b/i;

/** Transfer bonuses, ratio changes and fee moves — the things that make a
 *  stored conversion rate wrong. Deliberately separate from sign-up promos. */
const RATE_NEWS =
  /\b(transfer bonus|conversion (?:rate|bonus|fee)|points?[- ]to[- ]miles|devalu\w*|revalu\w*|earn rate|mile ?rate|redemption rate|fee (?:increase|hike|change)|(?:raising|hiking|lowering) .{0,20}fee)\b/i;

export function isRateNews(item: FeedItem): boolean {
  return RATE_NEWS.test(`${item.title} ${item.summary}`);
}

export function isRelevant(item: FeedItem, watchTerms: string[] = []): boolean {
  const hay = `${item.title} ${item.summary}`;
  if (watchTerms.some((t) => t && hay.toLowerCase().includes(t.toLowerCase()))) return true;
  return PROMO.test(hay) && CONTEXT.test(hay);
}

export interface ScanResult {
  id: number;
  title: string;
  link: string;
  feed: string;
}

/** Fetch every active feed, store unseen items, return only the new relevant ones. */
export async function scanFeeds(env: Env): Promise<ScanResult[]> {
  const { results: feeds } = await env.DB.prepare(`SELECT url, label FROM feeds WHERE active = 1`).all<{
    url: string;
    label: string;
  }>();

  const { results: cards } = await env.DB.prepare(
    `SELECT DISTINCT product FROM cards WHERE closed_at IS NULL`
  ).all<{ product: string }>();
  const watch = (cards ?? []).map((c) => c.product);

  const fresh: ScanResult[] = [];

  for (const feed of feeds ?? []) {
    let xml: string;
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'miles-tracker/0.1 (personal use)', Accept: 'application/rss+xml, application/xml, text/xml' },
      });
      if (!res.ok) continue;
      xml = await res.text();
    } catch {
      continue; // one bad feed must not abort the scan
    }

    for (const item of parseFeed(xml)) {
      if (!item.guid) continue;
      const ins = await env.DB.prepare(
        `INSERT OR IGNORE INTO feed_items (guid, feed, title, link, published_at) VALUES (?, ?, ?, ?, ?)`
      )
        .bind(item.guid, feed.label ?? feed.url, item.title, item.link, item.published_at)
        .run();

      // changes === 0 means we have shown this item before.
      if ((ins.meta.changes ?? 0) === 0) continue;
      const rateNews = isRateNews(item);
      if (!isRelevant(item, watch) && !rateNews) continue;

      await env.DB.prepare(`UPDATE feed_items SET topic = ? WHERE id = ?`)
        .bind(rateNews ? 'rates' : 'promo', ins.meta.last_row_id as number)
        .run();

      // Rate news is reported in the weekly review, not pushed as a card offer.
      if (rateNews && !isRelevant(item, watch)) continue;

      fresh.push({
        id: ins.meta.last_row_id as number,
        title: item.title,
        link: item.link,
        feed: feed.label ?? feed.url,
      });
    }
  }
  return fresh;
}
