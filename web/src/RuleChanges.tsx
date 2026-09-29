import { useEffect, useState } from 'react';
import {
  applyRuleChange,
  checkRuleChanges,
  dismissRuleChange,
  fetchRuleChanges,
  type PendingRuleChange,
} from './api';

/**
 * Rate changes a bank made to its own card, spotted and waiting for a person.
 *
 * Nothing here publishes itself. A page read by a machine is a reason to look,
 * not a fact about what a card pays, so what the page said arrives as an
 * editable starting point and what gets published is whatever the reviewer
 * leaves in the boxes. The date the new rates start from matters as much as the
 * rates: get it wrong and the app quietly restates what last month earned.
 */

type Draft = PendingRuleChange['proposed'][number];

const dollars = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2));
const cents = (s: string) => {
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return s.trim() === '' || !Number.isFinite(n) ? null : Math.round(n * 100);
};

function Change({ c, onDone }: { c: PendingRuleChange; onDone: () => void }) {
  const [rules, setRules] = useState<Draft[]>(c.proposed.map((r) => ({ ...r })));
  const [from, setFrom] = useState(c.effective_from ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = (i: number, patch: Partial<Draft>) =>
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function apply() {
    setBusy(true);
    setErr(null);
    const r = await applyRuleChange(c.id, rules.filter((x) => x.mpd !== null), from || undefined).catch((e) => ({
      ok: false as const,
      error: (e as Error).message,
    }));
    setBusy(false);
    if (!r.ok) setErr(r.error ?? 'could not publish');
    else onDone();
  }

  async function dismiss() {
    setBusy(true);
    setErr(null);
    const r = await dismissRuleChange(c.id, note || undefined).catch((e) => ({
      ok: false as const,
      error: (e as Error).message,
    }));
    setBusy(false);
    if (!r.ok) setErr(r.error ?? 'could not dismiss');
    else onDone();
  }

  return (
    <li className={c.material ? 'unknown' : 'pass'}>
      <span>
        <strong>
          {c.issuer} {c.product_name}
        </strong>{' '}
        {c.material ? (
          <span className="chip critical">changes what it pays</span>
        ) : (
          <span className="chip never">wording only</span>
        )}
      </span>
      <p className="sub">
        Spotted {c.detected_at.slice(0, 10)} on{' '}
        <a className="link" href={c.source_url} target="_blank" rel="noreferrer">
          the bank&rsquo;s own page
        </a>
      </p>

      <ul className="rules">
        {c.diff.map((d, i) => (
          <li key={i} className={d.material ? 'fail' : 'unknown'}>
            <span>{d.summary}</span>
            <p className="sub mono">
              {d.category ?? 'card'} · {d.field} · {String(d.before ?? '—')} → {String(d.after ?? '—')}
            </p>
          </li>
        ))}
        {!c.diff.length && <li className="unknown">No difference worth reporting — the page was only refreshed.</li>}
      </ul>

      <details>
        <summary className="sub">What would be published ({rules.length} rules) — edit before applying</summary>
        <table className="grid rule-draft">
          <thead>
            <tr>
              <th>Category</th>
              <th>Rate</th>
              <th>Earns</th>
              <th>Cap (SGD)</th>
              <th>Per</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((r, i) => (
              <tr key={i}>
                <td>
                  <input value={r.category} onChange={(e) => set(i, { category: e.target.value })} />
                </td>
                <td>
                  <input
                    className="mono"
                    inputMode="decimal"
                    value={r.mpd === null ? '' : String(r.mpd)}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      set(i, { mpd: e.target.value.trim() === '' || !Number.isFinite(n) ? null : n });
                    }}
                  />
                </td>
                <td>
                  <select value={r.reward_type ?? 'miles'} onChange={(e) => set(i, { reward_type: e.target.value })}>
                    <option value="miles">miles</option>
                    <option value="points">points</option>
                    <option value="cashback">cashback</option>
                  </select>
                </td>
                <td>
                  <input
                    className="mono"
                    inputMode="decimal"
                    value={dollars(r.cap_cents)}
                    onChange={(e) => set(i, { cap_cents: cents(e.target.value) })}
                  />
                </td>
                <td>
                  <select value={r.cap_window ?? ''} onChange={(e) => set(i, { cap_window: e.target.value || null })}>
                    <option value="">no cap</option>
                    <option value="monthly">month</option>
                    <option value="statement">statement</option>
                    <option value="yearly">year</option>
                  </select>
                </td>
                <td>
                  <button className="secondary" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>
                    Drop
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rules.some((r) => r.quote) && (
          <p className="sub dim">
            Quoted from the page: {rules.find((r) => r.quote)?.quote?.slice(0, 200)}
          </p>
        )}
      </details>

      <div className="entry-foot rule-actions">
        <label className="sub">
          New rates start
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <input
          placeholder="Note (why, or why not)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button disabled={busy || !rules.some((r) => r.mpd !== null)} onClick={apply}>
          Publish as a new version
        </button>
        <button className="secondary" disabled={busy} onClick={dismiss}>
          Not a change
        </button>
      </div>
      <p className="sub dim">
        Publishing closes the current version the day before this date. Anything earned before it keeps the rates it was
        earned under.
      </p>
      {err && <p className="err-text">{err}</p>}
    </li>
  );
}

export default function RuleChanges() {
  const [changes, setChanges] = useState<PendingRuleChange[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<string | null>(null);

  function load() {
    fetchRuleChanges()
      .then((d) => setChanges(d.changes))
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(load, []);

  async function check() {
    setBusy(true);
    setChecked(null);
    try {
      const r = await checkRuleChanges();
      setChecked(
        `${r.checked} page${r.checked === 1 ? '' : 's'} read · ${r.changed} changed · ${r.material} that change what a card pays` +
          (r.failed.length ? ` · ${r.failed.length} could not be read` : '')
      );
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (err) return <section className="card"><h2>Rate changes</h2><p className="err-text">{err}</p></section>;

  return (
    <section className="card">
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>Rate changes waiting for you{changes?.length ? ` (${changes.length})` : ''}</h2>
        <button className="secondary" disabled={busy} onClick={check}>
          {busy ? 'Reading…' : 'Check now'}
        </button>
      </div>
      <p className="sub">
        The cards you hold have their own pages re-read each night. A page that no longer says what it used to says only
        that something is worth checking — nothing is published until you say so.
      </p>
      {checked && <p className="sub mono">{checked}</p>}
      {!changes ? (
        <p className="sub">Loading…</p>
      ) : changes.length === 0 ? (
        <p className="sub">Nothing changed. The last read of every page matched what the app already holds.</p>
      ) : (
        <ul className="rules">
          {changes.map((c) => (
            <Change key={c.id} c={c} onDone={load} />
          ))}
        </ul>
      )}
    </section>
  );
}
