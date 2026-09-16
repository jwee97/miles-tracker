import type { Env } from './types';

/**
 * Tidying merchant names.
 *
 * A statement writes the same merchant a hundred ways: "BUS/MRT 3948201",
 * "BUS/MRT 7712", "NETS BUS/MRT 22". They are one merchant, and until they are
 * spelled as one, every total that groups by merchant is wrong, no category is
 * ever learned, and the merchant-code list has a hundred rows that are really
 * one. Renaming them is not cosmetic.
 *
 * Nothing here guesses on your behalf. A rename reports what it WOULD change
 * first, and only touches rows when told to.
 */

export interface MerchantGroup {
  /** The shared opening of the names, trimmed to a word boundary. */
  prefix: string;
  /** The distinct spellings that start with it. */
  variants: { merchant: string; txn_count: number; spend_cents: number }[];
  txn_count: number;
  spend_cents: number;
}

const MIN_PREFIX = 4;

/** Trims back to the last word boundary, so "BUS/MRT 39" does not become "BUS/MRT 3". */
function toBoundary(s: string): string {
  const cut = s.replace(/[\s\-_/#.,:]*[0-9]*$/, '');
  return cut.trim();
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/**
 * Spellings that look like one merchant, biggest first.
 *
 * The rule is a shared opening long enough to mean something, with what
 * follows differing only by digits and punctuation — which is exactly the shape
 * a terminal id takes. Two genuinely different merchants that happen to share
 * eight characters would be grouped, which is why nothing is applied
 * automatically and every variant is listed before you agree.
 */
export async function merchantGroups(env: Env, limit = 20): Promise<MerchantGroup[]> {
  const { results } = await env.DB.prepare(
    `SELECT TRIM(merchant) AS merchant, COUNT(*) AS txn_count, SUM(amount_cents) AS spend_cents
       FROM transactions
      WHERE merchant IS NOT NULL AND TRIM(merchant) <> ''
      GROUP BY LOWER(TRIM(merchant))
      ORDER BY LOWER(TRIM(merchant))`
  ).all<{ merchant: string; txn_count: number; spend_cents: number }>();

  const rows = results ?? [];
  const groups: MerchantGroup[] = [];
  let run: typeof rows = [];

  const flush = () => {
    if (run.length < 2) {
      run = [];
      return;
    }
    let prefix = run[0].merchant;
    for (const r of run.slice(1)) prefix = commonPrefix(prefix.toLowerCase(), r.merchant.toLowerCase());
    prefix = toBoundary(run[0].merchant.slice(0, prefix.length));
    if (prefix.length >= MIN_PREFIX) {
      groups.push({
        prefix,
        variants: run.map((r) => ({ merchant: r.merchant, txn_count: r.txn_count, spend_cents: r.spend_cents })),
        txn_count: run.reduce((n, r) => n + r.txn_count, 0),
        spend_cents: run.reduce((n, r) => n + r.spend_cents, 0),
      });
    }
    run = [];
  };

  for (const row of rows) {
    if (!run.length) {
      run = [row];
      continue;
    }
    const shared = commonPrefix(run[0].merchant.toLowerCase(), row.merchant.toLowerCase());
    // The tail past the shared opening has to be an id, not another word:
    // "NTUC FAIRPRICE" and "NTUC INCOME" share five characters and are not the
    // same shop.
    const tailIsId = (s: string) => /^[\s\-_/#.,:]*[0-9]*[\s\-_/#.,:]*[0-9]*$/.test(s);
    if (
      toBoundary(row.merchant.slice(0, shared.length)).length >= MIN_PREFIX &&
      tailIsId(row.merchant.slice(shared.length)) &&
      tailIsId(run[0].merchant.slice(shared.length))
    ) {
      run.push(row);
    } else {
      flush();
      run = [row];
    }
  }
  flush();

  return groups.sort((a, b) => b.txn_count - a.txn_count).slice(0, limit);
}

export interface RenameResult {
  /** How many rows the match covers. */
  matched: number;
  /** The distinct names it would replace, so a bad match is visible first. */
  from: string[];
  to: string;
  /** 0 on a preview. */
  updated: number;
  preview: boolean;
}

/**
 * Rename every transaction whose merchant matches, in one go.
 *
 * `prefix` is the mode a terminal id wants; `contains` and `exact` are there
 * for the names that do not start with the useful part.
 */
export async function renameMerchant(
  env: Env,
  opts: { match: string; to: string; mode?: string; apply?: boolean }
): Promise<RenameResult> {
  const match = opts.match.trim();
  const to = opts.to.trim();
  const mode = ['prefix', 'contains', 'exact'].includes(opts.mode ?? '') ? opts.mode! : 'prefix';
  if (!match || !to) throw new Error('both a match and a new name are required');

  // LIKE with an escape, so a merchant with a % or _ in its name does not
  // quietly widen the match to everything.
  const esc = match.replace(/[\\%_]/g, (c) => `\\${c}`).toLowerCase();
  const pattern = mode === 'prefix' ? `${esc}%` : mode === 'contains' ? `%${esc}%` : esc;
  const where = `merchant IS NOT NULL AND LOWER(TRIM(merchant)) LIKE ? ESCAPE '\\'`;

  const { results } = await env.DB.prepare(
    `SELECT TRIM(merchant) AS merchant, COUNT(*) AS n FROM transactions
      WHERE ${where} GROUP BY LOWER(TRIM(merchant)) ORDER BY n DESC`
  )
    .bind(pattern)
    .all<{ merchant: string; n: number }>();

  const from = (results ?? []).map((r) => r.merchant);
  const matched = (results ?? []).reduce((n, r) => n + r.n, 0);

  if (!opts.apply) return { matched, from, to, updated: 0, preview: true };

  const res = await env.DB.prepare(`UPDATE transactions SET merchant = ? WHERE ${where}`)
    .bind(to, pattern)
    .run();
  return { matched, from, to, updated: res.meta.changes ?? 0, preview: false };
}
