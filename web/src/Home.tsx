import { useEffect, useState } from 'react';
import Advisor from './Advisor';
import Action from './components/ActionItem';
import {
  fetchActions,
  fetchOnboarding,
  fetchTransactions,
  logUsed,
  money,
  type ActionItem,
  type OnboardingView,
  type RecommendationV2,
  type Txn,
} from './api';

/** Whether the reward on a logged transaction is fact, forecast or guess. */
function certainty(t: Txn): { label: string; cls: string } {
  if (t.actual_miles !== null && t.actual_miles !== undefined) return { label: 'confirmed', cls: 'ok' };
  if (t.needs_review || !t.mcc) return { label: 'uncertain', cls: 'soon' };
  return { label: 'probable', cls: 'never' };
}

const rewardOf = (t: Txn) => {
  const miles = t.actual_miles ?? t.expected_miles ?? 0;
  const cash = t.actual_cashback_cents ?? t.expected_cashback_cents ?? 0;
  if (miles > 0) return `+${miles.toLocaleString()} miles`;
  if (cash > 0) return `+$${money(cash)}`;
  return '—';
};

/**
 * Today, yesterday, then the date — the way a person reads a statement.
 *
 * `today` comes from the action centre, which is much slower to answer than the
 * ledger: it walks every card's standings, the expiry tranches and the stale
 * catalogue, against one indexed query. So the activity list routinely renders
 * before there is a day to compare against, and the date has to survive that.
 * It used to be formatted regardless, which threw on an empty string and took
 * the whole screen down with it — a crash reads as a blank page, not as a
 * missing section.
 */
function dayLabel(date: string, today: string): string {
  const now = Date.parse(today);
  if (!Number.isFinite(now)) return date;
  if (date === today) return 'Today';
  const y = new Date(now - 86_400_000).toISOString().slice(0, 10);
  if (date === y) return 'Yesterday';
  return date;
}

function RecentActivity({ rows, today }: { rows: Txn[]; today: string }) {
  const days: { day: string; rows: Txn[] }[] = [];
  for (const t of rows) {
    const d = t.posted_at ?? t.occurred_at;
    const last = days[days.length - 1];
    if (last && last.day === d) last.rows.push(t);
    else days.push({ day: d, rows: [t] });
  }

  return (
    <section className="card">
      <header>
        <div>
          <h2>Recent activity</h2>
        </div>
      </header>
      {rows.length === 0 ? (
        <p className="sub">Nothing logged yet.</p>
      ) : (
        days.map((d) => (
          <div key={d.day} className="activity-day">
            <p className="activity-date">{dayLabel(d.day, today)}</p>
            <ul className="activity-list">
              {d.rows.map((t) => {
                const c = certainty(t);
                return (
                  <li key={t.id}>
                    <div className="activity-main">
                      <span className="activity-merchant">{t.merchant ?? 'unnamed'}</span>
                      <span className="mono">${money(t.amount_cents)}</span>
                    </div>
                    <div className="activity-meta">
                      <span>{t.product}</span>
                      <span className="mono">{rewardOf(t)}</span>
                      <span className={`chip ${c.cls}`}>{c.label}</span>
                      {t.status === 'pending' && <span className="chip soon">pending</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

/**
 * The home screen: what to use, what needs doing, what just happened.
 *
 * The advisor is first because the question it answers is the one the app
 * exists for, and it is asked standing at a till. Everything below it is there
 * to be glanced at, not worked through.
 */
export default function Home({ onGo }: { onGo: (target: string) => void }) {
  const [actions, setActions] = useState<ActionItem[] | null>(null);
  const [asOf, setAsOf] = useState('');
  const [recent, setRecent] = useState<Txn[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [logged, setLogged] = useState<{ id: number; text: string } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [setup, setSetup] = useState<OnboardingView | null>(null);

  function load() {
    fetchActions()
      .then((d) => {
        setActions(d.actions ?? []);
        setAsOf(d.as_of ?? '');
      })
      .catch((e) => {
        // An empty list, not a permanent "Loading…": a section that never
        // finishes loading is indistinguishable from one that is broken.
        setActions([]);
        setErr((e as Error).message);
      });
    fetchTransactions(8)
      .then((d) => setRecent(d.transactions ?? []))
      .catch(() => void 0);
    fetchOnboarding()
      .then(setSetup)
      .catch(() => void 0);
  }
  useEffect(load, []);

  /**
   * "I used this card", offered on the winning card only.
   *
   * It logs the purchase the advisor was just asked about, as pending: the
   * bank has not confirmed it, and a posting date the app invented would be
   * counted as fact by every window that judges by posting date.
   */
  const usedButton = (r: RecommendationV2) => {
    const pick = r.recommendation;
    if (!pick || r.purchase.amount_cents === null) return null;
    return (
      <div className="used-row">
        <button
          type="button"
          onClick={async () => {
            try {
              const res = await logUsed({
                card_id: pick.card.id,
                amount_cents: r.purchase.amount_cents,
                merchant: r.merchant?.merchant ?? r.merchant?.query ?? null,
                mcc: r.purchase.mcc ?? null,
                category: r.purchase.category ?? null,
                channel: r.purchase.channel ?? null,
              });
              setLogged({
                id: res.id,
                text: `Logged $${money(res.amount_cents)} on ${res.card.product} — pending until the bank posts it.`,
              });
              load();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          I used this card
        </button>
        {logged && <span className="ok-text">{logged.text}</span>}
      </div>
    );
  };

  const shown = actions ? (showAll ? actions : actions.slice(0, 5)) : [];

  return (
    <>
      {setup && setup.state.status === 'not_started' && (
        <section className="card">
          <h2>Set up Miles Tracker</h2>
          <p className="sub">
            Add your cards and it can start answering which one to use. It takes about a minute and never asks for
            reward rates.
          </p>
          <div className="entry-foot">
            <button onClick={() => onGo('setup')}>Get started</button>
          </div>
        </section>
      )}

      {/*
        A gap in an existing setup is a repair, not an onboarding. Someone with
        four cards and two years of history being shown a welcome screen would
        be told the app had forgotten who they were.
      */}
      {setup && setup.state.status === 'completed' && setup.repairs.length > 0 && (
        <section className="card">
          <h2>A few details would improve recommendations</h2>
          <ul className="onb-list">
            {setup.repairs.map((r) => (
              <li key={r.card_id}>
                <b>{r.product}</b> — {r.missing.map((m) => m.label).join(', ')}
                {r.consequence && <span className="sub"> {r.consequence}</span>}
              </li>
            ))}
          </ul>
          <div className="entry-foot">
            <button className="secondary" onClick={() => onGo('cards')}>
              Complete setup
            </button>
          </div>
        </section>
      )}

      <Advisor action={usedButton} />

      <section className="card">
        <div className="section-head" style={{ marginTop: 0 }}>
          <h2>Things to take care of</h2>
          {actions && actions.length > 5 && (
            <button className="secondary" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show less' : `All ${actions.length}`}
            </button>
          )}
        </div>
        {err && <p className="err-text">{err}</p>}
        {!actions ? (
          <p className="sub">Loading…</p>
        ) : actions.length === 0 ? (
          <p className="sub">Nothing needs chasing. Every minimum is met and nothing is close to expiring.</p>
        ) : (
          <>
            <ul className="actions">
              {shown.map((a, i) => (
                <Action key={`${a.kind}-${a.subject}-${i}`} a={a} onGo={onGo} />
              ))}
            </ul>
            <p className="sub">As of {asOf}. Deadlines first, housekeeping last.</p>
          </>
        )}
      </section>

      <RecentActivity rows={recent} today={asOf} />
    </>
  );
}
