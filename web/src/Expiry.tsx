import { useEffect, useState } from 'react';
import { fetchExpiry, fetchTransfers, type Expiry as Row } from './api';

function urgency(days: number | null): { cls: string; label: string } {
  if (days === null) return { cls: 'never', label: 'no expiry' };
  if (days < 0) return { cls: 'gone', label: 'expired' };
  if (days <= 30) return { cls: 'critical', label: `${days}d` };
  if (days <= 90) return { cls: 'soon', label: `${days}d` };
  if (days <= 365) return { cls: 'ok', label: `${days}d` };
  return { cls: 'far', label: `${Math.round(days / 30)}mo` };
}

export default function ExpiryTab() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [transfers, setTransfers] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // An empty list and a failed request look identical on screen unless the
    // error is kept; "no balances" is a very different message from "broken".
    fetchExpiry()
      .then((d) => setRows(d.tranches))
      .catch((e) => {
        setRows([]);
        setErr((e as Error).message);
      });
    fetchTransfers().then((d) => setTransfers(d.transfers)).catch(() => void 0);
  }, []);

  if (err) return <p className="pad error">{err}</p>;
  if (!rows) return <p className="pad sub">Loading…</p>;
  if (!rows.length)
    return (
      <section className="card">
        <p className="sub">
          No balances recorded. Add them on the Points tab, or send <code>/addbal</code> to the bot.
        </p>
      </section>
    );

  const soon = rows.filter((r) => r.days_left !== null && r.days_left <= 90);
  const soonTotal = soon.reduce((s, r) => s + r.points, 0);

  return (
    <>
      {soon.length > 0 && (
        <section className="card hero">
          <span className="stat-label">Expiring within 90 days</span>
          <span className="hero-value warn-num">{soonTotal.toLocaleString()}</span>
          <span className="sub">
            across {soon.length} batch{soon.length === 1 ? '' : 'es'} · soonest {soon[0].expires_at}
          </span>
        </section>
      )}

      <section className="card">
        <header>
          <div>
            <h2>Every batch by expiry</h2>
            <p className="sub">Soonest first — the order a transfer should use them up</p>
          </div>
        </header>
        <div className="scroller">
          <table className="pts">
            <thead>
              <tr>
                <th>Expires</th>
                <th>Left</th>
                <th>Programme</th>
                <th className="num">Amount</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const u = urgency(r.days_left);
                return (
                  <tr key={r.id}>
                    <td className="mono">{r.expires_at ?? '—'}</td>
                    <td>
                      <span className={`chip ${u.cls}`}>{u.label}</span>
                    </td>
                    <td>
                      {r.name}
                      <span className={`kind ${r.kind}`}>{r.kind}</span>
                    </td>
                    <td className="num strong">
                      {r.points.toLocaleString()} <span className="unit">{r.unit}</span>
                    </td>
                    <td className="dim-num">{r.note ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="sub" style={{ marginTop: 10 }}>
          Transferring points consumes the soonest-expiring batch first, so the ones at the top of this list are the
          ones a transfer will spend.
        </p>
      </section>

      {transfers.length > 0 && (
        <section className="card">
          <header>
            <div>
              <h2>Transfers made</h2>
              <p className="sub">What has actually moved</p>
            </div>
          </header>
          <div className="scroller">
            <table className="pts">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Route</th>
                  <th className="num">Out</th>
                  <th className="num">In</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr key={t.id}>
                    <td className="mono dim-num">{t.executed_at}</td>
                    <td>
                      {t.from_program} → {t.to_program}
                      {t.route && <span className="kind">{t.route}</span>}
                    </td>
                    <td className="num dim-num">−{t.points_out.toLocaleString()}</td>
                    <td className="num strong">+{t.units_in.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
