import { useEffect, useState } from 'react';
import { PROFILES, normalise, type Normalised } from './banks';
import {
  importStatementInSlices,
  money,
  parseStatement,
  type CardSummary,
  type ParsedRow,
  type StatementParse,
} from './api';

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
  const [progress, setProgress] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [pdf, setPdf] = useState<(Normalised & { rows: number; file: string }) | null>(null);
  const [bank, setBank] = useState('');

  /**
   * The PDF is read here, in the browser — pdf.js is pulled in only when you
   * open one. The file itself never leaves the device; what goes to your Worker
   * is the lines below, once you ask for them.
   */
  async function readPdf(file: File, forced = bank) {
    setReading(true);
    setErr(null);
    setMsg(null);
    try {
      const { extractPdfLines } = await import('./pdf');
      const pages = await extractPdfLines(file);
      const n = normalise(pages, forced || undefined);
      if (!n.text) {
        setPdf(null);
        setErr(
          `Read ${pages.length} page(s) of ${n.label} but found no transaction rows. ` +
            'If this is a scan rather than a text PDF there is nothing to extract — or pick the bank by hand below.'
        );
        setText('');
        return;
      }
      setPdf({ ...n, rows: n.text.split('\n').length, file: file.name });
      setBank(n.bank);
      setText(n.text);
      setParsed(null);
    } catch (e) {
      setErr(`Could not read that PDF: ${(e as Error).message}`);
    } finally {
      setReading(false);
    }
  }

  async function read() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await parseStatement(text, nickname, pdf?.statement_date ?? null);
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
      // A few rows per request, because that is what a Worker invocation can
      // do. Progress is shown rather than hidden: twenty small requests with a
      // count moving is a wait someone can sit through, and a spinner that
      // says nothing for the same duration is one they reload out of.
      const r = await importStatementInSlices(nickname, rows, (done, total) =>
        setProgress(`Importing ${done} of ${total}…`)
      );
      setProgress(null);
      // What changed, not what was sent: most of a statement is usually
      // already known, and "52 imported" when 48 were already there is the
      // sentence that makes people stop trusting the number.
      const parts = [`${r.imported} new transaction${r.imported === 1 ? '' : 's'}`];
      if (r.already_known) parts.push(`${r.already_known} already known`);
      if (r.reconciled) parts.push(`${r.reconciled} confirmed as posted`);
      if (r.queued_for_review) parts.push(`${r.queued_for_review} to answer under Review`);
      const skipped = (r.skipped ?? []).reduce((t, x) => t + x.count, 0);
      if (skipped) parts.push(`${skipped} payment/fee row${skipped === 1 ? '' : 's'} skipped`);
      setMsg(
        parts.join(' · ') +
          (r.expected_miles ? ` · ${r.expected_miles.toLocaleString()} points expected, waiting on the Points tab` : '')
      );
      setParsed(null);
      setText('');
      onImported();
    } catch (e) {
      // Partial progress is real: the slices that landed are imported, and
      // re-running the same statement will recognise them rather than
      // duplicating them.
      setErr(`${(e as Error).message}${progress ? ` — stopped at ${progress.replace(/…$/, '')}` : ''}`);
      setProgress(null);
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
            Upload the statement PDF, or paste the rows yourself — date, description, amount, one per line. Two dates on
            a line are read as the transaction date and the posting date.
          </p>

          <div className="entry-grid">
            <label className="f f-note">
              <span>Statement PDF</span>
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) readPdf(file);
                }}
              />
            </label>
            <label className="f">
              <span>Bank</span>
              <select
                value={bank}
                onChange={(e) => {
                  setBank(e.target.value);
                  const input = document.querySelector<HTMLInputElement>('input[type=file][accept*=pdf]');
                  const file = input?.files?.[0];
                  if (file) readPdf(file, e.target.value);
                }}
              >
                <option value="">detect</option>
                {PROFILES.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="sub">
            The PDF is read in this browser and never uploaded. Only the rows you choose to import are sent, and only to
            your own app.
          </p>
          {reading && <p className="sub">Reading the PDF…</p>}
          {pdf && (
            <p className="sub">
              <strong>{pdf.label}</strong> · {pdf.file} · {pdf.rows} transaction row{pdf.rows === 1 ? '' : 's'}
              {pdf.statement_date ? ` · statement dated ${pdf.statement_date}` : ' · no statement date found'} ·{' '}
              {pdf.dropped} other line{pdf.dropped === 1 ? '' : 's'} ignored
              {pdf.confidence === 0 ? ' · the bank was a guess, check the rows' : ''}
            </p>
          )}
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

          {parsed.summary && (
            <ul className="stmt-summary">
              {(
                [
                  ['matched', 'already known'],
                  ['new', 'new'],
                  ['possible_duplicate', 'possibly a duplicate'],
                  ['refund', 'refunds'],
                  ['payment', 'bill payments'],
                  ['fee', 'fees'],
                  ['interest', 'interest'],
                ] as const
              )
                .filter(([k]) => parsed.summary![k])
                .map(([k, label]) => (
                  <li key={k} className={k === 'possible_duplicate' ? 'warn-num' : ''}>
                    <span className="mono">{parsed.summary![k]}</span> {label}
                  </li>
                ))}
            </ul>
          )}

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
                  {r.kind && r.kind !== 'new' ? ` · ${r.detail ?? r.kind}` : ''}
                  {!r.kind && r.duplicate ? ' · already logged' : ''}
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
              {progress ?? `Import ${kept.length} row${kept.length === 1 ? '' : 's'} · ${signed(keptTotal)}`}
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
