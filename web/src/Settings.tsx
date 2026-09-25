import { useEffect, useState } from 'react';
import {
  fetchForecastAccuracy,
  fetchIntelligenceMetrics,
  fetchPlatform,
  money,
  fetchSettings,
  fetchUsage,
  runMigrate,
  runSeed,
  saveSetting,
  fetchReadiness,
  type IntelligenceMetrics,
  type PlatformReport,
  type TrainingReadiness,
  type SettingRow,
  type Usage,
} from './api';
import { CountBars } from './charts';

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
    fetchUsage()
      .then(setUsage)
      .catch((e) => setMsg({ kind: 'err', text: (e as Error).message }));
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

          <Maintenance />

          <Intelligence />

          <Platform />

          <StorageNotes usage={usage} />

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

// Today is its own question — "is the thing I just deployed working" — and it
// is the one window a weekly view cannot answer.
const WINDOWS: { days: number; label: string }[] = [
  { days: 1, label: 'today' },
  { days: 2, label: 'today and yesterday' },
  { days: 7, label: 'last 7 days' },
  { days: 14, label: 'last 14 days' },
  { days: 30, label: 'last 30 days' },
];

/** A number against its daily allowance, with the number said out loud. */

/**
 * How well the app's own estimates are doing, and whether it has enough
 * confirmed data to do better.
 *
 * Put in Settings rather than on the home screen on purpose: this is the
 * app grading itself, which is worth being able to check and not worth
 * interrupting anyone with. The numbers are also the baseline any future model
 * has to beat, recorded before there was a model anyone wanted to like.
 */
function Intelligence() {
  const [readiness, setReadiness] = useState<TrainingReadiness | null>(null);
  const [metrics, setMetrics] = useState<IntelligenceMetrics | null>(null);
  const [accuracy, setAccuracy] = useState<{
    evaluated: number;
    mae_cents: number;
    bias_cents: number;
    coverage: number;
    by_model: { model: string; mae_cents: number; coverage: number; n: number }[];
  } | null>(null);

  useEffect(() => {
    fetchReadiness().then(setReadiness).catch(() => {});
    fetchIntelligenceMetrics().then(setMetrics).catch(() => {});
    fetchForecastAccuracy().then(setAccuracy).catch(() => {});
  }, []);

  const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);

  return (
    <section className="card">
      <header>
        <div>
          <h2>Intelligence</h2>
          <p className="sub">What the app estimates, and how often it turns out to be right</p>
        </div>
      </header>

      {metrics && (
        <>
          <h3>Merchant and code resolution</h3>
          {metrics.resolutions === 0 ? (
            <p className="sub">{metrics.note}</p>
          ) : (
            <ul className="stmt-summary">
              <li>
                resolved without asking <span className="mono">{pct(metrics.coverage)}</span>
              </li>
              <li>
                sent to review <span className="mono">{pct(metrics.abstention_rate)}</span>
              </li>
              <li>
                later corrected <span className="mono">{pct(metrics.correction_rate)}</span>
              </li>
              <li>
                high-confidence precision <span className="mono">{pct(metrics.high_confidence_precision)}</span>
              </li>
              <li>
                questions not worth asking <span className="mono">{metrics.spared_by_reward_impact}</span>
              </li>
            </ul>
          )}
        </>
      )}

      {readiness && (
        <>
          <h3>Training data</h3>
          <p className="sub">
            {readiness.labels} of {readiness.thresholds.min_labels} confirmed labels,{' '}
            {readiness.distinct_merchants} of {readiness.thresholds.min_merchants} distinct merchants,{' '}
            {readiness.categories_meeting_bar} of {readiness.thresholds.min_categories} categories with at least{' '}
            {readiness.thresholds.min_per_category}.
          </p>
          <p className="sub dim">{readiness.verdict}</p>
        </>
      )}

      {accuracy && accuracy.evaluated > 0 && (
        <>
          <h3>Forecast accuracy</h3>
          <ul className="stmt-summary">
            <li>
              scored forecasts <span className="mono">{accuracy.evaluated}</span>
            </li>
            <li>
              average error <span className="mono">${money(accuracy.mae_cents)}</span>
            </li>
            <li>
              bias <span className="mono">${money(accuracy.bias_cents)}</span>
            </li>
            <li>
              interval coverage <span className="mono">{Math.round(accuracy.coverage * 100)}%</span>
              <span className="sub"> (80% is the target)</span>
            </li>
          </ul>
          {accuracy.by_model.length > 1 && (
            <p className="sub dim">
              Best method so far: {accuracy.by_model[0].model.replace(/_/g, ' ')} at $
              {money(accuracy.by_model[0].mae_cents)} average error over {accuracy.by_model[0].n}.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Allowance({ label, used, cap, unit }: { label: string; used: number | null; cap: number; unit: string }) {
  const pct = used === null ? null : Math.min(100, (used / cap) * 100);
  const tone = pct === null ? 'ok' : pct >= 80 ? 'bad' : pct >= 50 ? 'mid' : 'ok';
  return (
    <li className="allow">
      <div className="allow-head">
        <span>{label}</span>
        <span className="mono">
          {used === null ? '—' : used.toLocaleString()} / {cap.toLocaleString()} {unit}
        </span>
      </div>
      <div className="meter">
        <span className={`fill ${tone}`} style={{ width: `${pct ?? 0}%` }} />
      </div>
      <span className="sub">{pct === null ? 'no data for this window' : `${pct.toFixed(pct < 1 ? 2 : 0)}% of the daily free allowance on the busiest day`}</span>
    </li>
  );
}

/**
 * What Cloudflare's own meters say.
 *
 * Everything above is counted from inside the database. This is the outside
 * view — the numbers a bill would be based on. It is optional: without a token
 * the panel says exactly what is missing rather than showing zeros, because a
 * dashboard that reads "0 requests" when it simply cannot see is worse than one
 * that admits it.
 */
function Platform() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<PlatformReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDiag, setShowDiag] = useState(false);

  function load(d = days) {
    setBusy(true);
    setErr(null);
    fetchPlatform(d)
      .then(setData)
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  }
  useEffect(() => load(days), [days]);

  return (
    <section className="card">
      <header>
        <div>
          <h2>Cloudflare</h2>
          <p className="sub">What the platform itself says this app costs</p>
        </div>
        <select className="range-select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {WINDOWS.map((w) => (
            <option key={w.days} value={w.days}>
              {w.label}
            </option>
          ))}
        </select>
      </header>

      {err && <p className="error">{err}</p>}
      {!data && !err && <p className="sub">{busy ? 'Asking Cloudflare…' : 'Loading…'}</p>}

      {data && !data.configured && (
        <>
          <p className="cap">Not set up yet. It needs four things, and one of them is a secret.</p>
          <ul className="notes">
            {data.missing.map((m) => (
              <li key={m}>
                <code>{m}</code>
              </li>
            ))}
          </ul>
          <p className="sub">
            The three ids go in the settings above — none of them is a credential. The token is a secret and is set with{' '}
            <code>wrangler secret put CF_API_TOKEN</code>, or in the Cloudflare dashboard under the Worker&rsquo;s
            Settings → Variables. It needs one permission: <strong>Account → Account Analytics → Read</strong>. See
            SETUP.md for the walkthrough.
          </p>
        </>
      )}

      {data && data.configured && (
        <>
          <p className="sub mono">
            {data.from === data.to ? data.from : `${data.from} → ${data.to}`} · {data.script} ·{' '}
            {data.days} day{data.days === 1 ? '' : 's'}
          </p>

          <h3 className="panel-h">Worker</h3>
          {data.worker.error ? (
            <p className="cap">{data.worker.error}</p>
          ) : (
            <>
              <div className="stat-row">
                <div className="stat">
                  <span className="stat-label">invocations</span>
                  <span className="stat-value">{data.worker.requests.toLocaleString()}</span>
                  <span className="stat-sub">{data.worker.per_day.toLocaleString()} a day</span>
                </div>
                <div className="stat">
                  <span className="stat-label">errors</span>
                  <span className={`stat-value ${data.worker.errors > 0 ? 'bad' : ''}`}>
                    {data.worker.errors.toLocaleString()}
                  </span>
                  <span className="stat-sub">{data.worker.error_percent.toFixed(2)}% of requests</span>
                </div>
                <div className="stat">
                  <span className="stat-label">CPU, typical</span>
                  <span className="stat-value">
                    {data.worker.cpu_median_ms === null ? '—' : `${data.worker.cpu_median_ms}ms`}
                  </span>
                  {/* The median is the request you actually get; p99 is the one
                      in a hundred that is slowest, and is the only reason the
                      old panel read 41ms for what was 41 microseconds. */}
                  <span className="stat-sub">
                    {data.worker.cpu_p99_ms === null ? 'median per invocation' : `p99 ${data.worker.cpu_p99_ms}ms`}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">subrequests</span>
                  <span className="stat-value">{data.worker.subrequests.toLocaleString()}</span>
                  <span className="stat-sub">outbound calls it made</span>
                </div>
              </div>
              {data.worker.by_status.length > 0 && (
                <p className="sub">
                  By outcome: {data.worker.by_status.map((s) => `${s.status} ${s.requests.toLocaleString()}`).join(' · ')}
                </p>
              )}
              {/* The count says 17 exceptions; only the logs say which line
                  threw. Empty here is a real state with a real cause, so it
                  reports the cause rather than showing nothing. */}
              {data.worker.errors > 0 &&
                (data.worker.errors_seen.length > 0 ? (
                  <ul className="notes errors-seen">
                    {data.worker.errors_seen.slice(0, 5).map((e) => (
                      <li key={e.message}>
                        <span className="count">{e.count}×</span> <code>{e.message}</code>
                        {e.last_seen && <span className="sub"> last {e.last_seen}</span>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  data.worker.errors_error && <p className="sub">Messages: {data.worker.errors_error}</p>
                ))}
              {data.worker.totals_only ? (
                <p className="sub">Your account does not break these down by day, so only the totals are shown.</p>
              ) : (
                data.worker.days.length > 0 && (
                  <CountBars
                    data={data.worker.days.map((d) => ({ date: d.date, value: d.requests, overlay: d.errors }))}
                    label="invocations"
                    overlayLabel="errors"
                  />
                )
              )}
            </>
          )}

          <h3 className="panel-h">D1 database</h3>
          {data.d1.error ? (
            <p className="cap">{data.d1.error}</p>
          ) : (
            <>
              <div className="stat-row">
                <div className="stat">
                  <span className="stat-label">rows read</span>
                  <span className="stat-value">{data.d1.rows_read.toLocaleString()}</span>
                  <span className="stat-sub">
                    {data.d1.rows_per_read === null ? '—' : `${data.d1.rows_per_read.toLocaleString()} per query`}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">rows written</span>
                  <span className="stat-value">{data.d1.rows_written.toLocaleString()}</span>
                  <span className="stat-sub">{data.d1.write_queries.toLocaleString()} write queries</span>
                </div>
                <div className="stat">
                  <span className="stat-label">queries</span>
                  <span className="stat-value">
                    {(data.d1.read_queries + data.d1.write_queries).toLocaleString()}
                  </span>
                  <span className="stat-sub">
                    {data.d1.latency_avg_ms === null
                      ? `${data.d1.read_queries.toLocaleString()} reads`
                      : `${data.d1.latency_avg_ms}ms average`}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">database</span>
                  <span className="stat-value">{data.d1.size_bytes === null ? '—' : bytes(data.d1.size_bytes)}</span>
                  <span className="stat-sub">
                    {data.d1.size_change_bytes === null
                      ? 'current size'
                      : `${data.d1.size_change_bytes >= 0 ? '+' : '−'}${bytes(Math.abs(data.d1.size_change_bytes))} this window`}
                  </span>
                </div>
              </div>
              {(data.d1.latency_p90_ms !== null || data.d1.response_bytes > 0) && (
                <p className="sub">
                  {data.d1.latency_p90_ms !== null && <>Slowest 10% of batches take {data.d1.latency_p90_ms}ms. </>}
                  {data.d1.response_bytes > 0 && <>{bytes(data.d1.response_bytes)} of query results returned.</>}
                </p>
              )}
              {/* Rows read per query is the one number that says whether a query
                  found its rows by index or walked the table to reach them. */}
              {data.d1.rows_per_read !== null && data.d1.rows_per_read > 1000 && (
                <p className="cap">
                  {data.d1.rows_per_read.toLocaleString()} rows read per query — something is scanning a table rather
                  than using an index. Worth finding before the free tier notices.
                </p>
              )}
              {data.d1.days.length > 0 && (
                <CountBars
                  data={data.d1.days.map((d) => ({ date: d.date, value: d.rows_read, overlay: d.rows_written }))}
                  label="rows read"
                  overlayLabel="rows written"
                />
              )}

              {/* Rows read is never spread evenly: one statement missing an
                  index reads more in a week than everything else together.
                  D1 keeps the SQL, minus bound parameters, so the answer can
                  be named instead of guessed at. */}
              <h3 className="panel-h">Where the rows go</h3>
              {data.d1.heavy.length > 0 ? (
                <ol className="heavy">
                  {data.d1.heavy.map((q, i) => (
                    <li key={i}>
                      <div className="heavy-head">
                        <span className="mono">
                          {q.rows_read.toLocaleString()} read · {q.share_percent.toFixed(0)}%
                        </span>
                        <span className="sub">
                          {q.runs.toLocaleString()} run{q.runs === 1 ? '' : 's'} · {q.rows_per_run.toLocaleString()} a run
                          {q.rows_written > 0 && ` · ${q.rows_written.toLocaleString()} written`}
                          {q.duration_ms !== null && ` · ${q.duration_ms.toLocaleString()}ms`}
                        </span>
                      </div>
                      <div className="meter">
                        <span
                          className={`fill ${q.share_percent >= 40 ? 'bad' : q.share_percent >= 15 ? 'mid' : 'ok'}`}
                          style={{ width: `${Math.min(100, q.share_percent)}%` }}
                        />
                      </div>
                      <code className="sql">{q.sql}</code>
                      {q.rows_per_run > 1000 && (
                        <p className="cap">
                          {q.rows_per_run.toLocaleString()} rows for one run — this is walking a table. An index on what
                          it filters by would turn that into single figures.
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="sub">
                  {data.d1.heavy_error ?? 'No per-query breakdown for this window.'}
                </p>
              )}
            </>
          )}

          {/* The free tier is a DAILY allowance, so the busiest day is the one
              that decides whether it runs out — an average over a quiet week
              would hide the day that did. */}
          <h3 className="panel-h">Against the free tier</h3>
          <ul className="allowances">
            <Allowance
              label="Worker invocations, busiest day"
              used={
                data.free_tier.worker_peak_percent === null
                  ? null
                  : Math.round((data.free_tier.worker_peak_percent / 100) * data.free_tier.worker_requests_per_day)
              }
              cap={data.free_tier.worker_requests_per_day}
              unit="a day"
            />
            <Allowance
              label="Rows read, busiest day"
              used={
                data.free_tier.d1_rows_read_peak_percent === null
                  ? null
                  : Math.round((data.free_tier.d1_rows_read_peak_percent / 100) * data.free_tier.d1_rows_read_per_day)
              }
              cap={data.free_tier.d1_rows_read_per_day}
              unit="a day"
            />
            <Allowance
              label="Rows written, busiest day"
              used={
                data.free_tier.d1_rows_written_peak_percent === null
                  ? null
                  : Math.round(
                      (data.free_tier.d1_rows_written_peak_percent / 100) * data.free_tier.d1_rows_written_per_day
                    )
              }
              cap={data.free_tier.d1_rows_written_per_day}
              unit="a day"
            />
          </ul>

          <div className="entry-foot">
            <button className="secondary" onClick={() => load()} disabled={busy}>
              {busy ? 'Refreshing…' : 'Refresh'}
            </button>
            <button className="secondary" onClick={() => setShowDiag((v) => !v)}>
              {showDiag ? 'Hide what was asked' : 'What was asked'}
            </button>
          </div>

          {/* Which query shapes Cloudflare accepted. Fields and dimensions vary
              by dataset and by plan, so the panel tries several — and when the
              numbers look wrong, this is what says why. */}
          {showDiag && (
            <ul className="notes">
              {data.attempts.map((a, i) => (
                <li key={i}>
                  <span className={a.ok ? 'ok-text' : 'bad-text'}>{a.ok ? '✓' : '✕'}</span> <code>{a.query}</code>
                  {a.error && <> — {a.error}</>}
                </li>
              ))}
            </ul>
          )}

          <p className="sub">Cloudflare keeps about 30 days of this, and the most recent hours can lag.</p>
        </>
      )}
    </section>
  );
}

/**
 * Which tables actually grow, and how fast. The honest answer to "should I
 * delete old transactions" is no — this shows why, in this database's own
 * numbers rather than as an assertion.
 */
function StorageNotes({ usage }: { usage: Usage }) {
  const { feed_items: feed, transactions: tx, transactions_years_to_1pct: years } = usage.storage;
  return (
    <section className="card">
      <header>
        <div>
          <h2>What grows</h2>
          <p className="sub">Only two tables grow on their own, and not at the same rate</p>
        </div>
      </header>
      <ul className="notes">
        <li>
          <strong>Scanned items</strong> — {feed.rows.toLocaleString()} rows, {bytes(feed.text_bytes)} of text. Each
          carries an excerpt and the phrases it matched, which is most of its size. Judged items older than{' '}
          {feed.retention_days} days are compacted nightly; {feed.compactable.toLocaleString()} are due now, worth about{' '}
          {bytes(feed.reclaimable_bytes)}. The Offers tab can do it on demand.
        </li>
        <li>
          <strong>Transactions</strong> — {tx.rows.toLocaleString()} rows at about {tx.bytes_per_row} bytes each,{' '}
          {bytes(tx.text_bytes)} in total{tx.oldest ? `, back to ${tx.oldest}` : ''}.
          {years != null && years > 0 ? (
            <>
              {' '}
              At the rate you are logging, transactions would need{' '}
              <strong>{years < 1000 ? Math.round(years).toLocaleString() : '1,000+'} years</strong> to reach 1% of the
              5 GB allowance. Deleting or summarising old ones would save nothing worth having and would break the
              trends, the reward audit and the portfolio check, all of which read the full history.
            </>
          ) : (
            ' Too few rows yet to project a growth rate, but a transaction is a hundred-odd bytes — the history is not what fills a database.'
          )}
        </li>
      </ul>
    </section>
  );
}

/**
 * Bringing the database up to date, and loading the reference data.
 *
 * Both used to be bot-only, which is the wrong place for them: the error that
 * calls for a migration appears here, in the app, right after a deploy.
 */
function Maintenance() {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

  async function migrate() {
    setBusy('migrate');
    setMsg(null);
    try {
      const r = await runMigrate();
      setMsg(
        r.alreadyCurrent
          ? 'Already up to date.'
          : `Created ${r.created.length} table(s), added ${r.altered.length} column(s).` +
              (r.errors.length ? ` ${r.errors.length} problem(s): ${r.errors[0]}` : '')
      );
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function seed() {
    setBusy('seed');
    setMsg(null);
    try {
      await runSeed();
      setMsg('Reference data loaded: merchant codes, programmes and transfer routes. Your own edits were left alone.');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="card">
      <header>
        <div>
          <h2>Maintenance</h2>
          <p className="sub">After a deploy, or when a screen says the database is behind the code</p>
        </div>
      </header>
      <div className="entry-foot">
        <button className="secondary" onClick={migrate} disabled={!!busy}>
          {busy === 'migrate' ? 'Migrating…' : 'Bring the database up to date'}
        </button>
        <button className="secondary" onClick={seed} disabled={!!busy}>
          {busy === 'seed' ? 'Loading…' : 'Load reference data'}
        </button>
        {msg && <span className="sub">{msg}</span>}
      </div>
      <p className="sub">
        Both are safe to repeat. Migrating only fills gaps; loading reference data refreshes merchant-code descriptions
        and adds any missing programmes or routes, without touching categories or rates you have changed.
      </p>
    </section>
  );
}
