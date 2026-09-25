import { useEffect, useState } from 'react';
import Pager, { PageSize, usePageSize } from './Pager';
import Repricer from './Repricer';
import Statement from './Statement';
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
  type TxnPage,
  fetchMerchantGroups,
  renameMerchant,
  type MerchantGroup,
  type RenameResult,
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

/**
 * One merchant, spelled a hundred ways.
 *
 * A statement writes "BUS/MRT 3948201" and "BUS/MRT 7712" for the same two
 * journeys. Until they are one name, every merchant total is wrong, no category
 * is ever learned from them, and the code list carries a row per terminal.
 *
 * Nothing is applied on a guess: the match is previewed with every name it
 * would rewrite, and the button only appears once you have seen them.
 */
function TidyMerchants({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<MerchantGroup[] | null>(null);
  const [f, setF] = useState({ match: '', to: '', mode: 'prefix' });
  const [preview, setPreview] = useState<RenameResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || groups) return;
    fetchMerchantGroups()
      .then((d) => setGroups(d.groups))
      .catch((e) => setErr((e as Error).message));
  }, [open, groups]);

  async function look() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      setPreview(await renameMerchant({ match: f.match, to: f.to, mode: f.mode }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setErr(null);
    try {
      const r = await renameMerchant({ match: f.match, to: f.to, mode: f.mode, apply: true });
      setMsg(`${r.updated} row${r.updated === 1 ? '' : 's'} now read "${r.to}".`);
      setPreview(null);
      setGroups(null);
      setF({ ...f, match: '', to: '' });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card entry">
      <div className="section-head">
        <h2>Tidy merchant names</h2>
        <button className="secondary" onClick={() => setOpen((v) => !v)}>
          {open ? 'Close' : 'Open'}
        </button>
      </div>
      {!open && (
        <p className="sub">
          Fold "BUS/MRT 3948201" and "BUS/MRT 7712" into one name, so they group, categorise and carry a code together.
        </p>
      )}

      {open && (
        <>
          {groups === null && !err && <p className="sub">Looking for names that repeat…</p>}
          {groups !== null && groups.length === 0 && <p className="sub">No merchant names look like variants of each other.</p>}
          {groups !== null && groups.length > 0 && (
            <>
              <p className="sub">
                These spellings share an opening and differ only by digits — the shape a terminal id takes. Two genuinely
                different shops could land here, so nothing is changed until you look.
              </p>
              <ul className="notes">
                {groups.map((g) => (
                  <li key={g.prefix}>
                    <strong>{g.prefix}</strong> — {g.variants.length} spellings, {g.txn_count} purchase
                    {g.txn_count === 1 ? '' : 's'}, ${money(g.spend_cents)}
                    <button
                      className="linky"
                      onClick={() => {
                        setF({ match: g.prefix, to: g.prefix, mode: 'prefix' });
                        setPreview(null);
                        setMsg(null);
                      }}
                    >
                      use this
                    </button>
                    <span className="sub"> {g.variants.slice(0, 4).map((v) => v.merchant).join(' · ')}
                      {g.variants.length > 4 ? ` · +${g.variants.length - 4} more` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="entry-grid">
            <label className="f">
              <span>Match</span>
              <input
                value={f.match}
                onChange={(e) => {
                  setF({ ...f, match: e.target.value });
                  setPreview(null);
                }}
                placeholder="BUS/MRT"
              />
            </label>
            <label className="f">
              <span>Where</span>
              <select value={f.mode} onChange={(e) => { setF({ ...f, mode: e.target.value }); setPreview(null); }}>
                <option value="prefix">the name starts with it</option>
                <option value="contains">the name contains it</option>
                <option value="exact">the name is exactly it</option>
              </select>
            </label>
            <label className="f f-note">
              <span>Rename all of them to</span>
              <input value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="BUS/MRT" />
            </label>
          </div>

          <div className="entry-foot">
            <button className="secondary" onClick={look} disabled={busy || !f.match || !f.to}>
              {busy ? 'Checking…' : 'Show me what changes'}
            </button>
            {preview && preview.matched > 0 && (
              <button onClick={apply} disabled={busy}>
                Rename {preview.matched} row{preview.matched === 1 ? '' : 's'}
              </button>
            )}
            {err && <span className="err-text">{err}</span>}
            {msg && <span className="sub">{msg}</span>}
          </div>

          {preview && (
            <div className="counted">
              {preview.matched === 0 ? (
                <p className="sub">Nothing matches "{f.match}".</p>
              ) : (
                <>
                  <p className="sub">
                    {preview.matched} purchase{preview.matched === 1 ? '' : 's'} across {preview.from.length} spelling
                    {preview.from.length === 1 ? '' : 's'} would become <strong>{preview.to}</strong>:
                  </p>
                  <ul className="notes">
                    {preview.from.slice(0, 20).map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                    {preview.from.length > 20 && <li className="sub">…and {preview.from.length - 20} more</li>}
                  </ul>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default function Ledger() {
  const [rows, setRows] = useState<Txn[]>([]);
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [review, setReview] = useState<{ ready: ReviewRow[]; waiting: ReviewRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [limit, setLimit] = usePageSize('ledger', 25);
  const [page, setPage] = useState(1);
  const [range, setRange] = useState('30d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [meta, setMeta] = useState<{
    total_count: number;
    total_cents: number;
    from: string | null;
    to: string | null;
    page: number;
    pages: number;
  } | null>(null);

  // Filters, held apart from the time range because they answer a different
  // question: the range is "when", these are "which".
  const [fCard, setFCard] = useState('');
  const [fCat, setFCat] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fSource, setFSource] = useState('');
  const [fReview, setFReview] = useState(false);
  const [q, setQ] = useState('');
  /** What the search box holds, before it has been applied. */
  const [qDraft, setQDraft] = useState('');
  const [facets, setFacets] = useState<TxnPage['facets'] | null>(null);

  // New-row draft
  const todayIso = new Date().toISOString().slice(0, 10);
  const [nAmount, setNAmount] = useState('');
  const [nCard, setNCard] = useState('');
  const [nDate, setNDate] = useState(todayIso);
  const [nMerchant, setNMerchant] = useState('');
  const [nCat, setNCat] = useState('');

  function load() {
    // A custom range only applies once both ends are set; until then keep the
    // named range so the table never silently empties mid-edit.
    const custom = range === 'custom' && from && to;
    fetchTransactions(limit, {
      ...(custom ? { from, to } : { range }),
      page,
      card: fCard || undefined,
      category: fCat || undefined,
      status: fStatus || undefined,
      source: fSource || undefined,
      review: fReview || undefined,
      q: q || undefined,
    })
      .then((d) => {
        setRows(d.transactions);
        if (d.facets) setFacets(d.facets);
        setMeta({
          total_count: d.total_count,
          total_cents: d.total_cents,
          from: d.range.from,
          to: d.range.to,
          page: d.page,
          pages: d.pages,
        });
        // Narrowing the range while deep in the list would otherwise leave an
        // empty table; the server clamps and the view follows it back.
        if (d.page !== page) setPage(d.page);
      })
      .catch((e) => setErr(e.message));
    fetchReview().then(setReview).catch(() => void 0);
  }

  useEffect(() => {
    fetchSummary()
      .then((s) => {
        // Defaulted, not assumed. A list that arrives missing is a render that
        // throws, and a render that throws is a blank screen rather than a
        // missing dropdown.
        setCards(s.cards ?? []);
        setNCard((c) => c || s.cards?.[0]?.nickname || '');
      })
      .catch(() => void 0);
    fetchCategories().then((d) => setCats(d.categories ?? [])).catch(() => void 0);
  }, []);

  useEffect(load, [limit, page, range, from, to, fCard, fCat, fStatus, fSource, fReview, q]);

  // Narrowing while on page 7 should start at the top of the new, shorter
  // list rather than land on an empty one and have the server bounce it back.
  useEffect(() => {
    setPage(1);
  }, [fCard, fCat, fStatus, fSource, fReview, q]);

  const activeFilters =
    [fCard, fCat, fStatus, fSource, q].filter(Boolean).length + (fReview ? 1 : 0);
  const clearFilters = () => {
    setFCard('');
    setFCat('');
    setFStatus('');
    setFSource('');
    setFReview(false);
    setQ('');
    setQDraft('');
  };
  // A new range or page size renumbers everything, so start from the top.
  useEffect(() => setPage(1), [limit, range, from, to]);

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
      <Statement cards={cards} onImported={load} />

      <TidyMerchants onDone={load} />
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

        <Repricer cards={cards.map((c) => c.nickname)} onDone={load} />

        <div className="seg wrap" role="group" aria-label="Time frame">
          {[
            ['today', 'Today'],
            ['yesterday', 'Yesterday'],
            ['7d', 'Last 7 days'],
            ['30d', 'Last 30 days'],
            ['month', 'This month'],
            ['lastmonth', 'Last month'],
            ['ytd', 'Year to date'],
            ['all', 'All'],
            ['custom', 'Custom'],
          ].map(([k, label]) => (
            <button key={k} type="button" className={range === k ? 'on' : ''} onClick={() => setRange(k)}>
              {label}
            </button>
          ))}
        </div>

        {/*
          Which, as opposed to when. Kept as one row of selects rather than a
          panel behind a button: a filter you cannot see is a filter you forget
          is on, and "where did my transactions go" is the bug that follows.
        */}
        <div className="filter-row">
          <label className="f">
            <span>Card</span>
            <select value={fCard} onChange={(e) => setFCard(e.target.value)}>
              <option value="">Any card</option>
              {cards.map((c) => (
                <option key={c.id} value={c.nickname}>
                  {c.nickname} — {c.product}
                </option>
              ))}
            </select>
          </label>

          <label className="f">
            <span>Category</span>
            <select value={fCat} onChange={(e) => setFCat(e.target.value)}>
              <option value="">Any category</option>
              <option value="none">Uncategorised</option>
              {(facets?.categories ?? [])
                .filter((c) => c.value !== 'none')
                .map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.value} ({c.count})
                  </option>
                ))}
              {/* Categories with nothing filed under them yet, so a filter can
                  be set before the first transaction arrives in one. */}
              {cats
                .filter((c) => !(facets?.categories ?? []).some((f) => f.value === c))
                .map((c) => (
                  <option key={c} value={c}>
                    {c} (0)
                  </option>
                ))}
            </select>
          </label>

          <label className="f">
            <span>Status</span>
            <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
              <option value="">Any status</option>
              {(facets?.statuses ?? []).map((s) => (
                <option key={s.value} value={s.value}>
                  {s.value} ({s.count})
                </option>
              ))}
            </select>
          </label>

          <label className="f">
            <span>Came from</span>
            <select value={fSource} onChange={(e) => setFSource(e.target.value)}>
              <option value="">Anywhere</option>
              {(facets?.sources ?? []).map((s) => (
                <option key={s.value} value={s.value}>
                  {s.value} ({s.count})
                </option>
              ))}
            </select>
          </label>

          <label className="f f-note">
            <span>Merchant</span>
            <input
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && setQ(qDraft.trim())}
              onBlur={() => setQ(qDraft.trim())}
              placeholder="part of a name"
            />
          </label>
        </div>

        <div className="filter-foot">
          <button
            type="button"
            className={`chip ${fReview ? 'on' : ''}`}
            aria-pressed={fReview}
            onClick={() => setFReview((v) => !v)}
          >
            Needs attention
          </button>
          {activeFilters > 0 && (
            <button type="button" className="chip" onClick={clearFilters}>
              Clear {activeFilters} filter{activeFilters === 1 ? '' : 's'}
            </button>
          )}
        </div>

        {range === 'custom' && (
          <div className="entry-grid" style={{ marginTop: 10 }}>
            <label className="f">
              <span>From</span>
              <input id="r-from" type="date" value={from} max={to || todayIso} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="f">
              <span>To</span>
              <input id="r-to" type="date" value={to} min={from} max={todayIso} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
        )}

        {meta && (
          <p className="sub range-summary">
            {meta.from ? (
              <>
                {meta.from} → {meta.to}
              </>
            ) : (
              'Everything'
            )}
            {' · '}
            <b>{meta.total_count.toLocaleString()}</b> transaction{meta.total_count === 1 ? '' : 's'}
            {activeFilters > 0 && <> matching your filters</>}
            {' · '}
            <b>${money(meta.total_cents)}</b>
            {meta.pages > 1 && (
              <>
                {' '}
                · page <b>{meta.page}</b> of {meta.pages}
              </>
            )}
          </p>
        )}

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
        {!rows.length && (
          <p className="sub">
            {range === 'custom' && (!from || !to) ? 'Pick both ends of the range.' : 'Nothing in this period.'}
          </p>
        )}
        <div className="list-foot">
          <PageSize per={limit} onChange={setLimit} label="Rows per page" />
          {meta && meta.pages > 1 && <Pager page={meta.page} pages={meta.pages} onGo={setPage} />}
        </div>
        <p className="sub" style={{ marginTop: 10 }}>
          A dotted category was inferred from the merchant. A highlighted row has none at all.
        </p>
      </section>
    </>
  );
}
