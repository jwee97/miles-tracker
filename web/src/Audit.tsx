import { useEffect, useState } from 'react';
import { fetchAudit, money, recordCredited, type AuditReport, type AuditRow } from './api';

function Row({ r, onSaved }: { r: AuditRow; onSaved: () => void }) {
  const [miles, setMiles] = useState(r.actual_miles === null ? '' : String(r.actual_miles));
  const [busy, setBusy] = useState(false);

  const badge =
    r.status === 'short'
      ? { cls: 'critical', label: 'short' }
      : r.status === 'over'
        ? { cls: 'soon', label: 'over' }
        : r.status === 'matched'
          ? { cls: 'ok', label: 'ok' }
          : { cls: '', label: 'not checked' };

  return (
    <>
      <tr className={r.status === 'short' ? 'row-review' : ''}>
        <td className="mono dim-num">{r.occurred_at.slice(5)}</td>
        <td>
          {r.merchant ?? '—'}
          {r.mcc && <span className="kind">{r.mcc}</span>}
        </td>
        <td className="num dim-num">${money(r.amount_cents)}</td>
        <td className="num">{r.expected_miles.toLocaleString()}</td>
        <td className="num">
          <input
            className="cell-input tiny"
            value={miles}
            inputMode="numeric"
            placeholder="—"
            onChange={(e) => setMiles(e.target.value)}
            onBlur={async () => {
              const v = miles.trim() === '' ? null : Number(miles);
              if (v === r.actual_miles) return;
              setBusy(true);
              try {
                await recordCredited(r.id, v, null);
                onSaved();
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          />
        </td>
        <td className="num">
          <span className={`chip ${badge.cls}`}>{badge.label}</span>
        </td>
      </tr>
      {r.reason && (
        <tr className="reason-row">
          <td />
          <td colSpan={5} className="sub">
            {r.reason}
          </td>
        </tr>
      )}
    </>
  );
}

export default function Audit() {
  const [report, setReport] = useState<AuditReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  function load() {
    setErr(null);
    fetchAudit(from && to ? { from, to } : {})
      .then(setReport)
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(load, [from, to]);

  if (err) return <p className="pad error">{err}</p>;
  if (!report) return <p className="pad sub">Loading…</p>;
  const t = report.totals;

  return (
    <>
      <section className="card hero">
        <span className="stat-label">
          Reward audit · {report.period.start} → {report.period.end}
        </span>
        <span className={`hero-value ${t.shortfall_miles > 0 ? 'warn-num' : ''}`}>
          {t.shortfall_miles > 0 ? `${t.shortfall_miles.toLocaleString()} short` : 'All matched'}
        </span>
        <span className="sub">
          Expected {t.expected_miles.toLocaleString()} miles · credited {t.actual_miles.toLocaleString()} ·{' '}
          {t.checked} checked, {t.unrecorded} not
        </span>
      </section>

      {report.findings.length > 0 && (
        <section className="card insights">
          <h2>What the audit found</h2>
          <ul>
            {report.findings.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <header>
          <div>
            <h2>Transaction by transaction</h2>
            <p className="sub">Type what the bank actually credited into the Credited column</p>
          </div>
        </header>
        <div className="entry-grid">
          <label className="f">
            <span>From</span>
            <input id="a-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="f">
            <span>To</span>
            <input id="a-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        <div className="scroller" style={{ marginTop: 12 }}>
          <table className="pts">
            <thead>
              <tr>
                <th>Date</th>
                <th>Merchant</th>
                <th className="num">Amount</th>
                <th className="num">Expected</th>
                <th className="num">Credited</th>
                <th className="num">Status</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <Row key={r.id} r={r} onSaved={load} />
              ))}
            </tbody>
          </table>
        </div>
        {!report.rows.length && <p className="sub">Nothing in this period.</p>}
      </section>
    </>
  );
}
