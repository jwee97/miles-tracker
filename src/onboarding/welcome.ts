import { parseDateToken, today } from '../spend';
import type { Env } from '../types';

/**
 * Attaching a welcome offer to a card that was just added.
 *
 * A card opened last month is usually in the middle of a sign-up minimum, and
 * that minimum is the single most consequential thing about where spend should
 * go — miss it and the whole bonus is gone. Asking once, at the moment the card
 * is added, is the only time the question is cheap.
 *
 * The offer becomes an ordinary requirement. There is deliberately no second
 * progress system for sign-up bonuses: the minimum-spend engine already knows
 * how to count spend in a window against a threshold, and a parallel one would
 * drift from it.
 */

export interface WelcomeOffer {
  /** What has to be spent. */
  amount_cents: number;
  /** How long there is to spend it, from the opening date. */
  window_days: number;
  /** What it pays, in the bank's own words. */
  reward_note: string;
  /** Where the terms say so, when there is a source. */
  source_note?: string | null;
  /** Some offers also need N transactions. */
  min_txns?: number | null;
}

export interface AttachResult {
  ok: boolean;
  error?: string;
  requirement_id?: number;
  deadline?: string;
  /** What the app will now track, in a sentence. */
  summary?: string;
}

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Offers the app already knows about for a product.
 *
 * Empty until the promotion platform fills it, and deliberately so: a welcome
 * offer invented from memory would put a deadline and a number in front of
 * someone who would then plan spending around it. When nothing is known the
 * honest answer is to ask.
 */
export async function knownOffers(env: Env, productId: number): Promise<(WelcomeOffer & { id: number })[]> {
  const table = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'promotions'`
  ).first<{ name: string }>();
  if (!table) return [];

  const { results } = await env.DB.prepare(
    `SELECT p.id, p.title, p.terms_json, p.end_at
       FROM promotions p
       JOIN promotion_card_products pc ON pc.promotion_id = p.id
      WHERE pc.product_id = ? AND p.promotion_type = 'welcome_offer' AND p.status = 'published'
      ORDER BY p.end_at IS NULL, p.end_at`
  )
    .bind(productId)
    .all<{ id: number; title: string; terms_json: string | null; end_at: string | null }>();

  const out: (WelcomeOffer & { id: number })[] = [];
  for (const r of results ?? []) {
    let terms: any = {};
    try {
      terms = r.terms_json ? JSON.parse(r.terms_json) : {};
    } catch {
      continue;
    }
    if (typeof terms.minimum_spend_cents !== 'number') continue;
    out.push({
      id: r.id,
      amount_cents: terms.minimum_spend_cents,
      window_days: typeof terms.window_days === 'number' ? terms.window_days : 90,
      reward_note: r.title,
      min_txns: typeof terms.min_txns === 'number' ? terms.min_txns : null,
      source_note: `promotion #${r.id}`,
    });
  }
  return out;
}

export async function attachWelcomeOffer(env: Env, cardId: number, offer: WelcomeOffer): Promise<AttachResult> {
  const card = await env.DB.prepare(`SELECT * FROM cards WHERE id = ?`).bind(cardId).first<any>();
  if (!card) return { ok: false, error: 'no such card' };

  if (!Number.isFinite(offer.amount_cents) || offer.amount_cents <= 0) {
    return { ok: false, error: 'the amount to spend is required' };
  }
  const days = Number(offer.window_days);
  if (!Number.isFinite(days) || days <= 0) return { ok: false, error: 'how long you have is required' };

  // The window runs from the day the card was opened, which is what the bank
  // counts from. Without an opening date there is nothing to count from, and
  // guessing would put a deadline in front of someone that the bank does not
  // recognise.
  const starts = (card.opened_at ?? '').trim() || null;
  if (!starts) {
    return { ok: false, error: 'add the date you got the card first — the offer window runs from it' };
  }
  const deadline = addDays(starts, days);

  const existing = await env.DB.prepare(
    `SELECT id FROM requirements WHERE card_id = ? AND kind = 'signup_min' AND active = 1`
  )
    .bind(cardId)
    .first<{ id: number }>();
  if (existing) return { ok: false, error: 'this card already has a sign-up offer being tracked' };

  const ins = await env.DB.prepare(
    `INSERT INTO requirements (card_id, kind, amount_cents, window, deadline, starts_at, min_txns, reward_note, source_note)
     VALUES (?, 'signup_min', ?, 'fixed_window', ?, ?, ?, ?, ?)`
  )
    .bind(
      cardId,
      offer.amount_cents,
      deadline,
      starts,
      offer.min_txns ?? null,
      offer.reward_note,
      offer.source_note ?? 'added during setup'
    )
    .run();

  const left = Math.round((Date.parse(deadline) - Date.parse(today(env))) / 86_400_000);
  return {
    ok: true,
    requirement_id: ins.meta.last_row_id,
    deadline,
    summary:
      left >= 0
        ? `$${(offer.amount_cents / 100).toFixed(2)} by ${deadline} — ${left} day${left === 1 ? '' : 's'} left`
        : `$${(offer.amount_cents / 100).toFixed(2)} by ${deadline}, which has already passed`,
  };
}

/** Parse a date the way the rest of the app does, so setup accepts the same forms. */
export const asDate = parseDateToken;
