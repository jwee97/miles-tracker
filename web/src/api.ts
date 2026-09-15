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

// --- pasting a statement ----------------------------------------------------

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
}

export interface StatementParse {
  rows: ParsedRow[];
  skipped: { raw: string; reason: string }[];
  total_cents: number;
  duplicates: number;
  statement_date: string | null;
}

export const parseStatement = (text: string, nickname?: string, statement_date?: string | null) =>
  post<StatementParse>('/api/statement/parse', { text, nickname, statement_date });

export const importStatement = (nickname: string, rows: ParsedRow[]) =>
  post<{ ok: true; imported: number; expected_miles: number }>('/api/statement/import', { nickname, rows });

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
  program_key: string | null;
  cap_cents: number | null;
  cap_group: string | null;
  cap_window: string | null;
  note: string | null;
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
}

export const fetchCards = () =>
  get<{ cards: CardRow[]; programs: ProgramRow[]; categories: string[] }>('/api/cards');

export const addCard = (body: {
  issuer: string;
  product: string;
  nickname: string;
  limit?: string;
  statement_day?: number;
  opened_at?: string;
  program_key?: string | null;
  base_mpd?: string;
}) => post<{ ok: true; id: number; nickname: string; program_key: string | null }>('/api/card', body);

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
  note?: string;
}) => post<{ ok: true; id: number }>('/api/card/rule', body);

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
  opts: { q?: string; filter?: string; category?: string; page?: number; carriers?: boolean } = {}
) => {
  const q = new URLSearchParams();
  if (opts.q) q.set('q', opts.q);
  if (opts.filter && opts.filter !== 'all') q.set('filter', opts.filter);
  if (opts.category) q.set('category', opts.category);
  if (opts.page) q.set('page', String(opts.page));
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

export const fetchUnknownMerchants = () => get<{ merchants: UnknownMerchant[] }>('/api/mcc/unknown');

/** Read a published merchant-code directory and record what it says. */
export const scanMccDirectory = () => post<MccScanResult>('/api/mcc/scan', {});

export const assignMerchantCode = (merchant: string, mcc: string, backfill = true) =>
  post<{ ok: true; merchant: string; updated: number }>('/api/mcc/assign', { merchant, mcc, backfill });

export const saveExclusion = (body: { mcc: string; nickname?: string | null; reason?: string; active?: boolean }) =>
  post<{ ok: true }>('/api/exclusion', body);

export const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
