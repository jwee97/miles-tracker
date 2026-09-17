import { useState } from 'react';
import { money, recalculateAll, type RecalcReport } from './api';

/**
 * Re-price what the app predicted, after the rules it predicted from changed.
 *
 * The prediction on a transaction is only as good as the rules and the merchant
 * code that were known when it was logged. Correct a rate, confirm a code, fix
 * a category — and every purchase priced before that is quietly carrying an old
 * answer. This replaces the predictions; it never touches what the bank
 * actually paid, which is the only thing the reward audit has to check them
 * against.
 */
export default function Repricer({ cards, onDone }: { cards: string[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState('');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<RecalcReport | null>(null);

  const delta = report ? report.miles_after - report.miles_before : 0;
  const cashDelta = report ? report.cashback_after_cents - report.cashback_before_cents : 0;

  return (
    <details
      className="batches repricer"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>Re-price against the current rules</summary>
      <p className="sub">
        Uses the rules as they now read <b>for the day each purchase happened</b>, so correcting an August rate re-prices
        August and leaves September alone. What the bank actually paid is never changed.
      </p>

      <div className="advisor-row">
        <select value={card} onChange={(e) => setCard(e.target.value)}>
          <option value="">every card</option>
          {cards.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              setReport(await recalculateAll({ nickname: card || undefined, from: from || undefined }));
              onDone();
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Re-pricing…' : 'Re-price'}
        </button>
        <span className="sub">from this date, if you set one</span>
      </div>
      {err && <p className="err-text">{err}</p>}

      {report && (
        <div className="recalc-report">
          <p className="sub">
            {report.considered} looked at · <b>{report.changed}</b> changed · {report.unchanged} already right
            {report.failed.length ? ` · ${report.failed.length} failed` : ''}
          </p>
          {report.changed === 0 ? (
            <p className="sub">Every prediction already matches the rules. Nothing was written.</p>
          ) : (
            <>
              <p className={delta < 0 || cashDelta < 0 ? 'warn-num' : 'ok-text'}>
                {delta !== 0 && `${delta > 0 ? '+' : ''}${delta.toLocaleString()} miles`}
                {delta !== 0 && cashDelta !== 0 && ' · '}
                {cashDelta !== 0 && `${cashDelta > 0 ? '+' : '−'}$${money(Math.abs(cashDelta))}`}
                {delta === 0 && cashDelta === 0 && 'Same rewards, different rule versions'}
              </p>
              <ul className="diff-list">
                {report.changes.slice(0, 20).map((c) => (
                  <li key={c.id} className="changed">
                    {c.occurred_at} · {c.merchant ?? 'unnamed'} ({c.card}) — {c.summary}
                  </li>
                ))}
              </ul>
              {report.changes.length > 20 && <p className="sub">…and {report.changes.length - 20} more.</p>}
            </>
          )}
        </div>
      )}
    </details>
  );
}
