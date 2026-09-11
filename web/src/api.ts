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

export interface OfferRow {
  id: number;
  issuer: string | null;
  product: string | null;
  bonus_miles: number | null;
  min_spend_cents: number | null;
  spend_window_days: number | null;
  valid_until: string | null;
  source_url: string | null;
  source_title: string | null;
  eligibility: {
    verdict: 'eligible' | 'not_eligible' | 'needs_review';
    rules: { verdict: 'pass' | 'fail' | 'unknown'; reason: string; quote: string | null }[];
  };
}

export interface Txn {
  id: number;
  amount_cents: number;
  occurred_at: string;
  posted_at: string | null;
  merchant: string | null;
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

export const fetchTransactions = (limit = 25) => get<{ transactions: Txn[] }>(`/api/transactions?limit=${limit}`);

export const addTransaction = (body: { nickname: string; amount: string; date: string; note: string }) =>
  post<{ ok: true; id: number; card: string; date: string }>('/api/tx', body);

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
  headroom_cents: number | null;
  miles: number | null;
  reasons: string[];
}

export const fetchPoints = () =>
  get<{ balances: BalanceRow[]; programs: ProgramRow[]; tranches: Tranche[] }>('/api/points');

export const fetchConvert = (points: string, from: string, to: string) =>
  get<{ plans: Plan[] }>(`/api/convert?points=${encodeURIComponent(points)}&from=${from}&to=${to}`);

export const fetchWhich = (category: string, amount: string) =>
  get<{ category: string; picks: Pick[] }>(
    `/api/which?category=${encodeURIComponent(category)}${amount ? `&amount=${encodeURIComponent(amount)}` : ''}`
  );

export const fetchCategories = () => get<{ categories: string[] }>('/api/categories');

export const fetchSummary = () => get<Summary>('/api/summary');
export const fetchOffers = () => get<{ offers: OfferRow[] }>('/api/offers');

export const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
