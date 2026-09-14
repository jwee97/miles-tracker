import { useEffect, useState } from 'react';
import { importStatement, money, parseStatement, type CardSummary, type ParsedRow, type StatementParse } from './api';

/** Signed money: a statement full of refunds should not read "$-9.25". */
const signed = (cents: number) => `${cents < 0 ? '−' : ''}$${money(Math.abs(cents))}`;

/**
 * Pasting a month of spend instead of typing it.
 *
 * Every row is shown before anything is written, rows that look like something
 * already logged are ticked off by default, and lines the parser could not read
 * are listed with the reason — a transaction that vanishes quietly is worse
 * than one you have to type in yourself.
 */
export default function Statement({ cards, onImported }: { cards: CardSummary[]; onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [nickname, setNickname] = useState('');
  // The card list arrives after the first render, so the select would sit on an
  // empty value — showing the first card while holding none of it.
  useEffect(() => {
    if (!nickname && cards.length) setNickname(cards[0].nickname);
  }, [cards, nickname]);
  const [parsed, setParsed] = useState<StatementParse | null>(null);
  const [keep, setKeep] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function read() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await parseStatement(text, nickname);
      setParsed(r);
      // Anything that looks already logged starts unticked.
      setKeep(new Set(r.rows.map((_, i) => i).filter((i) => !r.rows[i].duplicate)));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!parsed) return;
    setBusy(true);
    setErr(null);
    try {
      const rows = parsed.rows.filter((_, i) => keep.has(i));
      const r = await importStatement(nickname, rows);
      setMsg(
        `Imported ${r.imported} transaction${r.imported === 1 ? '' : 's'}` +
          (r.expected_miles ? ` · ${r.expected_miles.toLocaleString()} points expected, waiting on the Points tab` : '')
      );
      setParsed(null);
      setText('');
      onImported();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const kept = parsed ? parsed.rows.filter((_, i) => keep.has(i)) : [];
  const keptTotal = kept.reduce((s, r) => s + r.amount_cents, 0);

  return (
    <section className="card entry">
      <div className="section-head" style={{ margin: 0 }}>
        <h2>Paste a statement</h2>
        <button className="secondary" onClick={() => setOpen((v) => !v)}>
          {open ? 'Close' : 'Open'}
        </button>
      </div>

      {open && (
        <>
          <p className="sub">
            Copy the transaction rows out of your statement and paste them here — date, description, amount, one per
            line. Two dates on a line are read as the transaction date and the posting date.
          </p>
          <div className="entry-grid">
            <label className="f">
              <span>Card</span>
              <select value={nickname} onChange={(e) => setNickname(e.target.value)}>
                {cards.map((c) => (
                  <option key={c.id} value={c.nickname}>
                    {c.nickname} — {c.product}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <textarea
            className="prompt"
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'14 SEP  15 SEP  NTUC FAIRPRICE  23.45\n15/09/2026  GRAB *TRIP  12.30'}
          />
          <div className="entry-foot">
            <button onClick={read} disabled={busy || !text.trim() || !nickname}>
              {busy ? 'Reading…' : 'Read the rows'}
            </button>
            {msg && <span className="sub">{msg}</span>}
            {err && <span className="err-text">{err}</span>}
          </div>
        </>
      )}

      {parsed && (
        <>
          <p className="sub">
            {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'} read · {signed(parsed.total_cents)} in total
            {parsed.duplicates ? ` · ${parsed.duplicates} already logged, unticked below` : ''}
            {parsed.skipped.length ? ` · ${parsed.skipped.length} line(s) not understood` : ''}
          </p>

          <ul className="txns statement">
            {parsed.rows.map((r, i) => (
              <li key={i} className={r.duplicate ? 'unposted' : ''}>
                <label className="tick">
                  <input
                    type="checkbox"
                    checked={keep.has(i)}
                    onChange={() => {
                      const next = new Set(keep);
                      next.has(i) ? next.delete(i) : next.add(i);
                      setKeep(next);
                    }}
                  />
                </label>
                <span className="t-date">{r.occurred_at.slice(5)}</span>
                <span className="t-note">
                  {r.merchant}
                  {r.duplicate ? ' · already logged' : ''}
                </span>
                <span className="t-card">{r.category ?? (r.mcc ? `mcc ${r.mcc}` : 'no category')}</span>
                <span className={`t-amt ${r.credit ? 'ok-text' : ''}`}>
                  {r.credit ? '−' : ''}${money(Math.abs(r.amount_cents))}
                </span>
              </li>
            ))}
          </ul>

          {parsed.skipped.length > 0 && (
            <details className="batches">
              <summary>{parsed.skipped.length} line(s) this could not read</summary>
              <ul className="notes">
                {parsed.skipped.map((s, i) => (
                  <li key={i}>
                    <strong>{s.reason}</strong>
                    <br />
                    <code>{s.raw}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="entry-foot">
            <button onClick={save} disabled={busy || !kept.length}>
              Import {kept.length} row{kept.length === 1 ? '' : 's'} · {signed(keptTotal)}
            </button>
            <button className="secondary" onClick={() => setParsed(null)}>
              Discard
            </button>
          </div>
        </>
      )}
    </section>
  );
}
