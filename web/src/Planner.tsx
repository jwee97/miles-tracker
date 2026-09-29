import { useEffect, useState } from 'react';
import { fetchLeakage, fetchMonthlyPlan, money, type LeakageReport, type MonthlyPlan } from './api';

/**
 * Two questions the app could not answer before.
 *
 * "Which card for this purchase" was always answerable. "How should I use my
 * cards for the rest of the month" was not, because the answer changes the
 * moment a bonus cap fills — and "what did using the wrong one cost me" was
 * not, because it needs the rules that were in force at the time rather than
 * today's.
 *
 * Both are presented with their limits attached. A plan that reads as a budget
 * and a leakage figure that reads as avoidable are the two ways these go
 * wrong, and both are easy to write by accident.
 */

const RANGES: { key: string; label: string }[] = [
  { key: 'lastmonth', label: 'Last month' },
  { key: 'month', label: 'This month' },
  { key: 'ytd', label: 'This year' },
];

function Leakage() {
  const [range, setRange] = useState('lastmonth');
  const [data, setData] = useState<LeakageReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    setBusy(true);
    fetchLeakage(range)
      .then(setData)
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  }, [range]);

  if (err) return <section className="card"><h2>What the wrong card cost</h2><p className="err-text">{err}</p></section>;

  return (
    <section className="card">
      <header>
        <div>
          <h2>What the wrong card cost</h2>
          <p className="sub">Every purchase replayed against the rules that were in force on its own day</p>
        </div>
      </header>

      <div className="seg wrap" role="group" aria-label="Period">
        {RANGES.map((r) => (
          <button key={r.key} type="button" className={range === r.key ? 'on' : ''} onClick={() => setRange(r.key)}>
            {r.label}
          </button>
        ))}
      </div>

      {busy || !data ? (
        <p className="sub">Reading your history…</p>
      ) : data.priced === 0 ? (
        <p className="sub">Nothing in this period could be priced, so there is nothing to compare.</p>
      ) : (
        <>
          <ul className="stmt-summary">
            <li>
              you earned <span className="mono">${money(data.actual_value_cents)}</span>
            </li>
            <li>
              best available <span className="mono">${money(data.best_value_cents)}</span>
            </li>
            <li>
              difference <span className="mono">${money(data.leakage_cents)}</span>
            </li>
            <li>
              captured <span className="mono">{Math.round(data.capture_rate * 100)}%</span>
            </li>
          </ul>

          {/*
            The repeated mistake first. An expensive one-off is history; a
            pattern is the only part anybody can change next month.
          */}
          {data.patterns.length > 0 && (
            <>
              <h3>The pattern worth changing</h3>
              <ul className="notes">
                {data.patterns.map((p, i) => (
                  <li key={i}>{p.summary}</li>
                ))}
              </ul>
            </>
          )}

          {data.by_category.length > 0 && (
            <>
              <h3>Where it went</h3>
              <ul className="code-counts">
                {data.by_category.slice(0, 8).map((c) => (
                  <li key={c.category} className="enough">
                    <span>
                      {c.category} <span className="sub">({c.occurrences})</span>
                    </span>
                    <span className="mono">${money(c.lost_cents)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {data.worst.length > 0 && (
            <details className="trail">
              <summary>The individual purchases ({data.worst.length})</summary>
              <ul className="notes">
                {data.worst.map((w) => (
                  <li key={w.transaction_id}>
                    <strong>{w.merchant ?? 'unnamed'}</strong> · {w.occurred_at} · ${money(w.amount_cents)}
                    <div className="sub">{w.reason}</div>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {data.unpriced.length > 0 && (
            <p className="sub dim">
              Left out: {data.unpriced.map((u) => `${u.count} — ${u.reason}`).join('; ')}.
            </p>
          )}

          {data.caveats.map((c, i) => (
            <p key={i} className="sub dim">
              {c}
            </p>
          ))}
        </>
      )}
    </section>
  );
}

function Plan() {
  const [plan, setPlan] = useState<MonthlyPlan | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchMonthlyPlan()
      .then(setPlan)
      .catch((e) => setErr((e as Error).message));
  }, []);

  if (err) return <section className="card"><h2>The rest of the month</h2><p className="err-text">{err}</p></section>;
  if (!plan) return <section className="card"><h2>The rest of the month</h2><p className="sub">Working it out…</p></section>;

  return (
    <section className="card">
      <header>
        <div>
          <h2>The rest of the month</h2>
          <p className="sub">
            {plan.period.days_left} day{plan.period.days_left === 1 ? '' : 's'} left · which card to use for what, and
            when to switch
          </p>
        </div>
      </header>

      {plan.headlines.length > 0 && (
        <ul className="outlook-lines">
          {plan.headlines.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      )}

      {plan.categories.map((c) => (
        <div key={c.category} className="addrule">
          <p className="sub">
            <b>{c.category}</b> — expected ${money(c.lower_cents)}–${money(c.upper_cents)} ({c.confidence} confidence)
          </p>
          {c.allocations.length ? (
            <ul className="rules">
              {c.allocations.map((a, i) => (
                <li key={i} className={i === 0 ? 'pass' : 'unknown'}>
                  <span>
                    <strong>{a.card}</strong> — ${money(a.amount_cents)} at {a.rate_text}
                    {a.cap_remaining_cents !== null && (
                      <span className="sub"> · ${money(a.cap_remaining_cents)} of cap left</span>
                    )}
                  </span>
                  <p className="sub">{a.why}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sub">{c.note ?? 'No card pays a bonus on this.'}</p>
          )}
          {c.allocations.length > 0 && c.note && <p className="sub dim">{c.note}</p>}
        </div>
      ))}

      {plan.exhausted.length > 0 && (
        <>
          <h3>Caps already full</h3>
          <ul className="notes">
            {plan.exhausted.map((c, i) => (
              <li key={i}>{c.advice}</li>
            ))}
          </ul>
        </>
      )}

      {plan.unplanned.length > 0 && (
        <p className="sub dim">
          Not planned: {plan.unplanned.map((u) => `${u.category} (${u.reason})`).join('; ')}.
        </p>
      )}

      {plan.caveats.map((c, i) => (
        <p key={i} className="sub dim">
          {c}
        </p>
      ))}
    </section>
  );
}

export default function Planner() {
  return (
    <>
      <Plan />
      <Leakage />
    </>
  );
}
