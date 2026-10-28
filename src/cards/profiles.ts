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
  /** Paid only when you pay this way; a purchase made another way falls to the base rate. */
  channel?: 'online' | 'contactless' | 'offline';
  cap_cents?: number;
  cap_window?: string;
  cap_group?: string;
  min_tier_cents?: number;
  min_txn_cents?: number;
  earn_step_cents?: number;
  mcc_include?: string;
  /** Codes the rate never pays on, whatever else matches. */
  mcc_exclude?: string;
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
  /**
   * A minimum that decides a tier, and the rungs it has: what a month must
   * spend to hold each, and what the quarter pays at it (0 where the rung only
   * gates a better rate, as Trust's do).
   */
  requirement?: {
    amount_cents: number;
    window: string;
    /** Only while the card is set to this mode; left out for a card with no modes. */
    mode_key?: string;
    note: string;
    rungs: { spend_cents: number; pays_cents: number }[];
    /** Transactions a month must also reach, as UOB One counts. */
    min_txns?: number;
  };
  /**
   * The card's own base rate, for a card whose rates do not all live in modes.
   * Left out, the profile zeroes the card's base rate and programme because
   * every rate belongs to a mode (the Trust Freedom); given, the base rate is
   * set to it and the programme is left alone.
   */
  card_base_mpd?: number;
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
    rungs: [
      { spend_cents: 50000, pays_cents: 0 },
      { spend_cents: 200000, pays_cents: 0 },
    ],
  },
  not_modelled: [
    'From 1 Jan 2027 Stockback pays 2% local and 0.5% foreign — a new dated version under Catalogue → Edit its rules.',
    'The first calendar month after approval waives the Bonus Cashback minimum.',
    'Exclusions without a merchant code: cash advances, AXS, SAM, ATM, instalments, fees, top-ups.',
    'Foreign spend is only known when tagged #fx; a statement import cannot tell.',
  ],
};

const HSBC_GROUPS: Record<string, string> = {
  travel: '3000-3999,4411,4511',
  shopping:
    '4816,5045,5262,5309,5310,5311,5331,5399,5611,5621,5631,5641,5651,5655,5661,5691,5699,5732-5735,5912,5942,5944-5949,5964-5970,5992,5999',
  dining: '5441,5462,5811,5812,5813',
  transport: '4121,7997',
};

/**
 * The HSBC Revolution Card, from HSBC's 10X Reward Points Terms and Conditions.
 *
 * Priced in miles, which is what the rest of the app compares in: 10X is
 * 10 HSBC points per S$1, and 25,000 points become 10,000 miles, so 4 mpd; the
 * 1 point per S$1 everything else earns is 0.4 mpd.
 *
 * The bonus is paid on eligible spend — an eligible merchant code AND paid
 * online or by tapping — up to 9,000 bonus points a month. 9 bonus points per
 * S$1 makes that S$1,000 of spend, which is what the engine caps. One cap is
 * shared by every category and both ways of paying, so they are one group.
 *
 * Eligible spend past the cap, and everything else that is not excluded, earns
 * the base 0.4. Excluded codes earn nothing at all.
 */
export const HSBC_REVOLUTION: CardProfile = {
  key: 'hsbc_revolution',
  product_key: 'hsbc_revolution',
  issuer: 'HSBC',
  product_name: 'Revolution Card',
  sources: [
    'https://www.hsbc.com.sg/content/dam/hsbc/sg/documents/credit-cards/revolution/offers/10x-reward-points-terms-and-conditions.pdf',
    'https://www.hsbc.com.sg/credit-cards/products/revolution/',
  ],
  verified_on: '2026-10-27',
  modes: [],
  card_base_mpd: 0.4,
  rules: [
    { category: '*', rate: 0.4, reward_type: 'miles' },
    ...Object.entries(HSBC_GROUPS).flatMap(([category, codes]): ProfileRule[] =>
      (['online', 'contactless'] as const).map((channel) => ({
        category,
        rate: 4,
        reward_type: 'miles' as const,
        channel,
        cap_cents: 100000,
        cap_window: 'calendar_month',
        cap_group: 'tenx',
        mcc_include: codes,
      }))
    ),
  ],
  // The 48 codes in the terms' excluded list. These earn no points at all, not
  // even the base ones.
  exclusions: [
    { codes: '4829,6050,6051,6529,6530,6532,6533,6534,6536,6537,6538,6540,6555', reason: 'money transfer, quasi cash, stored value' },
    { codes: '6010,6011,6012,6211', reason: 'financial institutions, cash disbursements, securities' },
    { codes: '5960,6300', reason: 'insurance' },
    { codes: '4900', reason: 'utilities' },
    { codes: '6513,7349', reason: 'rentals and cleaning services' },
    { codes: '5199,7299,7399,8999', reason: 'nondurable goods, other and professional services' },
    { codes: '7511,7523', reason: 'truck stop quasi cash, parking' },
    { codes: '7801,7995,9754', reason: 'gambling' },
    { codes: '8062', reason: 'hospitals' },
    { codes: '8211,8220,8241,8244,8249,8299', reason: 'educational institutions' },
    { codes: '8398,8651,8661', reason: 'charitable, political, religious organisations' },
    { codes: '9211,9222,9223,9311,9399,9402,9405', reason: 'government payments, fines, tax' },
  ],
  not_modelled: [
    'No minimum spend, so there is nothing for /req.',
    'Points are worked out on the month\'s eligible total rounded down to S$1, not purchase by purchase, so a month can differ by a few points.',
    'Priced at 0.4 miles a point (25,000 points = 10,000 Asia Miles). Other partners pay less per point — KrisFlyer is 30,000 = 10,000 miles, 3.33 mpd.',
    'The 20X tier (8 mpd, cap S$1,200 of spend a month) needs S$50,000 average daily balance in a sole HSBC Everyday Global Account. Not modelled.',
    'A purchase with no payment method recorded is priced as if it qualified. Log online or contactless where you know it.',
    'HSBC\'s terms still carry a line that contactless earns 1 point from 15 July 2024; its product page and the April 2026 announcements say tapping is back at 10X. Check the first tap on a statement.',
    'MCC 7011 (hotels) is not in HSBC\'s list, though two blogs include it; 4722 (travel agencies) is not eligible. Both follow the terms.',
    'Exclusions without a merchant code: instalment plans, AXS, ATM, fees, top-ups.',
    'Bonus points credit after the month ends, and a reversed purchase takes its points back.',
  ],
};

const CITI_SHOPPING = '5311,5611,5621,5631,5641,5651,5655,5661,5691,5699,5948';
/** What Citi calls travel-related, which is never 10X even when bought online. */
const CITI_TRAVEL = '3000-3999,4111,4112,4411,4511,4722,4723,4789,5962,7011,7012,7512';

/**
 * The Citi Rewards Card, from Citi's 10X Rewards Promotion Terms and Conditions
 * (effective 1 April 2024).
 *
 * Priced in miles, like every card here: 10X is 10 ThankYou Points per S$1 and
 * 1X is 1 point, and a point is 0.4 miles, so 4 mpd and 0.4 mpd. It was entered
 * as 10 and 1 — points — and a rate of 10 is valued as ten miles a dollar,
 * which made this card look two and a half times better than the same 4 mpd
 * anywhere else.
 *
 * 10X is paid on in-store clothing, shoe, luggage and department-store codes, and
 * on online retail that is not travel, up to 9,000 bonus points a statement
 * month — 9 bonus points per S$1, so S$1,000 of spend, shared by both. Points
 * are worked out on each purchase rounded down to S$1.
 */
export const CITI_REWARDS: CardProfile = {
  key: 'citi_rewards',
  product_key: 'citi_rewards',
  issuer: 'Citi',
  product_name: 'Rewards Card',
  sources: [
    'https://www.citibank.com.sg/global_docs/pdf/Citi_Rewards_Card_10X_Rewards_Promotion_Terms_and_Conditions.pdf',
    'https://www.citibank.com.sg/credit-cards/rewards/welcome-offers/',
  ],
  verified_on: '2026-10-28',
  modes: [],
  card_base_mpd: 0.4,
  rules: [
    { category: '*', rate: 0.4, reward_type: 'miles', earn_step_cents: 100 },
    {
      category: 'shopping',
      rate: 4,
      reward_type: 'miles',
      cap_cents: 100000,
      cap_window: 'statement_cycle',
      cap_group: '10x',
      earn_step_cents: 100,
      mcc_include: CITI_SHOPPING,
    },
    {
      category: 'online',
      rate: 4,
      reward_type: 'miles',
      channel: 'online',
      cap_cents: 100000,
      cap_window: 'statement_cycle',
      cap_group: '10x',
      earn_step_cents: 100,
      mcc_exclude: CITI_TRAVEL,
    },
  ],
  exclusions: [],
  not_modelled: [
    'No minimum spend, so nothing for /req.',
    'Priced at 0.4 miles a point (the 25,000 : 10,000 ThankYou route). A different partner pays a different rate.',
    'Online spend paid with a mobile wallet is not 10X; the app cannot tell how an online purchase was paid.',
    'Only a purchase logged as `online` gets the online rate. Online groceries or dining logged under their own category are priced by that category.',
    'Citi\'s list of excluded merchants (citibank.com.sg/rwdexcl) is not published as codes the app can read, so only the exclusions that apply to every card are used.',
    'Citi counts the cap in bonus points; the app counts S$1,000 of spend, which differs by cents when purchases are not whole dollars.',
  ],
};

const UOB_EXCLUDED: { codes: string; reason: string }[] = [
  { codes: '4829,6012,6050,6051,6529,6530,6534,6540', reason: 'money transfer, financial institutions, quasi cash, stored value' },
  { codes: '6211', reason: 'securities brokers and dealers' },
  { codes: '5960,6300', reason: 'insurance' },
  { codes: '5199,5965,5993', reason: 'nondurable goods, catalog merchants, cigar stores' },
  { codes: '6513,7349', reason: 'rentals and property management' },
  { codes: '7511,7523', reason: 'truck stop quasi cash, parking' },
  { codes: '7995', reason: 'gambling' },
  { codes: '8062', reason: 'hospitals' },
  { codes: '8211,8220,8241,8244,8249,8299', reason: 'educational institutions' },
  { codes: '8398,8651,8661,8699', reason: 'charitable, political, religious, membership organisations' },
  { codes: '8999', reason: 'professional services' },
  { codes: '9211,9222,9223,9311,9399,9402,9405', reason: 'government payments, fines, tax' },
];

/**
 * The UOB One Card, from UOB's terms and conditions (revised 1 July 2025; for a
 * card issued before then, from the quarter starting 1 September 2025).
 *
 * The card pays in two layers, and they are separate here for the same reason
 * they are separate at UOB. The QUARTERLY cashback is S$60, S$100 or S$200 for
 * a quarter whose every statement month spent S$600, S$1,000 or S$2,000 in at
 * least 10 transactions — that is the requirement and its tiers. The
 * ADDITIONAL cashback is a rate on named merchants, paid only if the quarterly
 * cashback was, at a rate that depends on which tier it was — those are the
 * rules, each carrying the tier it needs. A card holding no tier earns the
 * 0.03% base and nothing else.
 *
 * Additional cashback is capped at S$120 a statement month. The cap is on the
 * cashback, so each rule's spend cap is S$120 divided by its rate.
 */
export const UOB_ONE: CardProfile = {
  key: 'uob_one',
  product_key: 'uob_one',
  issuer: 'UOB',
  product_name: 'One Card',
  sources: ['https://www.uob.com.sg/assets/pdfs/one_card_full_tnc.pdf', 'https://www.uob.com.sg/onetncs'],
  verified_on: '2026-10-28',
  modes: [],
  card_base_mpd: 0,
  rules: [
    // Base Cashback: 0.03% of the year's spend, paid in February.
    { category: '*', rate: 0.03, reward_type: 'cashback' },
    // Grab, McDonald's, Shopee and SimplyGo: 5% at Tier 1 and 2, 6.67% at Tier 3.
    ...['transport', 'dining', 'online'].flatMap((category): ProfileRule[] => {
      const base = { category, reward_type: 'cashback' as const, cap_window: 'statement_cycle', cap_group: 'selected' };
      return [
        { ...base, rate: 6.67, min_tier_cents: 200000, cap_cents: 180000 },
        { ...base, rate: 5, min_tier_cents: 60000, cap_cents: 240000 },
      ];
    }),
    // Groceries coded 5411: nothing at Tier 1, 2.67% at Tier 2, 4.67% at Tier 3.
    { category: 'groceries', rate: 4.67, reward_type: 'cashback', min_tier_cents: 200000, cap_cents: 257143, cap_window: 'statement_cycle', cap_group: 'selected', mcc_include: '5411' },
    { category: 'groceries', rate: 2.67, reward_type: 'cashback', min_tier_cents: 100000, cap_cents: 450000, cap_window: 'statement_cycle', cap_group: 'selected', mcc_include: '5411' },
    // Shell: Tier 3 only.
    { category: 'fuel', rate: 1.67, reward_type: 'cashback', min_tier_cents: 200000, cap_cents: 720000, cap_window: 'statement_cycle', cap_group: 'selected' },
    // Singapore Power: 1% from Tier 1.
    { category: 'utilities', rate: 1, reward_type: 'cashback', min_tier_cents: 60000, cap_cents: 1200000, cap_window: 'statement_cycle', cap_group: 'selected', mcc_include: '4900' },
  ],
  exclusions: UOB_EXCLUDED,
  requirement: {
    amount_cents: 60000,
    window: 'statement_quarter',
    note: 'quarterly cashback',
    min_txns: 10,
    rungs: [
      { spend_cents: 60000, pays_cents: 6000 },
      { spend_cents: 100000, pays_cents: 10000 },
      { spend_cents: 200000, pays_cents: 20000 },
    ],
  },
  not_modelled: [
    'The additional cashback is for named merchants — Grab, McDonald\'s, Shopee, SimplyGo, Shell, Singapore Power, and groceries coded 5411. The app prices by category, so other dining, transport and online spend is priced as if it earned it too.',
    'The S$120 monthly cap is on cashback. Each rate\'s spend cap is S$120 divided by its rate, so a month that mixes rates is only approximately right.',
    'The tier is the leanest statement month of the quarter, with at least 10 transactions in each; the app reads it from the minimum recorded here.',
    'The 0.03% base cashback is paid once a year, in February, and only if no quarterly cashback was paid in the year.',
    'Excluded by name rather than code, so not seen here: Grab and ShopeePay top-ups, AXS, EZ-Link, PayPal and similar descriptions.',
    'The sign-up and 20% promotions are time-limited and not included.',
  ],
};

export const PROFILES: CardProfile[] = [TRUST_FREEDOM, HSBC_REVOLUTION, CITI_REWARDS, UOB_ONE];

/**
 * A product key without the words banks and users add or drop: the catalogue
 * calls the card `hsbc_revolution`, adding it by hand makes `hsbc_revolution_card`,
 * and the form can produce `hsbc_revolution_credit_card`. All one product.
 */
const canon = (key: string | null | undefined) =>
  (key ?? '').toLowerCase().replace(/_(credit_)?card$/, '');

export const profileFor = (productKey: string | null | undefined) =>
  productKey ? (PROFILES.find((p) => canon(p.product_key) === canon(productKey)) ?? null) : null;

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
    if (r.channel) parts.push(`channel ${r.channel}`);
    if (r.cap_cents) parts.push(`cap ${dollars(r.cap_cents)}`);
    if (r.cap_window) parts.push(`window ${r.cap_window}`);
    if (r.cap_group) parts.push(`group ${r.cap_group}`);
    if (r.min_txn_cents) parts.push(`min ${dollars(r.min_txn_cents)}`);
    if (r.earn_step_cents) parts.push(`step ${dollars(r.earn_step_cents)}`);
    if (r.mcc_include) parts.push(`mcc ${r.mcc_include}`);
    if (r.mcc_exclude) parts.push(`except ${r.mcc_exclude}`);
    L.push(parts.join(' '));
  }
  if (p.requirement) {
    const q = p.requirement;
    L.push(
      `/req ${nickname}|monthly_min|${dollars(q.amount_cents)}|${q.window}|||${q.min_txns ?? ''}|${q.note}` +
        (q.mode_key ? `|${q.mode_key}` : '')
    );
    L.push(`/tiers ${nickname} ${q.rungs.map((r) => `${dollars(r.spend_cents)}=${dollars(r.pays_cents)}`).join(' ')}`);
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
  (r.channel ? ` (${r.channel} only)` : '') +
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
  if (p.card_base_mpd !== undefined) {
    if ((card.base_mpd ?? 0) !== p.card_base_mpd) fields.push(`base rate ${card.base_mpd ?? 0} → ${p.card_base_mpd}`);
  } else {
    if ((card.base_mpd ?? 0) !== 0) {
      fields.push(`base rate ${card.base_mpd} → 0 (every rate on this card belongs to a mode)`);
    }
    if (card.program_key) fields.push(`programme ${card.program_key} → none (what it pays depends on the mode)`);
  }

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

export interface ProfileStatement {
  sql: string;
  args: unknown[];
}

/**
 * Every write that puts a card back to a profile, as data.
 *
 * Separate from running them so the same statements can be applied by
 * /cardfix, shown, and checked in a test, and so what is written by hand into a
 * database is exactly what /cardfix would have written rather than a copy of it.
 * Nothing here reads anything: the card, its product, the rule set the rules
 * belong to and the date they start from are all passed in.
 */
export function profileStatements(
  card: { id: number },
  p: CardProfile,
  ctx: {
    product_id: number;
    rule_set_id: number | null;
    /** The card's opening date, which dated choices and quarters count from. */
    anchor: string;
    mode?: string | null;
    category?: string | null;
  }
): ProfileStatement[] {
  const s: ProfileStatement[] = [];
  const q = (sql: string, ...args: unknown[]) => s.push({ sql, args });
  const product = ctx.product_id;
  const keep = p.modes.map((m) => m.mode_key);
  const pick = p.modes.find((m) => m.mode_key === ctx.mode);

  // The card itself.
  if (p.card_base_mpd !== undefined) {
    // Its rates are not all in modes, so the programme it pays into stays.
    q(`UPDATE cards SET base_mpd = ? WHERE id = ?`, p.card_base_mpd, card.id);
    q(`UPDATE card_products SET base_mpd = ? WHERE id = ?`, p.card_base_mpd, product);
  } else {
    // Its rates live in the modes, and so does what it pays in.
    q(`UPDATE cards SET base_mpd = 0, program_key = NULL WHERE id = ?`, card.id);
    q(`UPDATE card_products SET base_mpd = NULL, program_key = NULL WHERE id = ?`, product);
  }

  // Every rule the card has collected, off; then the profile's.
  q(
    `UPDATE earn_rules SET active = 0
      WHERE active = 1 AND (card_id = ? OR rule_set_id IN (SELECT id FROM rule_sets WHERE product_id = ?))`,
    card.id,
    product
  );
  for (const r of p.rules) {
    q(
      `INSERT INTO earn_rules (card_id, rule_set_id, category, mpd, reward_type, mcc_include, mcc_exclude, min_tier_cents,
         cap_cents, cap_window, cap_group, mode_key, earn_step_cents, region, min_txn_cents, note, channel, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      card.id,
      ctx.rule_set_id,
      r.category,
      r.rate,
      r.reward_type,
      r.mcc_include ?? null,
      r.mcc_exclude ?? null,
      r.min_tier_cents ?? null,
      r.cap_cents ?? null,
      r.cap_window ?? null,
      r.cap_group ?? null,
      r.mode_key ?? null,
      r.earn_step_cents ?? null,
      r.region ?? null,
      r.min_txn_cents ?? null,
      `${p.key}, verified ${p.verified_on}`,
      r.channel ?? null
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
  if (keep.length) {
    q(`DELETE FROM card_modes WHERE product_id = ? AND mode_key NOT IN (${keep.map(() => '?').join(',')})`, product, ...keep);
  } else {
    q(`DELETE FROM card_modes WHERE product_id = ?`, product);
  }

  // Choices: replaced by the named mode, or pruned of modes that no longer exist.
  if (ctx.mode) {
    q(`DELETE FROM card_mode_choices WHERE card_id = ?`, card.id);
    q(
      `INSERT INTO card_mode_choices (card_id, mode_key, category, effective_from, note) VALUES (?, ?, ?, ?, ?)`,
      card.id,
      ctx.mode,
      pick?.category_choices ? (ctx.category ?? '').toLowerCase() : null,
      ctx.anchor,
      `set by /cardfix`
    );
  } else if (keep.length) {
    q(`DELETE FROM card_mode_choices WHERE card_id = ? AND mode_key NOT IN (${keep.map(() => '?').join(',')})`, card.id, ...keep);
  } else {
    q(`DELETE FROM card_mode_choices WHERE card_id = ?`, card.id);
  }

  // Exclusions: this card's, replaced — which is also what removes duplicates
  // from a block pasted twice. Ones that apply to every card are left alone.
  q(`UPDATE exclusions SET active = 0 WHERE card_id = ? AND active = 1`, card.id);
  for (const x of p.exclusions) {
    for (const code of x.codes.split(',')) {
      q(`INSERT INTO exclusions (card_id, mcc, reason, source, active) VALUES (?, ?, ?, 'user', 1)`, card.id, code.trim(), x.reason);
    }
  }

  // The minimum, and its rungs, found by the row just written.
  q(`UPDATE requirements SET active = 0 WHERE card_id = ? AND active = 1`, card.id);
  if (p.requirement) {
    const r = p.requirement;
    const mode = r.mode_key ?? null;
    q(
      `INSERT INTO requirements (card_id, kind, amount_cents, window, anchor_at, per_month, prorate_first, min_txns, reward_note, mode_key, active)
       VALUES (?, 'monthly_min', ?, ?, ?, 1, 1, ?, ?, ?, 1)`,
      card.id,
      r.amount_cents,
      r.window,
      ctx.anchor,
      r.min_txns ?? null,
      r.note,
      mode
    );
    for (const rung of r.rungs) {
      // `IS` rather than `=`: a card with no modes has a NULL here.
      q(
        `INSERT INTO requirement_tiers (requirement_id, min_spend_cents, reward_cents)
         SELECT MAX(id), ?, ? FROM requirements WHERE card_id = ? AND active = 1 AND mode_key IS ?`,
        rung.spend_cents,
        rung.pays_cents,
        card.id,
        mode
      );
    }
  }
  return s;
}

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
  const statements = profileStatements(card, p, {
    product_id: card.product_id,
    rule_set_id: ruleSet,
    anchor: card.opened_at ?? today(env),
    mode: opts.mode,
    category: opts.category,
  });
  await env.DB.batch(statements.map((x) => env.DB.prepare(x.sql).bind(...x.args)));
  return plan;
}
