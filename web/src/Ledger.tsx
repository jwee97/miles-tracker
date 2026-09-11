import { useEffect, useState } from 'react';
import {
  addTransaction,
  deleteTransaction,
  fetchCategories,
  fetchReview,
  fetchSummary,
  fetchTransactions,
  money,
  updateTransaction,
  type CardSummary,
  type ReviewRow,
  type Txn,
} from './api';

type Field = 'occurred_at' | 'posted_at' | 'amount' | 'merchant' | 'category' | 'card_id';

/** One cell: click to edit, Enter or blur to save, Escape to abandon. */
function Cell({
  value,
  display,
  type,
  options,
  onSave,
  className,
}: {
  value: string;
  display?: string;
  type?: 'text' | 'date' | 'number';
  options?: { value: string; label: string }[];
  onSave: (v: string) => Promise<void>;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);

  async function commit(v: string) {
    setEditing(false);
    if (v === value) return;
    setBusy(true);
    try {
      await onSave(v);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <td className={className}>
        <button
          type="button"
          className={`cell ${busy ? 'saving' : ''} ${!display && !value ? 'empty' : ''}`}
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
        >
          {display ?? value ?? ''}
          {!display && !value && <span className="cell-hint">+</span>}
        </button>
      </td>
    );
  }

  if (options) {
    return (
      <td className={className}>
        <select
          className="cell-input"
          autoFocus
          value={draft}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => setEditing(false)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </td>
    );
  }

  return (
    <td className={className}>
      <input
        className="cell-input"
        autoFocus
        type={type ?? 'text'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(draft);
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    </td>
  );
}

export default function Ledger() {
  const [rows, setRows] = useState<Txn[]>([]);
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [review, setReview] = useState<{ ready: ReviewRow[]; waiting: ReviewRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [limit, setLimit] = useState(50);

  // New-row draft
  const todayIso = new Date().toISOString().slice(0, 10);
  const [nAmount, setNAmount] = useState('');
  const [nCard, setNCard] = useState('');
  const [nDate, setNDate] = useState(todayIso);
  const [nMerchant, setNMerchant] = useState('');
  const [nCat, setNCat] = useState('');

  function load() {
    fetchTransactions(limit).then((d) => setRows(d.transactions)).catch((e) => setErr(e.message));
    fetchReview().then(setReview).catch(() => void 0);
  }

  useEffect(() => {
    fetchSummary()
      .then((s) => {
        setCards(s.cards);
        setNCard((c) => c || s.cards[0]?.nickname || '');
      })
      .catch(() => void 0);
    fetchCategories().then((d) => setCats(d.categories)).catch(() => void 0);
  }, []);

  useEffect(load, [limit]);

  async function save(id: number, field: Field, value: string) {
    try {
      await updateTransaction(id, field, value === '' ? null : value);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function addRow(e: React.FormEvent) {
    e.preventDefault();
    if (!nAmount || !nCard) return;
    try {
      await addTransaction({ nickname: nCard, amount: nAmount, date: nDate, note: nMerchant, category: nCat });
      setNAmount('');
      setNMerchant('');
      setNCat('');
      setErr(null);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const cardOptions = cards.map((c) => ({ value: String(c.id), label: c.product }));
  const catOptions = [{ value: '', label: '— unknown —' }, ...cats.map((c) => ({ value: c, label: c }))];
  const needsReview = (review?.ready.length ?? 0) + (review?.waiting.length ?? 0);

  return (
    <>
      {err && <p className="pad error">{err}</p>}

      {needsReview > 0 && (
        <section className="card review-card">
          <header>
            <div>
              <h2>{needsReview} without a category</h2>
              <p className="sub">Uncategorised spend earns no cap credit and is left out of the wrong-card analysis</p>
            </div>
          </header>
          {review!.ready.length > 0 && (
            <p className="sub">
              <b className="ok-text">{review!.ready.length} ready</b> — these have posted, so your bank can tell you the
              merchant category. Set them below.
            </p>
          )}
          {review!.waiting.length > 0 && (
            <p className="sub">
              <b>{review!.waiting.length} waiting to post</b> — the category isn't reliably knowable until a purchase
              posts, so leave these until then.
            </p>
          )}
        </section>
      )}

      <form className="card entry" onSubmit={addRow}>
        <h2>New transaction</h2>
        <div className="entry-grid">
          <label className="f">
            <span>Amount</span>
            <input id="n-amt" value={nAmount} onChange={(e) => setNAmount(e.target.value)} inputMode="decimal" placeholder="25.40" required />
          </label>
          <label className="f">
            <span>Card</span>
            <select id="n-card" value={nCard} onChange={(e) => setNCard(e.target.value)}>
              {cards.map((c) => (
                <option key={c.id} value={c.nickname}>{c.product}</option>
              ))}
            </select>
          </label>
          <label className="f">
            <span>Date</span>
            <input id="n-date" type="date" value={nDate} max={todayIso} onChange={(e) => setNDate(e.target.value)} />
          </label>
          <label className="f">
            <span>Category</span>
            <select id="n-cat" value={nCat} onChange={(e) => setNCat(e.target.value)}>
              <option value="">auto / unknown</option>
              {cats.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="f f-note">
            <span>Merchant</span>
            <input id="n-merch" value={nMerchant} onChange={(e) => setNMerchant(e.target.value)} placeholder="NTUC" />
          </label>
        </div>
        <div className="entry-foot">
          <button type="submit">Add row</button>
        </div>
      </form>

      <section className="card">
        <header>
          <div>
            <h2>All transactions</h2>
            <p className="sub">Click any cell to edit it</p>
          </div>
        </header>
        <div className="scroller">
          <table className="pts sheet">
            <thead>
              <tr>
                <th>Date</th>
                <th>Posted</th>
                <th>Card</th>
                <th>Merchant</th>
                <th>Category</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className={t.category ? '' : 'row-review'}>
                  <Cell value={t.occurred_at} type="date" onSave={(v) => save(t.id, 'occurred_at', v)} />
                  <Cell
                    value={t.posted_at ?? ''}
                    display={t.posted_at ?? undefined}
                    type="date"
                    className="dim-num"
                    onSave={(v) => save(t.id, 'posted_at', v)}
                  />
                  <Cell
                    value={String(t.card_id ?? '')}
                    display={t.nickname}
                    options={cardOptions}
                    onSave={(v) => save(t.id, 'card_id', v)}
                  />
                  <Cell value={t.merchant ?? ''} onSave={(v) => save(t.id, 'merchant', v)} />
                  <Cell
                    value={t.category ?? ''}
                    display={t.category ?? undefined}
                    options={catOptions}
                    className={t.category_source === 'learned' ? 'learned-cell' : ''}
                    onSave={(v) => save(t.id, 'category', v)}
                  />
                  <Cell
                    value={(t.amount_cents / 100).toFixed(2)}
                    display={`$${money(t.amount_cents)}`}
                    className="num strong"
                    onSave={(v) => save(t.id, 'amount', v)}
                  />
                  <td>
                    <button
                      type="button"
                      className="t-del"
                      onClick={async () => {
                        await deleteTransaction(t.id);
                        load();
                      }}
                      aria-label={`Delete transaction ${t.id}`}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && <p className="sub">Nothing logged yet.</p>}
        {rows.length >= limit && (
          <div className="entry-foot">
            <button type="button" onClick={() => setLimit((l) => l + 50)}>
              Load 50 more
            </button>
          </div>
        )}
        <p className="sub" style={{ marginTop: 10 }}>
          A dotted category was inferred from the merchant. A highlighted row has none at all.
        </p>
      </section>
    </>
  );
}
