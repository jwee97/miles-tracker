import { useState } from 'react';
import { money, type RecommendationPick } from '../api';

export const rewardText = (p: RecommendationPick) =>
  p.reward.type === 'cashback' ? `$${money(p.reward.amount)}` : `${p.reward.amount.toLocaleString()} miles`;

export const rateText = (p: RecommendationPick) =>
  p.reward.type === 'cashback' ? `${p.reward.effective_rate.toFixed(2)}% back` : `${p.reward.effective_rate} mpd`;

const capText = (p: RecommendationPick) => {
  if (!p.cap.applies || p.cap.remaining_cents === null) return 'No bonus cap';
  if (p.cap.remaining_cents === 0) return 'Bonus allowance used up';
  return `$${money(p.cap.remaining_cents)} of bonus allowance remains`;
};

/** The six numbers behind the ranking, so the order is arguable rather than magic. */
function Score({ p }: { p: RecommendationPick }) {
  const c = p.score_components;
  const rows: [string, number][] = [
    ['Reward value', c.reward_value],
    ['Objective', c.objective_bonus],
    ['Minimum spend', c.minimum_spend_bonus],
    ['Deadline', c.urgency_bonus],
    ['Uncertainty', c.uncertainty_penalty],
    ['Cap used up', c.exhausted_cap_penalty],
  ];
  return (
    <table className="score-table">
      <tbody>
        {rows
          .filter(([, v]) => v !== 0)
          .map(([label, v]) => (
            <tr key={label}>
              <td>{label}</td>
              <td className={`mono ${v < 0 ? 'bad-text' : ''}`}>
                {v > 0 ? '+' : ''}
                {v.toLocaleString()}
              </td>
            </tr>
          ))}
        <tr className="score-total">
          <td>Score</td>
          <td className="mono">{p.score.toLocaleString()}</td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * The winning card, given the weight it deserves.
 *
 * The old list treated first place as merely the top row of a table. The point
 * of the app is the answer to one question, so the answer gets the space and
 * everything else earns its place underneath it.
 */
export function TopRecommendation({ p, action }: { p: RecommendationPick; action?: React.ReactNode }) {
  const [why, setWhy] = useState(false);
  const [score, setScore] = useState(false);

  return (
    <section className="card rec-top">
      <p className="rec-kicker">Recommended</p>
      <h2 className="rec-name">{p.card.product}</h2>
      <p className="rec-sub">
        {p.card.issuer} · {p.card.nickname}
      </p>

      <div className="rec-reward">
        <span className="rec-amount mono">{rewardText(p)}</span>
        <span className="rec-rate">{rateText(p)}</span>
      </div>
      <p className={`rec-cap ${p.cap.remaining_cents === 0 ? 'warn-num' : ''}`}>{capText(p)}</p>

      {p.minimum_spend && (
        <p className={p.minimum_spend.urgent ? 'err-text' : 'warn-num'}>
          ${money(p.minimum_spend.remaining_cents)} short of its minimum
          {p.minimum_spend.days_left !== null && ` · ${p.minimum_spend.days_left} days left`}
        </p>
      )}

      {action}

      <div className="rec-actions">
        <button type="button" className="link-btn" onClick={() => setWhy((v) => !v)}>
          {why ? 'Hide' : 'Why this card?'}
        </button>
        <button type="button" className="link-btn" onClick={() => setScore((v) => !v)}>
          {score ? 'Hide score' : 'Show the score'}
        </button>
      </div>

      {why && (
        <ol className="trace">
          {p.reasons.map((r, i) => (
            <li key={i} className={r.pass === true ? 'ok' : r.pass === false ? 'no' : 'info'}>
              <span className="trace-detail">{r.text}</span>
            </li>
          ))}
        </ol>
      )}
      {score && <Score p={p} />}
    </section>
  );
}

/** A runner-up, or a card that cannot be used at all. */
export function AlternativePick({ p, rank }: { p: RecommendationPick; rank: number }) {
  const [why, setWhy] = useState(false);
  const dq = p.disqualified;

  return (
    <li className={`pick ${dq ? 'excluded' : ''}`}>
      <div className="pick-top">
        <span className="pick-name">
          <span className="medal">{dq ? '—' : rank}</span>
          {p.card.product}
        </span>
        <span className="pick-earn mono">
          {dq ? <span className="bad-text">cannot be used</span> : rewardText(p)}
        </span>
      </div>
      <div className="pick-meta">
        <span>{dq ? `${dq.reason} — ${dq.detail}` : rateText(p)}</span>
        {!dq && <span className={p.cap.remaining_cents === 0 ? 'warn-num' : ''}>{capText(p)}</span>}
        {!dq && p.minimum_spend && (
          <span className={p.minimum_spend.urgent ? 'err-text' : 'warn-num'}>
            ${money(p.minimum_spend.remaining_cents)} short
            {p.minimum_spend.days_left !== null && `, ${p.minimum_spend.days_left}d`}
          </span>
        )}
      </div>
      <button type="button" className="link-btn why" onClick={() => setWhy((v) => !v)}>
        {why ? 'Hide' : 'Why?'}
      </button>
      {why && (
        <ol className="trace">
          {p.reasons.map((r, i) => (
            <li key={i} className={r.pass === true ? 'ok' : r.pass === false ? 'no' : 'info'}>
              <span className="trace-detail">{r.text}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
