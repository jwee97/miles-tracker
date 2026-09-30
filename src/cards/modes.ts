import { cached } from '../cache';
import type { Env } from '../types';
import type { EarnRule } from '../rules';

/**
 * Cards that make you choose what they pay.
 *
 * The Trust Freedom Card pays miles, or one of two cashback structures, or
 * stock — one of them, chosen at onboarding and locked for the membership
 * quarter. Encoding only the mode you happen to be on today would be wrong in
 * two directions at once: every other mode disappears from the app, so it can
 * never tell you the choice was worth revisiting; and when you do switch, last
 * quarter's purchases get re-priced under this quarter's mode, which restates
 * what the card already earned.
 *
 * So a mode is a dated choice, in the same shape as a versioned rule set, and
 * for the same reason: which rules applied is a question about a DATE.
 *
 * A rule with no mode applies whatever the card is set to. That is what every
 * ordinary card's rules look like, so nothing here changes them.
 */

export interface CardMode {
  id: number;
  product_id: number;
  mode_key: string;
  label: string;
  payout: 'cash' | 'miles' | 'stock' | 'points' | string;
  picks_category: number;
  category_choices: string | null;
  note: string | null;
}

export interface ModeChoice {
  id: number;
  card_id: number;
  mode_key: string;
  category: string | null;
  effective_from: string;
  effective_until: string | null;
  note: string | null;
}

/** The placeholder a rule uses for "whichever category the holder picked". */
export const SELECTED = '@selected';

/** What a product offers. Empty for the vast majority of cards, which offer one thing. */
export async function modesOf(env: Env, productId: number | null): Promise<CardMode[]> {
  if (!productId) return [];
  return cached(env, `modes:${productId}`, async () => {
    const { results } = await env.DB.prepare(
      `SELECT * FROM card_modes WHERE product_id = ? ORDER BY id`
    )
      .bind(productId)
      .all<CardMode>();
    return results ?? [];
  });
}

/** Every choice this card has made, oldest first. The history is the point. */
export async function choicesOf(env: Env, cardId: number): Promise<ModeChoice[]> {
  return cached(env, `modechoices:${cardId}`, async () => {
    const { results } = await env.DB.prepare(
      `SELECT * FROM card_mode_choices WHERE card_id = ? ORDER BY effective_from, id`
    )
      .bind(cardId)
      .all<ModeChoice>();
    return results ?? [];
  });
}

/**
 * The mode a card was set to on a given day.
 *
 * Resolved in memory from the card's own history rather than with a query per
 * purchase: pricing a statement asks this once a line, and the history is a
 * handful of rows.
 */
export function chosenOn(choices: ModeChoice[], on: string): ModeChoice | null {
  let found: ModeChoice | null = null;
  for (const c of choices) {
    if (c.effective_from > on) continue;
    if (c.effective_until && c.effective_until < on) continue;
    // Later start wins, so re-stating the current mode with a newer date works.
    if (!found || c.effective_from >= found.effective_from) found = c;
  }
  return found;
}

export async function modeOn(env: Env, cardId: number, on: string): Promise<ModeChoice | null> {
  return chosenOn(await choicesOf(env, cardId), on);
}

/**
 * The rules that apply under one choice.
 *
 * Two things happen here. Rules belonging to a mode that is not the selected
 * one are dropped. And a rule written against the placeholder category takes
 * the category the holder actually picked — which is how "5% on the category
 * you chose this quarter" is one rule rather than six.
 *
 * With no choice recorded, mode-specific rules are dropped rather than all
 * being applied. A card whose modes are known but whose selection is not is a
 * card nobody has told us about yet, and the honest reading of that is the base
 * rate, not the best of four structures the holder may not be on.
 */
export function rulesUnder(rules: EarnRule[], choice: ModeChoice | null): EarnRule[] {
  return rules
    .filter((r) => {
      const mode = (r as { mode_key?: string | null }).mode_key ?? null;
      if (!mode) return true;
      return choice !== null && mode === choice.mode_key;
    })
    .map((r) => {
      if (r.category !== SELECTED) return r;
      // A mode that picks a category, with no category picked, covers nothing.
      if (!choice?.category) return { ...r, category: '\u0000none' };
      return { ...r, category: choice.category };
    });
}

/** Whether a product has modes at all — the cheap check before doing any of this. */
export async function hasModes(env: Env, productId: number | null): Promise<boolean> {
  return (await modesOf(env, productId)).length > 0;
}

export class ModeError extends Error {}

/**
 * Record a switch.
 *
 * The previous choice is closed the day before the new one starts rather than
 * deleted, so what the card earned under it keeps the mode it earned under.
 * Same handover the rule sets make, and refused in the same case: a start date
 * on or before the choice it replaces would leave two modes covering one day,
 * and the pricing would silently pick one.
 */
export async function chooseMode(
  env: Env,
  card: { id: number; product_id: number | null; nickname: string },
  mode_key: string,
  opts: { from: string; category?: string | null; note?: string | null } = { from: '' }
): Promise<ModeChoice> {
  const modes = await modesOf(env, card.product_id);
  const mode = modes.find((m) => m.mode_key === mode_key);
  if (!mode) {
    throw new ModeError(
      modes.length
        ? `${card.nickname} has no mode called "${mode_key}" — it offers ${modes.map((m) => m.mode_key).join(', ')}`
        : `${card.nickname} does not have selectable rewards`
    );
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.from)) throw new ModeError('a date this mode starts from is required');

  const category = (opts.category ?? '').trim().toLowerCase() || null;
  if (mode.picks_category && !category) {
    throw new ModeError(`${mode.label} also picks a category — one of ${mode.category_choices ?? 'the ones it lists'}`);
  }
  if (category && mode.category_choices) {
    const allowed = mode.category_choices.split(',').map((c) => c.trim().toLowerCase());
    if (!allowed.includes(category)) {
      throw new ModeError(`${mode.label} cannot be set to ${category} — it offers ${allowed.join(', ')}`);
    }
  }

  const choices = await choicesOf(env, card.id);
  const open = choices.filter((c) => c.effective_until === null).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
  if (open && open.effective_from >= opts.from) {
    throw new ModeError(
      `${card.nickname} has been on ${open.mode_key} since ${open.effective_from}, so a switch cannot start on or before that day`
    );
  }

  if (open) {
    const close = new Date(Date.parse(`${opts.from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    await env.DB.prepare(`UPDATE card_mode_choices SET effective_until = ? WHERE id = ?`).bind(close, open.id).run();
  }

  const ins = await env.DB.prepare(
    `INSERT INTO card_mode_choices (card_id, mode_key, category, effective_from, note)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(card.id, mode.mode_key, mode.picks_category ? category : null, opts.from, opts.note ?? null)
    .run();

  const made = await env.DB.prepare(`SELECT * FROM card_mode_choices WHERE id = ?`)
    .bind(ins.meta.last_row_id)
    .first<ModeChoice>();
  if (!made) throw new ModeError('the choice could not be recorded');
  return made;
}

/** Add a mode to a product. Idempotent on (product, key), like everything else here. */
export async function defineMode(
  env: Env,
  productId: number,
  m: {
    mode_key: string;
    label: string;
    payout?: string;
    picks_category?: boolean;
    category_choices?: string | null;
    note?: string | null;
  }
): Promise<CardMode> {
  await env.DB.prepare(
    `INSERT INTO card_modes (product_id, mode_key, label, payout, picks_category, category_choices, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_id, mode_key) DO UPDATE SET
       label = excluded.label, payout = excluded.payout, picks_category = excluded.picks_category,
       category_choices = excluded.category_choices, note = excluded.note`
  )
    .bind(
      productId,
      m.mode_key,
      m.label,
      m.payout ?? 'cash',
      m.picks_category ? 1 : 0,
      m.category_choices ?? null,
      m.note ?? null
    )
    .run();

  const made = await env.DB.prepare(`SELECT * FROM card_modes WHERE product_id = ? AND mode_key = ?`)
    .bind(productId, m.mode_key)
    .first<CardMode>();
  if (!made) throw new ModeError(`could not define mode ${m.mode_key}`);
  return made;
}
