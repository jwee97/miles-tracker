export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_SECRET: string;
  OWNER_CHAT_ID: string;
  APP_SECRET: string;
  TZ_OFFSET_MINUTES: string;
  UTIL_THRESHOLDS: string;
  MIN_SPEND_WARN_DAYS: string;
  POSTING_LAG_DAYS: string;
  RATE_RECHECK_DAYS: string;
  MILE_VALUE_CENTS: string;
  OBJECTIVE: string;
  /** Keep scanned items in full for this many days; compact them after. */
  FEED_RETENTION_DAYS: string;
  /** How far back a scan looks: month (default), 7d, 30d, ytd or all. */
  SCAN_WINDOW: string;
  /** Delete offers this long after they expire. 0 keeps them. */
  OFFER_RETENTION_DAYS: string;
  /** 'true' to count spend on excluded codes toward a minimum anyway. */
  MIN_SPEND_COUNTS_EXCLUDED: string;
  /** Splitting a payment below this gain in cents is noise, not advice. */
  SPLIT_MIN_GAIN_CENTS: string;

  // --- reading Cloudflare's own meters (all optional) ---------------------
  /** A secret, like the others: `wrangler secret put CF_API_TOKEN`. */
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  /** The Worker's name, as in wrangler.toml. */
  CF_SCRIPT_NAME: string;
  /** The D1 database's id, as in wrangler.toml. */
  CF_DATABASE_ID: string;
}

export interface Card {
  id: number;
  issuer: string;
  product: string;
  product_key: string;
  nickname: string;
  credit_limit_cents: number;
  statement_day: number;
  /** 0 when nobody has told us the day and the default is standing in. */
  statement_day_known?: number;
  opened_at: string | null;
  closed_at: string | null;
  signup_bonus_at: string | null;
  /** Programme this card's points land in; null until you set one. */
  program_key: string | null;
  base_mpd: number;
}

export interface Requirement {
  id: number;
  card_id: number;
  kind: 'monthly_min' | 'signup_min';
  amount_cents: number;
  window: 'calendar_month' | 'calendar_quarter' | 'statement_cycle' | 'statement_quarter' | 'fixed_window';
  deadline: string | null;
  starts_at: string | null;
  min_txns: number | null;
  bonus_cap_cents: number | null;
  reward_note: string | null;
  /** Sets a statement quarter's cycle; defaults to the card's opening date. */
  anchor_at: string | null;
  /** 1 when the minimum must be met in EVERY statement month of the window. */
  per_month: number;
  /** 1 when the first quarter pays in thirds for its qualifying months. */
  prorate_first: number;
  active: number;
}

/** One rung of a tiered reward: spend this much, the window pays that much. */
export interface RequirementTier {
  id: number;
  requirement_id: number;
  min_spend_cents: number;
  reward_cents: number;
  label: string | null;
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

/** What you decided about a clause the data cannot settle. `na` means it does
 *  not apply to you; it counts as a pass but is never displayed as one. */
export type RuleDecision = 'pass' | 'fail' | 'na';

export interface RuleResult {
  id: number;
  /** The verdict in force: your decision when there is one, else the computed one. */
  verdict: RuleVerdict;
  /** What your card history alone says, always kept so an override is visible. */
  computed: RuleVerdict;
  reason: string;
  decision: RuleDecision | null;
  decided_at: string | null;
  note: string | null;
  /** Your decision contradicts a verdict the data was sure about. */
  overridden: boolean;
  predicate: Predicate;
  quote: string | null;
}

export interface EligibilityResult {
  verdict: 'eligible' | 'not_eligible' | 'needs_review';
  rules: RuleResult[];
  /** Clauses still waiting on you. */
  open_questions: number;
  decided_by_you: number;
}
