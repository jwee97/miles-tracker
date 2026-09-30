import type { Env } from '../types';
import { ensureProduct, productKeyOf } from './products';
import { draftRuleSet, publishRuleSet } from './rulesets';

/**
 * Moving the existing cards onto the product model.
 *
 * The rule this follows: nothing is deleted, nothing is invented, and running
 * it twice changes nothing the first run did. It creates one product per
 * distinct card product, links each card to it, and wraps that card's existing
 * rules in version 1 of a rule set that has applied since the card was opened.
 *
 * The effective date is the honest weak point. The real start of a card's terms
 * is not recorded anywhere, so the card's opening date is used and the product
 * is marked `migrated_unverified` — which lowers a recommendation's confidence
 * rather than pretending the date was checked.
 */

export interface ProductMigrationReport {
  products_created: number;
  cards_linked: number;
  rule_sets_created: number;
  rules_attached: number;
  exclusions_copied: number;
  /** Cards that could not be linked, with the reason. Never silent. */
  skipped: { nickname: string; why: string }[];
  /** Data that was inconsistent and has been made consistent, said out loud. */
  repaired: { nickname: string; what: string }[];
  alreadyDone: boolean;
}

/** The earliest date any calculation could reasonably ask about. */
const DAWN = '2000-01-01';

export async function migrateCardsToProducts(env: Env, today: string): Promise<ProductMigrationReport> {
  const report: ProductMigrationReport = {
    products_created: 0,
    cards_linked: 0,
    rule_sets_created: 0,
    rules_attached: 0,
    exclusions_copied: 0,
    skipped: [],
    repaired: [],
    alreadyDone: false,
  };

  const { results: cards } = await env.DB.prepare(
    `SELECT id, issuer, product, product_key, nickname, opened_at, base_mpd, program_key, product_id
       FROM cards ORDER BY id`
  ).all<any>();
  if (!cards?.length) {
    report.alreadyDone = true;
    return report;
  }

  // Which programmes exist, read once. Every card is checked against this, and
  // the alternative is one query per card on a step that already runs on every
  // deploy.
  const { results: programs } = await env.DB.prepare(`SELECT key FROM programs`).all<{ key: string }>();
  const known = new Set((programs ?? []).map((p) => p.key));

  for (const card of cards) {
    try {
      await migrateOneCard(env, card, today, report, known);
    } catch (e) {
      // One card's problem used to end the whole step, so a single bad row left
      // every other card unlinked — and the reason was a database error with no
      // card named in it.
      report.skipped.push({ nickname: card.nickname, why: (e as Error).message });
    }
  }

  report.alreadyDone =
    report.products_created === 0 &&
    report.cards_linked === 0 &&
    report.rule_sets_created === 0 &&
    report.rules_attached === 0 &&
    report.exclusions_copied === 0 &&
    report.repaired.length === 0;
  return report;
}

async function migrateOneCard(
  env: Env,
  card: any,
  today: string,
  report: ProductMigrationReport,
  known: Set<string>
): Promise<void> {
  {
    const key = (card.product_key ?? '').trim() || productKeyOf(card.issuer ?? 'unknown', card.product ?? card.nickname);
    if (!key) {
      report.skipped.push({ nickname: card.nickname, why: 'no issuer or product name to build a key from' });
      return;
    }

    // A card pointing at a programme that is not in the table is a write
    // waiting to fail: the product it becomes has the same foreign key, so the
    // whole migration stopped here. The programme is the least of what a card
    // holds, so the dangling name is cleared and said out loud rather than
    // being carried forward into a second table.
    if (card.program_key && !known.has(card.program_key)) {
      await env.DB.prepare(`UPDATE cards SET program_key = NULL WHERE id = ?`).bind(card.id).run();
      report.repaired.push({
        nickname: card.nickname,
        what: `pointed at a programme called "${card.program_key}", which does not exist — cleared, so set it again under Cards`,
      });
      card.program_key = null;
    }

    const before = await env.DB.prepare(`SELECT id FROM card_products WHERE product_key = ?`).bind(key).first();
    const product = await ensureProduct(env, {
      product_key: key,
      issuer: card.issuer ?? 'unknown',
      product_name: card.product ?? card.nickname,
      program_key: card.program_key ?? null,
      base_mpd: typeof card.base_mpd === 'number' ? card.base_mpd : null,
      // Migrated, not checked against a bank document. Saying so is the point.
      source: 'imported',
      verification_status: 'migrated_unverified',
    });
    if (!before) report.products_created++;

    if (card.product_id !== product.id) {
      await env.DB.prepare(`UPDATE cards SET product_id = ? WHERE id = ?`).bind(product.id, card.id).run();
      report.cards_linked++;
    }

    // One rule set per product, holding the rules of every card on it. A second
    // card of the same product finds the set already there and adds to it.
    let set = await env.DB.prepare(
      `SELECT * FROM rule_sets WHERE product_id = ? ORDER BY version LIMIT 1`
    )
      .bind(product.id)
      .first<{ id: number }>();

    const { results: loose } = await env.DB.prepare(
      `SELECT id FROM earn_rules WHERE card_id = ? AND rule_set_id IS NULL AND active = 1`
    )
      .bind(card.id)
      .all<{ id: number }>();

    if (!set) {
      if (!loose?.length) return; // nothing to version yet
      // The card's opening date, or the dawn of the data if it has none. Never
      // invented: an unknown start is explicitly the earliest possible one.
      const from = (card.opened_at ?? '').trim() || DAWN;
      const draft = await draftRuleSet(env, product.id, from, {
        notes: 'migrated from per-card rules',
      });
      set = await publishRuleSet(env, draft.id, today);
      report.rule_sets_created++;
    }

    for (const r of loose ?? []) {
      await env.DB.prepare(`UPDATE earn_rules SET rule_set_id = ? WHERE id = ?`).bind(set.id, r.id).run();
      report.rules_attached++;
    }

    // Card-scoped exclusions become part of the version too; global ones stay
    // global rather than being copied into every product.
    const { results: ex } = await env.DB.prepare(
      `SELECT mcc, reason FROM exclusions WHERE card_id = ? AND active = 1`
    )
      .bind(card.id)
      .all<{ mcc: string; reason: string | null }>();
    for (const e of ex ?? []) {
      const dup = await env.DB.prepare(`SELECT id FROM rule_exclusions WHERE rule_set_id = ? AND mcc = ?`)
        .bind(set.id, e.mcc)
        .first();
      if (dup) continue;
      await env.DB.prepare(`INSERT INTO rule_exclusions (rule_set_id, mcc, reason) VALUES (?, ?, ?)`)
        .bind(set.id, e.mcc, e.reason)
        .run();
      report.exclusions_copied++;
    }
  }
}

/**
 * The rule set a card's rules live in right now, creating one if the card has
 * none yet — so a rule added after the migration still lands in a version.
 */
export async function currentRuleSetFor(env: Env, cardId: number, today: string): Promise<number | null> {
  const card = await env.DB.prepare(`SELECT product_id, opened_at FROM cards WHERE id = ?`)
    .bind(cardId)
    .first<{ product_id: number | null; opened_at: string | null }>();
  if (!card?.product_id) return null;

  const open = await env.DB.prepare(
    `SELECT id FROM rule_sets WHERE product_id = ? AND status = 'published' AND effective_until IS NULL
     ORDER BY effective_from DESC LIMIT 1`
  )
    .bind(card.product_id)
    .first<{ id: number }>();
  if (open) return open.id;

  const draft = await draftRuleSet(env, card.product_id, (card.opened_at ?? '').trim() || DAWN, {
    notes: 'opened for rules added after the product migration',
  });
  const published = await publishRuleSet(env, draft.id, today);
  return published.id;
}
