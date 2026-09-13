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
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
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
  met_only_with_at_risk: boolean;
  txn_count: number;
  txns_required: number;
  txns_remaining: number;
  cap_reached: boolean;
  window: { start: string; end: string };
}

export interface CardSummary {
  id: number;
  issuer: string;
  product: string;
  nickname: string;
  limit_cents: number;
  balance_cents: number;
  at_risk_cents: number;
  percent: number;
  cycle: { start: string; end: string };
  days_left: number;
  requirements: Progress[];
}

export interface Summary {
  today: string;
  cards: CardSummary[];
  overall: { balance_cents: number; limit_cents: number; percent: number };
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
  status: 'pending' | 'tracked' | 'applied' | 'dismissed';
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

export interface TxnPage {
  transactions: Txn[];
  range: { from: string | null; to: string | null; label: string };
  total_count: number;
  total_cents: number;
}

export const fetchTransactions = (
  limit = 25,
  opts: { range?: string; from?: string; to?: string } = {}
) => {
  const p = new URLSearchParams({ limit: String(limit) });
  if (opts.range) p.set('range', opts.range);
  if (opts.from) p.set('from', opts.from);
  if (opts.to) p.set('to', opts.to);
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

export const fetchSummary = () => get<Summary>('/api/summary');
export const fetchOffers = (status: 'open' | 'all' = 'open') =>
  get<{ offers: OfferRow[] }>(`/api/offers?status=${status}`);

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

export const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
