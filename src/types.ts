export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_SECRET: string;
  OWNER_CHAT_ID: string;
  APP_SECRET: string;
  TZ_OFFSET_MINUTES: string;
  UTIL_THRESHOLDS: string;
  MIN_SPEND_WARN_DAYS: string;
}

export interface Card {
  id: number;
  issuer: string;
  product: string;
  product_key: string;
  nickname: string;
  credit_limit_cents: number;
  statement_day: number;
  opened_at: string | null;
  closed_at: string | null;
  signup_bonus_at: string | null;
  base_mpd: number;
}

export interface Requirement {
  id: number;
  card_id: number;
  kind: 'monthly_min' | 'signup_min';
  amount_cents: number;
  window: 'calendar_month' | 'calendar_quarter' | 'statement_cycle' | 'fixed_window';
  deadline: string | null;
  starts_at: string | null;
  min_txns: number | null;
  bonus_cap_cents: number | null;
  reward_note: string | null;
  active: number;
}

export interface Offer {
  id: number;
  status: string;
  issuer: string | null;
  product: string | null;
  product_key: string | null;
  bonus_miles: number | null;
  bonus_note: string | null;
  min_spend_cents: number | null;
  spend_window_days: number | null;
  valid_from: string | null;
  valid_until: string | null;
  source_url: string | null;
  source_title: string | null;
  raw_terms: string | null;
  extracted_at: string | null;
}

/** Eligibility clauses, extracted from T&C text into a closed set of shapes. */
export type Predicate =
  | { type: 'never_held_product'; product_key: string }
  | { type: 'no_product_within_months'; product_key: string; months: number }
  | { type: 'no_issuer_card_within_months'; issuer: string; months: number }
  | { type: 'new_to_bank'; issuer: string }
  | { type: 'no_signup_bonus_within_months'; issuer: string; months: number }
  | { type: 'min_income'; amount_cents: number; period: 'year' | 'month' }
  | { type: 'manual_review'; note: string };

export type RuleVerdict = 'pass' | 'fail' | 'unknown';

export interface RuleResult {
  verdict: RuleVerdict;
  reason: string;
  predicate: Predicate;
  quote: string | null;
}

export interface EligibilityResult {
  verdict: 'eligible' | 'not_eligible' | 'needs_review';
  rules: RuleResult[];
}
