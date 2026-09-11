import { useEffect, useState } from 'react';
import { fetchSettings, fetchUsage, saveSetting, type SettingRow, type Usage } from './api';

const bytes = (n: number) => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

function Setting({ row, onSave }: { row: SettingRow; onSave: (k: string, v: string | null) => Promise<void> }) {
  const [draft, setDraft] = useState(row.value);
  const [busy, setBusy] = useState(false);
  const dirty = draft !== row.value;
  const overridden = row.stored_value !== null;

  return (
    <div className="setting">
      <div className="setting-head">
        <label htmlFor={`s-${row.key}`}>{row.label}</label>
        {overridden && <span className="chip soon">changed</span>}
      </div>
      <div className="setting-row">
        <input
          id={`s-${row.key}`}
          value={draft}
          inputMode={row.kind === 'number' ? 'decimal' : 'text'}
          onChange={(e) => setDraft(e.target.value)}
        />
        <span className="setting-unit">{row.unit}</span>
        <button
          type="button"
          disabled={!dirty || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(row.key, draft);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save
        </button>
        {overridden && (
          <button
            type="button"
            className="link-btn"
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(row.key, null);
                setDraft(row.default_value);
              } finally {
                setBusy(false);
              }
            }}
          >
            reset
          </button>
        )}
      </div>
      <p className="sub">{row.help}</p>
      {overridden && <p className="sub">Deployed default: <code>{row.default_value}</code></p>}
    </div>
  );
}

export default function Settings() {
  const [rows, setRows] = useState<SettingRow[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    fetchSettings().then((d) => setRows(d.settings)).catch((e) => setMsg({ kind: 'err', text: e.message }));
    fetchUsage().then(setUsage).catch(() => void 0);
  }, []);

  async function save(key: string, value: string | null) {
    try {
      const r = await saveSetting(key, value);
      setRows(r.settings);
      setMsg({ kind: 'ok', text: value === null ? 'Reset to the deployed default' : 'Saved' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    }
  }

  return (
    <>
      <section className="card">
        <header>
          <div>
            <h2>Settings</h2>
            <p className="sub">Stored in the database and applied immediately — no redeploy</p>
          </div>
        </header>
        {msg && <p className={msg.kind === 'ok' ? 'ok-text' : 'err-text'}>{msg.text}</p>}
        {rows ? rows.map((r) => <Setting key={r.key} row={r} onSave={save} />) : <p className="sub">Loading…</p>}
        <p className="sub" style={{ marginTop: 14 }}>
          Secrets — the bot token, your chat id, the signing keys — are not listed and cannot be read or changed here.
          They live in Cloudflare's encrypted store. Cron times are also not here: they are UTC and set in
          <code> wrangler.toml</code>.
        </p>
      </section>

      {usage && (
        <>
          <section className="card">
            <header>
              <div>
                <h2>Database</h2>
                <p className="sub">
                  {usage.db.size_source === 'pragma'
                    ? 'Reported by SQLite'
                    : usage.db.size_source === 'estimated'
                      ? 'Estimated from row counts — D1 would not report the real figure'
                      : 'Size unavailable'}
                </p>
              </div>
              {usage.db.percent !== null && (
                <div className={`pct ${usage.db.percent > 80 ? 'bad' : 'ok'}`}>{usage.db.percent.toFixed(3)}%</div>
              )}
            </header>
            {usage.db.size_bytes !== null && (
              <>
                <p className="sub mono">
                  {bytes(usage.db.size_bytes)} of {bytes(usage.db.limit_bytes)} · {usage.db.total_rows.toLocaleString()} rows
                </p>
                <svg viewBox="0 0 100 6" preserveAspectRatio="none" className="ranked-bar" aria-hidden="true">
                  <rect x="0" y="0" width={Math.max(0.4, Math.min(100, usage.db.percent ?? 0))} height="6" rx="1.5" fill="var(--ok)" />
                </svg>
              </>
            )}
            <div className="scroller" style={{ marginTop: 10 }}>
              <table className="pts">
                <thead>
                  <tr>
                    <th>Table</th>
                    <th className="num">Rows</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.db.rows.filter((r) => r.count > 0).map((r) => (
                    <tr key={r.table}>
                      <td className="mono">{r.table}</td>
                      <td className="num strong">{r.count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <header>
              <div>
                <h2>Free tier</h2>
                <p className="sub">What you get, and what this app uses</p>
              </div>
            </header>
            <div className="scroller">
              <table className="pts">
                <thead>
                  <tr>
                    <th>Resource</th>
                    <th>Limit</th>
                    <th>In practice</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.free_tier.map((f) => (
                    <tr key={f.label}>
                      <td>{f.label}</td>
                      <td className="mono dim-num">{f.limit}</td>
                      <td className="sub">{f.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sub" style={{ marginTop: 12 }}>{usage.worker.note}</p>
          </section>
        </>
      )}
    </>
  );
}
