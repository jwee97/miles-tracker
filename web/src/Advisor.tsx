import { useEffect, useState } from 'react';
import { confirmMcc, fetchRecommend, money, type Evaluation, type Recommendation } from './api';

const OBJECTIVES = [
  ['balanced', 'Balanced'],
  ['miles', 'Miles'],
  ['cashback', 'Cashback'],
  ['minspend', 'Hit minimums'],
];

const rate = (e: Evaluation) =>
  e.reward_type === 'cashback' ? `${e.effective_rate.toFixed(2)}% back` : `${e.effective_rate} mpd`;

function Pick({ e, rank }: { e: Evaluation; rank: number }) {
  const [why, setWhy] = useState(false);
  const medal = ['🥇', '🥈', '🥉'][rank] ?? '  ';

  return (
    <li className={`pick ${rank === 0 && !e.excluded ? 'best' : ''} ${e.excluded ? 'excluded' : ''}`}>
      <div className="pick-top">
        <span className="pick-name">
          <span className="medal">{medal}</span>
          {e.card.product}
        </span>
        <span className="pick-earn mono">
          {e.excluded ? (
            <span className="bad-text">earns nothing</span>
          ) : (
            <>
              {e.reward_type === 'cashback'
                ? `$${money(e.cashback_cents)}`
                : `${e.miles.toLocaleString()} mi`}
            </>
          )}
        </span>
      </div>
      <div className="pick-meta">
        <span>{e.excluded ? (e.exclusion_reason ?? 'excluded') : rate(e)}</span>
        {!e.excluded && e.headroom_cents !== null && (
          <span className={e.headroom_cents === 0 ? 'warn-num' : ''}>
            {e.headroom_cents === 0
              ? 'bonus cap used up'
              : `$${money(e.headroom_cents)} bonus allowance left`}
          </span>
        )}
        {e.min_spend_short_cents > 0 && (
          <span className="warn-num">
            ${money(e.min_spend_short_cents)} short of its minimum
            {e.min_spend_days_left !== null && `, ${e.min_spend_days_left}d`}
          </span>
        )}
      </div>
      {e.base_portion_cents > 0 && e.bonus_portion_cents > 0 && (
        <p className="pick-split">
          ${money(e.bonus_portion_cents)} at the bonus rate · ${money(e.base_portion_cents)} at the base rate
        </p>
      )}
      <button type="button" className="link-btn why" onClick={() => setWhy((w) => !w)}>
        {why ? 'Hide' : 'Why?'}
      </button>
      {why && (
        <ol className="trace">
          {e.trace.map((s, i) => (
            <li key={i} className={s.pass === true ? 'ok' : s.pass === false ? 'no' : 'info'}>
              <span className="trace-check">{s.check}</span>
              <span className="trace-detail">{s.detail}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

export default function Advisor() {
  const [merchant, setMerchant] = useState('');
  const [amount, setAmount] = useState('');
  const [objective, setObjective] = useState('');
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fixMcc, setFixMcc] = useState('');

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    if (!merchant.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setRec(await fetchRecommend({ merchant, amount, objective }));
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Re-rank when the objective changes, without retyping.
  useEffect(() => {
    if (rec) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objective]);

  const g = rec?.merchant;

  return (
    <>
      <form className="card advisor" onSubmit={run}>
        <h2>Where are you spending?</h2>
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
            placeholder="Amount (optional)"
          />
          <button type="submit" disabled={busy || !merchant.trim()}>
            {busy ? '…' : 'Check'}
          </button>
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
          <section className="card">
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

            <ul className="picks-list">
              {rec.picks.map((p, i) => (
                <Pick key={p.card.id} e={p} rank={i} />
              ))}
            </ul>
          </section>

          {rec.split_advice && (
            <section className="card missed">
              <header>
                <div>
                  <h2>Split it</h2>
                  <p className="sub">The bonus allowance runs out part-way through this purchase</p>
                </div>
              </header>
              <p>
                Put the first <b>${money(rec.split_advice.bonus_cents)}</b> on{' '}
                <b>{rec.picks[0].card.product}</b>, and the remaining{' '}
                <b>${money(rec.split_advice.remainder_cents)}</b> on <b>{rec.split_advice.use}</b> — that part earns{' '}
                {rec.split_advice.earns} instead of the base rate.
              </p>
            </section>
          )}
        </>
      )}
    </>
  );
}
