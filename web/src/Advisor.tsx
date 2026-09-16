import { useEffect, useState } from 'react';
import { confirmMcc, money, recommendV2, type RecommendationV2 } from './api';
import ConfidenceBadge from './components/ConfidenceBadge';
import { AlternativePick, TopRecommendation } from './components/RecommendationCard';

const OBJECTIVES = [
  ['balanced', 'Balanced'],
  ['miles', 'Miles'],
  ['cashback', 'Cashback'],
  ['minspend', 'Hit minimums'],
];

const CHANNELS = [
  ['', 'Auto'],
  ['online', 'Online'],
  ['in_store', 'In store'],
  ['contactless', 'Contactless'],
];

/**
 * Which card to use.
 *
 * The answer is one card, so one card gets the page. Everything else —
 * runners-up, the cards that cannot be used, the arithmetic, what was assumed
 * — is available underneath without being in the way.
 */
export default function Advisor({ action }: { action?: (r: RecommendationV2) => React.ReactNode }) {
  const [merchant, setMerchant] = useState('');
  const [amount, setAmount] = useState('');
  const [channel, setChannel] = useState('');
  const [objective, setObjective] = useState('');
  const [rec, setRec] = useState<RecommendationV2 | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fixMcc, setFixMcc] = useState('');
  const [showConf, setShowConf] = useState(false);
  const [showIneligible, setShowIneligible] = useState(false);

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    if (!merchant.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setRec(await recommendV2({ merchant, amount, channel: channel || null, objective }));
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Re-rank when the objective or channel changes, without retyping.
  useEffect(() => {
    if (rec) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objective, channel]);

  const g = rec?.merchant;
  const top = rec?.recommendation ?? null;

  return (
    <>
      <form className="card advisor" onSubmit={run}>
        <h2>Which card should I use?</h2>
        <input
          id="adv-merchant"
          className="big-search"
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
          placeholder="Din Tai Fung"
          autoComplete="off"
        />
        <div className="advisor-row">
          <input
            id="adv-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="Amount (optional, but caps need it)"
          />
          <button type="submit" disabled={busy || !merchant.trim()}>
            {busy ? '…' : 'Check cards'}
          </button>
        </div>
        <div className="seg wrap" role="group" aria-label="Purchase type">
          {CHANNELS.map(([k, label]) => (
            <button key={k || 'auto'} type="button" className={channel === k ? 'on' : ''} onClick={() => setChannel(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="seg wrap" role="group" aria-label="Optimise for">
          {OBJECTIVES.map(([k, label]) => (
            <button key={k} type="button" className={objective === k ? 'on' : ''} onClick={() => setObjective(k)}>
              {label}
            </button>
          ))}
        </div>
        {err && <p className="err-text">{err}</p>}
      </form>

      {rec && (
        <>
          <section className="card merchant-head">
            <header>
              <div>
                <h2>{g?.merchant ?? merchant}</h2>
                <p className="sub">
                  {g?.mcc ? (
                    <>
                      Likely MCC {g.mcc} — {g.description}
                      {g.confidence === 'guess' && <span className="chip soon">guess</span>}
                      {g.confidence === 'confirmed' && <span className="chip ok">confirmed</span>}
                    </>
                  ) : (
                    'No merchant code on file — ranking on the category alone'
                  )}
                </p>
              </div>
            </header>

            <ConfidenceBadge
              confidence={rec.confidence}
              assumptions={rec.assumptions}
              open={showConf}
              onToggle={() => setShowConf((v) => !v)}
            />

            {g?.confidence !== 'confirmed' && (
              <details className="batches">
                <summary>Know the real code? Set it</summary>
                <div className="advisor-row" style={{ marginTop: 8 }}>
                  <input
                    id="adv-mcc"
                    value={fixMcc}
                    onChange={(e) => setFixMcc(e.target.value)}
                    inputMode="numeric"
                    placeholder="5812"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      if (!/^\d{4}$/.test(fixMcc)) return;
                      await confirmMcc(g?.merchant ?? merchant, fixMcc, g?.channel ?? undefined);
                      setFixMcc('');
                      run();
                    }}
                  >
                    Confirm
                  </button>
                </div>
                <p className="sub">
                  The code is set by the acquirer and differs between outlets, so a code read off a posted transaction
                  beats any guess. Once confirmed it is used everywhere.
                </p>
              </details>
            )}
          </section>

          {top ? (
            <TopRecommendation p={top} action={action?.(rec)} />
          ) : (
            <section className="card">
              <p className="sub">
                No card can be used for this purchase. The cards that were considered are below, each with the reason.
              </p>
            </section>
          )}

          {rec.split_advice && (
            <section className="card missed">
              <header>
                <div>
                  <h2>Split it</h2>
                  <p className="sub">The bonus allowance runs out part-way through this purchase</p>
                </div>
              </header>
              <p>
                Put the first <b>${money(rec.split_advice.bonus_cents)}</b> on <b>{top?.card.product}</b>, and the
                remaining <b>${money(rec.split_advice.remainder_cents)}</b> on <b>{rec.split_advice.use}</b> — that part
                earns {rec.split_advice.earns} instead of the base rate.
              </p>
              <p className="sub">Worth ${money(rec.split_advice.gain_cents)} more than leaving it all on one card.</p>
            </section>
          )}

          {rec.alternatives.length > 0 && (
            <section className="card">
              <header>
                <div>
                  <h2>Other options</h2>
                </div>
              </header>
              <ul className="picks-list">
                {rec.alternatives.map((p, i) => (
                  <AlternativePick key={p.card.id} p={p} rank={i + 2} />
                ))}
              </ul>
            </section>
          )}

          {rec.ineligible.length > 0 && (
            <section className="card">
              <div className="section-head" style={{ marginTop: 0 }}>
                <h2>Cannot be used here ({rec.ineligible.length})</h2>
                <button className="secondary" onClick={() => setShowIneligible((v) => !v)}>
                  {showIneligible ? 'Hide' : 'Show'}
                </button>
              </div>
              <p className="sub">
                Not merely behind — an excluded code, a closed card or no rules in force means the card cannot earn on
                this purchase at all, however good its rate.
              </p>
              {showIneligible && (
                <ul className="picks-list">
                  {rec.ineligible.map((p) => (
                    <AlternativePick key={p.card.id} p={p} rank={0} />
                  ))}
                </ul>
              )}
            </section>
          )}

          <p className="pad sub rec-foot">
            Worked out on {rec.evaluated_at} · card data: {rec.data_version}
          </p>
        </>
      )}
    </>
  );
}
