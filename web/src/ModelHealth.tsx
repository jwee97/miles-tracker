import { useEffect, useState } from 'react';
import { fetchModelHealth, type ModelHealth as Health, type ModelRow } from './api';

/**
 * What the model is doing, as opposed to what it tested at.
 *
 * Deliberately not on the home screen. This is the app grading itself, which
 * is worth being able to check and not worth interrupting anybody with — and
 * the moment it becomes a dashboard somebody watches, the temptation is to
 * optimise the number on it rather than the answer underneath.
 *
 * The figure to read is the correction rate. Coverage can always be bought by
 * abstaining less; corrections are what that costs, and a model with excellent
 * validation and a bad correction rate was validated on the wrong
 * distribution.
 */

const pct = (n: number | null | undefined) => (typeof n === 'number' ? `${Math.round(n * 100)}%` : '—');
const num = (n: number | null | undefined) => (typeof n === 'number' ? String(n) : '—');

const STATUS: Record<Health['status'], { label: string; cls: string }> = {
  healthy: { label: 'Healthy', cls: 'ok' },
  watch: { label: 'Worth watching', cls: 'soon' },
  degraded: { label: 'Degraded', cls: 'critical' },
  unproven: { label: 'Not yet provable', cls: 'never' },
  none: { label: 'No model live', cls: 'never' },
};

export default function ModelHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  const [history, setHistory] = useState<ModelRow[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchModelHealth()
      .then((d) => {
        setHealth(d.health);
        setHistory(d.history ?? []);
      })
      .catch(() => setFailed(true));
  }, []);

  if (failed || !health) return null;
  const s = STATUS[health.status];

  return (
    <section className="card">
      <header>
        <div>
          <h2>Merchant intelligence</h2>
          <p className="sub">How the code detector is doing on your actual spending, not on the data it trained beside</p>
        </div>
        <span className={`chip ${s.cls}`}>{s.label}</span>
      </header>

      {health.model ? (
        <p className="sub">
          <b>
            {health.model.key} v{health.model.version}
          </b>{' '}
          · {health.model.architecture} · live since {health.model.deployed_at ?? 'unknown'}
        </p>
      ) : (
        <p className="sub">Nothing is deployed. Codes come from evidence alone, and unknown merchants go to Review.</p>
      )}

      {health.notes.map((n, i) => (
        <p key={i} className={health.status === 'degraded' ? 'warn-num' : 'sub'}>
          {n}
        </p>
      ))}

      {health.model && (
        <>
          <h3>What it scored before deployment</h3>
          <ul className="stmt-summary">
            <li>
              trained on <span className="mono">{health.training.examples.toLocaleString()}</span>
            </li>
            <li>
              codes it can name <span className="mono">{num(health.training.classes)}</span>
            </li>
            <li>
              rarest code seen <span className="mono">{num(health.training.min_class_support)}×</span>
            </li>
            <li>
              accuracy <span className="mono">{pct(health.training.accuracy)}</span>
            </li>
            <li>
              macro F1 <span className="mono">{num(health.training.macro_f1)}</span>
            </li>
            <li>
              high-confidence precision <span className="mono">{pct(health.training.high_confidence_precision)}</span>
            </li>
          </ul>

          {/*
            Calibration answers a different question from precision: not "is it
            right when it is sure", but "does 80% mean eighty per cent". The
            threshold is only worth moving if the numbers underneath are honest.
          */}
          <p className="sub dim">
            Calibration error {num(health.training.ece)} · Brier {num(health.training.brier)} — lower is better; below
            0.05 means a stated probability is close to how often it turns out right.
          </p>

          <h3>What it has done since</h3>
          <ul className="stmt-summary">
            <li>
              consulted <span className="mono">{health.live.consulted}</span>
            </li>
            <li>
              declined to answer <span className="mono">{health.live.abstained}</span> ({pct(health.live.abstention_rate)})
            </li>
            <li>
              resolved on its own <span className="mono">{health.live.auto_resolved}</span>
            </li>
            <li>
              sent to Review <span className="mono">{health.live.asked}</span>
            </li>
            <li>
              later corrected <span className="mono">{health.live.corrected}</span>
            </li>
          </ul>

          <p className={health.live.correction_rate > 0.05 ? 'warn-num' : 'sub'}>
            <b>Correction rate {pct(health.live.correction_rate)}</b> — of what it resolved without asking, how much a
            person later changed. This is the number that decides whether it stays.
          </p>

          {health.live.why_it_declined.length > 0 && (
            <details className="trail">
              <summary>Why it declined ({health.live.abstained})</summary>
              <ul className="notes">
                {health.live.why_it_declined.map((r) => (
                  <li key={r.reason}>
                    <strong>{r.n}×</strong> {r.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {health.latency.samples > 0 && (
            <>
              <h3>What it costs to run</h3>
              <ul className="stmt-summary">
                <li>
                  median <span className="mono">{health.latency.p50_ms} ms</span>
                </li>
                <li>
                  95th <span className="mono">{health.latency.p95_ms} ms</span>
                </li>
                <li>
                  slowest <span className="mono">{health.latency.max_ms} ms</span>
                </li>
                <li>
                  database, median <span className="mono">{health.latency.p50_db_ms} ms</span>
                </li>
                <li>
                  database, 95th <span className="mono">{health.latency.p95_db_ms} ms</span>
                </li>
                <li>
                  rows read, 95th <span className="mono">{health.latency.p95_rows}</span>
                </li>
                <li>
                  worst descriptor <span className="mono">{health.latency.max_ngrams} fragments</span>
                </li>
              </ul>
              <p className="sub dim">
                Measured in the requests that ran, not in a benchmark — the real cost here is the round trip to the
                database for this descriptor&rsquo;s fragments, and only production can say what that is.
              </p>
            </>
          )}
        </>
      )}

      {history.length > 0 && (
        <details className="trail">
          <summary>Every version ({history.length})</summary>
          <ul className="notes">
            {history.map((m) => (
              <li key={m.id}>
                <strong>v{m.version}</strong> · {m.status} · {m.training_examples.toLocaleString()} labels
                {m.note && <div className="sub">{m.note}</div>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="sub dim">
        A model that starts getting things wrong is retired automatically on the nightly job, and codes go back to
        being read from evidence. Putting a new one in its place stays a decision with a person in it.
      </p>
    </section>
  );
}
