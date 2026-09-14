import { addMonths, EFFECTIVE_DATE, today } from './spend';
import type { Env } from './types';

/**
 * The bridge between spending and the points wallet.
 *
 * Adding a transaction already records what the rules say it should earn. What
 * was missing was the other half: getting those points into the balance you
 * plan transfers from. They are never added silently — a bank can post
 * something different, and a wallet that quietly disagrees with the statement
 * is worse than no wallet — so each one waits for you to accept it.
 */

export interface PendingCredit {
  id: number;
  date: string;
  merchant: string | null;
  amount_cents: number;
  card: string;
  program_key: string;
  program_name: string;
  unit: string;
  miles: number;
}

export interface PendingSummary {
  credits: PendingCredit[];
  by_program: { program_key: string; program_name: string; unit: string; points: number; count: number }[];
  total_points: number;
  /** Transactions that earned something but have no programme to put it in. */
  unassigned: { card: string; nickname: string; miles: number; count: number }[];
}

/** Which programme a card's points land in: the rule's, else the card's. */
export async function programForCard(env: Env, cardId: number, ruleId?: number | null): Promise<string | null> {
  if (ruleId) {
    const rule = await env.DB.prepare(`SELECT program_key FROM earn_rules WHERE id = ?`)
      .bind(ruleId)
      .first<{ program_key: string | null }>();
    if (rule?.program_key) return rule.program_key;
  }
  const card = await env.DB.prepare(`SELECT program_key FROM cards WHERE id = ?`)
    .bind(cardId)
    .first<{ program_key: string | null }>();
  return card?.program_key ?? null;
}

/** Everything earned but not yet in the wallet. */
export async function pendingCredits(env: Env, limit = 200): Promise<PendingSummary> {
  const { results } = await env.DB.prepare(
    `SELECT t.id, ${EFFECTIVE_DATE} AS date, t.merchant, t.amount_cents, t.expected_miles AS miles,
            c.nickname AS card, t.expected_program AS program_key,
            COALESCE(p.name, t.expected_program) AS program_name, COALESCE(p.unit, 'points') AS unit
       FROM transactions t
       JOIN cards c ON c.id = t.card_id
       LEFT JOIN programs p ON p.key = t.expected_program
      WHERE t.credited_at IS NULL
        AND t.expected_miles > 0
        AND t.expected_program IS NOT NULL
      ORDER BY date DESC, t.id DESC
      LIMIT ?`
  )
    .bind(limit)
    .all<PendingCredit>();

  const credits = results ?? [];
  const groups = new Map<string, { program_key: string; program_name: string; unit: string; points: number; count: number }>();
  for (const c of credits) {
    const g = groups.get(c.program_key) ?? {
      program_key: c.program_key,
      program_name: c.program_name,
      unit: c.unit,
      points: 0,
      count: 0,
    };
    g.points += c.miles;
    g.count++;
    groups.set(c.program_key, g);
  }

  // Earning with nowhere to put it is a setup gap, not an error — say so
  // rather than dropping the points on the floor.
  const { results: orphans } = await env.DB.prepare(
    `SELECT c.product AS card, c.nickname, SUM(t.expected_miles) AS miles, COUNT(*) AS count
       FROM transactions t JOIN cards c ON c.id = t.card_id
      WHERE t.credited_at IS NULL AND t.expected_miles > 0 AND t.expected_program IS NULL
      GROUP BY c.id ORDER BY miles DESC`
  ).all<any>();

  return {
    credits,
    by_program: [...groups.values()].sort((a, b) => b.points - a.points),
    total_points: credits.reduce((s, c) => s + c.miles, 0),
    unassigned: orphans ?? [],
  };
}

export interface AcceptResult {
  accepted: number;
  points: number;
  tranches: { program_key: string; period: string; points: number; expires_at: string | null }[];
}

/**
 * Move accepted earnings into the wallet.
 *
 * One tranche per programme per month, not per transaction: a year of daily
 * coffees would otherwise be 365 rows that all expire together anyway, and the
 * expiry clock these programmes run is monthly at best.
 */
export async function acceptCredits(env: Env, ids: number[]): Promise<AcceptResult> {
  if (!ids.length) return { accepted: 0, points: 0, tranches: [] };

  const { results } = await env.DB.prepare(
    `SELECT t.id, ${EFFECTIVE_DATE} AS date, t.expected_miles AS miles, t.expected_program AS program_key
       FROM transactions t
      WHERE t.id IN (${ids.map(() => '?').join(',')})
        AND t.credited_at IS NULL AND t.expected_miles > 0 AND t.expected_program IS NOT NULL`
  )
    .bind(...ids)
    .all<{ id: number; date: string; miles: number; program_key: string }>();

  const out: AcceptResult = { accepted: 0, points: 0, tranches: [] };

  for (const row of results ?? []) {
    const period = row.date.slice(0, 7);
    const prog = await env.DB.prepare(`SELECT key, expiry_months FROM programs WHERE key = ?`)
      .bind(row.program_key)
      .first<{ key: string; expiry_months: number | null }>();
    if (!prog) continue; // the programme was deleted; leave the transaction alone

    let tranche = await env.DB.prepare(
      `SELECT id, points FROM balance_tranches WHERE program_key = ? AND source = 'auto' AND period = ?`
    )
      .bind(row.program_key, period)
      .first<{ id: number; points: number }>();

    if (!tranche) {
      const earned = `${period}-01`;
      const expires = prog.expiry_months ? addMonths(earned, prog.expiry_months) : null;
      const ins = await env.DB.prepare(
        `INSERT INTO balance_tranches (program_key, points, earned_at, expires_at, note, source, period)
         VALUES (?, 0, ?, ?, ?, 'auto', ?)`
      )
        .bind(row.program_key, earned, expires, `Earned on card spend, ${period}`, period)
        .run();
      tranche = { id: ins.meta.last_row_id as number, points: 0 };
      out.tranches.push({ program_key: row.program_key, period, points: 0, expires_at: expires });
    }

    await env.DB.prepare(`UPDATE balance_tranches SET points = points + ? WHERE id = ?`)
      .bind(row.miles, tranche.id)
      .run();
    await env.DB.prepare(`UPDATE transactions SET credited_at = ?, credited_tranche_id = ? WHERE id = ?`)
      .bind(today(env), tranche.id, row.id)
      .run();

    out.accepted++;
    out.points += row.miles;
    const t = out.tranches.find((x) => x.program_key === row.program_key && x.period === period);
    if (t) t.points += row.miles;
  }
  return out;
}

/** Take a credit back out of the wallet — the same amount, from the same tranche. */
export async function undoCredit(env: Env, txnId: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id, expected_miles AS miles, credited_tranche_id FROM transactions WHERE id = ? AND credited_at IS NOT NULL`
  )
    .bind(txnId)
    .first<{ id: number; miles: number; credited_tranche_id: number | null }>();
  if (!row) return false;

  if (row.credited_tranche_id) {
    await env.DB.prepare(`UPDATE balance_tranches SET points = MAX(points - ?, 0) WHERE id = ?`)
      .bind(row.miles, row.credited_tranche_id)
      .run();
    // An emptied automatic tranche is noise in the expiry view.
    await env.DB.prepare(`DELETE FROM balance_tranches WHERE id = ? AND source = 'auto' AND points <= 0`)
      .bind(row.credited_tranche_id)
      .run();
  }
  await env.DB.prepare(`UPDATE transactions SET credited_at = NULL, credited_tranche_id = NULL WHERE id = ?`)
    .bind(txnId)
    .run();
  return true;
}

export interface WalletProgram {
  program_key: string;
  name: string;
  kind: string;
  unit: string;
  points: number;
  expiring_soon: number;
  next_expiry: string | null;
  pending: number;
  /** What the balance is worth in miles, once a conversion is applied. */
  miles_equivalent: number | null;
  value_cents: number | null;
  rate_note: string | null;
}

export interface Wallet {
  programs: WalletProgram[];
  totals: { points: number; miles_equivalent: number; value_cents: number; pending_points: number };
  pending: PendingSummary;
  expiring: { program_key: string; name: string; points: number; expires_at: string; days: number }[];
}

/**
 * One view of everything you hold. Bank points are shown both in their own unit
 * and as the miles they would become, because 50,000 Citi points and 50,000
 * miles are not the same thing and a total that adds them up is a lie.
 */
export async function wallet(env: Env, withinDays = 90): Promise<Wallet> {
  const now = today(env);
  const cutoff = new Date(Date.parse(now + 'T00:00:00Z') + withinDays * 86_400_000).toISOString().slice(0, 10);
  const mileValue = parseFloat(env.MILE_VALUE_CENTS ?? '1.5') || 1.5;

  const { results: rows } = await env.DB.prepare(
    `SELECT p.key AS program_key, p.name, p.kind, p.unit,
            COALESCE(SUM(t.points), 0) AS points,
            COALESCE(SUM(CASE WHEN t.expires_at IS NOT NULL AND t.expires_at <= ? THEN t.points ELSE 0 END), 0) AS expiring_soon,
            MIN(t.expires_at) AS next_expiry
       FROM programs p LEFT JOIN balance_tranches t ON t.program_key = p.key
      GROUP BY p.key ORDER BY p.kind, p.name`
  )
    .bind(cutoff)
    .all<any>();

  const pending = await pendingCredits(env);
  const pendingBy = new Map(pending.by_program.map((g) => [g.program_key, g.points]));

  const programs: WalletProgram[] = [];
  for (const r of rows ?? []) {
    let miles: number | null = null;
    let note: string | null = null;

    if (r.unit === 'miles') {
      miles = r.points;
    } else if (r.points > 0) {
      // The best route out of this programme, if one is recorded.
      const route = await env.DB.prepare(
        `SELECT to_program, from_units, to_units, bonus_pct, bonus_until, verified_at
           FROM conversions
          WHERE from_program = ? AND from_units > 0 AND active = 1
          ORDER BY (CAST(to_units AS REAL) / from_units) DESC LIMIT 1`
      )
        .bind(r.program_key)
        .first<any>();
      if (route) {
        // A promotional bonus only counts while it is still running.
        const bonus = route.bonus_until && route.bonus_until < now ? 0 : route.bonus_pct ?? 0;
        miles = Math.floor(((r.points * route.to_units) / route.from_units) * (1 + bonus / 100));
        note =
          `at ${route.from_units}:${route.to_units} to ${route.to_program}` +
          (bonus ? ` +${bonus}%` : '') +
          (route.verified_at ? '' : ' (unverified)');
      }
    }

    programs.push({
      program_key: r.program_key,
      name: r.name,
      kind: r.kind,
      unit: r.unit,
      points: r.points,
      expiring_soon: r.expiring_soon,
      next_expiry: r.next_expiry,
      pending: pendingBy.get(r.program_key) ?? 0,
      miles_equivalent: miles,
      value_cents: miles === null ? null : Math.round(miles * mileValue),
      rate_note: note,
    });
  }

  const { results: expiring } = await env.DB.prepare(
    `SELECT t.program_key, p.name, t.points, t.expires_at
       FROM balance_tranches t JOIN programs p ON p.key = t.program_key
      WHERE t.expires_at IS NOT NULL AND t.expires_at <= ? AND t.points > 0
      ORDER BY t.expires_at LIMIT 20`
  )
    .bind(cutoff)
    .all<any>();

  return {
    programs,
    totals: {
      points: programs.reduce((s, p) => s + p.points, 0),
      miles_equivalent: programs.reduce((s, p) => s + (p.miles_equivalent ?? 0), 0),
      value_cents: programs.reduce((s, p) => s + (p.value_cents ?? 0), 0),
      pending_points: pending.total_points,
    },
    pending,
    expiring: (expiring ?? []).map((e) => ({
      ...e,
      days: Math.round((Date.parse(e.expires_at + 'T00:00:00Z') - Date.parse(now + 'T00:00:00Z')) / 86_400_000),
    })),
  };
}

/**
 * The programme a new card most likely earns into, from its issuer. A starting
 * point only — a cashback card earns no points at all, and some cards credit
 * miles directly — so it is reported when set and changed with /setprogram.
 */
export function defaultProgramForIssuer(issuer: string): string | null {
  const i = issuer.trim().toLowerCase();
  if (/^(uob|united overseas)/.test(i)) return 'uob_uni';
  if (/^(citi|citibank)/.test(i)) return 'citi_ty';
  if (/^(dbs|posb)/.test(i)) return 'dbs_points';
  if (/^ocbc/.test(i)) return 'ocbc_dollar';
  if (/^hsbc/.test(i)) return 'hsbc_points';
  if (/^(amex|american express)/.test(i)) return 'amex_mr';
  if (/^(sc|scb|standard chartered)/.test(i)) return 'scb_360';
  return null;
}

/** Only suggest a programme the database actually knows about. */
export async function guessProgram(env: Env, issuer: string): Promise<string | null> {
  const key = defaultProgramForIssuer(issuer);
  if (!key) return null;
  const row = await env.DB.prepare(`SELECT key FROM programs WHERE key = ?`).bind(key).first<{ key: string }>();
  return row?.key ?? null;
}
