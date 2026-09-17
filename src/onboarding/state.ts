import { today } from '../spend';
import { fieldsFor } from './questions';
import type { Env } from '../types';

/**
 * How far through setup we are, and what is still missing.
 *
 * Two things this is careful about. Someone who already has cards is not a new
 * user and must never be shown a welcome screen — but they may still be missing
 * a statement day, and that is a repair, not an onboarding. And nothing here
 * blocks: a card with a gap in it still earns, still gets recommended, and says
 * what the gap costs rather than refusing to answer.
 */

export type OnboardingStatus = 'not_started' | 'in_progress' | 'completed';

export interface OnboardingState {
  status: OnboardingStatus;
  cards_completed: number;
  statements_offered: number;
  wallet_offered: number;
  completed_at: string | null;
  updated_at: string;
}

const DEFAULTS: OnboardingState = {
  status: 'not_started',
  cards_completed: 0,
  statements_offered: 0,
  wallet_offered: 0,
  completed_at: null,
  updated_at: '',
};

export async function readState(env: Env): Promise<OnboardingState> {
  const row = await env.DB.prepare(`SELECT * FROM onboarding_state WHERE id = 1`).first<OnboardingState>();
  return row ?? { ...DEFAULTS };
}

export async function writeState(env: Env, patch: Partial<OnboardingState>): Promise<OnboardingState> {
  const current = await readState(env);
  const next = { ...current, ...patch };
  await env.DB.prepare(
    `INSERT INTO onboarding_state (id, status, cards_completed, statements_offered, wallet_offered, completed_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       cards_completed = excluded.cards_completed,
       statements_offered = excluded.statements_offered,
       wallet_offered = excluded.wallet_offered,
       completed_at = excluded.completed_at,
       updated_at = excluded.updated_at`
  )
    .bind(
      next.status,
      next.cards_completed,
      next.statements_offered,
      next.wallet_offered,
      next.completed_at,
      today(env)
    )
    .run();
  return await readState(env);
}

/**
 * Whether a card can be used for a recommendation, and what it costs if not.
 *
 * Three states rather than two, because "missing something" is not one
 * condition. A card with no statement day still earns the right rate on the
 * right categories; it just cannot track a cycle cap accurately. Refusing to
 * recommend it would be worse than saying so.
 */
export type CardSetupStatus = 'ready' | 'usable_with_limits' | 'needs_setup';

export interface CardSetup {
  card_id: number;
  nickname: string;
  product: string;
  status: CardSetupStatus;
  /** Fields the product asked for and this card has not answered. */
  missing: { field_key: string; label: string; affects: string; required: boolean }[];
  /** What the gap actually costs, in words. */
  consequence: string | null;
}

/** What the app does without each kind of field, said plainly. */
const COST: Record<string, string> = {
  statement_window:
    'Standard rewards still work; a cap that runs by the statement cycle may be counted against the wrong month.',
  reward_calculation: 'The rate this card pays cannot be worked out, so it is left out of recommendations.',
  minimum_spend: 'Progress toward its minimum cannot be tracked.',
  eligibility: 'Sign-up offers for this card cannot be judged.',
  notification: 'Some alerts will not fire.',
};

const VALUE_OF: Record<string, (c: any) => unknown> = {
  // The number is always there; whether anyone told us it is not.
  statement_day: (c) => (c.statement_day_known ? c.statement_day : null),
  opened_at: (c) => c.opened_at,
  credit_limit: (c) => (c.credit_limit_cents ? c.credit_limit_cents : null),
  base_mpd: (c) => (c.base_mpd ? c.base_mpd : null),
  program_key: (c) => c.program_key,
};

export async function cardSetup(env: Env, card: any): Promise<CardSetup> {
  // The same set the setup screen asks for, not a second list. Two lists that
  // are supposed to agree are two lists that will not: a field asked for but
  // never checked leaves a card looking ready with a hole in it.
  const fields = await fieldsFor(env, card.product_id ?? null);

  const missing = fields
    .filter((f) => {
      const read = VALUE_OF[f.key];
      // A field the app does not know how to read is not a field it can call
      // missing. Saying a card needs something and then not being able to tell
      // whether it has it is worse than not asking.
      if (!read) return false;
      const v = read(card);
      return v === null || v === undefined || v === '';
    })
    .map((f) => ({ field_key: f.key, label: f.label, affects: f.affects, required: !!f.required }));

  // Only a field the reward calculation itself cannot do without blocks a card.
  // Everything else degrades: the card earns, and says what is less accurate.
  const blocking = missing.filter((m) => m.required && m.affects === 'reward_calculation');
  const status: CardSetupStatus = blocking.length ? 'needs_setup' : missing.length ? 'usable_with_limits' : 'ready';

  return {
    card_id: card.id,
    nickname: card.nickname,
    product: card.product,
    status,
    missing,
    consequence: missing.length ? (COST[missing[0].affects] ?? null) : null,
  };
}

export async function allCardSetups(env: Env): Promise<CardSetup[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM cards WHERE closed_at IS NULL ORDER BY issuer, product`
  ).all<any>();
  const out: CardSetup[] = [];
  for (const c of results ?? []) out.push(await cardSetup(env, c));
  return out;
}

export interface OnboardingView {
  state: OnboardingState;
  cards: CardSetup[];
  /** Cards that need something, so the app can offer a repair rather than a restart. */
  repairs: CardSetup[];
  /** Set when there is nothing left to ask and the app can simply be used. */
  ready: boolean;
}

/**
 * Where setup stands, including for someone who never went through it.
 *
 * Existing users are migrated by having cards at all: an app that showed a
 * welcome screen to someone with four cards and two years of history would be
 * telling them it had forgotten who they were.
 */
export async function onboardingView(env: Env): Promise<OnboardingView> {
  const cards = await allCardSetups(env);
  let state = await readState(env);

  if (state.status === 'not_started' && cards.length > 0) {
    state = await writeState(env, {
      status: 'completed',
      cards_completed: cards.length,
      completed_at: state.completed_at ?? today(env),
    });
  }

  const repairs = cards.filter((c) => c.status !== 'ready');
  return { state, cards, repairs, ready: state.status === 'completed' && repairs.length === 0 };
}
