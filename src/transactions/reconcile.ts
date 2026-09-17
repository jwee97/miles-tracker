import type { ParsedRow } from '../statement';
import type { Env } from '../types';
import { findDuplicate, rawHash } from './dedupe';
import { ingestTransaction, type IngestResult, type TransactionCandidate } from './ingest';

/**
 * A statement is not a list of transactions to create.
 *
 * It is the bank's record, checked against what the app already believes. Most
 * of its rows are purchases already logged — by the advisor, by the bot, by an
 * SMS — and importing them as new would double a month's spend and wreck every
 * minimum-spend calculation that depends on it.
 *
 * So each row is classified first, the summary is shown, and only then is
 * anything written. Running the same statement twice must create nothing the
 * second time, and that is a test rather than an intention.
 */

export type RowKind =
  | 'matched'
  | 'new'
  | 'possible_duplicate'
  | 'refund'
  | 'payment'
  | 'fee'
  | 'interest'
  | 'needs_review';

export interface ClassifiedRow extends ParsedRow {
  kind: RowKind;
  /** The transaction it matched, when it matched one. */
  matched_id: number | null;
  detail: string;
  /** A stable id for this line, so committing imports exactly what was previewed. */
  external_id: string;
}

export interface StatementPreview {
  card: { id: number; nickname: string; product: string };
  rows: ClassifiedRow[];
  summary: Record<RowKind, number>;
  total_cents: number;
  statement_date: string | null;
}

const PAYMENT = /\b(payment|paymt|pymt|giro|autopay|thank you)\b/i;
const FEE = /\b(annual fee|late (payment )?(charge|fee)|service (charge|fee)|card fee|admin fee)\b/i;
const INTEREST = /\b(interest|finance charge)\b/i;

/**
 * What a statement line is, before deciding what to do about it.
 *
 * A credit is not automatically a refund: a bill payment and an annual fee
 * reversal both arrive as negative amounts and neither is spend. Treating them
 * all as refunds would have them subtract from a minimum they never counted
 * toward in the first place.
 */
function classifyKind(r: ParsedRow): RowKind | null {
  const text = `${r.merchant} ${r.raw}`;
  if (PAYMENT.test(text)) return 'payment';
  if (INTEREST.test(text)) return 'interest';
  if (FEE.test(text)) return 'fee';
  if (r.credit || r.amount_cents < 0) return 'refund';
  return null;
}

/** The identifier a statement row is known by, stable across previews. */
export const rowId = (cardId: number, r: ParsedRow) =>
  `stmt:${cardId}:${rawHash([r.occurred_at, r.posted_at, r.amount_cents, r.merchant, r.raw])}`;

export async function previewStatement(
  env: Env,
  card: { id: number; nickname: string; product: string },
  rows: ParsedRow[],
  statementDate: string | null = null
): Promise<StatementPreview> {
  const out: ClassifiedRow[] = [];
  const summary: Record<RowKind, number> = {
    matched: 0,
    new: 0,
    possible_duplicate: 0,
    refund: 0,
    payment: 0,
    fee: 0,
    interest: 0,
    needs_review: 0,
  };

  for (const r of rows) {
    const external_id = rowId(card.id, r);
    const dup = await findDuplicate(env, {
      card_id: card.id,
      amount_cents: r.amount_cents,
      occurred_at: r.occurred_at,
      posted_at: r.posted_at,
      merchant: r.merchant,
      source: 'statement',
      external_id,
      raw_hash: rawHash(['statement', card.id, r.amount_cents, r.occurred_at, r.raw]),
    });

    let kind: RowKind;
    let detail: string;
    if (dup?.automatic) {
      kind = 'matched';
      detail = dup.detail;
    } else if (dup) {
      kind = 'possible_duplicate';
      detail = dup.detail;
    } else {
      kind = classifyKind(r) ?? 'new';
      detail =
        kind === 'new'
          ? 'not seen before'
          : kind === 'payment'
            ? 'a payment toward the bill, not spend'
            : kind === 'fee'
              ? 'a charge by the bank, not spend'
              : kind === 'interest'
                ? 'interest, not spend'
                : 'money back';
    }

    summary[kind]++;
    out.push({ ...r, kind, matched_id: dup?.transaction_id ?? null, detail, external_id, duplicate: kind === 'matched' });
  }

  return {
    card,
    rows: out,
    summary,
    total_cents: out.filter((r) => r.kind === 'new').reduce((t, r) => t + r.amount_cents, 0),
    statement_date: statementDate,
  };
}

export interface CommitReport {
  processed: number;
  created: number;
  already_known: number;
  reconciled: number;
  queued_for_review: number;
  skipped: { kind: RowKind; count: number }[];
  expected_miles: number;
}

/** Kinds that are the bank's own accounting rather than something you bought. */
const NOT_SPEND: RowKind[] = ['payment', 'fee', 'interest'];

/**
 * Write what the preview showed.
 *
 * Everything goes through the one ingestion path, so a statement row is
 * deduplicated, merchant-resolved, coded and priced exactly as a typed entry
 * is. A row that matched is still offered to the pipeline: the statement knows
 * the posting date and often the code, and the pending row it matched knows
 * neither.
 */
export async function commitStatement(
  env: Env,
  card: { id: number },
  rows: ClassifiedRow[]
): Promise<CommitReport> {
  const report: CommitReport = {
    processed: 0,
    created: 0,
    already_known: 0,
    reconciled: 0,
    queued_for_review: 0,
    skipped: [],
    expected_miles: 0,
  };
  const skipped = new Map<RowKind, number>();

  for (const r of rows) {
    report.processed++;
    if (NOT_SPEND.includes(r.kind)) {
      skipped.set(r.kind, (skipped.get(r.kind) ?? 0) + 1);
      continue;
    }

    const candidate: TransactionCandidate = {
      source: 'statement',
      external_id: r.external_id,
      card_id: card.id,
      amount_cents: r.amount_cents,
      occurred_at: r.occurred_at,
      posted_at: r.posted_at,
      merchant: r.merchant,
      mcc: r.mcc ?? null,
      category: r.category ?? null,
      raw_description: r.raw,
      // A line on a statement has posted by definition; that is what a
      // statement is.
      status: 'posted',
    };

    const res: IngestResult = await ingestTransaction(env, candidate);
    if (res.status === 'duplicate') report.already_known++;
    else if (res.status === 'updated') {
      report.already_known++;
      if (res.reconciled) report.reconciled++;
    } else if (res.status === 'created' || res.status === 'needs_review') {
      report.created++;
      report.expected_miles += res.reward?.miles ?? 0;
      if (res.status === 'needs_review') report.queued_for_review++;
    }
  }

  report.skipped = [...skipped.entries()].map(([kind, count]) => ({ kind, count }));
  return report;
}
