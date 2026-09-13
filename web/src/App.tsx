import { useEffect, useState } from 'react';
import Advisor from './Advisor';
import Audit from './Audit';
import Analytics from './Analytics';
import Ledger from './Ledger';
import ExpiryTab from './Expiry';
import Settings from './Settings';
import {
  addProgram,
  addTranche,
  addTransaction,
  deleteTranche,
  fetchCategories,
  fetchConvert,
  fetchPoints,
  fetchWhich,
  bootstrapToken,
  deleteTransaction,
  fetchFeed,
  fetchOffers,
  fetchSummary,
  feedAction,
  runScan,
  fetchTransactions,
  markPosted,
  money,
  type CardSummary,
  type FeedItemRow,
  type OfferRow,
  type ScanSummary,
  type Progress,
  type Summary,
  type Txn,
  type BalanceRow,
  type Pick,
  type Plan,
  type ProgramRow,
  type Tranche,
} from './api';

const tone = (pct: number) => (pct >= 90 ? 'bad' : pct >= 80 ? 'warn' : pct >= 50 ? 'mid' : 'ok');

function Meter({ percent, tone: t }: { percent: number; tone: string }) {
  return (
    <div className="meter" role="img" aria-label={`${percent.toFixed(0)} percent`}>
      <span className={`fill ${t}`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

function RequirementRow({ p }: { p: Progress }) {
  const label = p.kind === 'signup_min' ? 'Sign-up minimum' : 'Monthly minimum';
  const pct = (p.spent_cents / p.amount_cents) * 100;
  const urgent = !p.met && p.days_left <= 7;

  return (
    <div className={`req ${p.met ? 'done' : urgent ? 'urgent' : ''}`}>
      <div className="req-head">
        <span>{label}</span>
        <span className="mono">
          ${money(p.spent_cents)} / ${money(p.amount_cents)}
          {p.txns_required > 0 && ` · ${p.txn_count}/${p.txns_required} txns`}
        </span>
      </div>
      <Meter percent={pct} tone={p.met ? 'ok' : urgent ? 'warn' : 'mid'} />
      <div className="req-foot">
        {p.met && p.met_only_with_at_risk ? (
          <span className="risk-text">
            Met only if ${money(p.at_risk_cents)} posts in time · ${money(p.confirmed_cents)} confirmed
          </span>
        ) : p.met ? (
          <span className="ok-text">Met</span>
        ) : (
          <span>
            {p.remaining_cents > 0 && <>${money(p.remaining_cents)} to go</>}
            {p.remaining_cents > 0 && p.txns_remaining > 0 && <> and </>}
            {p.txns_remaining > 0 && <>{p.txns_remaining} more txn{p.txns_remaining > 1 ? 's' : ''}</>}
            {' · '}{p.days_left}d
            {p.remaining_cents > 0 && p.days_left > 0 && <> · ~${money(p.per_day_cents)}/day</>}
          </span>
        )}
        {p.reward_note && <span className="note">{p.reward_note}</span>}
      </div>
      {/* The mirror of a minimum: past the cap the elevated rate is gone. */}
      {p.cap_reached && <div className="cap">Bonus cap reached — further spend earns the base rate.</div>}
      {!p.met && p.at_risk_cents > 0 && (
        <div className="risk">⏳ ${money(p.at_risk_cents)} of this may post after {p.window.end}.</div>
      )}
    </div>
  );
}

function Card({ c }: { c: CardSummary }) {
  return (
    <section className="card">
      <header>
        <div>
          <h2>{c.product}</h2>
          <p className="sub">
            {c.issuer} · {c.nickname}
          </p>
        </div>
        <div className={`pct ${tone(c.percent)}`}>{c.percent.toFixed(0)}%</div>
      </header>
      <Meter percent={c.percent} tone={tone(c.percent)} />
      <p className="sub mono">
        ${money(c.balance_cents)} / ${money(c.limit_cents)} · closes {c.cycle.end} ({c.days_left}d)
      </p>
      {c.at_risk_cents > 0 && (
        <p className="risk">⏳ ${money(c.at_risk_cents)} may post after this cycle closes</p>
      )}
      {c.requirements.map((r) => (
        <RequirementRow key={r.id} p={r} />
      ))}
    </section>
  );
}

/**
 * The scan the cron runs twice a day, on a button. Matches land here as well as
 * in Telegram, so an offer can be judged and tracked without leaving the app.
 */
function Scanner({ onTracked }: { onTracked: () => void }) {
  const [items, setItems] = useState<FeedItemRow[] | null>(null);
  const [stats, setStats] = useState<ScanSummary | null>(null);
  const [busy, setBusy] = useState<'' | 'deep' | 'quick' | 'url'>('');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);

  function load() {
    fetchFeed('new')
      .then((d) => setItems(d.items))
      .catch((e) => setErr(e.message));
  }
  useEffect(load, []);

  async function scan(mode: 'deep' | 'quick' | 'url') {
    setBusy(mode);
    setErr(null);
    try {
      const res = await runScan(mode === 'url' ? { url } : { deep: mode === 'deep' });
      setStats(res);
      if (mode === 'url') setUrl('');
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function act(id: number, action: 'track' | 'ignore') {
    await feedAction(id, action);
    setItems((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
    if (action === 'track') onTracked();
  }

  return (
    <section className="card entry">
      <h2>Scan for offers</h2>
      <p className="sub">
        Runs automatically at 06:00 and 14:00. A deep scan opens each article to read past the headline; a quick scan
        only reads feed summaries.
      </p>
      <div className="entry-foot">
        <button onClick={() => scan('deep')} disabled={!!busy}>
          {busy === 'deep' ? 'Scanning…' : 'Scan now'}
        </button>
        <button onClick={() => scan('quick')} disabled={!!busy}>
          {busy === 'quick' ? 'Scanning…' : 'Quick scan'}
        </button>
      </div>
      <div className="entry-grid" style={{ marginTop: 12 }}>
        <label className="f f-note">
          <span>Or read one page</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://milelion.com/2026/…"
            inputMode="url"
          />
        </label>
      </div>
      <div className="entry-foot">
        <button onClick={() => scan('url')} disabled={!!busy || !/^https?:\/\//i.test(url)}>
          {busy === 'url' ? 'Reading…' : 'Read page'}
        </button>
        {stats && (
          <span className="sub">
            {stats.feeds_read} source{stats.feeds_read === 1 ? '' : 's'} · {stats.items_seen} new · {stats.pages_fetched}{' '}
            opened · {stats.fresh.length} match{stats.fresh.length === 1 ? '' : 'es'}
            {stats.feeds_failed.length ? ` · unreachable: ${stats.feeds_failed.join(', ')}` : ''}
          </span>
        )}
        {err && <span className="err-text">{err}</span>}
      </div>

      {items && items.length > 0 && (
        <ul className="rules">
          {items.map((i) => (
            <li key={i.id} className={i.topic === 'promo' ? 'pass' : 'unknown'}>
              <a className="strong" href={i.link} target="_blank" rel="noreferrer">
                {i.title || i.link}
              </a>
              <p className="sub">
                {i.feed}
                {i.deep ? ' · article read' : ' · headline only'}
                {i.terms ? ` · ${i.terms}` : ''}
              </p>
              {i.excerpt && <blockquote>{i.excerpt}</blockquote>}
              {i.apply_url && i.apply_url !== i.link && (
                <a className="link" href={i.apply_url} target="_blank" rel="noreferrer">
                  Offer page
                </a>
              )}
              <div className="entry-foot">
                <button onClick={() => act(i.id, 'track')}>Track</button>
                <button onClick={() => act(i.id, 'ignore')}>Ignore</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {items && !items.length && <p className="sub">Nothing waiting. New matches appear here and in Telegram.</p>}
    </section>
  );
}

function Offer({ o }: { o: OfferRow }) {
  const v = o.eligibility.verdict;
  const label = v === 'eligible' ? 'Eligible' : v === 'not_eligible' ? 'Not eligible' : 'Needs review';
  return (
    <section className="card">
      <header>
        <div>
          <h2>{o.product ?? o.source_title ?? 'Untitled offer'}</h2>
          <p className="sub">{o.issuer}</p>
        </div>
        <div className={`badge ${v}`}>{label}</div>
      </header>
      <p className="sub">
        {o.bonus_miles ? `${o.bonus_miles.toLocaleString()} miles` : 'Bonus not extracted'}
        {o.min_spend_cents ? ` for $${money(o.min_spend_cents)} in ${o.spend_window_days ?? '?'}d` : ''}
        {o.valid_until ? ` · expires ${o.valid_until}` : ''}
      </p>
      <ul className="rules">
        {o.eligibility.rules.map((r, i) => (
          <li key={i} className={r.verdict}>
            <span>{r.reason}</span>
            {/* Every verdict stays traceable to the sentence it came from. */}
            {r.quote && <blockquote>{r.quote}</blockquote>}
          </li>
        ))}
        {!o.eligibility.rules.length && <li className="unknown">No rules extracted yet — run /extract in the bot.</li>}
      </ul>
      {o.source_url && (
        <a className="link" href={o.source_url} target="_blank" rel="noreferrer">
          Source
        </a>
      )}
    </section>
  );
}

function AddSpend({
  cards,
  categories,
  onSaved,
}: {
  cards: CardSummary[];
  categories: string[];
  onSaved: () => void;
}) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const [nickname, setNickname] = useState(cards[0]?.nickname ?? '');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso);
  const [posted, setPosted] = useState('');
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const backdated = date !== todayIso;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await addTransaction({ nickname, amount, date, note, posted, category });
      // Keep the card and date, clear the entry — several receipts from the
      // same day is the common case.
      setAmount('');
      setNote('');
      setPosted('');
      setMsg({
        kind: 'ok',
        text:
          `Added $${amount} to ${r.card}` +
          (r.posted_at ? `, posted ${r.posted_at}` : '') +
          (r.category ? ` · ${r.category}` : ''),
      });
      onSaved();
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!cards.length) return null;

  return (
    <form className="card entry" onSubmit={submit}>
      <h2>Log spend</h2>
      <div className="entry-grid">
        <label className="f f-amount">
          <span>Amount</span>
          <input
            id="amt"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="25.40"
            required
          />
        </label>
        <label className="f">
          <span>Card</span>
          <select id="card" value={nickname} onChange={(e) => setNickname(e.target.value)}>
            {cards.map((c) => (
              <option key={c.id} value={c.nickname}>
                {c.product}
              </option>
            ))}
          </select>
        </label>
        <label className="f">
          <span>Date</span>
          <input id="date" type="date" value={date} max={todayIso} onChange={(e) => setDate(e.target.value)} />
        </label>
        {/* Windows are judged on the posting date. For an older purchase you
            often already know it; leave it blank while it is still pending. */}
        <label className="f">
          <span>Posted {backdated ? '' : '(optional)'}</span>
          <input
            id="posted"
            type="date"
            value={posted}
            min={date}
            max={todayIso}
            onChange={(e) => setPosted(e.target.value)}
          />
        </label>
        {categories.length > 0 && (
          <label className="f">
            <span>Category</span>
            <select id="cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">auto</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="f f-note">
          <span>Note</span>
          <input id="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="merchant" />
        </label>
      </div>
      <div className="entry-foot">
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Add'}
        </button>
        {msg && <span className={msg.kind === 'ok' ? 'ok-text' : 'err-text'}>{msg.text}</span>}
      </div>
      {backdated && !posted && (
        <p className="risk">
          ⏳ Backdated with no posting date — it will count from {date} until you set one.
        </p>
      )}
    </form>
  );
}

function Recent({
  txns,
  count,
  setCount,
  onDelete,
  onPosted,
}: {
  txns: Txn[];
  count: number;
  setCount: (n: number) => void;
  onDelete: (id: number) => void;
  onPosted: (id: number, date: string) => void;
}) {
  if (!txns.length) return null;
  return (
    <section className="card">
      <header>
        <div>
          <h2>Recent</h2>
          <p className="sub">Newest first</p>
        </div>
        <div className="seg" role="group" aria-label="How many to show">
          {[5, 10, 25].map((n) => (
            <button key={n} type="button" className={count === n ? 'on' : ''} onClick={() => setCount(n)}>
              {n}
            </button>
          ))}
        </div>
      </header>
      <ul className="txns">
        {txns.map((t) => (
          <li key={t.id} className={t.posted_at ? '' : 'unposted'}>
            <span className="mono t-date">{t.occurred_at.slice(5)}</span>
            <span className="t-card">{t.nickname}</span>
            <span className="t-note">{t.merchant ?? ''}</span>
            {/* The posting date is what windows are judged on, so make it
                settable in one tap rather than hiding it behind the bot. */}
            {t.posted_at ? (
              <span className="mono t-posted" title={`Posted ${t.posted_at}`}>
                → {t.posted_at.slice(5)}
              </span>
            ) : (
              <input
                id={`posted-${t.id}`}
                className="t-posted-input"
                type="date"
                min={t.occurred_at}
                title="Set the date the bank posted this"
                onChange={(e) => e.target.value && onPosted(t.id, e.target.value)}
              />
            )}
            <span className="mono t-amt">${money(t.amount_cents)}</span>
            <button type="button" className="t-del" onClick={() => onDelete(t.id)} aria-label={`Delete entry ${t.id}`}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function WhichCard({ categories }: { categories: string[] }) {
  const [category, setCategory] = useState(categories[0] ?? 'dining');
  const [amount, setAmount] = useState('');
  const [picks, setPicks] = useState<Pick[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      setPicks((await fetchWhich(category, amount)).picks);
    } finally {
      setBusy(false);
    }
  }

  if (!categories.length) return null;

  return (
    <section className="card">
      <header>
        <div>
          <h2>Which card?</h2>
          <p className="sub">Ranked by what you actually get back — cashback and miles on one scale</p>
        </div>
      </header>
      <form className="entry-grid" onSubmit={run}>
        <label className="f">
          <span>Category</span>
          <select id="wc-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="f">
          <span>Amount (optional)</span>
          <input id="wc-amt" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="120" />
        </label>
      </form>
      <div className="entry-foot">
        <button type="button" onClick={run as unknown as () => void} disabled={busy}>
          {busy ? 'Checking…' : 'Rank cards'}
        </button>
      </div>
      {picks && (
        <ol className="picks">
          {picks.map((p, i) => (
            <li key={p.card_id} className={i === 0 ? 'best' : ''}>
              <div className="pick-head">
                <span>{p.product}</span>
                {/* Value in dollars is the only scale on which a cashback card
                    and a miles card can be compared. */}
                <span className="mono">
                  {p.reward_type === 'cashback' ? `${p.effective_mpd}% back` : `${p.effective_mpd} mpd`}
                  {p.value_cents > 0 && <> · ≈${money(Math.round(p.value_cents))}</>}
                </span>
              </div>
              {p.reasons.map((r, j) => (
                <p key={j} className="sub">
                  {r}
                </p>
              ))}
            </li>
          ))}
          {!picks.length && <li className="sub">No earn rules yet — add them with /addearn in the bot.</li>}
        </ol>
      )}
    </section>
  );
}

function PointsTab() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const [data, setData] = useState<{ balances: BalanceRow[]; programs: ProgramRow[]; tranches: Tranche[] } | null>(null);
  const [points, setPoints] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [plans, setPlans] = useState<Plan[] | null>(null);

  // Add-a-balance form
  const [bProg, setBProg] = useState('');
  const [bPoints, setBPoints] = useState('');
  const [bExpires, setBExpires] = useState('');
  const [bNote, setBNote] = useState('');
  const [bMsg, setBMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Add-a-programme form
  const [pName, setPName] = useState('');
  const [pKind, setPKind] = useState('airline');
  const [pUnit, setPUnit] = useState('miles');

  function load() {
    return fetchPoints()
      .then((d) => {
        setData(d);
        setFrom((f) => f || d.programs.find((p) => p.kind === 'bank')?.key || '');
        setTo((t) => t || d.programs.find((p) => p.kind === 'airline')?.key || '');
        setBProg((b) => b || d.programs[0]?.key || '');
      })
      .catch(() => void 0);
  }

  useEffect(() => {
    load();
  }, []);

  async function convert(e: React.FormEvent) {
    e.preventDefault();
    if (!points || !from || !to) return;
    setPlans((await fetchConvert(points, from, to)).plans);
  }

  async function saveBalance(e: React.FormEvent) {
    e.preventDefault();
    setBMsg(null);
    try {
      const r = await addTranche({ program_key: bProg, points: bPoints, expires_at: bExpires, note: bNote });
      setBPoints('');
      setBNote('');
      setBExpires('');
      setBMsg({ kind: 'ok', text: r.expires_at ? `Saved, expires ${r.expires_at}` : 'Saved' });
      await load();
    } catch (err) {
      setBMsg({ kind: 'err', text: (err as Error).message });
    }
  }

  async function saveProgram(e: React.FormEvent) {
    e.preventDefault();
    if (!pName.trim()) return;
    await addProgram({ key: pName, name: pName.trim(), kind: pKind, unit: pUnit });
    setPName('');
    await load();
  }

  async function removeTranche(id: number) {
    await deleteTranche(id);
    await load();
  }

  if (!data) return <p className="pad sub">Loading…</p>;

  const held = data.balances.filter((b) => b.total > 0);
  const nameOf = (key: string) => data.programs.find((p) => p.key === key)?.name ?? key;
  const kindOf = (key: string) => data.programs.find((p) => p.key === key)?.kind;

  return (
    <>
      <section className="card">
        <header>
          <div>
            <h2>Balances</h2>
            <p className="sub">Everything you hold, across banks and airlines</p>
          </div>
        </header>

        {held.length ? (
          <div className="scroller">
            <table className="pts">
              <thead>
                <tr>
                  <th>Programme</th>
                  <th className="num">Balance</th>
                  <th className="num">Expiring 90d</th>
                  <th className="num">Next expiry</th>
                </tr>
              </thead>
              <tbody>
                {held.map((b) => (
                  <tr key={b.program_key}>
                    <td>
                      {b.name}
                      <span className={`kind ${kindOf(b.program_key)}`}>{kindOf(b.program_key)}</span>
                    </td>
                    <td className="num strong">
                      {b.total.toLocaleString()} <span className="unit">{b.unit}</span>
                    </td>
                    <td className={`num ${b.expiring_soon > 0 ? 'warn-num' : 'dim-num'}`}>
                      {b.expiring_soon > 0 ? b.expiring_soon.toLocaleString() : '—'}
                    </td>
                    <td className="num dim-num">{b.next_expiry ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="sub">Nothing recorded yet. Add a balance below.</p>
        )}

        {/* Points expire in batches, so the individual rows are what you act on. */}
        {data.tranches.length > 0 && (
          <details className="batches">
            <summary>{data.tranches.length} batch{data.tranches.length === 1 ? '' : 'es'}</summary>
            <ul className="txns">
              {data.tranches.map((t) => (
                <li key={t.id}>
                  <span className="t-card">{nameOf(t.program_key)}</span>
                  <span className="t-note">{t.note ?? ''}</span>
                  <span className="mono t-posted">{t.expires_at ?? 'no expiry'}</span>
                  <span className="mono t-amt">{t.points.toLocaleString()}</span>
                  <button type="button" className="t-del" onClick={() => removeTranche(t.id)} aria-label="Delete batch">
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <form className="card entry" onSubmit={saveBalance}>
        <h2>Add a balance</h2>
        <div className="entry-grid">
          <label className="f">
            <span>Programme</span>
            <select id="b-prog" value={bProg} onChange={(e) => setBProg(e.target.value)}>
              <optgroup label="Airline">
                {data.programs.filter((p) => p.kind === 'airline').map((p) => (
                  <option key={p.key} value={p.key}>{p.name}</option>
                ))}
              </optgroup>
              <optgroup label="Bank & other">
                {data.programs.filter((p) => p.kind === 'bank').map((p) => (
                  <option key={p.key} value={p.key}>{p.name}</option>
                ))}
              </optgroup>
            </select>
          </label>
          <label className="f">
            <span>Amount</span>
            <input id="b-pts" value={bPoints} onChange={(e) => setBPoints(e.target.value)} inputMode="numeric" placeholder="50000" required />
          </label>
          <label className="f">
            <span>Expires (optional)</span>
            <input id="b-exp" type="date" value={bExpires} min={todayIso} onChange={(e) => setBExpires(e.target.value)} />
          </label>
          <label className="f">
            <span>Note</span>
            <input id="b-note" value={bNote} onChange={(e) => setBNote(e.target.value)} placeholder="statement balance" />
          </label>
        </div>
        <div className="entry-foot">
          <button type="submit">Add</button>
          {bMsg && <span className={bMsg.kind === 'ok' ? 'ok-text' : 'err-text'}>{bMsg.text}</span>}
        </div>
        <p className="sub">
          Record each batch separately when they expire on different dates — a single total hides the one about to lapse.
        </p>

        <details className="batches">
          <summary>Programme not listed?</summary>
          <div className="entry-grid" style={{ marginTop: 10 }}>
            <label className="f f-note">
              <span>Name</span>
              <input id="p-name" value={pName} onChange={(e) => setPName(e.target.value)} placeholder="Malaysia Airlines Enrich" />
            </label>
            <label className="f">
              <span>Kind</span>
              <select id="p-kind" value={pKind} onChange={(e) => setPKind(e.target.value)}>
                <option value="airline">Airline</option>
                <option value="bank">Bank / other</option>
              </select>
            </label>
            <label className="f">
              <span>Unit</span>
              <input id="p-unit" value={pUnit} onChange={(e) => setPUnit(e.target.value)} />
            </label>
          </div>
          <div className="entry-foot">
            <button type="button" onClick={saveProgram}>Add programme</button>
          </div>
        </details>
      </form>

      <section className="card">
        <header>
          <div>
            <h2>Transfer planner</h2>
            <p className="sub">Blocks and per-transfer fees, not a flat ratio</p>
          </div>
        </header>
        <form className="entry-grid" onSubmit={convert}>
          <label className="f">
            <span>Points</span>
            <input id="cv-pts" value={points} onChange={(e) => setPoints(e.target.value)} inputMode="numeric" placeholder="50000" />
          </label>
          <label className="f">
            <span>From</span>
            <select id="cv-from" value={from} onChange={(e) => setFrom(e.target.value)}>
              {data.programs.filter((p) => p.kind === 'bank').map((p) => (
                <option key={p.key} value={p.key}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="f">
            <span>To</span>
            <select id="cv-to" value={to} onChange={(e) => setTo(e.target.value)}>
              {data.programs.filter((p) => p.kind === 'airline').map((p) => (
                <option key={p.key} value={p.key}>{p.name}</option>
              ))}
            </select>
          </label>
        </form>
        <div className="entry-foot">
          <button type="button" onClick={convert as unknown as () => void}>Plan</button>
        </div>
        {plans && (
          <ol className="picks">
            {plans.map((p, i) => (
              <li key={i} className={i === 0 && p.possible ? 'best' : ''}>
                <div className="pick-head">
                  <span>{p.conversion.route ?? 'route'}</span>
                  <span className="mono">{p.possible ? `${p.miles.toLocaleString()} mi` : '—'}</span>
                </div>
                {p.possible ? (
                  <>
                    <p className="sub">
                      {p.transferable.toLocaleString()} transferred in {p.conversion.block_increment.toLocaleString()} blocks
                      {p.stranded > 0 && <> · {p.stranded.toLocaleString()} stranded</>}
                    </p>
                    <p className="sub">
                      {p.fee_cents ? `Fee $${money(p.fee_cents)} · ${p.cents_per_mile.toFixed(3)}¢ per mile` : 'No fee'}
                      {p.bonus_miles > 0 && <> · incl. {p.bonus_miles.toLocaleString()} bonus</>}
                    </p>
                  </>
                ) : (
                  <p className="risk">{p.reason}</p>
                )}
              </li>
            ))}
            {!plans.length && <li className="sub">No route configured. Add one with <code>/addconv</code>.</li>}
          </ol>
        )}
      </section>
    </>
  );
}

export default function App() {
  const [tab, setTab] = useState<'use' | 'cards' | 'ledger' | 'trends' | 'audit' | 'points' | 'expiry' | 'offers' | 'settings'>('use');
  const [categories, setCategories] = useState<string[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [offers, setOffers] = useState<OfferRow[] | null>(null);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [recentCount, setRecentCount] = useState(10);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    fetchSummary().then(setSummary).catch((e) => setError(e.message));
    fetchTransactions(recentCount)
      .then((d) => setTxns(d.transactions))
      .catch(() => void 0);
  }

  // Refetch when the row count changes, without re-running the whole load.
  useEffect(() => {
    if (!bootstrapToken()) return;
    fetchTransactions(recentCount)
      .then((d) => setTxns(d.transactions))
      .catch(() => void 0);
  }, [recentCount]);

  useEffect(() => {
    if (!bootstrapToken()) {
      setError('No access token. Send /app to your Telegram bot and open the link it replies with.');
      return;
    }
    refresh();
    fetchOffers()
      .then((d) => setOffers(d.offers))
      .catch(() => void 0);
    fetchCategories()
      .then((d) => setCategories(d.categories))
      .catch(() => void 0);
  }, []);

  async function removeTxn(id: number) {
    await deleteTransaction(id);
    refresh();
  }

  async function confirmPosted(id: number, date: string) {
    await markPosted(id, date);
    refresh();
  }

  if (error && tab !== 'use') return <main className="pad"><p className="error">{error}</p></main>;

  return (
    <main>
      <nav className="tabs">
        <button className={tab === 'use' ? 'on' : ''} onClick={() => setTab('use')}>
          Use
        </button>
        <button className={tab === 'cards' ? 'on' : ''} onClick={() => setTab('cards')}>
          Cards
        </button>
        <button className={tab === 'ledger' ? 'on' : ''} onClick={() => setTab('ledger')}>
          Ledger
        </button>
        <button className={tab === 'trends' ? 'on' : ''} onClick={() => setTab('trends')}>
          Trends
        </button>
        <button className={tab === 'audit' ? 'on' : ''} onClick={() => setTab('audit')}>
          Audit
        </button>
        <button className={tab === 'points' ? 'on' : ''} onClick={() => setTab('points')}>
          Points
        </button>
        <button className={tab === 'expiry' ? 'on' : ''} onClick={() => setTab('expiry')}>
          Expiry
        </button>
        <button className={tab === 'offers' ? 'on' : ''} onClick={() => setTab('offers')}>
          Offers{offers?.length ? ` (${offers.length})` : ''}
        </button>
        <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>
          Settings
        </button>
      </nav>

      {tab === 'cards' &&
        (summary ? (
          <>
            <section className="card overall">
              <header>
                <div>
                  <h2>All cards</h2>
                  <p className="sub">Total utilization — what a credit score actually reads</p>
                </div>
                <div className={`pct ${tone(summary.overall.percent)}`}>{summary.overall.percent.toFixed(0)}%</div>
              </header>
              <Meter percent={summary.overall.percent} tone={tone(summary.overall.percent)} />
              <p className="sub mono">
                ${money(summary.overall.balance_cents)} / ${money(summary.overall.limit_cents)}
              </p>
            </section>
            <AddSpend cards={summary.cards} categories={categories} onSaved={refresh} />
            <WhichCard categories={categories} />
            {summary.cards.map((c) => (
              <Card key={c.id} c={c} />
            ))}
            <Recent txns={txns} count={recentCount} setCount={setRecentCount} onDelete={removeTxn} onPosted={confirmPosted} />
            {!summary.cards.length && <p className="pad sub">No cards yet. Add one with /newcard in the bot.</p>}
          </>
        ) : (
          <p className="pad sub">Loading…</p>
        ))}

      {tab === 'use' && <Advisor />}

      {tab === 'ledger' && <Ledger />}

      {tab === 'audit' && <Audit />}

      {tab === 'trends' && <Analytics />}

      {tab === 'expiry' && <ExpiryTab />}

      {tab === 'settings' && <Settings />}

      {tab === 'points' && <PointsTab />}

      {tab === 'offers' && (
        <>
          <Scanner onTracked={() => fetchOffers().then((d) => setOffers(d.offers)).catch(() => void 0)} />
          {offers ? (
            offers.length ? (
              offers.map((o) => <Offer key={o.id} o={o} />)
            ) : (
              <p className="pad sub">No tracked offers yet. Track one above, then run /extract in the bot.</p>
            )
          ) : (
            <p className="pad sub">Loading…</p>
          )}
        </>
      )}
    </main>
  );
}
