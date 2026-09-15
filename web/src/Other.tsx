import { useEffect, useState } from 'react';
import { RankedBars, SERIES, slotMap } from './charts';
import {
  addOther,
  deleteOther,
  fetchOther,
  money,
  updateOther,
  type OtherSummary,
} from './api';

/**
 * Spending that never touched a credit card.
 *
 * The point is not bookkeeping. This app exists to earn miles, and PayLah,
 * PayNow and cash earn none — so the number worth showing is what that spending
 * would have earned on the right card, and the share of the month it accounts
 * for. Two things keep that honest: only spend a card could actually have taken
 * is counted, and anything with no category is named rather than quietly
 * excluded, because an uncosted row is not a zero.
 */
export default function Other() {
  const [data, setData] = useState<OtherSummary | null>(null);
  const [month, setMonth] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({
    amount: '',
    date: today,
    method: 'paylah',
    merchant: '',
    category: '',
    note: '',
    card_possible: true,
  });

  function load(m = month) {
    fetchOther(m || undefined)
      .then((d) => {
        setData(d);
        if (!month) setMonth(d.month);
      })
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(() => load(), [month]);

  async function save() {
    setErr(null);
    setMsg(null);
    try {
      const r = await addOther({
        amount: f.amount,
        date: f.date,
        method: f.method,
        merchant: f.merchant || undefined,
        category: f.category || undefined,
        card_possible: f.card_possible,
        note: f.note || undefined,
      });
      setMsg(
        `Added $${money(Math.round(parseFloat(f.amount) * 100))}` +
          (r.category ? ` as ${r.category}` : ' with no category — it cannot be costed until it has one')
      );
      setF({ ...f, amount: '', merchant: '', note: '' });
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (err && !data) return <p className="pad error">{err}</p>;
  if (!data) return <p className="pad sub">Loading…</p>;

  const methodColors = slotMap(data.by_method.map((m) => m.method));
  const catColors = slotMap(data.by_category.map((c) => c.category));
  const rows = showAll ? data.rows : data.rows.slice(0, 12);
  const methodOf = (key: string) => data.methods.find((m) => m.key === key);

  return (
    <>
      <section className="card hero">
        <span className="stat-label">Off-card spending · {data.month}</span>
        <span className="hero-value">${money(data.total_cents)}</span>
        <span className="sub">
          {data.share_percent.toFixed(0)}% of everything you spent this month · ${money(data.card_spend_cents)} went on
          cards
        </span>
      </section>

      {data.missed_value_cents > 0 && (
        <section className="card">
          <header>
            <div>
              <h2>What it cost you</h2>
              <p className="sub">
                ${money(data.avoidable_cents)} of it could have gone on a card. At your best rate for each category
                that is about <strong>${money(data.missed_value_cents)}</strong>
                {data.missed_miles > 0 ? ` (${data.missed_miles.toLocaleString()} miles)` : ''} left on the table.
              </p>
            </div>
          </header>
          <ul className="rules">
            {data.missed.map((m) => (
              <li key={m.category} className={m.value_cents > 500 ? 'fail' : 'unknown'}>
                <span>
                  <strong>{m.category}</strong> — ${money(m.spend_cents)}
                  {m.card ? (
                    <>
                      {' '}
                      on <strong>{m.card}</strong> would have paid{' '}
                      {m.miles > 0 ? `${m.miles.toLocaleString()} miles` : `$${money(m.cashback_cents)}`}
                    </>
                  ) : (
                    ' — no card of yours earns on this category'
                  )}
                </span>
              </li>
            ))}
          </ul>
          {data.uncategorised_cents > 0 && (
            <p className="cap">
              ${money(data.uncategorised_cents)} has no category, so it is not in that figure. Give those rows one below
              and the number will grow.
            </p>
          )}
        </section>
      )}

      <section className="card entry">
        <div className="section-head" style={{ margin: 0 }}>
          <h2>Add spending</h2>
          <select className="range-select" value={month} onChange={(e) => setMonth(e.target.value)}>
            {data.months.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="entry-grid">
          <label className="f">
            <span>Amount</span>
            <input
              value={f.amount}
              onChange={(e) => setF({ ...f, amount: e.target.value })}
              placeholder="12.80"
              inputMode="decimal"
            />
          </label>
          <label className="f">
            <span>Paid by</span>
            <select
              value={f.method}
              onChange={(e) =>
                setF({ ...f, method: e.target.value, card_possible: !!methodOf(e.target.value)?.card_possible })
              }
            >
              {data.methods.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="f">
            <span>Date</span>
            <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} max={today} />
          </label>
          <label className="f">
            <span>Category</span>
            <input
              value={f.category}
              onChange={(e) => setF({ ...f, category: e.target.value })}
              placeholder="dining — blank learns from the merchant"
            />
          </label>
          <label className="f f-note">
            <span>Merchant</span>
            <input value={f.merchant} onChange={(e) => setF({ ...f, merchant: e.target.value })} placeholder="Maxwell hawker" />
          </label>
          <label className="f f-note">
            <span>Note</span>
            <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="optional" />
          </label>
        </div>
        <div className="entry-foot">
          <label className="tick">
            <input
              type="checkbox"
              checked={f.card_possible}
              onChange={(e) => setF({ ...f, card_possible: e.target.checked })}
            />
            <span>a card was an option here</span>
          </label>
        </div>
        <div className="entry-foot">
          <button onClick={save} disabled={!f.amount}>
            Add
          </button>
          {msg && <span className="sub">{msg}</span>}
          {err && <span className="err-text">{err}</span>}
        </div>
        <p className="sub">
          Untick when a card could never have been used — a hawker with no terminal, a transfer to a person. Those stay
          in the total but out of what it cost you. If you top up PayLah with a card, that top-up is already card spend:
          record what you buy here, not the top-up, or you will count it twice.
        </p>
      </section>

      <section className="card">
        <header>
          <div>
            <h2>By method</h2>
          </div>
        </header>
        <RankedBars
          rows={data.by_method.map((m) => ({ key: m.method, label: m.label, cents: m.spend_cents, count: m.count }))}
          colors={methodColors}
          total={data.total_cents}
        />
      </section>

      <section className="card">
        <header>
          <div>
            <h2>By category</h2>
          </div>
        </header>
        <RankedBars
          rows={data.by_category.map((c) => ({ key: c.category, label: c.category, cents: c.spend_cents, count: c.count }))}
          colors={catColors}
          total={data.total_cents}
        />
      </section>

      <section className="card">
        <header>
          <div>
            <h2>Everything in {data.month}</h2>
            <p className="sub">Click a cell to change it</p>
          </div>
        </header>
        {rows.length ? (
          <ul className="txns other">
            {rows.map((r) => (
              <li key={r.id} className={r.card_possible ? '' : 'no-card'}>
                <span className="t-date">{r.occurred_at.slice(5)}</span>
                <span className="t-card">{methodOf(r.method)?.label ?? r.method}</span>
                <input
                  className="t-posted-input"
                  defaultValue={r.merchant ?? ''}
                  placeholder="merchant"
                  onBlur={(e) => e.target.value !== (r.merchant ?? '') && updateOther(r.id, 'merchant', e.target.value).then(() => load())}
                />
                <input
                  className="t-posted-input"
                  defaultValue={r.category ?? ''}
                  placeholder="category"
                  onBlur={(e) => e.target.value !== (r.category ?? '') && updateOther(r.id, 'category', e.target.value).then(() => load())}
                />
                <span className="t-amt">${money(r.amount_cents)}</span>
                <button
                  type="button"
                  className="t-del"
                  aria-label="Delete"
                  onClick={() => deleteOther(r.id).then(() => load())}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sub">Nothing recorded for {data.month}.</p>
        )}
        {data.rows.length > 12 && (
          <div className="entry-foot">
            <button className="secondary" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show all ${data.rows.length}`}
            </button>
          </div>
        )}
        <p className="sub">A dimmed row is one where a card was never an option.</p>
      </section>
    </>
  );
}
