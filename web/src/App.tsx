import { useEffect, useState } from 'react';
import {
  addTransaction,
  bootstrapToken,
  deleteTransaction,
  fetchOffers,
  fetchSummary,
  fetchTransactions,
  money,
  type CardSummary,
  type OfferRow,
  type Progress,
  type Summary,
  type Txn,
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
        {p.met ? (
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
      {c.requirements.map((r) => (
        <RequirementRow key={r.id} p={r} />
      ))}
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

function AddSpend({ cards, onSaved }: { cards: CardSummary[]; onSaved: () => void }) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const [nickname, setNickname] = useState(cards[0]?.nickname ?? '');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await addTransaction({ nickname, amount, date, note });
      // Keep the card and date, clear the entry — several receipts from the
      // same day is the common case.
      setAmount('');
      setNote('');
      setMsg({ kind: 'ok', text: `Added $${amount} to ${r.card}` });
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
    </form>
  );
}

function Recent({ txns, onDelete }: { txns: Txn[]; onDelete: (id: number) => void }) {
  if (!txns.length) return null;
  return (
    <section className="card">
      <header>
        <div>
          <h2>Recent</h2>
          <p className="sub">Newest first</p>
        </div>
      </header>
      <ul className="txns">
        {txns.map((t) => (
          <li key={t.id}>
            <span className="mono t-date">{t.occurred_at.slice(5)}</span>
            <span className="t-card">{t.nickname}</span>
            <span className="t-note">{t.merchant ?? ''}</span>
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

export default function App() {
  const [tab, setTab] = useState<'cards' | 'offers'>('cards');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [offers, setOffers] = useState<OfferRow[] | null>(null);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    fetchSummary().then(setSummary).catch((e) => setError(e.message));
    fetchTransactions(25)
      .then((d) => setTxns(d.transactions))
      .catch(() => void 0);
  }

  useEffect(() => {
    if (!bootstrapToken()) {
      setError('No access token. Send /app to your Telegram bot and open the link it replies with.');
      return;
    }
    refresh();
    fetchOffers()
      .then((d) => setOffers(d.offers))
      .catch(() => void 0);
  }, []);

  async function removeTxn(id: number) {
    await deleteTransaction(id);
    refresh();
  }

  if (error) return <main className="pad"><p className="error">{error}</p></main>;

  return (
    <main>
      <nav className="tabs">
        <button className={tab === 'cards' ? 'on' : ''} onClick={() => setTab('cards')}>
          Cards
        </button>
        <button className={tab === 'offers' ? 'on' : ''} onClick={() => setTab('offers')}>
          Offers{offers?.length ? ` (${offers.length})` : ''}
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
            <AddSpend cards={summary.cards} onSaved={refresh} />
            {summary.cards.map((c) => (
              <Card key={c.id} c={c} />
            ))}
            <Recent txns={txns} onDelete={removeTxn} />
            {!summary.cards.length && <p className="pad sub">No cards yet. Add one with /newcard in the bot.</p>}
          </>
        ) : (
          <p className="pad sub">Loading…</p>
        ))}

      {tab === 'offers' &&
        (offers ? (
          offers.length ? (
            offers.map((o) => <Offer key={o.id} o={o} />)
          ) : (
            <p className="pad sub">No tracked offers. The nightly scan will send new ones to Telegram.</p>
          )
        ) : (
          <p className="pad sub">Loading…</p>
        ))}
    </main>
  );
}
