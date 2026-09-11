// Point this at your deployed Worker, e.g. https://miles-tracker.<you>.workers.dev
export const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://miles-tracker.YOUR-SUBDOMAIN.workers.dev';

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

export const fetchSummary = () => get<Summary>('/api/summary');
export const fetchOffers = () => get<{ offers: OfferRow[] }>('/api/offers');

export const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
