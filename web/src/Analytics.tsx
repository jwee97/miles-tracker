import { useEffect, useState } from 'react';
import { fetchAnalytics, fetchMonths, type Analytics as A } from './api';
import { CumulativeLine, DailyBars, RankedBars, WeekdayBars, money, short, slotMap } from './charts';

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone ?? ''}`}>{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

export default function Analytics() {
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState<string>('');
  const [a, setA] = useState<A | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchMonths()
      .then((d) => {
        setMonths(d.months);
        setMonth((m) => m || d.months[0] || new Date().toISOString().slice(0, 7));
      })
      .catch(() => setMonth(new Date().toISOString().slice(0, 7)));
  }, []);

  useEffect(() => {
    if (!month) return;
    fetchAnalytics(month).then(setA).catch((e) => setErr(e.message));
  }, [month]);

  if (err) return <p className="pad error">{err}</p>;
  if (!a) return <p className="pad sub">Loading…</p>;

  const { totals: t } = a;
  const delta = t.spend_cents - t.prev_spend_cents;
  const pct = t.prev_spend_cents > 0 ? Math.round((delta / t.prev_spend_cents) * 100) : null;
  const pace = a.day_of_month ? Math.round((t.spend_cents / a.day_of_month) * a.days_in_month) : null;

  const catColors = slotMap(a.by_category.map((c) => c.key));
  const cardColors = slotMap(a.by_card.map((c) => c.key));
  const lostTotal = a.missed.reduce((s, m) => s + m.lost_value_cents, 0);

  if (t.txn_count === 0) {
    return (
      <>
        <MonthPicker months={months} month={month} setMonth={setMonth} />
        <section className="card">
          <p className="sub">
            No spend recorded in {month}. Log some on the Cards tab, or send <code>25.40 &lt;card&gt; lunch</code> to the bot.
          </p>
        </section>
      </>
    );
  }

  return (
    <>
      <MonthPicker months={months} month={month} setMonth={setMonth} />

      {/* The headline is a number, not a chart. */}
      <section className="card hero">
        <span className="stat-label">Spent in {month}</span>
        <span className="hero-value">${money(t.spend_cents)}</span>
        <div className="hero-delta">
          {pct !== null ? (
            <span className={delta >= 0 ? 'up' : 'down'}>
              {delta >= 0 ? '▲' : '▼'} ${money(Math.abs(delta))} ({Math.abs(pct)}%) vs {a.prev_month}
            </span>
          ) : (
            <span className="sub">No {a.prev_month} spend to compare</span>
          )}
          {pace !== null && <span className="sub">· on pace for ${money(pace)}</span>}
        </div>
      </section>

      <div className="stat-row">
        <Stat label="Transactions" value={String(t.txn_count)} sub={`${t.active_days} active days`} />
        <Stat label="Average" value={`$${money(t.avg_txn_cents)}`} sub="per transaction" />
        <Stat label="Largest" value={`$${money(t.largest_cents)}`} sub="single purchase" />
        <Stat
          label="Rewards"
          value={a.rewards.value_cents > 0 ? `$${money(a.rewards.value_cents)}` : '—'}
          sub={
            a.rewards.miles > 0
              ? `${a.rewards.miles.toLocaleString()} miles${a.rewards.cashback_cents ? ` + $${money(a.rewards.cashback_cents)}` : ''}`
              : a.rewards.cashback_cents > 0
                ? 'cashback'
                : 'add earn rules'
          }
          tone="ok"
        />
      </div>

      {a.insights.length > 0 && (
        <section className="card insights">
          <h2>What happened</h2>
          <ul>
            {a.insights.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <header>
          <div>
            <h2>Running total</h2>
            <p className="sub">Against the same point last month</p>
          </div>
        </header>
        <CumulativeLine data={a.cumulative} month={a.month} prevMonth={a.prev_month} />
      </section>

      <section className="card">
        <header>
          <div>
            <h2>Day by day</h2>
            <p className="sub">Every day of {a.month}</p>
          </div>
        </header>
        <DailyBars data={a.daily} />
      </section>

      <section className="card">
        <header>
          <div>
            <h2>Where it went</h2>
            <p className="sub">By category</p>
          </div>
        </header>
        <RankedBars rows={a.by_category} colors={catColors} total={t.spend_cents} />
      </section>

      <section className="card">
        <header>
          <div>
            <h2>Which card</h2>
            <p className="sub">By card used</p>
          </div>
        </header>
        <RankedBars rows={a.by_card} colors={cardColors} total={t.spend_cents} />
      </section>

      <section className="card">
        <header>
          <div>
            <h2>Weekly rhythm</h2>
            <p className="sub">Which days you spend on</p>
          </div>
        </header>
        <WeekdayBars rows={a.by_weekday} />
      </section>

      {a.top_merchants.length > 0 && (
        <section className="card">
          <header>
            <div>
              <h2>Top merchants</h2>
              <p className="sub">Where the money actually goes</p>
            </div>
          </header>
          <div className="scroller">
            <table className="pts">
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Category</th>
                  <th className="num">Visits</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {a.top_merchants.map((m) => (
                  <tr key={m.merchant}>
                    <td>{m.merchant}</td>
                    <td className="dim-num">{m.category ?? '—'}</td>
                    <td className="num dim-num">{m.count}</td>
                    <td className="num strong">${money(m.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* The distinctive one: spend that would have earned more elsewhere. */}
      {a.missed.length > 0 && (
        <section className="card missed">
          <header>
            <div>
              <h2>Left on the table</h2>
              <p className="sub">Spend that a card you already hold would have rewarded better</p>
            </div>
            <div className="pct bad">${money(lostTotal)}</div>
          </header>
          <ul className="ranked">
            {a.missed.slice(0, 6).map((m, i) => (
              <li key={i}>
                <div className="ranked-head">
                  <span className="ranked-label">{m.category}</span>
                  <span className="mono ranked-val">${money(m.lost_value_cents)}</span>
                </div>
                <span className="ranked-sub">
                  ${money(m.cents)} on {m.used_label} ({m.used_type === 'cashback' ? `${m.used_rate}%` : `${m.used_rate} mpd`})
                  {' → '}
                  {m.best_label} would give {m.best_type === 'cashback' ? `${m.best_rate}%` : `${m.best_rate} mpd`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {a.rewards.by_card.length > 0 && (
        <section className="card">
          <header>
            <div>
              <h2>Rewards earned</h2>
              <p className="sub">Estimated — caps applied to monthly totals</p>
            </div>
            <div className="pct-block">
              <span className="pct ok">{a.rewards.per_dollar_cents.toFixed(1)}¢</span>
              <span className="pct-sub">per dollar</span>
            </div>
          </header>
          <ul className="ranked">
            {a.rewards.by_card.map((r) => (
              <li key={r.label}>
                <div className="ranked-head">
                  <span className="ranked-label">{r.label}</span>
                  <span className="mono ranked-val">${money(r.value_cents)}</span>
                </div>
                <span className="ranked-sub">
                  {r.miles > 0 && `${r.miles.toLocaleString()} miles`}
                  {r.miles > 0 && r.cashback_cents > 0 && ' · '}
                  {r.cashback_cents > 0 && `$${money(r.cashback_cents)} cashback`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Accessibility: every chart's numbers are readable as a table. */}
      <section className="card">
        <button type="button" className="link-btn" onClick={() => setShowTable((s) => !s)}>
          {showTable ? 'Hide' : 'Show'} the numbers
        </button>
        {showTable && (
          <div className="scroller" style={{ marginTop: 12 }}>
            <table className="pts">
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="num">Spent</th>
                  <th className="num">Running</th>
                  <th className="num">{a.prev_month} running</th>
                </tr>
              </thead>
              <tbody>
                {a.daily.map((d, i) => (
                  <tr key={d.date}>
                    <td className="dim-num">{d.date}</td>
                    <td className="num">{d.cents ? `$${money(d.cents)}` : '—'}</td>
                    <td className="num strong">{short(a.cumulative[i].cents)}</td>
                    <td className="num dim-num">
                      {a.cumulative[i].prev_cents !== null ? short(a.cumulative[i].prev_cents!) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function MonthPicker({
  months,
  month,
  setMonth,
}: {
  months: string[];
  month: string;
  setMonth: (m: string) => void;
}) {
  return (
    <div className="month-row">
      <label className="f">
        <span>Month</span>
        <select id="month" value={month} onChange={(e) => setMonth(e.target.value)}>
          {(months.length ? months : [month]).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
