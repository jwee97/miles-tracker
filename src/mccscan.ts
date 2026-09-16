import { canonicalUrl, htmlToText, pageMeta } from './rss';
import type { Env } from './types';

/**
 * Keeping merchant codes current.
 *
 * Two halves, both called a scan because they answer the same question from
 * different ends: **which code does this merchant actually bill under?**
 *
 *  - The import reads a published merchant-code directory and records what it
 *    says. Anything you confirmed yourself is never overwritten — your own
 *    statement outranks a directory — and a disagreement is reported rather
 *    than resolved silently.
 *  - The review lists merchants in your own spend that have no code yet, with
 *    what the directory would call them, so the gap can be closed by hand.
 */

const UA = 'miles-tracker/0.3 (personal use)';

/** The directory's host, for saying where a figure came from. */
const shortHost = (base: string) => base.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
const SOURCE = 'check-mcc.sg';

export interface ImportedMerchant {
  merchant: string;
  mcc: string;
  description: string | null;
  verified: boolean;
  url: string;
}

export interface MccScanResult {
  fetched: number;
  added: ImportedMerchant[];
  updated: ImportedMerchant[];
  unchanged: number;
  /** Where the directory disagrees with something you confirmed yourself. */
  conflicts: { merchant: string; yours: string; theirs: string; url: string }[];
  failed: string[];
  source: string;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.text()).slice(0, 600_000);
  } catch {
    return null;
  }
}

/** The merchant pages a directory lists, from its sitemap. */
export async function merchantUrls(base: string): Promise<string[]> {
  const xml = await fetchText(`${base}/sitemap.xml`);
  if (!xml) return [];
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim());
  return locs.filter((u) => {
    const path = u.replace(base, '');
    // /mcc/<merchant>, but not the editorial pages that share the prefix.
    return /^\/mcc\/[a-z0-9][a-z0-9.-]*$/i.test(path) && !/\/(insert|singapore|singapore-vs-global)$/i.test(path);
  });
}

/** Merchant name, code and whether the directory calls it verified. */
export function parseMerchantPage(html: string, url: string): ImportedMerchant | null {
  // The header carries the code and the verification note, so read the whole
  // page rather than the article body.
  const text = htmlToText(html, 20_000, { whole: true });
  const code = text.match(/MCC\s*Code:?\s*(\d{4})/i)?.[1] ?? text.match(/\bMCC\s(\d{4})\b/)?.[1];
  if (!code) return null;

  // "Grab MCC Code & Best Credit Card Rewards | Singapore 2026" — the name is
  // everything before the first "MCC".
  const title = pageMeta(html).title;
  const name = (title.split(/\s+MCC\b/i)[0] || '').trim();
  if (!name) return null;

  // The description is parenthesised and often contains parentheses of its
  // own — "Business Services (Not Elsewhere Classified)" — so match to the
  // last one on the line rather than the first.
  const described =
    text.match(new RegExp(`MCC\\s*Code:?\\s*${code}\\s*\\(\\s*([^\\n]{3,90}?)\\s*\\)\\s*(?:[A-Z]|$)`, 'i'))?.[1] ?? null;
  return {
    merchant: name.toLowerCase(),
    mcc: code,
    description: described?.trim() ?? null,
    verified: /officially verified|verified mcc/i.test(text),
    url,
  };
}

export interface ImportOptions {
  base?: string;
  /** Ceiling on pages fetched, so one scan stays cheap and predictable. */
  budget?: number;
}

export async function importMerchantCodes(env: Env, opts: ImportOptions = {}): Promise<MccScanResult> {
  const base = opts.base ?? 'https://www.check-mcc.sg';
  let budget = opts.budget ?? 30;

  const result: MccScanResult = {
    fetched: 0,
    added: [],
    updated: [],
    unchanged: 0,
    conflicts: [],
    failed: [],
    source: shortHost(base),
  };

  const urls = await merchantUrls(base);
  for (const raw of urls) {
    if (budget <= 0) break;
    const url = canonicalUrl(raw) ?? raw;
    const html = await fetchText(url);
    budget--;
    if (!html) {
      result.failed.push(url);
      continue;
    }
    result.fetched++;

    const parsed = parseMerchantPage(html, url);
    if (!parsed) {
      result.failed.push(url);
      continue;
    }

    const existing = await env.DB.prepare(`SELECT mcc, source, confidence FROM merchant_mcc WHERE merchant = ?`)
      .bind(parsed.merchant)
      .first<{ mcc: string; source: string; confidence: string }>();

    // What you confirmed from your own statement beats a directory.
    if (existing && existing.source === 'user' && existing.confidence === 'confirmed') {
      if (existing.mcc !== parsed.mcc) {
        result.conflicts.push({ merchant: parsed.merchant, yours: existing.mcc, theirs: parsed.mcc, url });
      } else {
        result.unchanged++;
      }
      continue;
    }

    if (existing && existing.mcc === parsed.mcc) {
      result.unchanged++;
      continue;
    }

    await env.DB.prepare(
      `INSERT INTO merchant_mcc (merchant, mcc, channel, source, confidence, note, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, datetime('now'))
       ON CONFLICT(merchant) DO UPDATE SET mcc = excluded.mcc, source = excluded.source,
         confidence = excluded.confidence, note = excluded.note, updated_at = datetime('now')`
    )
      .bind(
        parsed.merchant,
        parsed.mcc,
        SOURCE,
        parsed.verified ? 'confirmed' : 'guess',
        `${parsed.verified ? 'Verified by' : 'Listed by'} ${result.source}`
      )
      .run();

    (existing ? result.updated : result.added).push(parsed);
  }

  return result;
}

export interface UnknownMerchant {
  merchant: string;
  txn_count: number;
  spend_cents: number;
  last_seen: string;
  /** What the merchant table would call it, if anything. */
  suggested_mcc: string | null;
  suggested_description: string | null;
  suggested_source: string | null;
}

/**
 * Merchants you have spent at whose code is still unknown. A transaction with
 * no code cannot be judged against a card's MCC rules at all, so these are the
 * gaps that make the earn engine guess.
 */
export interface UnknownPage {
  merchants: UnknownMerchant[];
  page: number;
  pages: number;
  per: number;
  /** Merchants with no code, before ignores are taken out. */
  total: number;
  /** How many you have told it to stop asking about. */
  ignored: number;
}

/** The shared shape of "spend whose merchant has no code", minus the ignored. */
const UNKNOWN_FROM = `FROM transactions t
       LEFT JOIN merchant_ignored g ON g.merchant = LOWER(TRIM(t.merchant))
      WHERE t.mcc IS NULL AND t.merchant IS NOT NULL AND TRIM(t.merchant) <> ''
        AND g.merchant IS NULL`;

/**
 * Merchants you have spent at whose code is still unknown, biggest spend first.
 *
 * Paged, because this list only grows: every statement import adds names, and a
 * to-do list nobody can reach the bottom of is not a to-do list. Ignored
 * merchants are left out but still counted, so the number never silently
 * disagrees with what you remember deciding.
 */
export async function unknownMerchants(
  env: Env,
  opts: { page?: number; per?: number } = {}
): Promise<UnknownPage> {
  const per = Math.min(200, Math.max(1, Math.round(opts.per ?? 25)));

  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (SELECT LOWER(TRIM(t.merchant)) AS m ${UNKNOWN_FROM} GROUP BY m)`
  ).first<{ n: number }>();
  const total = counts?.n ?? 0;
  const ignoredRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM merchant_ignored`).first<{ n: number }>();

  const pages = Math.max(1, Math.ceil(total / per));
  const page = Math.min(Math.max(1, Math.round(opts.page ?? 1)), pages);

  const { results } = await env.DB.prepare(
    `SELECT LOWER(TRIM(t.merchant)) AS merchant,
            COUNT(*) AS txn_count,
            SUM(t.amount_cents) AS spend_cents,
            MAX(COALESCE(t.posted_at, t.occurred_at)) AS last_seen,
            m.mcc AS suggested_mcc,
            c.description AS suggested_description,
            m.source AS suggested_source
       ${UNKNOWN_FROM.replace('FROM transactions t', 'FROM transactions t\n       LEFT JOIN merchant_mcc m ON m.merchant = LOWER(TRIM(t.merchant))\n       LEFT JOIN mcc_codes c ON c.code = m.mcc')}
      GROUP BY LOWER(TRIM(t.merchant))
      ORDER BY spend_cents DESC
      LIMIT ? OFFSET ?`
  )
    .bind(per, (page - 1) * per)
    .all<UnknownMerchant>();

  return { merchants: results ?? [], page, pages, per, total, ignored: ignoredRow?.n ?? 0 };
}

/**
 * Stop asking about a merchant, or start again.
 *
 * Some spend has no code to find — a hawker stall, a transfer to a friend — and
 * the honest answer is not a guess, it is to take it off the list.
 */
export async function ignoreMerchant(
  env: Env,
  merchant: string,
  opts: { reason?: string | null; undo?: boolean } = {}
): Promise<{ merchant: string; ignored: boolean }> {
  const name = merchant.trim().toLowerCase();
  if (opts.undo) {
    await env.DB.prepare(`DELETE FROM merchant_ignored WHERE merchant = ?`).bind(name).run();
    return { merchant: name, ignored: false };
  }
  await env.DB.prepare(
    `INSERT INTO merchant_ignored (merchant, reason) VALUES (?, ?)
     ON CONFLICT(merchant) DO UPDATE SET reason = excluded.reason`
  )
    .bind(name, opts.reason?.trim() || null)
    .run();
  return { merchant: name, ignored: true };
}

export async function ignoredMerchants(env: Env): Promise<{ merchant: string; reason: string | null }[]> {
  const { results } = await env.DB.prepare(
    `SELECT merchant, reason FROM merchant_ignored ORDER BY merchant`
  ).all<{ merchant: string; reason: string | null }>();
  return results ?? [];
}

/**
 * Record a code for a merchant and apply it to the spend already logged under
 * that name — those transactions were evaluated without a code, so the earn
 * engine could not see the rules that depend on one.
 */
export async function assignMerchantCode(
  env: Env,
  merchant: string,
  mcc: string,
  opts: { channel?: string | null; backfill?: boolean; categorise?: boolean } = {}
): Promise<{ merchant: string; updated: number; categorised: number; category: string | null }> {
  const name = merchant.trim().toLowerCase();
  await env.DB.prepare(
    `INSERT INTO merchant_mcc (merchant, mcc, channel, source, confidence, updated_at)
     VALUES (?, ?, ?, 'user', 'confirmed', datetime('now'))
     ON CONFLICT(merchant) DO UPDATE SET mcc = excluded.mcc, channel = excluded.channel,
       source = 'user', confidence = 'confirmed', updated_at = datetime('now')`
  )
    .bind(name, mcc, opts.channel ?? null)
    .run();

  let updated = 0;
  if (opts.backfill !== false) {
    const res = await env.DB.prepare(
      `UPDATE transactions SET mcc = ? WHERE mcc IS NULL AND LOWER(TRIM(merchant)) = ?`
    )
      .bind(mcc, name)
      .run();
    updated = res.meta.changes ?? 0;
  }

  // A code carries a category, and a purchase with a code but no category is
  // still invisible to any rule that matches on one. So the category comes with
  // it — but only where there is nothing to overwrite. A category you chose by
  // hand outranks a code's idea of what a merchant is, always: the bank knows
  // the code, you know the purchase.
  let categorised = 0;
  const row = await env.DB.prepare(`SELECT category FROM mcc_codes WHERE code = ?`)
    .bind(mcc)
    .first<{ category: string | null }>();
  const category = row?.category ?? null;
  if (category && opts.categorise !== false) {
    const res = await env.DB.prepare(
      `UPDATE transactions
          SET category = ?, category_source = 'mcc', needs_review = 0
        WHERE LOWER(TRIM(merchant)) = ?
          AND mcc = ?
          AND (category IS NULL OR TRIM(category) = '' OR category_source IS NULL OR category_source = 'learned')
          AND COALESCE(category_source, '') <> 'manual'`
    )
      .bind(category, name, mcc)
      .run();
    categorised = res.meta.changes ?? 0;
  }

  return { merchant: name, updated, categorised, category };
}

/**
 * URL-shaped names for a merchant's own page on the directory. The search
 * endpoint answers by name, so this is only needed when a page has to be
 * addressed directly — the importer's own list, and any future per-page read.
 */
export function slugCandidates(query: string): string[] {
  const base = query
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return [];

  const hyphen = base.replace(/ /g, '-');
  const out = [hyphen];
  // Statements pad merchant names: "GRAB *TRIP SINGAPORE SG", "SHOPEE SG".
  const trimmed = base.replace(/\b(singapore|sg|pte|ltd|com|sgp|asia)\b/g, '').replace(/\s+/g, ' ').trim();
  if (trimmed && trimmed !== base) out.push(trimmed.replace(/ /g, '-'));
  // A first word on its own catches "watsons personal care" → "watsons".
  const first = base.split(' ')[0];
  if (first && first !== base) out.push(first);
  // Dotted names keep their dot: booking.com.
  if (base.includes('.')) out.push(base.replace(/ /g, ''));
  return [...new Set(out)].filter(Boolean).slice(0, 4);
}

export interface DirectoryHit {
  /** The merchant as the directory spells it. */
  store: string;
  mcc: string;
  /** Their description of the code, which may differ from ours. */
  their_description: string | null;
  /** online | offline, as they record it. */
  channel: string | null;
  url: string | null;
  /** What this app calls that code, and how it categorises it. */
  description: string | null;
  category: string | null;
}

export interface MerchantLookup {
  query: string;
  /** What this app already knows, which always outranks a directory. */
  known: { merchant: string; mcc: string; source: string; confidence: string } | null;
  results: DirectoryHit[];
  source: string;
  /** Set when the directory could not be reached, so an empty list is not
   *  mistaken for "no such merchant". */
  error: string | null;
}

/**
 * Search a published merchant directory by name.
 *
 * This is the search its own site uses, and it matches on fragments — "kopi"
 * finds ten kopitiams — so several hits come back and the choice is yours.
 * Nothing is written: recording a code is a separate, deliberate step.
 */
export async function lookupMerchantOnline(
  env: Env,
  query: string,
  opts: { base?: string; limit?: number } = {}
): Promise<MerchantLookup> {
  const base = opts.base ?? 'https://www.check-mcc.sg';
  const limit = opts.limit ?? 10;
  const name = query.trim();

  const known = await env.DB.prepare(
    `SELECT merchant, mcc, source, confidence FROM merchant_mcc WHERE merchant = ? OR ? LIKE merchant || '%'
      ORDER BY LENGTH(merchant) DESC LIMIT 1`
  )
    .bind(name.toLowerCase(), name.toLowerCase())
    .first<{ merchant: string; mcc: string; source: string; confidence: string }>();

  const out: MerchantLookup = {
    query: name,
    known: known ?? null,
    results: [],
    source: shortHost(base),
    error: null,
  };
  if (!name) return out;

  const body = await fetchText(`${base}/api/store/search?q=${encodeURIComponent(name)}`);
  if (body === null) {
    out.error = 'the directory did not answer';
    return out;
  }

  let parsed: { merchants?: any[] };
  try {
    parsed = JSON.parse(body);
  } catch {
    out.error = 'the directory returned something unreadable';
    return out;
  }

  for (const m of (parsed.merchants ?? []).slice(0, limit)) {
    const code = String(m?.MCC ?? '').trim();
    if (!/^\d{3,4}$/.test(code)) continue;
    const padded = code.padStart(4, '0');
    // Their description of a code is theirs; ours is what the engine matches on.
    const row = await env.DB.prepare(`SELECT description, category FROM mcc_codes WHERE code = ?`)
      .bind(padded)
      .first<{ description: string; category: string }>();
    out.results.push({
      store: String(m?.displayName ?? m?.Store ?? '').trim(),
      mcc: padded,
      their_description: m?.Category ? String(m.Category) : null,
      channel: m?.type ? String(m.type) : null,
      url: m?.url ? String(m.url) : null,
      description: row?.description ?? null,
      category: row?.category ?? null,
    });
  }
  return out;
}
