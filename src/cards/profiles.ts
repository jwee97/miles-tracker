import { currentRuleSetFor } from '../catalog/migrate-products';
import { money, today } from '../spend';
import type { Env } from '../types';
import { choicesOf, modesOf } from './modes';

/**
 * A card's whole reward structure as data, checked against the bank's own
 * examples, and a way to put a card's records back to it.
 *
 * Why this exists: a card like the Trust Freedom takes 42 commands to set up,
 * and a card set up by hand over several attempts ends up holding rules from
 * each attempt — the extraction's, the first correction's, the second's. There
 * was no way to say "make this card exactly this": /delearn went one rule at a
 * time and, until recently, did not even stop the rule applying.
 *
 * A profile is a claim about a bank product, so it says where it came from and
 * when it was checked, and `test/trust.ts` proves it against the bank's own
 * worked examples. It is applied only when a person asks, after being shown
 * exactly what will change.
 */

export interface ProfileRule {
  category: string;
  rate: number;
  reward_type: 'miles' | 'cashback';
  mode_key?: string;
  region?: 'local' | 'foreign';
  cap_cents?: number;
  cap_window?: string;
  cap_group?: string;
  min_tier_cents?: number;
  min_txn_cents?: number;
  earn_step_cents?: number;
  mcc_include?: string;
}

export interface CardProfile {
  key: string;
  product_key: string;
  issuer: string;
  product_name: string;
  sources: string[];
  verified_on: string;
  modes: {
    mode_key: string;
    label: string;
    payout: string;
    category_choices?: string;
    is_default?: boolean;
  }[];
  rules: ProfileRule[];
  exclusions: { codes: string; reason: string }[];
  /** A minimum that decides a tier, and the rungs it has. */
  requirement?: { amount_cents: number; window: string; mode_key: string; note: string; rungs_cents: number[] };
  /** What is known and deliberately not modelled, said out loud. */
  not_modelled: string[];
}

const TRUST_CATEGORIES: Record<string, string> = {
  dining: '5462,5499,5811,5812,5814',
  shopping:
    '4812,5137,5262,5309,5310,5311,5331,5399,5611,5621,5631,5641,5651,5655,5661,5681,5691,5712,5732,5699,5940,5941,5942,5944,5946,5947,5948,5977',
  travel: '3000-3308,3501-3839,4411,4511,4582,4722,4723,5962,7011,7012,7033',
  wellness: '5912,5997,7230,7297,7298,7997,8031,8041,8049',
  transport: '3351-3441,4111,4112,4121,4131,4457,4784,4789,5521,5541,5542,5552,5983,7512,7513,7519,7523',
  entertainment: '4899,5733,5735,5813,5815,5816,5945,7832,7841,7922',
};

/**
 * The Trust Freedom Card, from the Key Facts Sheet and Product Terms.
 *
 * Caps are SPEND caps, because that is what the engine counts; Trust caps the
 * REWARD, so each is the reward cap divided by the rate. S$500 of stock at 3%
 * is S$16,666.67 of spend; S$250 of bonus at 15% is S$1,666.67; S$30 at 5% is
 * S$600. Getting that the wrong way round caps Stockback at S$15 a quarter.
 */
export const TRUST_FREEDOM: CardProfile = {
  key: 'trust_freedom',
  product_key: 'trust_freedom_card',
  issuer: 'Trust',
  product_name: 'Freedom Card',
  sources: [
    'https://trustbank.sg/legal/trust-freedom-credit-card-key-facts-sheet/',
    'https://trustbank.sg/legal/trust-freedom-credit-card-product-terms/',
  ],
  verified_on: '2026-09-30',
  modes: [
    { mode_key: 'unlimited_cashback', label: 'Unlimited Cashback', payout: 'cash', is_default: true },
    {
      mode_key: 'bonus_cashback',
      label: 'Bonus Cashback',
      payout: 'cash',
      category_choices: Object.keys(TRUST_CATEGORIES).join(','),
    },
    { mode_key: 'stockback', label: 'Stockback', payout: 'stock' },
    { mode_key: 'miles', label: 'Miles', payout: 'miles' },
  ],
  rules: [
    // Unlimited Cashback: 1.5% local, 0.5% foreign, nothing under S$1.
    { category: '*', rate: 1.5, reward_type: 'cashback', mode_key: 'unlimited_cashback', region: 'local', min_txn_cents: 100 },
    { category: '*', rate: 0.5, reward_type: 'cashback', mode_key: 'unlimited_cashback', region: 'foreign', min_txn_cents: 100 },
    // Stockback: 3% local and foreign until 31 Dec 2026, S$500 of stock a quarter.
    {
      category: '*',
      rate: 3,
      reward_type: 'cashback',
      mode_key: 'stockback',
      cap_cents: 1666667,
      cap_window: 'membership_quarter',
      min_txn_cents: 100,
    },
    // Miles: 1.3 per S$1 local or foreign, in steps of S$5, no cap.
    { category: '*', rate: 1.3, reward_type: 'miles', mode_key: 'miles', earn_step_cents: 500 },
    // Bonus Cashback base: 1% local, 0.5% foreign, on everything.
    { category: '*', rate: 1, reward_type: 'cashback', mode_key: 'bonus_cashback', region: 'local', min_txn_cents: 100 },
    { category: '*', rate: 0.5, reward_type: 'cashback', mode_key: 'bonus_cashback', region: 'foreign', min_txn_cents: 100 },
    // The bonus on the picked category, stacked on the base: 15% if every month
    // of the quarter reaches S$2,000, 5% if every month reaches S$500.
    ...Object.entries(TRUST_CATEGORIES).flatMap(([category, codes]): ProfileRule[] => {
      const base = {
        category,
        reward_type: 'cashback' as const,
        mode_key: `bonus_cashback:${category}`,
        cap_window: 'membership_quarter',
        min_txn_cents: 100,
        mcc_include: codes,
      };
      return [
        { ...base, rate: 16, region: 'local', min_tier_cents: 200000, cap_cents: 166667, cap_group: 'bonus15' },
        { ...base, rate: 15.5, region: 'foreign', min_tier_cents: 200000, cap_cents: 166667, cap_group: 'bonus15' },
        { ...base, rate: 6, region: 'local', min_tier_cents: 50000, cap_cents: 60000, cap_group: 'bonus5' },
        { ...base, rate: 5.5, region: 'foreign', min_tier_cents: 50000, cap_cents: 60000, cap_group: 'bonus5' },
      ];
    }),
  ],
  exclusions: [
    { codes: '4900,6513,7349', reason: 'utilities, rentals and cleaning services' },
    { codes: '4829,5960,6010,6011,6012,6051,6211,6300,6540', reason: 'financial institutions, quasi cash, insurance, stored value, wire transfer' },
    { codes: '7995', reason: 'gambling' },
    { codes: '8211,8220,8241,8244,8249,8299', reason: 'educational institutions' },
    { codes: '8398,8651,8661,9211,9222,9223,9311,9399,9402,9405', reason: 'charitable, political, religious organisations, government payments' },
    { codes: '7299,7399,8999', reason: 'other services' },
  ],
  requirement: {
    amount_cents: 50000,
    window: 'membership_quarter',
    mode_key: 'bonus_cashback',
    note: 'Bonus Cashback minimum',
    rungs_cents: [50000, 200000],
  },
  not_modelled: [
    'From 1 Jan 2027 Stockback pays 2% local and 0.5% foreign — a new dated version under Catalogue → Edit its rules.',
    'The first calendar month after approval waives the Bonus Cashback minimum.',
    'Exclusions without a merchant code: cash advances, AXS, SAM, ATM, instalments, fees, top-ups.',
    'Foreign spend is only known when tagged #fx; a statement import cannot tell.',
  ],
};

export const PROFILES: CardProfile[] = [TRUST_FREEDOM];

export const profileFor = (productKey: string | null | undefined) =>
  PROFILES.find((p) => p.product_key === productKey) ?? null;

const dollars = (cents: number) => (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100));

/**
 * The same card as bot commands, for pasting by hand and for the test that
 * proves the commands and the profile describe one card.
 */
export function profileCommands(p: CardProfile, nickname: string): string {
  const L: string[] = [];
  for (const m of p.modes) {
    L.push(
      `/mode ${nickname} add ${m.mode_key}|${m.label}|${m.payout}|${m.category_choices ?? ''}${m.is_default ? '|default' : ''}`.replace(
        /\|$/,
        ''
      )
    );
  }
  for (const r of p.rules) {
    const parts = [`/addearn ${nickname} ${r.category} ${r.rate}${r.reward_type === 'cashback' ? '%' : ''}`];
    if (r.mode_key) parts.push(`mode ${r.mode_key}`);
    if (r.min_tier_cents) parts.push(`tier ${dollars(r.min_tier_cents)}`);
    if (r.region) parts.push(`region ${r.region}`);
    if (r.cap_cents) parts.push(`cap ${dollars(r.cap_cents)}`);
    if (r.cap_window) parts.push(`window ${r.cap_window}`);
    if (r.cap_group) parts.push(`group ${r.cap_group}`);
    if (r.min_txn_cents) parts.push(`min ${dollars(r.min_txn_cents)}`);
    if (r.earn_step_cents) parts.push(`step ${dollars(r.earn_step_cents)}`);
    if (r.mcc_include) parts.push(`mcc ${r.mcc_include}`);
    L.push(parts.join(' '));
  }
  if (p.requirement) {
    const q = p.requirement;
    L.push(`/req ${nickname}|monthly_min|${dollars(q.amount_cents)}|${q.window}||||${q.note}|${q.mode_key}`);
    L.push(`/tiers ${nickname} ${q.rungs_cents.map((c) => `${dollars(c)}=0`).join(' ')}`);
  }
  for (const x of p.exclusions) L.push(`/exclude ${x.codes} ${nickname} ${x.reason}`);
  return L.join('\n');
}

export interface ProfilePlan {
  card: { id: number; nickname: string; product: string };
  profile: string;
  remove: { rules: string[]; exclusions: number; requirements: number; modes: string[]; choices: string[] };
  add: { rules: number; exclusions: number; modes: number; requirement: boolean };
  card_fields: string[];
  mode_after: string;
}

interface CardRow {
  id: number;
  nickname: string;
  product: string;
  product_id: number | null;
  opened_at: string | null;
  base_mpd: number | null;
  program_key: string | null;
}

const describeRule = (r: any) =>
  `#${r.id} ${r.category} ${r.mpd}${r.reward_type === 'cashback' ? '%' : ' mpd'}` +
  (r.mode_key ? ` [${r.mode_key}]` : '') +
  (r.cap_cents ? ` cap $${money(r.cap_cents)}${r.cap_window ? `/${r.cap_window}` : ''}` : '');

/**
 * What applying the profile would change, and nothing else. Read-only, so it
 * can be shown before anything is touched.
 */
export async function planProfile(env: Env, card: CardRow, p: CardProfile, mode?: string | null): Promise<ProfilePlan> {
  const { results: rules } = await env.DB.prepare(
    `SELECT * FROM earn_rules
      WHERE active = 1 AND (card_id = ? OR rule_set_id IN (SELECT id FROM rule_sets WHERE product_id = ?))
      ORDER BY id`
  )
    .bind(card.id, card.product_id ?? -1)
    .all<any>();
  const ex = await env.DB.prepare(`SELECT COUNT(*) AS n FROM exclusions WHERE card_id = ? AND active = 1`)
    .bind(card.id)
    .first<{ n: number }>();
  const req = await env.DB.prepare(`SELECT COUNT(*) AS n FROM requirements WHERE card_id = ? AND active = 1`)
    .bind(card.id)
    .first<{ n: number }>();
  const modes = await modesOf(env, card.product_id);
  const choices = await choicesOf(env, card.id);

  const keep = new Set(p.modes.map((m) => m.mode_key));
  const staleModes = modes.filter((m) => !keep.has(m.mode_key)).map((m) => m.mode_key);
  const dropChoices = choices.filter((c) => (mode ? true : !keep.has(c.mode_key)));

  const fields: string[] = [];
  if ((card.base_mpd ?? 0) !== 0) {
    fields.push(`base rate ${card.base_mpd} → 0 (every rate on this card belongs to a mode)`);
  }
  if (card.program_key) fields.push(`programme ${card.program_key} → none (what it pays depends on the mode)`);

  const anchor = card.opened_at ?? today(env);
  const modeAfter = mode
    ? `${mode} from ${anchor}, when the card was opened`
    : choices.filter((c) => keep.has(c.mode_key)).length
      ? 'unchanged'
      : `nothing chosen — ${p.modes.find((m) => m.is_default)?.label ?? 'the default'} applies until you choose`;

  return {
    card: { id: card.id, nickname: card.nickname, product: card.product },
    profile: p.key,
    remove: {
      rules: (rules ?? []).map(describeRule),
      exclusions: ex?.n ?? 0,
      requirements: req?.n ?? 0,
      modes: staleModes,
      choices: dropChoices.map((c) => `${c.mode_key} from ${c.effective_from}`),
    },
    add: {
      rules: p.rules.length,
      exclusions: p.exclusions.reduce((n, x) => n + x.codes.split(',').length, 0),
      modes: p.modes.length,
      requirement: !!p.requirement,
    },
    card_fields: fields,
    mode_after: modeAfter,
  };
}

export class ProfileError extends Error {}

/**
 * Put a card's records back to the profile.
 *
 * One batch, so it is one subrequest however many rows it writes — 42 commands
 * sent separately would cost several hundred of the fifty a Worker invocation
 * gets — and D1 runs a batch as a transaction, so a failure part way leaves the
 * card as it was rather than half repaired.
 *
 * Old rules are switched off, not deleted: what they priced stays explainable.
 * Mode choices are kept unless a mode is named, in which case the history is
 * replaced by that mode from the day the card was opened — for a card fixed in
 * its first quarter, which is the case this exists for, that is the history.
 */
export async function applyProfile(
  env: Env,
  card: CardRow,
  p: CardProfile,
  opts: { mode?: string | null; category?: string | null } = {}
): Promise<ProfilePlan> {
  if (!card.product_id) throw new ProfileError(`${card.nickname} is not linked to a product yet — run /migrate first`);
  if (opts.mode && !p.modes.some((m) => m.mode_key === opts.mode)) {
    throw new ProfileError(`${p.product_name} has no mode called ${opts.mode} — it offers ${p.modes.map((m) => m.mode_key).join(', ')}`);
  }
  const pick = p.modes.find((m) => m.mode_key === opts.mode);
  if (pick?.category_choices && !opts.category) {
    throw new ProfileError(`${pick.label} also needs a category — one of ${pick.category_choices}`);
  }

  const plan = await planProfile(env, card, p, opts.mode);
  const ruleSet = await currentRuleSetFor(env, card.id, today(env));
  const product = card.product_id;
  const keep = p.modes.map((m) => m.mode_key);
  const anchor = card.opened_at ?? today(env);
  const s: D1PreparedStatement[] = [];
  const q = (sql: string, ...args: unknown[]) => s.push(env.DB.prepare(sql).bind(...args));

  // The card itself: its rates live in the modes, and so does what it pays in.
  q(`UPDATE cards SET base_mpd = 0, program_key = NULL WHERE id = ?`, card.id);
  q(`UPDATE card_products SET base_mpd = NULL, program_key = NULL WHERE id = ?`, product);

  // Every rule the card has collected, off; then the profile's.
  q(
    `UPDATE earn_rules SET active = 0
      WHERE active = 1 AND (card_id = ? OR rule_set_id IN (SELECT id FROM rule_sets WHERE product_id = ?))`,
    card.id,
    product
  );
  for (const r of p.rules) {
    q(
      `INSERT INTO earn_rules (card_id, rule_set_id, category, mpd, reward_type, mcc_include, min_tier_cents,
         cap_cents, cap_window, cap_group, mode_key, earn_step_cents, region, min_txn_cents, note, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      card.id,
      ruleSet,
      r.category,
      r.rate,
      r.reward_type,
      r.mcc_include ?? null,
      r.min_tier_cents ?? null,
      r.cap_cents ?? null,
      r.cap_window ?? null,
      r.cap_group ?? null,
      r.mode_key ?? null,
      r.earn_step_cents ?? null,
      r.region ?? null,
      r.min_txn_cents ?? null,
      `${p.key}, verified ${p.verified_on}`
    );
  }

  // The modes: the profile's, and none other.
  for (const m of p.modes) {
    q(
      `INSERT INTO card_modes (product_id, mode_key, label, payout, picks_category, category_choices, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(product_id, mode_key) DO UPDATE SET
         label = excluded.label, payout = excluded.payout, picks_category = excluded.picks_category,
         category_choices = excluded.category_choices, is_default = excluded.is_default`,
      product,
      m.mode_key,
      m.label,
      m.payout,
      m.category_choices ? 1 : 0,
      m.category_choices ?? null,
      m.is_default ? 1 : 0
    );
  }
  q(
    `DELETE FROM card_modes WHERE product_id = ? AND mode_key NOT IN (${keep.map(() => '?').join(',')})`,
    product,
    ...keep
  );

  // Choices: replaced by the named mode, or pruned of modes that no longer exist.
  if (opts.mode) {
    q(`DELETE FROM card_mode_choices WHERE card_id = ?`, card.id);
    q(
      `INSERT INTO card_mode_choices (card_id, mode_key, category, effective_from, note) VALUES (?, ?, ?, ?, ?)`,
      card.id,
      opts.mode,
      pick?.category_choices ? (opts.category ?? '').toLowerCase() : null,
      anchor,
      `set by /cardfix`
    );
  } else {
    q(
      `DELETE FROM card_mode_choices WHERE card_id = ? AND mode_key NOT IN (${keep.map(() => '?').join(',')})`,
      card.id,
      ...keep
    );
  }

  // Exclusions: this card's, replaced — which is also what removes duplicates
  // from a block pasted twice. Ones that apply to every card are left alone.
  q(`UPDATE exclusions SET active = 0 WHERE card_id = ? AND active = 1`, card.id);
  for (const x of p.exclusions) {
    for (const code of x.codes.split(',')) {
      q(
        `INSERT INTO exclusions (card_id, mcc, reason, source, active) VALUES (?, ?, ?, 'user', 1)`,
        card.id,
        code.trim(),
        x.reason
      );
    }
  }

  // The minimum, and its rungs, found by the row just written.
  q(`UPDATE requirements SET active = 0 WHERE card_id = ? AND active = 1`, card.id);
  if (p.requirement) {
    const r = p.requirement;
    q(
      `INSERT INTO requirements (card_id, kind, amount_cents, window, anchor_at, per_month, prorate_first, reward_note, mode_key)
       VALUES (?, 'monthly_min', ?, ?, ?, 1, 1, ?, ?)`,
      card.id,
      r.amount_cents,
      r.window,
      anchor,
      r.note,
      r.mode_key
    );
    for (const rung of r.rungs_cents) {
      q(
        `INSERT INTO requirement_tiers (requirement_id, min_spend_cents, reward_cents)
         SELECT MAX(id), ?, 0 FROM requirements WHERE card_id = ? AND active = 1 AND mode_key = ?`,
        rung,
        card.id,
        r.mode_key
      );
    }
  }

  await env.DB.batch(s);
  return plan;
}
