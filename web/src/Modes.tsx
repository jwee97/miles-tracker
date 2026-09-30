import { useEffect, useState } from 'react';
import {
  chooseCardMode,
  fetchModeCards,
  fetchModeComparison,
  money,
  type ModeCard,
  type ModeComparison,
} from './api';

/**
 * Cards that make you choose what they pay.
 *
 * The decision is quarterly and locked, so it belongs next to the other
 * decisions rather than buried in a card's settings. Two halves: what the card
 * is set to now, and what each of the alternatives would have been worth on
 * spending that already happened — which is the only evidence there is, since
 * the headline rates cannot tell you whether your own spending fits under a
 * S$500 cap.
 */

function Compare({ card }: { card: string }) {
  const [cmp, setCmp] = useState<ModeComparison | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [range, setRange] = useState('lastquarter');

  useEffect(() => {
    setCmp(null);
    setErr(null);
    fetchModeComparison(card, range)
      .then(setCmp)
      .catch((e) => setErr((e as Error).message));
  }, [card, range]);

  if (err) return <p className="err-text">{err}</p>;
  if (!cmp) return <p className="sub">Replaying what you spent…</p>;

  return (
    <div className="mode-compare">
      <div className="seg wrap" role="group" aria-label="Period">
        {[
          { key: 'lastquarter', label: 'Last quarter' },
          { key: 'quarter', label: 'This quarter' },
          { key: 'ytd', label: 'This year' },
        ].map((r) => (
          <button key={r.key} type="button" className={range === r.key ? 'on' : ''} onClick={() => setRange(r.key)}>
            {r.label}
          </button>
        ))}
      </div>

      <p className="warn-num">{cmp.headline}</p>
      <p className="sub">
        {cmp.transactions} purchase{cmp.transactions === 1 ? '' : 's'} · ${money(cmp.spend_cents)} of spending
      </p>

      <ul className="rules">
        {cmp.modes.map((m, i) => (
          <li key={m.mode_key} className={i === 0 ? 'pass' : m.selected ? 'unknown' : 'fail'}>
            <span>
              <strong>{m.label}</strong> <span className="mono">${money(m.value_cents)}</span>
              {m.selected && <span className="chip ok">what you are on</span>}
              {i === 0 && !m.selected && <span className="chip soon">would have paid most</span>}
            </span>
            <p className="sub">
              {m.miles ? `${m.miles.toLocaleString()} miles` : ''}
              {m.miles && m.cashback_cents ? ' · ' : ''}
              {m.cashback_cents
                ? `$${money(m.cashback_cents)} ${m.payout === 'stock' ? 'of stock' : m.payout === 'cash' ? 'back' : m.payout}`
                : ''}
              {m.category ? ` · on ${m.category}` : ''}
              {m.rounded_away_cents > 0 ? ` · $${money(m.rounded_away_cents)} lost to rounding` : ''}
            </p>
          </li>
        ))}
      </ul>

      {cmp.caveats.map((c, i) => (
        <p key={i} className="sub dim">
          {c}
        </p>
      ))}
    </div>
  );
}

function Card({ c, onChanged }: { c: ModeCard; onChanged: () => void }) {
  const [key, setKey] = useState(c.current?.mode_key ?? c.modes[0]?.mode_key ?? '');
  const [from, setFrom] = useState('');
  const [category, setCategory] = useState(c.current?.category ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mode = c.modes.find((m) => m.mode_key === key) ?? null;
  const picks = !!mode?.picks_category;

  async function save() {
    setBusy(true);
    setErr(null);
    const r = await chooseCardMode({
      nickname: c.nickname,
      mode_key: key,
      from,
      category: picks ? category : null,
    }).catch((e) => ({ ok: false as const, error: (e as Error).message }));
    setBusy(false);
    if (!r.ok) setErr(r.error ?? 'could not switch');
    else onChanged();
  }

  return (
    <section className="card">
      <header>
        <div>
          <h2>{c.product}</h2>
          <p className="sub">
            {c.current
              ? `On ${c.modes.find((m) => m.mode_key === c.current!.mode_key)?.label ?? c.current.mode_key}` +
                `${c.current.category ? ` (${c.current.category})` : ''} since ${c.current.effective_from}`
              : 'Nothing chosen yet, so only the rates that apply in every mode are used'}
          </p>
        </div>
      </header>

      <Compare card={c.nickname} />

      <details>
        <summary className="sub">Change the mode</summary>
        <div className="entry-foot rule-actions">
          <select value={key} onChange={(e) => setKey(e.target.value)}>
            {c.modes.map((m) => (
              <option key={m.mode_key} value={m.mode_key}>
                {m.label} — paid as {m.payout}
              </option>
            ))}
          </select>
          {picks && (
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">pick a category</option>
              {(mode?.category_choices ?? '').split(',').filter(Boolean).map((x) => (
                <option key={x} value={x.trim()}>
                  {x.trim()}
                </option>
              ))}
            </select>
          )}
          <label className="sub">
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <button disabled={busy || !key || !from} onClick={save}>
            Switch
          </button>
        </div>
        <p className="sub dim">
          The date is the day the new mode started, which is not always today. Everything bought before it keeps the mode
          it was bought under, so what the card has already earned does not change.
        </p>
        {err && <p className="err-text">{err}</p>}
      </details>

      {c.history.length > 1 && (
        <details>
          <summary className="sub">Every switch so far ({c.history.length})</summary>
          <ul className="notes">
            {c.history.map((h, i) => (
              <li key={i}>
                {h.effective_from} → {h.effective_until ?? 'now'} · {h.mode_key}
                {h.category ? ` (${h.category})` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export default function Modes() {
  const [cards, setCards] = useState<ModeCard[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function load() {
    fetchModeCards()
      .then((d) => setCards(d.cards))
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(load, []);

  if (err) return null;
  if (!cards?.length) return null;

  return (
    <>
      {cards.map((c) => (
        <Card key={c.nickname} c={c} onChanged={load} />
      ))}
    </>
  );
}
