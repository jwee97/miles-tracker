import { ensureProduct } from './products';
import type { Env } from '../types';

/**
 * The starting catalogue of Singapore reward cards.
 *
 * What is here, deliberately, is IDENTITY: who issues the card, what it is
 * called, which programme its points land in, and where its terms live. Those
 * facts are stable and cheap to check.
 *
 * What is NOT here is rates. Not one. A reward rate written from memory is
 * worse than no rate at all: the app would rank cards confidently on a number
 * nobody verified, and the whole point of this project is that it does not do
 * that. Every product below therefore arrives with `verification_status:
 * 'draft'` and no rule set, and the app says so rather than implying rules
 * exist.
 *
 * Filling them in is the workflow that already exists: open the product, read
 * its rewards page with the reader in Cards, confirm what it found, publish.
 * That is the spec's own draft-review-publish loop, and it keeps a human
 * between a bank's page and a number this app will act on.
 */

export interface SeedProduct {
  product_key: string;
  issuer: string;
  product_name: string;
  network?: string;
  reward_type: 'miles' | 'cashback' | 'points';
  program_key?: string | null;
  official_url?: string;
}

/**
 * Programme keys must match the `programs` table seeded in seed.sql, or a
 * card's points have nowhere to land. Left null where the programme depends on
 * which variant is held rather than on the product.
 */
export const SG_CARDS: SeedProduct[] = [
  // --- DBS / POSB ---------------------------------------------------------
  { product_key: 'dbs_womans_world', issuer: 'DBS', product_name: "Woman's World Card", network: 'mastercard', reward_type: 'miles', program_key: 'dbs_points', official_url: 'https://www.dbs.com.sg/personal/cards/credit-cards/dbs-womans-world-card' },
  { product_key: 'dbs_womans', issuer: 'DBS', product_name: "Woman's Card", network: 'mastercard', reward_type: 'miles', program_key: 'dbs_points', official_url: 'https://www.dbs.com.sg/personal/cards/credit-cards/dbs-womans-card' },
  { product_key: 'dbs_altitude_visa', issuer: 'DBS', product_name: 'Altitude Visa Signature', network: 'visa', reward_type: 'miles', program_key: 'dbs_points', official_url: 'https://www.dbs.com.sg/personal/cards/credit-cards/dbs-altitude-visa-signature-card' },
  { product_key: 'dbs_altitude_amex', issuer: 'DBS', product_name: 'Altitude American Express', network: 'amex', reward_type: 'miles', program_key: 'dbs_points', official_url: 'https://www.dbs.com.sg/personal/cards/credit-cards/dbs-altitude-american-express-card' },
  { product_key: 'dbs_live_fresh', issuer: 'DBS', product_name: 'Live Fresh Card', network: 'visa', reward_type: 'cashback', program_key: null, official_url: 'https://www.dbs.com.sg/personal/cards/credit-cards/dbs-live-fresh-card' },
  { product_key: 'dbs_yuu', issuer: 'DBS', product_name: 'yuu Card', network: 'visa', reward_type: 'points', program_key: null, official_url: 'https://www.dbs.com.sg/personal/cards/credit-cards/dbs-yuu-card' },
  { product_key: 'posb_everyday', issuer: 'POSB', product_name: 'Everyday Card', network: 'mastercard', reward_type: 'cashback', program_key: null, official_url: 'https://www.dbs.com.sg/personal/cards/credit-cards/posb-everyday-card' },

  // --- UOB ----------------------------------------------------------------
  { product_key: 'uob_one', issuer: 'UOB', product_name: 'One Card', network: 'visa', reward_type: 'cashback', program_key: null, official_url: 'https://www.uob.com.sg/personal/cards/credit-cards/cashback/uob-one-card.page' },
  { product_key: 'uob_ladys', issuer: 'UOB', product_name: "Lady's Card", network: 'mastercard', reward_type: 'miles', program_key: 'uob_uni', official_url: 'https://www.uob.com.sg/personal/cards/credit-cards/rewards/uob-ladys-card.page' },
  { product_key: 'uob_ladys_solitaire', issuer: 'UOB', product_name: "Lady's Solitaire Card", network: 'mastercard', reward_type: 'miles', program_key: 'uob_uni', official_url: 'https://www.uob.com.sg/personal/cards/credit-cards/rewards/uob-ladys-solitaire-card.page' },
  { product_key: 'uob_prvi_miles_visa', issuer: 'UOB', product_name: 'PRVI Miles Visa', network: 'visa', reward_type: 'miles', program_key: 'uob_uni', official_url: 'https://www.uob.com.sg/personal/cards/credit-cards/travel/uob-prvi-miles-card.page' },
  { product_key: 'uob_absolute', issuer: 'UOB', product_name: 'Absolute Cashback Card', network: 'amex', reward_type: 'cashback', program_key: null, official_url: 'https://www.uob.com.sg/personal/cards/credit-cards/cashback/uob-absolute-cashback-card.page' },
  { product_key: 'uob_visa_signature', issuer: 'UOB', product_name: 'Visa Signature Card', network: 'visa', reward_type: 'miles', program_key: 'uob_uni', official_url: 'https://www.uob.com.sg/personal/cards/credit-cards/rewards/uob-visa-signature-card.page' },
  { product_key: 'uob_evol', issuer: 'UOB', product_name: 'EVOL Card', network: 'mastercard', reward_type: 'cashback', program_key: null, official_url: 'https://www.uob.com.sg/personal/cards/credit-cards/cashback/uob-evol-card.page' },

  // --- Citi ---------------------------------------------------------------
  { product_key: 'citi_rewards', issuer: 'Citi', product_name: 'Rewards Card', network: 'visa', reward_type: 'miles', program_key: 'citi_ty', official_url: 'https://www.citibank.com.sg/credit-cards/all-credit-cards/citi-rewards-credit-card/' },
  { product_key: 'citi_premiermiles', issuer: 'Citi', product_name: 'PremierMiles Card', network: 'visa', reward_type: 'miles', program_key: 'citi_ty', official_url: 'https://www.citibank.com.sg/credit-cards/all-credit-cards/citi-premiermiles-credit-card/' },
  { product_key: 'citi_cash_back', issuer: 'Citi', product_name: 'Cash Back Card', network: 'visa', reward_type: 'cashback', program_key: null, official_url: 'https://www.citibank.com.sg/credit-cards/all-credit-cards/citi-cash-back-credit-card/' },
  { product_key: 'citi_smrt', issuer: 'Citi', product_name: 'SMRT Card', network: 'visa', reward_type: 'cashback', program_key: null, official_url: 'https://www.citibank.com.sg/credit-cards/all-credit-cards/citi-smrt-credit-card/' },

  // --- OCBC ---------------------------------------------------------------
  { product_key: 'ocbc_365', issuer: 'OCBC', product_name: '365 Card', network: 'visa', reward_type: 'cashback', program_key: null, official_url: 'https://www.ocbc.com/personal-banking/cards/365-credit-card' },
  { product_key: 'ocbc_90n', issuer: 'OCBC', product_name: '90°N Card', network: 'visa', reward_type: 'miles', program_key: 'ocbc_90n', official_url: 'https://www.ocbc.com/personal-banking/cards/90n-visa-card' },
  { product_key: 'ocbc_rewards', issuer: 'OCBC', product_name: 'Rewards Card', network: 'mastercard', reward_type: 'points', program_key: 'ocbc_dollar', official_url: 'https://www.ocbc.com/personal-banking/cards/rewards-credit-card' },

  // --- Standard Chartered -------------------------------------------------
  { product_key: 'sc_journey', issuer: 'Standard Chartered', product_name: 'Journey Card', network: 'mastercard', reward_type: 'miles', program_key: 'scb_360', official_url: 'https://www.sc.com/sg/credit-cards/journey-credit-card/' },
  { product_key: 'sc_smart', issuer: 'Standard Chartered', product_name: 'Smart Card', network: 'mastercard', reward_type: 'cashback', program_key: null, official_url: 'https://www.sc.com/sg/credit-cards/smart-credit-card/' },
  { product_key: 'sc_simply_cash', issuer: 'Standard Chartered', product_name: 'Simply Cash Card', network: 'visa', reward_type: 'cashback', program_key: null, official_url: 'https://www.sc.com/sg/credit-cards/simply-cash-credit-card/' },

  // --- HSBC ---------------------------------------------------------------
  { product_key: 'hsbc_revolution', issuer: 'HSBC', product_name: 'Revolution Card', network: 'visa', reward_type: 'miles', program_key: 'hsbc_points', official_url: 'https://www.hsbc.com.sg/credit-cards/products/revolution/' },
  { product_key: 'hsbc_travelone', issuer: 'HSBC', product_name: 'TravelOne Card', network: 'visa', reward_type: 'miles', program_key: 'hsbc_points', official_url: 'https://www.hsbc.com.sg/credit-cards/products/travelone/' },

  // --- Amex ---------------------------------------------------------------
  { product_key: 'amex_krisflyer_ascend', issuer: 'American Express', product_name: 'Singapore Airlines KrisFlyer Ascend', network: 'amex', reward_type: 'miles', program_key: 'krisflyer', official_url: 'https://www.americanexpress.com/en-sg/credit-cards/singapore-airlines-krisflyer-ascend-credit-card/' },
  { product_key: 'amex_krisflyer', issuer: 'American Express', product_name: 'Singapore Airlines KrisFlyer', network: 'amex', reward_type: 'miles', program_key: 'krisflyer', official_url: 'https://www.americanexpress.com/en-sg/credit-cards/singapore-airlines-krisflyer-credit-card/' },
  { product_key: 'amex_platinum_charge', issuer: 'American Express', product_name: 'Platinum Charge', network: 'amex', reward_type: 'points', program_key: 'amex_mr', official_url: 'https://www.americanexpress.com/en-sg/credit-cards/platinum-charge-card/' },

  // --- Maybank ------------------------------------------------------------
  { product_key: 'maybank_family_friends', issuer: 'Maybank', product_name: 'Family & Friends Card', network: 'mastercard', reward_type: 'cashback', program_key: null, official_url: 'https://www.maybank2u.com.sg/en/personal/cards/credit/family-and-friends-card.page' },
  { product_key: 'maybank_horizon', issuer: 'Maybank', product_name: 'Horizon Visa Signature', network: 'visa', reward_type: 'miles', program_key: null, official_url: 'https://www.maybank2u.com.sg/en/personal/cards/credit/horizon-visa-signature-card.page' },
];

export interface SeedReport {
  added: string[];
  already: number;
  /** Products in the catalogue with no published rules yet. */
  awaiting_rules: number;
}

/**
 * Put the catalogue in place. Idempotent, and never touches a product that
 * already exists — including one you have since verified yourself.
 */
export async function seedCardProducts(env: Env): Promise<SeedReport> {
  const added: string[] = [];
  let already = 0;

  for (const c of SG_CARDS) {
    const before = await env.DB.prepare(`SELECT id FROM card_products WHERE product_key = ?`)
      .bind(c.product_key)
      .first();
    if (before) {
      already++;
      continue;
    }
    await ensureProduct(env, {
      product_key: c.product_key,
      issuer: c.issuer,
      product_name: c.product_name,
      network: c.network ?? null,
      reward_type: c.reward_type,
      program_key: c.program_key ?? null,
      official_url: c.official_url ?? null,
      source: 'catalog',
      // Identity is known; the rates are not. Saying "draft" is the difference
      // between a catalogue entry and a claim about what a card pays.
      verification_status: 'draft',
    });
    added.push(c.product_key);
  }

  const awaiting = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM card_products p
      WHERE NOT EXISTS (
        SELECT 1 FROM rule_sets r WHERE r.product_id = p.id AND r.status = 'published'
      )`
  ).first<{ n: number }>();

  return { added, already, awaiting_rules: awaiting?.n ?? 0 };
}
