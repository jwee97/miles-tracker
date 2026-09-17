import { useEffect, useState } from 'react';
import { money, simulateAcquisition, type AcquisitionReport, type AcquisitionSuggestion } from '../../api';

/**
 * Is a card missing from my setup?
 *
 * Gaps first, cards second. A screen that starts from products is a list of
 * things somebody might sell you; starting from your own spending can reach the
 * answer "nothing is missing", which is the more valuable half of this feature
 * and the one a card-first layout can never produce.
 */

const OBJECTIVES: [string, string][] = [
  ['balanced', 'Balanced'],
  ['maximise_miles', 'Maximise miles'],
  ['minimise_fees', 'Minimise annual fees'],
  ['simpler_wallet', 'Keep the wallet simple'],
];

function Suggestion({ s }: { s: AcquisitionSuggestion }) {
  const [open, setOpen] = useState(false);

  return (
    <li className="acq">
      <div className="acq-head">
        <div>
          <p className="acq-name">
            {s.product.issuer} {s.product.product_name}
          </p>
          <p className="sub">
            Could add about <b>${money(s.projected_annual_incremental_value_cents)}</b> a year in value
            {s.projected_extra_miles > 0 && ` (${s.projected_extra_miles.toLocaleString()} miles)`}
            {s.annual_fee_cents > 0 && ` · $${money(s.annual_fee_cents)} annual fee`}
          </p>
        </div>
        <span className={`chip ${s.confidence === 'high' ? 'ok' : s.confidence === 'medium' ? 'soon' : 'critical'}`}>
          {s.confidence}
        </span>
      </div>

      <p className="sub">
        Based on ${money(s.affected_spend_cents)} a year of spending it would improve
        {s.closes_gaps.length > 0 && `, closing your ${s.closes_gaps.join(' and ')} gap`}.
      </p>

      {/*
        The welcome bonus is never added to the ongoing value: one is recurring
        and the other happens once, and the sum is a number that means nothing.
      */}
      {s.welcome_offer && (
        <p className="ok-text">
          Separately, a welcome offer: {s.welcome_offer.reward}
          {s.welcome_offer.requires && ` for ${s.welcome_offer.requires}`}.
        </p>
      )}

      <p className="sub">
        Eligibility: {s.eligibility === 'eligible' ? 'likely eligible' : s.eligibility === 'ineligible' ? 'not eligible' : 'needs a check'}
        {s.eligibility_note && ` — ${s.eligibility_note}`}
      </p>

      <button type="button" className="link-btn" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide the analysis' : 'See the analysis'}
      </button>

      {open && (
        <div className="acq-detail">
          <h4>Where the improvement comes from</h4>
          <ul className="diff-list">
            {s.categories_improved.map((c) => (
              <li key={c.category} className="added">
                {c.category}: ${money(c.extra_value_cents)} over {c.transactions} purchases
              </li>
            ))}
            {!s.categories_improved.length && <li>Nowhere — it does not beat what you already use.</li>}
          </ul>

          <h4>Where it does not help</h4>
          <ul className="diff-list">
            {s.no_improvement.map((n, i) => (
              <li key={i} className="removed">
                {n}
              </li>
            ))}
            {!s.no_improvement.length && <li>Nothing notable.</li>}
          </ul>

          <table className="score-table">
            <tbody>
              <tr>
                <td>Extra value a year</td>
                <td className="mono">${money(s.projected_annual_incremental_value_cents)}</td>
              </tr>
              {s.annual_fee_cents > 0 && (
                <tr>
                  <td>Annual fee</td>
                  <td className="mono bad-text">−${money(s.annual_fee_cents)}</td>
                </tr>
              )}
              <tr>
                <td>Another card to manage</td>
                <td className="mono bad-text">−${money(s.complexity_cost_cents)}</td>
              </tr>
              {s.overlap_score > 0.5 && (
                <tr>
                  <td>Overlaps what you hold</td>
                  <td className="mono bad-text">{Math.round(s.overlap_score * 100)}%</td>
                </tr>
              )}
              <tr className="score-total">
                <td>Worth</td>
                <td className="mono">${money(s.score_cents)}</td>
              </tr>
            </tbody>
          </table>

          <ul className="plan-assumptions">
            {s.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export default function PortfolioGaps() {
  const [report, setReport] = useState<AcquisitionReport | null>(null);
  const [months, setMonths] = useState(6);
  const [objective, setObjective] = useState('balanced');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function load() {
    setBusy(true);
    simulateAcquisition({ history_months: months, objective })
      .then(setReport)
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  }
  useEffect(load, [months, objective]);

  if (err) return <p className="pad error">{err}</p>;
  if (!report) return <p className="pad sub">Working through your spending…</p>;

  return (
    <>
      <section className="card">
        <div className="section-head" style={{ marginTop: 0 }}>
          <h2>Your biggest reward gaps</h2>
          <div className="seg" role="group" aria-label="How much history">
            {[3, 6, 12].map((n) => (
              <button key={n} type="button" className={months === n ? 'on' : ''} onClick={() => setMonths(n)}>
                {n}m
              </button>
            ))}
          </div>
        </div>
        <p className="sub">
          From {report.history.from} to {report.history.to} · {report.history.months_with_data} month
          {report.history.months_with_data === 1 ? '' : 's'} with transactions
          {report.confidence !== 'high' && <span className="chip soon">{report.confidence} confidence</span>}
        </p>

        {report.gaps.length === 0 ? (
          <p className="ok-text">
            Nothing stands out. Your spending is covered by the cards you already hold — which is a better outcome than
            any card this could suggest.
          </p>
        ) : (
          <ul className="gaps">
            {report.gaps.map((g, i) => (
              <li key={i} className={g.severity}>
                <p className="gap-cat">{g.category}</p>
                <p className="sub">{g.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="section-head" style={{ marginTop: 0 }}>
          <h2>Worth considering{busy ? '…' : ` (${report.suggestions.length})`}</h2>
          <div className="seg wrap" role="group" aria-label="What matters to you">
            {OBJECTIVES.map(([k, label]) => (
              <button key={k} type="button" className={objective === k ? 'on' : ''} onClick={() => setObjective(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="sub">
          Each candidate is re-run through the real recommendation engine over your actual transactions, so it only
          earns where it would have beaten the card you used. Caps, exclusions and overlap come out of that arithmetic
          rather than being argued about.
        </p>

        {report.suggestions.length === 0 ? (
          <p className="sub">No card in the catalogue would add enough to be worth another one to manage.</p>
        ) : (
          <ul className="acqs">
            {report.suggestions.map((s) => (
              <Suggestion key={s.product.id} s={s} />
            ))}
          </ul>
        )}
      </section>

      {report.not_worth_it.length > 0 && (
        <section className="card">
          <h2>Considered and not worth it ({report.not_worth_it.length})</h2>
          <p className="sub">The half of this that stops an unnecessary card.</p>
          <ul className="diff-list">
            {report.not_worth_it.map((n, i) => (
              <li key={i} className="removed">
                <b>{n.product_name}</b> — {n.why}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
