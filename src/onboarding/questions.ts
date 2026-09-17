import type { Env } from '../types';

/**
 * What to ask about a card, and nothing else.
 *
 * The rule: a question earns its place only if the answer changes a number. A
 * credit limit does not change which card to use, so it is optional and asked
 * later; a statement day decides which month a cap belongs to, so it is asked
 * up front. Anything the catalogue already knows — the rates, the programme,
 * the excluded codes — is never asked at all.
 */

export type FieldType = 'date' | 'day_of_month' | 'money' | 'number' | 'choice' | 'boolean';
export type Affects = 'reward_calculation' | 'statement_window' | 'minimum_spend' | 'eligibility' | 'notification';

export interface OnboardingField {
  key: string;
  type: FieldType;
  label: string;
  help_text: string | null;
  required: boolean;
  affects: Affects;
  sort: number;
}

/**
 * What every card needs, whatever it is.
 *
 * Both of these are facts about your copy of the card that no catalogue can
 * hold: when the bank gave it to you, and which day it bills.
 */
export const UNIVERSAL: OnboardingField[] = [
  {
    key: 'opened_at',
    type: 'date',
    label: 'When did you get this card?',
    help_text: 'It sets the quarters on cards that run in quarters, and decides which sign-up offers still apply.',
    required: false,
    affects: 'minimum_spend',
    sort: 10,
  },
  {
    key: 'statement_day',
    type: 'day_of_month',
    label: 'When does your statement usually close?',
    help_text: 'Caps and minimums are counted per statement cycle, so this decides which month a purchase lands in.',
    required: true,
    affects: 'statement_window',
    sort: 20,
  },
  {
    key: 'credit_limit',
    type: 'money',
    label: 'Credit limit',
    help_text: 'Only used for the utilisation bars. Recommendations do not need it.',
    required: false,
    affects: 'notification',
    sort: 90,
  },
];

/**
 * The questions for one product: the universal ones, plus whatever the
 * catalogue says this particular card needs.
 */
export async function fieldsFor(env: Env, productId: number | null): Promise<OnboardingField[]> {
  const extra: OnboardingField[] = [];
  if (productId) {
    const { results } = await env.DB.prepare(
      `SELECT field_key, field_type, label, help_text, required, affects, sort
         FROM product_onboarding_fields WHERE product_id = ? ORDER BY sort, id`
    )
      .bind(productId)
      .all<any>();
    for (const r of results ?? []) {
      extra.push({
        key: r.field_key,
        type: r.field_type,
        label: r.label,
        help_text: r.help_text,
        required: !!r.required,
        affects: r.affects,
        sort: r.sort ?? 50,
      });
    }
  }

  const byKey = new Map<string, OnboardingField>();
  for (const f of UNIVERSAL) byKey.set(f.key, f);
  // A product's own entry wins: a card that genuinely needs an opening date
  // can say so, and make an otherwise optional question required.
  for (const f of extra) byKey.set(f.key, f);

  return [...byKey.values()].sort((a, b) => a.sort - b.sort);
}

/**
 * Record what a product needs. Idempotent, so the catalogue can declare its
 * requirements on every deploy without piling up duplicates.
 */
export async function declareField(
  env: Env,
  productId: number,
  f: Omit<OnboardingField, 'help_text'> & { help_text?: string | null }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO product_onboarding_fields (product_id, field_key, field_type, label, help_text, required, affects, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_id, field_key) DO UPDATE SET
       field_type = excluded.field_type, label = excluded.label, help_text = excluded.help_text,
       required = excluded.required, affects = excluded.affects, sort = excluded.sort`
  )
    .bind(productId, f.key, f.type, f.label, f.help_text ?? null, f.required ? 1 : 0, f.affects, f.sort)
    .run();
}

/**
 * Cards whose mechanics need something extra.
 *
 * Kept as data rather than as a screen per card. UOB One runs on quarters
 * anchored to the month it was issued, so its opening date is not optional the
 * way it is elsewhere — without it the app cannot say which quarter you are in,
 * and a quarterly card that does not know its quarter is not tracking anything.
 */
export const QUARTERLY_ANCHORED = ['uob_one', 'uob_ladys', 'uob_ladys_solitaire'];

export async function seedOnboardingFields(env: Env): Promise<{ declared: number }> {
  let declared = 0;
  for (const key of QUARTERLY_ANCHORED) {
    const p = await env.DB.prepare(`SELECT id FROM card_products WHERE product_key = ?`)
      .bind(key)
      .first<{ id: number }>();
    if (!p) continue;
    await declareField(env, p.id, {
      key: 'opened_at',
      type: 'date',
      label: 'When did you get this card?',
      help_text: 'This card pays by the quarter, and the quarters are counted from the month it was issued.',
      required: true,
      affects: 'minimum_spend',
      sort: 10,
    });
    declared++;
  }
  return { declared };
}
