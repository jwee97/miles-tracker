import type { DiscoveryHealth, ScanFrequency, SourceState } from '../../shared/discovery';

// The dashboard is served by the Worker that owns the API, so requests are
// same-origin and there is nothing to configure here.
export const API_BASE = '';

const KEY = 'miles_token';

/** The bot delivers the token in the link fragment; keep it and clean the URL. */
export function bootstrapToken(): string | null {
  const m = location.hash.match(/[#&]t=([^&]+)/);
  if (m) {
    localStorage.setItem(KEY, m[1]);
    history.replaceState(null, '', location.pathname);
    return m[1];
  }
  return localStorage.getItem(KEY);
}

export function clearToken() {
  localStorage.removeItem(KEY);
}

async function get<T>(path: string): Promise<T> {
  const token = localStorage.getItem(KEY);
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    clearToken();
    throw new Error('Link expired — send /app to the bot for a new one.');
  }
  if (!res.ok) {
    // The Worker explains itself on failure — "the database is behind the
    // deployed code, send /migrate" — and throwing the status alone threw that
    // away, leaving a screen stuck on "Loading…" with no way to find out why.
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export interface Tier {
  id: number;
  min_spend_cents: number;
  reward_cents: number;
  label: string | null;
}

/** One statement month inside a quarter, and what it did. */
export interface MonthSlice {
  index: number;
  window: { start: string; end: string };
  spent_cents: number;
  confirmed_cents: number;
  at_risk_cents: number;
  txn_count: number;
  qualified: boolean;
  tier_index: number | null;
  state: 'past' | 'current' | 'future';
}

export interface Progress {
  id: number;
  kind: 'monthly_min' | 'signup_min';
  amount_cents: number;
  reward_note: string | null;
  bonus_cap_cents: number | null;
  spent_cents: number;
  remaining_cents: number;
  days_left: number;
  per_day_cents: number;
  met: boolean;
  confirmed_cents: number;
  at_risk_cents: number;
  excluded_cents: number;
  excluded_count: number;
  met_only_with_at_risk: boolean;
  txn_count: number;
  txns_required: number;
  txns_remaining: number;
  cap_reached: boolean;
  window: { start: string; end: string };
  window_kind: 'calendar_month' | 'calendar_quarter' | 'statement_cycle' | 'statement_quarter' | 'fixed_window';
  /** Set only for a quarter of three statement months anchored to the card. */
  quarter: {
    start: string;
    end: string;
    index: number;
    months: { start: string; end: string }[];
    /** The months this card's quarters begin in, e.g. "Mar, Jun, Sep, Dec". */
    pattern: string;
    anchor_month: string;
  } | null;
  months: MonthSlice[];
  tiers: Tier[];
  /** The minimum that actually has to be hit — the lowest rung, when there are rungs. */
  floor_cents: number;
  /** The tier this window's spend has reached. */
  tier: Tier | null;
  /** The best tier the quarter can still pay, given the months already closed. */
  ceiling_tier: Tier | null;
  ceiling_reason: string | null;
  /** What to spend this window to hold that tier. Null while nothing is decided. */
  target_cents: number | null;
  to_target_cents: number;
  beyond_target_cents: number;
  /** What the quarter pays if it ends as it stands — the lowest month's tier. */
  quarter_tier: Tier | null;
  thirds: number | null;
  projected_reward_cents: number;
  months_missed: number;
  /** Set when the window looks like the wrong one, in words that say what to change. */
  shape_warning: string | null;
}

export interface CardSummary {
  id: number;
  issuer: string;
  product: string;
  nickname: string;
  limit_cents: number;
  balance_cents: number;
  at_risk_cents: number;
  /** Progress toward the minimum that matters — utilization only when there is none. */
  percent: number;
  util_percent: number;
  /** Which requirement `percent` is about, if any. */
  headline_id: number | null;
  /** The window's reward is already gone — spending here cannot bring it back. */
  lost: boolean;
  cycle: { start: string; end: string };
  days_left: number;
  requirements: Progress[];
}

export interface Summary {
  today: string;
  cards: CardSummary[];
  overall: {
    balance_cents: number;
    limit_cents: number;
    percent: number;
    minimums_total: number;
    minimums_met: number;
    minimums_at_risk: number;
    still_needed_cents: number;
    soonest_days: number | null;
  };
}

export type RuleDecision = 'pass' | 'fail' | 'na';

export interface RuleRow {
  id: number;
  verdict: 'pass' | 'fail' | 'unknown';
  computed: 'pass' | 'fail' | 'unknown';
  reason: string;
  decision: RuleDecision | null;
  decided_at: string | null;
  note: string | null;
  overridden: boolean;
  quote: string | null;
  predicate: { type: string } & Record<string, unknown>;
}

export interface Eligibility {
  verdict: 'eligible' | 'not_eligible' | 'needs_review';
  rules: RuleRow[];
  open_questions: number;
  decided_by_you: number;
}

export interface OfferRow {
  id: number;
  status: 'pending' | 'tracked' | 'applied' | 'dismissed' | 'expired';
  days_left: number | null;
  expired: boolean;
  issuer: string | null;
  product: string | null;
  bonus_miles: number | null;
  bonus_note: string | null;
  min_spend_cents: number | null;
  spend_window_days: number | null;
  valid_until: string | null;
  source_url: string | null;
  source_title: string | null;
  extracted_at: string | null;
  eligibility: Eligibility;
}

export interface FeedRow {
  url: string;
  label: string;
  kind: 'rss' | 'page' | null;
  active: number;
  items: number;
  last_seen: string | null;
}

export interface Txn {
  id: number;
  amount_cents: number;
  occurred_at: string;
  posted_at: string | null;
  merchant: string | null;
  category?: string | null;
  category_source?: string | null;
  needs_review?: number;
  card_id?: number;
  source: string;
  nickname: string;
  product: string;
  mcc?: string | null;
  channel?: string | null;
  expected_miles?: number | null;
  expected_cashback_cents?: number | null;
  actual_miles?: number | null;
  actual_cashback_cents?: number | null;
  /** pending | posted | reversed | refunded */
  status?: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = localStorage.getItem(KEY);
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

async function del<T>(path: string): Promise<T> {
  const token = localStorage.getItem(KEY);
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface TxnPage {
  transactions: Txn[];
  range: { from: string | null; to: string | null; label: string };
  total_count: number;
  total_cents: number;
  page: number;
  pages: number;
  per_page: number;
}

export const fetchTransactions = (
  limit = 25,
  opts: { range?: string; from?: string; to?: string; page?: number; card?: string } = {}
) => {
  const p = new URLSearchParams({ limit: String(limit) });
  if (opts.range) p.set('range', opts.range);
  if (opts.from) p.set('from', opts.from);
  if (opts.to) p.set('to', opts.to);
  if (opts.page) p.set('page', String(opts.page));
  if (opts.card) p.set('card', opts.card);
  return get<TxnPage>(`/api/transactions?${p}`);
};

export const addTransaction = (body: {
  nickname: string;
  amount: string;
  date: string;
  note: string;
  posted?: string;
  category?: string;
}) => post<{ ok: true; id: number; card: string; date: string; posted_at: string | null; category: string | null }>('/api/tx', body);

export const deleteTransaction = (id: number) => post<{ ok: true }>('/api/tx/delete', { id });

export const markPosted = (id: number, date: string) =>
  post<{ ok: true; posted_at: string }>('/api/tx/posted', { id, date });

export interface BalanceRow {
  program_key: string;
  name: string;
  unit: string;
  total: number;
  expiring_soon: number;
  next_expiry: string | null;
}

export interface Tranche {
  id: number;
  program_key: string;
  points: number;
  expires_at: string | null;
  note: string | null;
  unit: string;
}

export interface ProgramRow {
  key: string;
  name: string;
  kind: 'bank' | 'airline';
  unit: string;
}

export interface Plan {
  conversion: { route: string | null; block_increment: number; from_units: number; to_units: number };
  transferable: number;
  stranded: number;
  miles: number;
  bonus_miles: number;
  fee_cents: number;
  cents_per_mile: number;
  possible: boolean;
  reason: string | null;
}

export interface Pick {
  card_id: number;
  product: string;
  nickname: string;
  effective_mpd: number;
  base_mpd: number;
  reward_type: 'miles' | 'cashback';
  headroom_cents: number | null;
  miles: number | null;
  cashback_cents: number | null;
  value_cents: number;
  reasons: string[];
}

export const addTranche = (body: { program_key: string; points: string; expires_at?: string; note?: string }) =>
  post<{ ok: true; id: number; expires_at: string | null }>('/api/tranche', body);

export const deleteTranche = (id: number) => post<{ ok: true }>('/api/tranche/delete', { id });

export const addProgram = (body: { key: string; name: string; kind: string; unit: string }) =>
  post<{ ok: true; key: string }>('/api/program', body);

export const fetchPoints = () =>
  get<{ balances: BalanceRow[]; programs: ProgramRow[]; tranches: Tranche[] }>('/api/points');

export const fetchConvert = (points: string, from: string, to: string) =>
  get<{ plans: Plan[] }>(`/api/convert?points=${encodeURIComponent(points)}&from=${from}&to=${to}`);

export const fetchWhich = (category: string, amount: string) =>
  get<{ category: string; picks: Pick[] }>(
    `/api/which?category=${encodeURIComponent(category)}${amount ? `&amount=${encodeURIComponent(amount)}` : ''}`
  );

export const fetchCategories = () => get<{ categories: string[] }>('/api/categories');

export interface Analytics {
  month: string;
  prev_month: string;
  days_in_month: number;
  day_of_month: number | null;
  totals: {
    spend_cents: number;
    prev_spend_cents: number;
    txn_count: number;
    avg_txn_cents: number;
    active_days: number;
    largest_cents: number;
  };
  daily: { date: string; cents: number }[];
  cumulative: { day: number; cents: number; prev_cents: number | null }[];
  by_category: { key: string; label: string; cents: number; count: number }[];
  by_card: { key: string; label: string; cents: number; count: number }[];
  by_weekday: { dow: number; label: string; cents: number; count: number }[];
  top_merchants: { merchant: string; category: string | null; cents: number; count: number }[];
  rewards: {
    miles: number;
    cashback_cents: number;
    value_cents: number;
    per_dollar_cents: number;
    by_card: { label: string; miles: number; cashback_cents: number; value_cents: number }[];
  };
  missed: {
    category: string;
    cents: number;
    used_label: string;
    used_rate: number;
    used_type: string;
    best_label: string;
    best_rate: number;
    best_type: string;
    lost_value_cents: number;
  }[];
  insights: string[];
  review: { ready: number; waiting: number };
  recurring: {
    merchant: string;
    category: string | null;
    occurrences: number;
    typical_cents: number;
    cadence_days: number;
    last_seen: string;
    next_expected: string;
    annualised_cents: number;
    lapsed: boolean;
  }[];
  trends: {
    category: string;
    this_month_cents: number;
    baseline_cents: number;
    delta_cents: number;
    delta_pct: number | null;
    z: number | null;
    verdict: 'spike' | 'dip' | 'steady' | 'new';
    months_of_history: number;
  }[];
  duplicates: { merchant: string; cents: number; dates: string[]; ids: number[] }[];
}

export interface Expiry {
  id: number;
  program_key: string;
  name: string;
  unit: string;
  kind: string;
  points: number;
  earned_at: string | null;
  expires_at: string | null;
  note: string | null;
  days_left: number | null;
}

export interface ReviewRow {
  id: number;
  amount_cents: number;
  occurred_at: string;
  posted_at: string | null;
  merchant: string | null;
  product: string;
  nickname: string;
}

export interface SettingRow {
  key: string;
  label: string;
  unit: string;
  help: string;
  kind: 'number' | 'text';
  default_value: string;
  stored_value: string | null;
  value: string;
}

export interface Usage {
  storage: {
    feed_items: { rows: number; text_bytes: number; reclaimable_bytes: number; compactable: number; retention_days: number };
    transactions: { rows: number; text_bytes: number; bytes_per_row: number; oldest: string | null };
    transactions_years_to_1pct: number | null;
  };
  db: {
    size_bytes: number | null;
    size_source: string;
    limit_bytes: number;
    percent: number | null;
    rows: { table: string; count: number }[];
    total_rows: number;
  };
  free_tier: { label: string; limit: string; note: string }[];
  worker: { available: boolean; note: string };
}

// --- transfer routes ---------------------------------------------------------

export interface RouteRow {
  id: number;
  from_program: string;
  to_program: string;
  from_name: string;
  to_name: string;
  from_units: number;
  to_units: number;
  fee_cents: number;
  min_block: number;
  block_increment: number;
  route: string | null;
  bonus_pct: number;
  bonus_until: string | null;
  verified_at: string | null;
  source_url: string | null;
  note: string | null;
}

export const fetchRoutes = () =>
  get<{ routes: RouteRow[]; today: string; recheck_days: number }>('/api/routes');

export const saveRoute = (body: Record<string, unknown>) => post<{ ok: true; id: number }>('/api/route', body);
export const deleteRoute = (id: number) => post<{ ok: true }>('/api/route/delete', { id });

export const runMigrate = () =>
  post<{ created: string[]; altered: string[]; alreadyCurrent: boolean; errors: string[] }>('/api/migrate', {});
export const runSeed = () => post<Record<string, unknown>>('/api/seed', {});

export const fetchSettings = () => get<{ settings: SettingRow[] }>('/api/settings');
export const saveSetting = (key: string, value: string | null) =>
  post<{ ok: true; settings: SettingRow[] }>('/api/settings', { key, value });
export const fetchUsage = () => get<Usage>('/api/usage');

export interface RuleStep { check: string; pass: boolean | null; detail: string }

export interface Evaluation {
  card: { id: number; product: string; nickname: string };
  rule: { category: string; mpd: number; reward_type: string } | null;
  excluded: boolean;
  exclusion_reason: string | null;
  reward_type: 'miles' | 'cashback';
  bonus_rate: number;
  base_rate: number;
  cap_cents: number | null;
  cap_used_cents: number;
  headroom_cents: number | null;
  bonus_portion_cents: number;
  base_portion_cents: number;
  miles: number;
  cashback_cents: number;
  value_cents: number;
  effective_rate: number;
  min_spend_short_cents: number;
  min_spend_days_left: number | null;
  trace: RuleStep[];
}

export interface MerchantGuess {
  query: string;
  merchant: string | null;
  mcc: string | null;
  description: string | null;
  category: string | null;
  channel: string | null;
  confidence: 'confirmed' | 'guess' | 'unknown';
  source: string | null;
  alternatives: { merchant: string; mcc: string; description: string | null }[];
}

export interface Recommendation {
  purchase: { amount_cents: number | null; mcc?: string | null; category?: string | null; channel?: string | null };
  merchant: MerchantGuess | null;
  objective: string;
  picks: Evaluation[];
  split_advice: { bonus_cents: number; remainder_cents: number; use: string; earns: string } | null;
}

export const fetchRecommend = (p: { merchant?: string; amount?: string; mcc?: string; category?: string; channel?: string; objective?: string }) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) q.set(k, v);
  return get<Recommendation>(`/api/recommend?${q}`);
};

/* --- the V2 engine ------------------------------------------------------ */

export interface ScoreComponents {
  reward_value: number;
  objective_bonus: number;
  minimum_spend_bonus: number;
  urgency_bonus: number;
  uncertainty_penalty: number;
  exhausted_cap_penalty: number;
}

export interface RecommendationPick {
  card: { id: number; nickname: string; issuer: string; product: string; product_id: number | null };
  reward: { type: 'miles' | 'cashback'; amount: number; effective_rate: number; value_cents: number };
  cap: { applies: boolean; cap_cents: number | null; used_cents: number; remaining_cents: number | null };
  minimum_spend: { remaining_cents: number; days_left: number | null; urgent: boolean } | null;
  rule_set_id: number | null;
  reasons: { pass: boolean | null; text: string }[];
  score_components: ScoreComponents;
  score: number;
  disqualified: { reason: string; detail: string } | null;
}

export interface RecommendationV2 {
  purchase: { amount_cents: number | null; mcc?: string | null; category?: string | null; channel?: string | null; resolved_from: string | null };
  merchant: MerchantGuess | null;
  objective: string;
  confidence: { level: 'high' | 'medium' | 'low'; reasons: string[] };
  recommendation: RecommendationPick | null;
  alternatives: RecommendationPick[];
  ineligible: RecommendationPick[];
  split_advice: { bonus_cents: number; remainder_cents: number; use: string; earns: string; gain_cents: number } | null;
  assumptions: { what: string; because: string; weight: 'material' | 'minor' }[];
  evaluated_at: string;
  data_version: string;
}

export const recommendV2 = (b: {
  merchant?: string;
  amount?: string;
  mcc?: string | null;
  category?: string | null;
  channel?: string | null;
  objective?: string;
  occurred_at?: string;
}) => post<RecommendationV2>('/api/recommend', b);

/* --- did the bank credit what it owed? ------------------------------------ */

export interface RewardDifference {
  component: string;
  unit: string;
  expected: number;
  actual: number;
  difference: number;
  within_tolerance: boolean;
}

export interface ReconciliationExplanation {
  cause: string;
  text: string;
  transaction_ids: number[];
  amount: number | null;
}

export interface ReconciliationResult {
  scope: { type: string; start: string; end: string; card_id: number };
  card: { id: number; nickname: string; product: string };
  expected: { component: string; amount: number; unit: string; all_pending: boolean }[];
  actual: { component: string; amount: number; unit: string }[];
  differences: RewardDifference[];
  status: 'matched' | 'within_tolerance' | 'undercredited' | 'overcredited' | 'incomplete' | 'needs_review';
  explanations: ReconciliationExplanation[];
  confidence: 'high' | 'medium' | 'low';
  pending: { component: string; amount: number; unit: string; expected_by: string | null }[];
  as_of: string;
}

export const fetchReconciliation = (periods = 1) =>
  get<{ results: ReconciliationResult[]; as_of: string }>(`/api/rewards/reconciliation?periods=${periods}`);

export const reconcileCard = (body: { nickname: string; from?: string; to?: string }) =>
  post<ReconciliationResult>('/api/rewards/reconcile', body);

export const applyStatementMcc = (transactionId: number, mcc: string) =>
  post<{ ok: boolean; error?: string; correction?: { previous_mcc: string | null; reward_before: number; reward_after: number } }>(
    `/api/rewards/mcc/${transactionId}`,
    { mcc }
  );

export interface RewardCandidate {
  id: number;
  card_id: number;
  entry_type: string;
  amount: number;
  unit: string;
  description: string;
  confidence: string;
  raw_line: string | null;
}

export const fetchRewardCandidates = () => get<{ candidates: RewardCandidate[] }>('/api/rewards/candidates');

export const resolveRewardCandidate = (id: number, action: 'accept' | 'reject') =>
  post<{ ok: boolean; ledger_id?: number; applied?: string }>(`/api/rewards/candidates/${id}`, { action });

/* --- transfers ------------------------------------------------------------ */

export interface Programme {
  key: string;
  name: string;
  kind: string;
  unit: string;
  expiry_months: number | null;
}

export interface PlanRoute {
  from_program: string;
  from_name: string;
  route: string | null;
  source_units: number;
  destination_units: number;
  bonus_units: number;
  fee_cents: number;
  stranded_units: number;
  expiring_units_saved: number;
  promotion: { title: string | null; bonus_pct: number | null; ends: string; registration_required: boolean } | null;
  processing_days: { min: number | null; max: number | null };
  reason: string;
}

export interface TransferPlanResult {
  destination: { key: string; name: string; unit: string };
  objective: string;
  target_units: number | null;
  resulting_units: number;
  shortfall_units: number;
  total_fees_cents: number;
  routes: PlanRoute[];
  expiring_points_saved: number;
  assumptions: string[];
  warnings: string[];
  as_of: string;
}

export interface GoalProgress {
  goal: { id: number; program_key: string; target_units: number; target_date: string | null; description: string | null; status: string };
  program_name: string;
  unit: string;
  held_units: number;
  convertible_units: number;
  total_units: number;
  shortfall_units: number;
  percent: number;
  days_left: number | null;
  at_risk: boolean;
}

export const fetchProgrammes = () => get<{ programmes: Programme[] }>('/api/rewards/programmes');

export const optimiseTransfer = (body: {
  destination: string;
  target_units?: number | null;
  target_date?: string | null;
  objective?: string;
  include_promotions?: boolean;
}) => post<TransferPlanResult>('/api/rewards/transfers/optimise', body);

export const fetchGoals = () => get<{ goals: GoalProgress[]; as_of: string }>('/api/rewards/goals');

export const saveRewardGoal = (body: {
  id?: number;
  program_key: string;
  target_units: number;
  target_date?: string;
  description?: string;
}) => post<{ ok: true; goal: GoalProgress }>('/api/rewards/goals', body);

export const setGoalStatus = (id: number, status: 'active' | 'met' | 'abandoned') =>
  post<{ ok: true }>(`/api/rewards/goals/${id}`, { status });

/* --- promotions ----------------------------------------------------------- */

export interface Promotion {
  id: number;
  promotion_type: string;
  issuer: string | null;
  title: string;
  description: string | null;
  start_at: string | null;
  end_at: string | null;
  registration_required: number;
  source_url: string | null;
  source_quote: string | null;
  confidence: string;
  status: string;
}

export interface RelevantPromotion {
  promotion: Promotion;
  terms: Record<string, unknown>;
  relevance: 'high' | 'medium' | 'low' | 'not_applicable';
  why: string[];
  blockers: string[];
  days_left: number | null;
  card: { id: number; nickname: string; product: string } | null;
  reachable: boolean | null;
  monthly_spend_cents: number | null;
  tracked: boolean;
  variants: VariantView[];
  pays: string | null;
  pays_varies: boolean;
  currency: PromotionCurrency;
}

export interface PromotionCurrency {
  state: string;
  text: string;
  independent_sources: number;
  last_verified_at: string | null;
  days_since_verified: number | null;
  stale: boolean;
}

export interface PromotionVariant {
  id: number;
  promotion_id: number;
  variant_key: string;
  audience: string;
  minimum_spend_cents: number | null;
  reward_json: string | null;
  annual_fee_required: number | null;
  application_channel: string;
  terms_json: string | null;
}

export interface VariantView {
  variant: PromotionVariant;
  reward: Record<string, number | string | undefined>;
  reward_text: string | null;
  audience_label: string;
  channel_label: string;
  available: boolean;
  blocker: string | null;
}

export interface PromotionEvidence {
  promotion: Promotion;
  terms: Record<string, unknown>;
  currency: PromotionCurrency;
  headline: string;
  sources: { url: string; host: string; tier: number; type: string; excerpt: string | null; seen_at: string | null; fields: string[] }[];
  fields: { field: string; label: string; value: unknown; claims: { value: unknown; hosts: string[]; tier: number }[]; agreed: boolean }[];
  timeline: { at: string; change_type: string; detail: string; source_url: string | null }[];
  variants: { variant: PromotionVariant; reward_text: string | null }[];
  unsourced: boolean;
  as_of: string;
}

export interface OfferInbox {
  worth_checking: RelevantPromotion[];
  ending_soon: RelevantPromotion[];
  your_cards: RelevantPromotion[];
  transfers: RelevantPromotion[];
  everything: RelevantPromotion[];
  as_of: string;
}

export interface TrackedOffer {
  tracking_id: number;
  promotion: Promotion;
  card: { id: number; nickname: string; product: string } | null;
  progress: { spent_cents: number; required_cents: number; remaining_cents: number; days_left: number; met: boolean } | null;
  status: string;
}

export const fetchOffers2 = () => get<OfferInbox>('/api/promotions');

export const fetchTrackedOffers = () => get<{ offers: TrackedOffer[]; as_of: string }>('/api/promotions/tracked');

export const trackOffer = (id: number, nickname?: string) =>
  post<{ ok: boolean; error?: string; summary?: string }>(`/api/promotions/${id}/track`, { nickname });

export const dismissOffer = (id: number) => post<{ ok: boolean }>(`/api/promotions/${id}/dismiss`, {});

// Named apart from the older sweepOffers, which retires expired feed items —
// two different sweeps, and one name for both would be a silent mix-up.
export const sweepPromotions = () =>
  post<{ completed: { title: string; expected: string }[] }>('/api/promotions/sweep', {});

export const fetchPromotionEvidence = (id: number) => get<PromotionEvidence>(`/api/promotions/${id}/evidence`);

export const contributeTargetedOffer = (
  id: number,
  body: { reward: Record<string, number | string>; minimum_spend_cents?: number | null; note?: string | null; application_channel?: string | null }
) => post<{ ok: boolean; error?: string }>(`/api/promotions/${id}/variants`, body);

export const removeTargetedOffer = (id: number, key: string) =>
  del<{ ok: boolean }>(`/api/promotions/${id}/variants/${encodeURIComponent(key)}`);

/* --- discovery: what the app read, and what is left for a person ---------- */

export interface DiscoverySource {
  id: number;
  source_key: string;
  name: string;
  source_type: string;
  base_url: string | null;
  feed_url: string | null;
  trust_tier: number;
  scan_frequency: ScanFrequency;
  last_scanned_at: string | null;
  last_success_at: string | null;
  failure_count: number;
  last_error: string | null;
  active: number;
  scans: number;
  successes: number;
  promotions_found: number;
  issuer: string | null;
  base_scan_frequency: ScanFrequency | null;
  adaptive_frequency: number;
  last_items_seen: number | null;
  last_items_new: number | null;
  last_relevant_new: number | null;
}

export interface DiscoverySourceHealth {
  source: DiscoverySource;
  state: SourceState;
  success_rate: number;
  days_since_success: number | null;
  last_result: { items_seen: number | null; items_found: number | null; relevant_items_found: number | null } | null;
  ailing: boolean;
  note: string;
}

/**
 * Where discovery stands.
 *
 * Typed against the same lists the Worker writes, because this pair drifted
 * once: the backend wrote `new` and this screen counted `pending`, so a
 * working pipeline displayed as idle and nothing objected.
 */
export interface DiscoveryStatus {
  as_of: string;
  health: { overall: DiscoveryHealth; search: DiscoveryHealth; rss: DiscoveryHealth; note: string };
  sources: DiscoverySourceHealth[];
  sources_configured: boolean;
  search: { configured: boolean; provider: string | null; searches_today: number; budget: number };
  pipeline: {
    items_new: number;
    items_processed: number;
    items_irrelevant: number;
    items_failed: number;
    candidates_extracted: number;
    candidates_review: number;
    candidates_published: number;
    candidates_rejected: number;
  };
  today: { new: number; changed: number; auto_published: number; awaiting_review: number };
  latest_run: DiscoveryRun | null;
}

export interface SourceTestExample {
  title: string;
  url: string;
  classification: string;
  relevant: boolean;
  signals: string[];
  trust_tier: number;
}

export interface SourceTestResult {
  ok: boolean;
  type: string;
  source_key: string;
  name: string;
  configured?: boolean;
  provider?: string | null;
  http_status?: number;
  items_seen?: number;
  relevant_items?: number;
  queries_planned?: number;
  examples: SourceTestExample[];
  error?: string;
  error_code?: string;
  note: string;
  as_of: string;
}

export const testDiscoverySource = (id: number) =>
  post<SourceTestResult>(`/api/admin/discovery/sources/${id}/test`, {});

export interface PromotionReviewItem {
  candidate_id: number;
  status: string;
  review_reason: string | null;
  issuer: string | null;
  product: string | null;
  resolved_product_id: number | null;
  promotion_type: string | null;
  application_channel: string;
  terms: Record<string, unknown>;
  evidence: {
    field: string;
    value: unknown;
    sources: number;
    highest_trust_tier: number;
    official_confirmation: boolean;
    conflicting_values: unknown[];
    confidence: string;
    excerpt: string | null;
    note: string;
  }[];
  verification_state: string;
  confidence: string;
  conflicts: string[];
  sources: { url: string; tier: number; type: string }[];
  existing: { id: number; title: string; terms: Record<string, unknown>; end_at: string | null } | null;
  diff: { field: string; before: unknown; after: unknown }[];
  article: { url: string | null; title: string | null } | null;
  provenance: {
    discovery_channels: ('rss' | 'search' | 'manual')[];
    article_sources: { name: string; url: string; trust_tier: number }[];
    official_verified: boolean;
    search_query: string | null;
  };
}

export const fetchDiscoveryStatus = () => get<DiscoveryStatus>('/api/admin/discovery/status');

export const runDiscovery = (stage: 'discover' | 'extract' | 'corroborate' | 'expire') =>
  post<Record<string, unknown>>('/api/admin/discovery/run', { stage });

export interface DiscoveryReport {
  stage: string;
  sources_scanned: number;
  feed_items_seen: number;
  search_queries_planned: number;
  search_queries_executed: number;
  search_results_seen: number;
  items_found: number;
  relevant_items_found: number;
  items_classified: number;
  articles_fetched: number;
  articles_failed: number;
  candidates_created: number;
  candidates_merged: number;
  published: number;
  held_for_review: number;
  expired: number;
  notes: string[];
  as_of: string;
}

export interface DiscoveryPipelineReport {
  discover: DiscoveryReport;
  extract: DiscoveryReport;
  corroborate: DiscoveryReport;
  summary: DiscoveryReport;
  cycles: number;
  stopped_because: 'no_work_left' | 'cycle_limit' | 'nothing_to_scan';
  outcome: string;
}

export const runDiscoveryAll = () => post<DiscoveryPipelineReport>('/api/admin/discovery/run-all', {});

export interface DiscoveryRun {
  id: number;
  stage: string;
  started_at: string;
  finished_at: string | null;
  success: number;
  sources_scanned: number;
  items_seen: number;
  items_found: number;
  relevant_items_found: number;
  articles_fetched: number;
  candidates_created: number;
  published: number;
  held_for_review: number;
  error: string | null;
}

export const fetchDiscoveryRuns = () => get<{ runs: DiscoveryRun[]; as_of: string }>('/api/admin/discovery/runs');

export const fetchPromotionReview = () => get<{ items: PromotionReviewItem[]; as_of: string }>('/api/admin/promotions/review');

export const publishCandidateEdit = (id: number, terms?: Record<string, unknown>) =>
  post<{ ok: boolean; error?: string; change?: string | null }>(`/api/admin/promotions/review/${id}/publish`, { terms });

export const rejectCandidate = (id: number, reason?: string) =>
  post<{ ok: boolean; error?: string }>(`/api/admin/promotions/review/${id}/reject`, { reason });

/* --- is a card missing from my setup? ------------------------------------- */

export interface PortfolioGap {
  category: string;
  monthly_cents: number;
  return_pct: number;
  detail: string;
  severity: 'high' | 'medium' | 'low';
}

export interface AcquisitionSuggestion {
  product: { id: number; product_key: string; issuer: string; product_name: string; annual_fee_cents: number | null };
  eligibility: 'eligible' | 'ineligible' | 'unknown';
  eligibility_note: string | null;
  projected_annual_incremental_value_cents: number;
  projected_extra_miles: number;
  annual_fee_cents: number;
  net_value_cents: number;
  affected_spend_cents: number;
  categories_improved: { category: string; spend_cents: number; extra_value_cents: number; transactions: number }[];
  overlap_score: number;
  no_improvement: string[];
  welcome_offer: { title: string; reward: string; requires: string | null } | null;
  assumptions: string[];
  reasons: string[];
  confidence: 'high' | 'medium' | 'low';
  score_cents: number;
  complexity_cost_cents: number;
  closes_gaps: string[];
}

export interface AcquisitionReport {
  gaps: PortfolioGap[];
  suggestions: AcquisitionSuggestion[];
  not_worth_it: { product_name: string; why: string }[];
  history: { months: number; months_with_data: number; from: string; to: string };
  objective: string;
  confidence: 'high' | 'medium' | 'low';
  as_of: string;
}

export const fetchPortfolioGaps = (months = 6) =>
  get<{ gaps: PortfolioGap[]; as_of: string }>(`/api/cards/portfolio-gaps?history_months=${months}`);

export const simulateAcquisition = (body: { history_months?: number; objective?: string }) =>
  post<AcquisitionReport>('/api/cards/acquisition/simulate', body);

/* --- onboarding ---------------------------------------------------------- */

export interface OnboardingField {
  key: string;
  type: 'date' | 'day_of_month' | 'money' | 'number' | 'choice' | 'boolean';
  label: string;
  help_text: string | null;
  required: boolean;
  affects: string;
  sort: number;
}

export interface CardSetup {
  card_id: number;
  nickname: string;
  product: string;
  status: 'ready' | 'usable_with_limits' | 'needs_setup';
  missing: { field_key: string; label: string; affects: string; required: boolean }[];
  consequence: string | null;
}

export interface OnboardingState {
  status: 'not_started' | 'in_progress' | 'completed';
  cards_completed: number;
  statements_offered: number;
  wallet_offered: number;
  completed_at: string | null;
}

export interface OnboardingView {
  state: OnboardingState;
  cards: CardSetup[];
  repairs: CardSetup[];
  ready: boolean;
}

export interface CardMatch {
  product: CatalogProduct;
  matched_on: 'alias' | 'name' | 'issuer' | 'initials';
  score: number;
  held_as: string | null;
}

export const fetchOnboarding = () => get<OnboardingView>('/api/onboarding');

export const searchCatalogue = (q: string) =>
  get<{ matches: CardMatch[] }>(`/api/onboarding/search?q=${encodeURIComponent(q)}`);

export const onboardingFields = (productId?: number) =>
  get<{ fields: OnboardingField[] }>(`/api/onboarding/fields${productId ? `?product_id=${productId}` : ''}`);

export const setOnboardingState = (body: Partial<OnboardingState>) =>
  post<{ ok: true; state: OnboardingState }>('/api/onboarding/state', body);

export const completeOnboarding = () =>
  post<{ ok: true; state: OnboardingState; repairs: CardSetup[] }>('/api/onboarding/complete', {});

export const attachOffer = (
  cardId: number,
  body: { amount: string; window_days: number; reward_note: string }
) =>
  post<{ ok: boolean; error?: string; deadline?: string; summary?: string }>(
    `/api/onboarding/cards/${cardId}/offers`,
    body
  );

/* --- the action centre --------------------------------------------------- */

export type ActionKind =
  | 'minimum_spend'
  | 'signup_deadline'
  | 'transaction_count'
  | 'cap_nearly_gone'
  | 'points_expiring'
  | 'unreviewed_import'
  | 'unknown_code';

export interface ActionItem {
  kind: ActionKind;
  subject: string;
  title: string;
  detail: string;
  amount_cents: number | null;
  deadline: string | null;
  days_left: number | null;
  urgency: 'now' | 'soon' | 'watch';
  target: string;
  priority: number;
  count: number;
}

export const fetchActions = () => get<{ actions: ActionItem[]; as_of: string }>('/api/actions');

/** "I used this card": the recommendation, taken, as a pending transaction. */
export const logUsed = (b: {
  card_id?: number;
  nickname?: string;
  amount_cents?: number | null;
  merchant?: string | null;
  mcc?: string | null;
  category?: string | null;
  channel?: string | null;
  occurred_at?: string;
}) =>
  post<{
    ok: true;
    id: number;
    status: string;
    card: { id: number; nickname: string; product: string };
    occurred_at: string;
    amount_cents: number;
    expected: { miles: number; cashback_cents: number };
  }>('/api/tx/used', b);

/* --- the card catalogue -------------------------------------------------- */

export interface CatalogProduct {
  id: number;
  product_key: string;
  issuer: string;
  product_name: string;
  network: string | null;
  reward_type: string | null;
  program_key: string | null;
  base_mpd: number | null;
  base_cashback_pct: number | null;
  annual_fee_cents: number | null;
  official_url: string | null;
  source: string;
  verification_status: string;
  last_verified_at: string | null;
  stale: boolean;
  current_rule_set: { id: number; version: number; effective_from: string } | null;
  rules: number;
  held_by: string[];
}

export interface CatalogRuleSet {
  id: number;
  version: number;
  status: string;
  effective_from: string;
  effective_until: string | null;
  notes: string | null;
  rules: {
    id: number;
    category: string;
    mpd: number;
    reward_type: string;
    cap_cents: number | null;
    // The column names are the engine's own: a rule includes codes or excludes
    // them, and conflating the two into one "list" is how a bonus restriction
    // turns into a bonus exclusion.
    mcc_include: string | null;
    mcc_exclude: string | null;
    channel: string | null;
    min_tier_cents: number | null;
  }[];
  exclusions: { id: number; mcc: string; reason: string | null }[];
}

export interface CatalogDetail {
  product: CatalogProduct;
  versions: CatalogRuleSet[];
  sources: { id: number; source_type: string; source_url: string; title: string | null; retrieved_at: string }[];
  overlaps: { a: number; b: number; from: string; until: string | null }[];
}

export interface RuleChange {
  kind: 'added' | 'removed' | 'changed';
  category: string;
  summary: string;
  before?: string;
  after?: string;
}

export interface RuleSetDiff {
  from: { id: number; version: number } | null;
  to: { id: number; version: number };
  rules: RuleChange[];
  exclusions: RuleChange[];
  identical: boolean;
}

export interface StaleProduct {
  product: CatalogProduct;
  reason: string;
  days_since: number | null;
  held_by: string[];
}

export const fetchStaleProducts = () =>
  get<{ products: StaleProduct[]; as_of: string }>('/api/catalog/stale');

export const draftRuleSet = (productId: number, body: { effective_from?: string; notes?: string }) =>
  post<{ ok: true; draft: CatalogRuleSet; copied_rules: number; copied_exclusions: number; based_on: number | null }>(
    `/api/catalog/cards/${productId}/rule-sets`,
    body
  );

export const addDraftRule = (
  ruleSetId: number,
  body: {
    category: string;
    mpd: number;
    reward_type?: string;
    mcc_include?: string | null;
    cap_cents?: number | null;
    channel?: string | null;
  }
) => post<{ ok: true; id: number }>(`/api/catalog/rule-sets/${ruleSetId}/rules`, body);

export const deleteDraftRule = (ruleSetId: number, ruleId: number) =>
  del<{ ok: true }>(`/api/catalog/rule-sets/${ruleSetId}/rules/${ruleId}`);

export const fetchRuleSetDiff = (ruleSetId: number) =>
  get<RuleSetDiff>(`/api/catalog/rule-sets/${ruleSetId}/diff`);

export const publishRuleSet = (ruleSetId: number) =>
  post<{ ok?: true; error?: string; code?: string; conflicts?: unknown; diff?: RuleSetDiff }>(
    `/api/catalog/rule-sets/${ruleSetId}/publish`,
    {}
  );

export const addProductSource = (
  productId: number,
  body: { source_type: string; source_url: string; title?: string; text?: string }
) => post<{ ok: true; source: { id: number } }>(`/api/catalog/cards/${productId}/sources`, body);

export const checkProductSource = (sourceId: number, text: string) =>
  post<{ ok: true; changed: boolean; hash: string }>(`/api/catalog/sources/${sourceId}/check`, { text });

export const fetchCatalog = (q = '') => get<{ products: CatalogProduct[] }>(`/api/catalog/cards?q=${encodeURIComponent(q)}`);

export const fetchCatalogCard = (key: string) => get<CatalogDetail>(`/api/catalog/cards/${encodeURIComponent(key)}`);

export const confirmMcc = (merchant: string, mcc: string, channel?: string) =>
  post<{ ok: true; merchant: MerchantGuess }>('/api/mcc/merchant', { merchant, mcc, channel, confirmed: true });

export interface AuditRow {
  id: number; occurred_at: string; posted_at: string | null; merchant: string | null;
  category: string | null; mcc: string | null; amount_cents: number; card: string;
  expected_miles: number; expected_cashback_cents: number;
  actual_miles: number | null; actual_cashback_cents: number | null;
  shortfall_miles: number; shortfall_cents: number;
  status: 'matched' | 'short' | 'over' | 'unrecorded'; reason: string | null;
}

export interface AuditReport {
  period: { start: string; end: string; label: string };
  totals: {
    expected_miles: number; actual_miles: number;
    expected_cashback_cents: number; actual_cashback_cents: number;
    shortfall_miles: number; shortfall_cents: number;
    checked: number; unrecorded: number;
  };
  rows: AuditRow[];
  findings: string[];
}

export const fetchAudit = (p: { from?: string; to?: string; card_id?: string } = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) q.set(k, v);
  return get<AuditReport>(`/api/audit?${q}`);
};

export const recordCredited = (id: number, miles: number | null, cashback: string | null) =>
  post<{ ok: true }>('/api/tx/credited', { id, miles, cashback });

export interface Optimisation {
  months_analysed: number;
  reallocations: {
    category: string; monthly_cents: number;
    from_card: string; from_rate: string;
    to_card: string; to_rate: string;
    movable_cents: number; gain_cents_year: number; gain_miles_year: number;
    capped_by: string | null;
  }[];
  underused: {
    card: string; category: string; cap_cents: number;
    typical_used_cents: number; utilisation_pct: number; unused_value_cents_year: number;
    better_category: { category: string; monthly_cents: number; gain_cents_year: number } | null;
  }[];
  total_gain_cents_year: number;
  notes: string[];
}

export const fetchOptimise = (months = 3) => get<Optimisation>(`/api/optimise?months=${months}`);

export const fetchExpiry = () => get<{ tranches: Expiry[] }>('/api/expiry');
export const fetchReview = () => get<{ ready: ReviewRow[]; waiting: ReviewRow[] }>('/api/review');
export const fetchTransfers = () => get<{ transfers: any[] }>('/api/transfers');

export const updateTransaction = (id: number, field: string, value: string | null) =>
  post<{ ok: true; transaction: Txn }>('/api/tx/update', { id, field, value });

export const runTransfer = (conversion_id: number, points: string) =>
  post<{ ok: boolean; error?: string; plan?: Plan; consumed?: { points: number; expires_at: string | null }[] }>(
    '/api/transfer',
    { conversion_id, points }
  );

export const fetchAnalytics = (month: string) => get<Analytics>(`/api/analytics?month=${month}`);
export const fetchMonths = () => get<{ months: string[] }>('/api/months');

// --- spending that never touched a card --------------------------------------

export interface OtherRow {
  id: number;
  occurred_at: string;
  amount_cents: number;
  method: string;
  merchant: string | null;
  category: string | null;
  card_possible: number;
  note: string | null;
}

export interface MissedReward {
  category: string;
  spend_cents: number;
  card: string | null;
  miles: number;
  cashback_cents: number;
  value_cents: number;
}

export interface OtherSummary {
  month: string;
  rows: OtherRow[];
  total_cents: number;
  avoidable_cents: number;
  by_method: { method: string; label: string; spend_cents: number; count: number; card_possible: number }[];
  by_category: { category: string; spend_cents: number; count: number }[];
  card_spend_cents: number;
  share_percent: number;
  missed: MissedReward[];
  missed_value_cents: number;
  missed_miles: number;
  uncategorised_cents: number;
  months: string[];
  methods: { key: string; label: string; card_possible: number }[];
}

export const fetchOther = (month?: string) =>
  get<OtherSummary>(`/api/other${month ? `?month=${month}` : ''}`);

export const addOther = (body: {
  amount: string;
  date?: string;
  method: string;
  merchant?: string;
  category?: string;
  card_possible?: boolean;
  note?: string;
}) => post<{ ok: true; id: number; category: string | null; card_possible: number }>('/api/other/add', body);

export const updateOther = (id: number, field: string, value: string | null) =>
  post<{ ok: true }>('/api/other/update', { id, field, value });

export const deleteOther = (id: number) => post<{ ok: true }>('/api/other/delete', { id });

// --- pasting a statement ----------------------------------------------------

export type RowKind =
  | 'matched'
  | 'new'
  | 'possible_duplicate'
  | 'refund'
  | 'payment'
  | 'fee'
  | 'interest'
  | 'needs_review';

export interface ParsedRow {
  occurred_at: string;
  posted_at: string | null;
  merchant: string;
  amount_cents: number;
  raw: string;
  credit: boolean;
  duplicate?: boolean;
  mcc?: string | null;
  category?: string | null;
  /** Set once a card is named and the rows can be checked against the ledger. */
  kind?: RowKind;
  matched_id?: number | null;
  detail?: string;
  external_id?: string;
}

export interface StatementParse {
  rows: ParsedRow[];
  skipped: { raw: string; reason: string }[];
  total_cents: number;
  duplicates: number;
  summary: Record<RowKind, number> | null;
  statement_date: string | null;
}

export interface ImportReport {
  ok: true;
  imported: number;
  already_known: number;
  reconciled: number;
  queued_for_review: number;
  processed: number;
  skipped: { kind: RowKind; count: number }[];
  expected_miles: number;
}

export const parseStatement = (text: string, nickname?: string, statement_date?: string | null) =>
  post<StatementParse>('/api/statement/parse', { text, nickname, statement_date });

export const importStatement = (nickname: string, rows: ParsedRow[]) =>
  post<ImportReport>('/api/statement/import', { nickname, rows });

/* --- re-pricing what the app believed ------------------------------------ */

export interface RecalcChange {
  id: number;
  occurred_at: string;
  merchant: string | null;
  card: string;
  before: { miles: number; cashback_cents: number; rule_set_id: number | null };
  after: { miles: number; cashback_cents: number; rule_set_id: number | null };
  summary: string;
  changed: boolean;
}

export interface RecalcReport {
  considered: number;
  changed: number;
  unchanged: number;
  failed: { id: number; error: string }[];
  changes: RecalcChange[];
  miles_before: number;
  miles_after: number;
  cashback_before_cents: number;
  cashback_after_cents: number;
}

export const recalculateAll = (body: { nickname?: string; from?: string; unpriced?: boolean }) =>
  post<RecalcReport>('/api/transactions/recalculate', body);

export const recalculateOne = (id: number) =>
  post<{ ok: boolean; error?: string; change?: RecalcChange }>(`/api/transactions/${id}/recalculate`, {});

/* --- the review inbox ---------------------------------------------------- */

export type ReviewReason =
  | 'unknown_card'
  | 'unknown_merchant'
  | 'unknown_mcc'
  | 'ambiguous_mcc'
  | 'possible_duplicate'
  | 'unknown_category'
  | 'reward_rule_uncertain'
  | 'statement_match_ambiguous';

export interface ReviewItem {
  id: number;
  transaction_id: number;
  reason: ReviewReason;
  detail: string | null;
  suggestion: string | null;
  other_id: number | null;
  merchant: string | null;
  merchant_raw: string | null;
  merchant_id: number | null;
  amount_cents: number;
  occurred_at: string;
  mcc: string | null;
  channel: string | null;
  category: string | null;
  nickname: string;
  product: string;
  options: { mcc: string; description: string | null; observations: number }[];
}

export const fetchReviewQueue = () => get<{ items: ReviewItem[] }>('/api/review/queue');

export const resolveReview = (
  id: number,
  body: { action: 'confirm' | 'ignore' | 'merge' | 'keep_both'; mcc?: string; category?: string; merchant?: string }
) => post<{ ok: boolean; error?: string; applied?: string; merged_into?: number }>(`/api/review/${id}/resolve`, body);

// --- cards and their earn rules ---------------------------------------------

export interface EarnRuleRow {
  id: number;
  card_id: number;
  category: string;
  mpd: number;
  reward_type: 'miles' | 'cashback';
  mcc_include: string | null;
  mcc_exclude: string | null;
  channel: string | null;
  min_txn_cents: number | null;
  min_tier_cents: number | null;
  program_key: string | null;
  cap_cents: number | null;
  cap_group: string | null;
  cap_window: string | null;
  note: string | null;
}

export interface RequirementRow {
  id: number;
  card_id: number;
  kind: 'monthly_min' | 'signup_min';
  amount_cents: number;
  window: string;
  deadline: string | null;
  starts_at: string | null;
  min_txns: number | null;
  bonus_cap_cents: number | null;
  reward_note: string | null;
  anchor_at: string | null;
  per_month: number;
  prorate_first: number;
  tiers: Tier[];
}

export interface CardRow {
  id: number;
  issuer: string;
  product: string;
  nickname: string;
  credit_limit_cents: number;
  statement_day: number;
  opened_at: string | null;
  closed_at: string | null;
  base_mpd: number;
  program_key: string | null;
  rules: EarnRuleRow[];
  requirements: RequirementRow[];
}

export const fetchCards = () =>
  get<{ cards: CardRow[]; programs: ProgramRow[]; categories: string[] }>('/api/cards');

export const addCard = (body: {
  issuer?: string;
  product?: string;
  nickname: string;
  limit?: string;
  statement_day?: number;
  opened_at?: string;
  program_key?: string | null;
  base_mpd?: string;
  /** Picked from the catalogue: everything the product decides comes with it. */
  product_id?: number;
}) =>
  post<{
    ok: true;
    id: number;
    nickname: string;
    program_key: string | null;
    product_id: number | null;
    issuer: string;
    product: string;
    from_catalog: boolean;
    rules: number;
  }>('/api/card', body);

export const addEarnRule = (body: {
  nickname: string;
  category: string;
  rate: string;
  reward_type: 'miles' | 'cashback';
  cap?: string;
  cap_window?: string | null;
  cap_group?: string | null;
  mcc_include?: string;
  mcc_exclude?: string;
  channel?: string | null;
  min_txn?: string;
  /** Only earn at this rate once the card holds this monthly spend rung. */
  min_tier?: string;
  note?: string;
}) => post<{ ok: true; id: number }>('/api/card/rule', body);

export const addRequirement = (body: {
  /** Set to change an existing requirement rather than add another. */
  id?: number;
  nickname: string;
  kind: 'monthly_min' | 'signup_min';
  amount: string;
  window: string;
  deadline?: string | null;
  starts_at?: string | null;
  min_txns?: number | null;
  bonus_cap?: string | null;
  reward_note?: string | null;
  anchor_at?: string | null;
  per_month?: boolean;
  prorate_first?: boolean;
  tiers?: { min_spend: string; reward: string; label?: string | null }[];
}) => post<{ ok: true; id: number; tiers: number }>('/api/card/requirement', body);

export const deleteRequirement = (id: number) => post<{ ok: true }>('/api/card/requirement/delete', { id });

export const deleteEarnRule = (id: number) => post<{ ok: true }>('/api/card/rule/delete', { id });

export const closeCard = (nickname: string, closed_at: string | null) =>
  post<{ ok: true; closed_at: string | null }>('/api/card/close', { nickname, closed_at });

export const fetchSummary = () => get<Summary>('/api/summary');
// --- the points wallet ------------------------------------------------------

export interface WalletProgram {
  program_key: string;
  name: string;
  kind: string;
  unit: string;
  points: number;
  expiring_soon: number;
  next_expiry: string | null;
  pending: number;
  miles_equivalent: number | null;
  value_cents: number | null;
  rate_note: string | null;
}

export interface PendingCredit {
  id: number;
  date: string;
  merchant: string | null;
  amount_cents: number;
  card: string;
  program_key: string;
  program_name: string;
  unit: string;
  miles: number;
}

export interface PendingSummary {
  credits: PendingCredit[];
  by_program: { program_key: string; program_name: string; unit: string; points: number; count: number }[];
  total_points: number;
  unassigned: { card: string; nickname: string; miles: number; count: number }[];
}

export interface Wallet {
  programs: WalletProgram[];
  totals: { points: number; miles_equivalent: number; value_cents: number; pending_points: number };
  pending: PendingSummary;
  expiring: { program_key: string; name: string; points: number; expires_at: string; days: number }[];
}

export const fetchWallet = () => get<Wallet>('/api/wallet');

/** Nothing is banked without this: the prediction waits to be confirmed. */
export const acceptCredits = (body: { ids?: number[]; program_key?: string }) =>
  post<{ accepted: number; points: number; wallet: Wallet }>('/api/credits/accept', body);

export const undoCredit = (id: number) => post<{ ok: true; wallet: Wallet }>('/api/credits/undo', { id });

export const setCardProgram = (nickname: string, program_key: string | null) =>
  post<{ ok: true }>('/api/card/program', { nickname, program_key });

export const sweepOffers = () =>
  post<{ expired: number; deleted: number; retention_days: number }>('/api/offers/sweep', {});

export const fetchOffers = (status: 'open' | 'all' = 'open') =>
  get<{ offers: OfferRow[]; today: string; offer_retention_days: number }>(`/api/offers?status=${status}`);

/** A headline the scanner has seen, before it is promoted to a tracked offer. */
export interface FeedItemRow {
  id: number;
  feed: string;
  title: string;
  link: string;
  apply_url: string | null;
  excerpt: string | null;
  terms: string | null;
  score: number | null;
  topic: 'promo' | 'rates' | null;
  action: 'tracked' | 'ignored' | null;
  deep: number;
  published_at: string | null;
  seen_at: string;
  offer_id: number | null;
}

export interface ScanSummary {
  fresh: FeedItemRow[];
  feeds_read: number;
  feeds_failed: string[];
  items_seen: number;
  pages_fetched: number;
}

export type FeedState = 'new' | 'tracked' | 'ignored' | 'promo' | 'all';
export type RangeName = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'lastmonth' | 'ytd' | 'all';

export interface FeedPage {
  items: FeedItemRow[];
  page: number;
  pages: number;
  per_page: number;
  total: number;
  state: FeedState;
  range: { from: string | null; to: string | null; label: string };
  counts: { new: number; tracked: number; ignored: number; all: number };
}

export const fetchFeed = (opts: { state?: FeedState; range?: RangeName; page?: number; per_page?: number } = {}) => {
  const q = new URLSearchParams({
    state: opts.state ?? 'new',
    range: opts.range ?? 'all',
    page: String(opts.page ?? 1),
    per_page: String(opts.per_page ?? 10),
  });
  return get<FeedPage>(`/api/feed?${q}`);
};

/** Runs the same scan the cron runs. `url` parses a single page instead. */
export const runScan = (body: { deep?: boolean; url?: string; push?: boolean } = {}) =>
  post<ScanSummary>('/api/scan', body);

export interface FeedStorage {
  total: number;
  undecided: number;
  tracked: number;
  ignored: number;
  text_bytes: number;
  reclaimable_bytes: number;
  compactable: number;
  retention_days: number;
}

export const fetchFeedStorage = () => get<FeedStorage>('/api/feed/storage');

/** `compact` keeps the row and drops its bulk; `delete` forgets it entirely. */
export const purgeFeed = (body: {
  mode: 'compact' | 'delete';
  scope: 'ignored' | 'decided';
  older_than_days?: number;
}) => post<{ mode: string; affected: number; freed_bytes: number; storage: FeedStorage }>('/api/feed/purge', body);

/** Track or ignore one item or many — one request either way. */
export const feedActionMany = (ids: number[], action: 'track' | 'ignore') =>
  post<{ ok: true; ignored?: number; tracked?: { id: number; offer_id: number }[] }>('/api/feed/action', {
    ids,
    action,
  });

export const fetchFeeds = () => get<{ feeds: FeedRow[] }>('/api/feeds');

export const saveFeed = (f: { url: string; label: string; kind: string | null; active: boolean; old_url?: string }) =>
  post<{ ok: true; url: string }>('/api/feeds/save', f);

export const deleteFeed = (url: string) => post<{ ok: true }>('/api/feeds/delete', { url });

/** The prompt to paste into Claude, for the offer whose T&C is not extracted yet. */
export const fetchExtractPrompt = (id: number) =>
  get<{ id: number; prompt: string; source_url: string | null }>(`/api/offer/prompt?id=${id}`);

export const saveExtraction = (id: number, json: string) =>
  post<{ rules_saved: number; decisions_kept: number; eligibility: Eligibility }>('/api/offer/extract', { id, json });

export const decideRule = (rule_id: number, decision: RuleDecision | null, note?: string | null) =>
  post<{ ok: true; offer_id: number; eligibility: Eligibility }>('/api/offer/rule', { rule_id, decision, note });

export const deleteRule = (rule_id: number) =>
  post<{ ok: true; offer_id: number; eligibility: Eligibility }>('/api/offer/rule/delete', { rule_id });

export const setOfferStatus = (id: number, status: OfferRow['status']) =>
  post<{ ok: true }>('/api/offer/status', { id, status });

// --- merchant codes ---------------------------------------------------------

export type CellState = 'excluded' | 'bonus' | 'base' | 'none';

export interface MccCell {
  card_id: number;
  nickname: string;
  state: CellState;
  rate: number;
  reward_type: 'miles' | 'cashback';
  category: string | null;
  cap_cents: number | null;
  cap_window: string | null;
  reason: string | null;
}

export interface MccRow {
  code: string;
  description: string;
  category: string;
  verified: number;
  excluded_everywhere: boolean;
  exclusion_reason: string | null;
  cells: MccCell[];
  spend_cents: number;
  txn_count: number;
}

export interface MccMatrix {
  cards: { id: number; nickname: string; product: string; issuer: string; base_mpd: number }[];
  rows: MccRow[];
  categories: string[];
  page: number;
  pages: number;
  per_page: number;
  total: number;
  carriers_hidden: number;
  summary: {
    codes: number;
    excluded_everywhere: number;
    excluded_somewhere: number;
    bonus_codes: number;
    codes_you_have_used: number;
    verified_codes: number;
    excluded_spend_cents: number;
  };
  min_spend_counts_excluded: boolean;
}

export const fetchMccMatrix = (
  opts: { q?: string; filter?: string; category?: string; page?: number; per?: number; carriers?: boolean } = {}
) => {
  const q = new URLSearchParams();
  if (opts.q) q.set('q', opts.q);
  if (opts.filter && opts.filter !== 'all') q.set('filter', opts.filter);
  if (opts.category) q.set('category', opts.category);
  if (opts.page) q.set('page', String(opts.page));
  if (opts.per) q.set('per_page', String(opts.per));
  if (opts.carriers) q.set('carriers', '1');
  return get<MccMatrix>(`/api/mcc/matrix${q.toString() ? `?${q}` : ''}`);
};

export interface UnknownMerchant {
  merchant: string;
  txn_count: number;
  spend_cents: number;
  last_seen: string;
  suggested_mcc: string | null;
  suggested_description: string | null;
  suggested_source: string | null;
}

export interface MccScanResult {
  fetched: number;
  added: { merchant: string; mcc: string; description: string | null; verified: boolean }[];
  updated: { merchant: string; mcc: string; description: string | null; verified: boolean }[];
  unchanged: number;
  conflicts: { merchant: string; yours: string; theirs: string; url: string }[];
  failed: string[];
  source: string;
}

export interface DirectoryHit {
  store: string;
  mcc: string;
  their_description: string | null;
  channel: string | null;
  url: string | null;
  description: string | null;
  category: string | null;
}

export interface MerchantLookup {
  query: string;
  known: { merchant: string; mcc: string; source: string; confidence: string } | null;
  results: DirectoryHit[];
  source: string;
  error: string | null;
}

/** Look one merchant up by name — ours first, then the public directory. */
export const lookupMerchant = (q: string) => get<MerchantLookup>(`/api/mcc/lookup?q=${encodeURIComponent(q)}`);

export interface UnknownPage {
  merchants: UnknownMerchant[];
  page: number;
  pages: number;
  per: number;
  total: number;
  ignored: number;
  ignored_list: { merchant: string; reason: string | null }[];
}

export const fetchUnknownMerchants = (page = 1, per = 25) =>
  get<UnknownPage>(`/api/mcc/unknown?page=${page}&per=${per}`);

/** Stop asking about a merchant that has no code to find, or start again. */
export const ignoreMerchant = (merchant: string, undo = false) =>
  post<{ ok: true; merchant: string; ignored: boolean }>('/api/mcc/ignore', { merchant, undo });

/** Read a published merchant-code directory and record what it says. */
export const scanMccDirectory = () => post<MccScanResult>('/api/mcc/scan', {});

export const assignMerchantCode = (merchant: string, mcc: string, backfill = true) =>
  post<{ ok: true; merchant: string; updated: number; categorised: number; category: string | null }>(
    '/api/mcc/assign',
    { merchant, mcc, backfill }
  );

export interface ScanCandidate {
  kind: 'rate' | 'cap' | 'mcc' | 'exclusion' | 'minspend' | string;
  occurrences?: number;
  quote: string;
  rate?: number;
  reward_type?: 'miles' | 'cashback';
  cap_cents?: number;
  cap_window?: string;
  min_spend_cents?: number;
  mccs?: string[];
  category?: string | null;
}

export interface CardPageScan {
  url: string;
  title: string;
  text_length: number;
  candidates: ScanCandidate[];
  codes: { mcc: string; description: string | null; category: string | null; excluded_here: boolean }[];
  prompt: string;
  error: string | null;
}

/** Read a card's rewards page (or pasted terms) and report what it claims. */
export const scanCardPage = (body: { nickname: string; url?: string; text?: string }) =>
  post<CardPageScan>('/api/card/scan', body);

export const saveExclusion = (body: { mcc: string; nickname?: string | null; reason?: string; active?: boolean }) =>
  post<{ ok: true }>('/api/exclusion', body);

export interface PlatformAttempt {
  query: string;
  ok: boolean;
  error: string | null;
}

export interface PlatformReport {
  configured: boolean;
  missing: string[];
  account_id: string | null;
  script: string | null;
  database_id: string | null;
  from: string;
  to: string;
  days: number;
  attempts: PlatformAttempt[];
  worker: {
    days: { date: string; requests: number; errors: number; subrequests: number }[];
    requests: number;
    errors: number;
    subrequests: number;
    error_percent: number;
    by_status: { status: string; requests: number }[];
    cpu_median_ms: number | null;
    cpu_p99_ms: number | null;
    per_day: number;
    error: string | null;
    totals_only: boolean;
    errors_seen: { message: string; count: number; last_seen: string | null }[];
    errors_error: string | null;
  };
  d1: {
    days: {
      date: string;
      read_queries: number;
      write_queries: number;
      rows_read: number;
      rows_written: number;
      response_bytes: number;
    }[];
    read_queries: number;
    write_queries: number;
    rows_read: number;
    rows_written: number;
    response_bytes: number;
    rows_per_read: number | null;
    latency_avg_ms: number | null;
    latency_p90_ms: number | null;
    size_bytes: number | null;
    size_change_bytes: number | null;
    heavy: {
      sql: string;
      runs: number;
      rows_read: number;
      rows_written: number;
      rows_per_run: number;
      duration_ms: number | null;
      share_percent: number;
    }[];
    heavy_error: string | null;
    error: string | null;
  };
  free_tier: {
    worker_requests_per_day: number;
    d1_rows_read_per_day: number;
    d1_rows_written_per_day: number;
    d1_storage_bytes: number;
    worker_peak_percent: number | null;
    d1_rows_read_peak_percent: number | null;
    d1_rows_written_peak_percent: number | null;
    storage_percent: number | null;
  };
}

/** What Cloudflare's own meters say this app costs. */
export const fetchPlatform = (days = 7) => get<PlatformReport>(`/api/platform?days=${days}`);

export interface MerchantGroup {
  prefix: string;
  variants: { merchant: string; txn_count: number; spend_cents: number }[];
  txn_count: number;
  spend_cents: number;
}

export interface RenameResult {
  matched: number;
  from: string[];
  to: string;
  updated: number;
  preview: boolean;
}

/** Spellings that look like one merchant — suggestions, never applied. */
export const fetchMerchantGroups = () => get<{ groups: MerchantGroup[] }>('/api/tx/groups');

export const renameMerchant = (body: { match: string; to: string; mode?: string; apply?: boolean }) =>
  post<RenameResult>('/api/tx/rename', body);

export const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
