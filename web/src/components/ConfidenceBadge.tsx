import type { RecommendationV2 } from '../api';

const WORDS: Record<string, { label: string; cls: string }> = {
  high: { label: 'Confident', cls: 'ok' },
  medium: { label: 'Fairly sure', cls: 'soon' },
  low: { label: 'Uncertain', cls: 'critical' },
};

/**
 * How much of this answer is known and how much is assumed.
 *
 * A recommendation made on a guess can be right and its reasoning still
 * unsound, so the badge is never decoration: tapping it shows the assumptions
 * the answer rests on, and which of them would change it if wrong.
 */
export default function ConfidenceBadge({
  confidence,
  assumptions,
  open,
  onToggle,
}: {
  confidence: RecommendationV2['confidence'];
  assumptions: RecommendationV2['assumptions'];
  open?: boolean;
  onToggle?: () => void;
}) {
  const w = WORDS[confidence.level] ?? WORDS.medium;
  const material = assumptions.filter((a) => a.weight === 'material').length;

  return (
    <div className="confidence">
      <button type="button" className={`chip ${w.cls} conf-chip`} onClick={onToggle} aria-expanded={!!open}>
        {w.label}
        {material > 0 && <span className="chip-n">{material}</span>}
      </button>
      <span className="conf-why">{confidence.reasons[0] ?? 'everything this needed was known'}</span>
      {open && (
        <div className="conf-detail">
          {confidence.reasons.length > 1 && (
            <ul className="conf-reasons">
              {confidence.reasons.slice(1).map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          {assumptions.length === 0 ? (
            <p className="sub">Nothing was assumed.</p>
          ) : (
            <ul className="assumptions">
              {assumptions.map((a, i) => (
                <li key={i} className={a.weight}>
                  <b>{a.what}</b> — {a.because}
                  {a.weight === 'material' && <span className="chip critical">could change the answer</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
