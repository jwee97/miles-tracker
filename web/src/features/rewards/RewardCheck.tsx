import { useEffect, useState } from 'react';
import {
  applyStatementMcc,
  fetchReconciliation,
  fetchRewardCandidates,
  money,
  resolveRewardCandidate,
  type ReconciliationResult,
  type RewardCandidate,
} from '../../api';

/**
 * Did the bank credit what it owed?
 *
 * The screen deliberately never says the bank got it wrong. It shows what was
 * expected, what arrived, and the transactions that would account for the gap —
 * and the most likely explanation is usually that the app's own expectation was
 * wrong, so that possibility is offered first.
 */

const LOOK: Record<string, { label: string; cls: string; mark: string }> = {
  matched: { label: 'Matches', cls: 'ok', mark: '✓' },
  within_tolerance: { label: 'Matches, allowing for rounding', cls: 'ok', mark: '✓' },
  undercredited: { label: 'Possible shortfall', cls: 'critical', mark: '⚠' },
  overcredited: { label: 'More than expected', cls: 'soon', mark: '⚠' },
  incomplete: { label: 'Not credited yet', cls: 'never', mark: '⏳' },
  needs_review: { label: 'Needs a look', cls: 'soon', mark: '⚠' },
};

const WORDS: Record<string, string> = {
  base: 'base',
  category_bonus: 'category bonus',
  campaign_bonus: 'campaign bonus',
  minimum_spend_bonus: 'minimum-spend bonus',
  quarterly_reward: 'quarterly reward',
  total: 'total',
};

const amount = (n: number, unit: string) =>
  unit === 'cents' ? `$${money(Math.round(n))}` : `${Math.round(n).toLocaleString()} ${unit}`;

function Detail({ r }: { r: ReconciliationResult }) {
  const [mcc, setMcc] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div className="recon-detail">
      <table className="score-table">
        <tbody>
          {r.differences.map((d) => (
            <tr key={d.component} className={d.within_tolerance ? '' : 'recon-off'}>
              <td>{WORDS[d.component] ?? d.component}</td>
              <td className="mono">{amount(d.expected, d.unit)}</td>
              <td className="mono">{amount(d.actual, d.unit)}</td>
              <td className={`mono ${d.difference < 0 ? 'bad-text' : d.difference > 0 ? 'warn-num' : ''}`}>
                {d.difference === 0 ? '—' : `${d.difference > 0 ? '+' : ''}${Math.round(d.difference).toLocaleString()}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {r.pending.length > 0 && (
        <p className="sub">
          Not due yet:{' '}
          {r.pending.map((p) => `${amount(p.amount, p.unit)}${p.expected_by ? ` by ${p.expected_by}` : ''}`).join(', ')}.
        </p>
      )}

      {r.explanations.length > 0 && (
        <>
          <h4>What might explain it</h4>
          <ul className="diff-list">
            {r.explanations.map((e, i) => (
              <li key={i} className={e.cause === 'rule_data_stale' ? 'changed' : 'removed'}>
                {e.text}
                {e.transaction_ids.length > 0 && (
                  <div className="advisor-row" style={{ marginTop: 8 }}>
                    <input
                      value={mcc[e.transaction_ids[0]] ?? ''}
                      onChange={(ev) => setMcc({ ...mcc, [e.transaction_ids[0]]: ev.target.value })}
                      inputMode="numeric"
                      placeholder="code on the statement"
                    />
                    <button
                      className="secondary"
                      disabled={!/^\d{4}$/.test(mcc[e.transaction_ids[0]] ?? '')}
                      onClick={async () => {
                        const res = await applyStatementMcc(e.transaction_ids[0], mcc[e.transaction_ids[0]]);
                        setMsg(
                          res.ok
                            ? `Re-priced: ${res.correction?.reward_before.toLocaleString()} → ${res.correction?.reward_after.toLocaleString()}. The merchant will use that code from now on.`
                            : (res.error ?? 'that did not work')
                        );
                      }}
                    >
                      Use the statement's code
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="sub">
            If the statement shows a different merchant code, that is usually the answer — and it means the expectation
            was wrong, not the credit.
          </p>
        </>
      )}
      {msg && <p className="ok-text">{msg}</p>}
    </div>
  );
}

function Candidates({ rows, onDone }: { rows: RewardCandidate[]; onDone: () => void }) {
  if (!rows.length) return null;
  return (
    <section className="card">
      <h2>Reward lines read off a statement ({rows.length})</h2>
      <p className="sub">
        Nothing here counts as "what the bank paid" until you accept it. A misread line that became an observation would
        corrupt the one record a check is made against.
      </p>
      <ul className="rules">
        {rows.map((c) => (
          <li key={c.id}>
            <span>
              <strong>{c.entry_type.replace(/_/g, ' ')}</strong> {amount(c.amount, c.unit)}{' '}
              <span className={`chip ${c.confidence === 'high' ? 'ok' : 'soon'}`}>{c.confidence}</span>
            </span>
            <p className="sub">{c.description}</p>
            <div className="entry-foot rule-actions">
              <button
                onClick={async () => {
                  await resolveRewardCandidate(c.id, 'accept');
                  onDone();
                }}
              >
                Accept
              </button>
              <button
                className="secondary"
                onClick={async () => {
                  await resolveRewardCandidate(c.id, 'reject');
                  onDone();
                }}
              >
                Not a credit
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function RewardCheck() {
  const [rows, setRows] = useState<ReconciliationResult[] | null>(null);
  const [candidates, setCandidates] = useState<RewardCandidate[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [periods, setPeriods] = useState(1);
  const [err, setErr] = useState<string | null>(null);

  function load() {
    fetchReconciliation(periods)
      .then((d) => setRows(d.results ?? []))
      .catch((e) => {
        setRows([]);
        setErr((e as Error).message);
      });
    fetchRewardCandidates()
      .then((d) => setCandidates(d.candidates ?? []))
      .catch(() => void 0);
  }
  useEffect(load, [periods]);

  if (!rows) return <p className="pad sub">Loading…</p>;

  return (
    <>
      <Candidates rows={candidates} onDone={load} />

      <section className="card">
        <div className="section-head" style={{ marginTop: 0 }}>
          <h2>Rewards check</h2>
          <div className="seg" role="group" aria-label="How far back">
            {[1, 3, 6].map((n) => (
              <button key={n} type="button" className={periods === n ? 'on' : ''} onClick={() => setPeriods(n)}>
                {n === 1 ? 'Latest' : `${n} periods`}
              </button>
            ))}
          </div>
        </div>
        <p className="sub">
          What the rules say each card owed, against what the bank credited. A difference is reported, never corrected —
          the app does not edit either side to make them agree.
        </p>
        {err && <p className="err-text">{err}</p>}

        {rows.length === 0 ? (
          <p className="sub">Nothing to check yet. Import a statement with its points summary and this fills in.</p>
        ) : (
          <ul className="recon-list">
            {rows.map((r, i) => {
              const look = LOOK[r.status];
              return (
                <li key={`${r.card.id}-${r.scope.start}`} className={`recon ${r.status}`}>
                  <div className="recon-head">
                    <span className="recon-mark">{look.mark}</span>
                    <div>
                      <p className="recon-card">
                        {r.card.product} <span className="sub">{r.scope.start} → {r.scope.end}</span>
                      </p>
                      <p className={`recon-status ${look.cls === 'critical' ? 'bad-text' : 'sub'}`}>
                        {look.label}
                        {r.confidence !== 'high' && <span className="chip soon">{r.confidence} confidence</span>}
                      </p>
                    </div>
                    <button className="link-btn" onClick={() => setOpen(open === i ? null : i)}>
                      {open === i ? 'Hide' : 'Detail'}
                    </button>
                  </div>
                  {open === i && <Detail r={r} />}
                </li>
              );
            })}
          </ul>
        )}
        <p className="sub">As of {rows[0]?.as_of ?? ''}.</p>
      </section>
    </>
  );
}
