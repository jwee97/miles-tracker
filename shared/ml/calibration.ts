/**
 * Does a probability mean what it says?
 *
 * High-confidence precision answers one question well: of the predictions the
 * model called confident, how many were right. It says nothing about the rest
 * of the range, and nothing about whether 90% and 70% differ in the way the
 * numbers imply. A model can score 96% precision above its threshold and still
 * be badly calibrated everywhere below it — which matters here, because the
 * threshold is a decision about when to interrupt somebody, and moving it is
 * only sensible if the probabilities underneath are trustworthy.
 *
 * Three measures, because each catches something the others miss:
 *
 *  - **Reliability bins** — the raw picture. "You said 80–90%; you were right
 *    71% of the time." Nothing else shows where the model is wrong in a way a
 *    person can act on.
 *  - **ECE** — the average of those gaps, weighted by how often each bin is
 *    used. One number for "is the confidence honest".
 *  - **Brier score** — accuracy and calibration together, so a model that is
 *    perfectly calibrated at 50% everywhere cannot look good.
 */

export interface ReliabilityBin {
  /** Inclusive lower bound of the confidence band. */
  from: number;
  /** Exclusive upper bound, except the last bin which includes 1. */
  to: number;
  count: number;
  /** Mean predicted probability in this bin. */
  predicted: number;
  /** Share actually correct. */
  actual: number;
  /** actual − predicted. Negative means over-confident, which is the dangerous way. */
  gap: number;
}

export interface Calibration {
  bins: ReliabilityBin[];
  /** Expected calibration error: the bin gaps, weighted by bin size. */
  ece: number;
  /** The largest single bin gap. One bad band can be hidden by a good average. */
  mce: number;
  /** Mean squared error of the predicted probability against the outcome. */
  brier: number;
  samples: number;
  /**
   * In words, because a number nobody interprets is a number nobody uses.
   */
  verdict: string;
}

export const DEFAULT_BINS = 10;

/**
 * Score a set of (confidence, was-it-right) pairs.
 *
 * Deliberately takes outcomes rather than predictions and truths: the caller
 * already knows what counts as correct, and multi-class accuracy against the
 * top label is only one of several reasonable definitions.
 */
export function calibration(
  samples: { confidence: number; correct: boolean }[],
  binCount = DEFAULT_BINS
): Calibration {
  const usable = samples.filter((s) => Number.isFinite(s.confidence) && s.confidence >= 0 && s.confidence <= 1);
  const n = usable.length;

  const bins: ReliabilityBin[] = [];
  let ece = 0;
  let mce = 0;

  for (let i = 0; i < binCount; i++) {
    const from = i / binCount;
    const to = (i + 1) / binCount;
    const inBin = usable.filter((s) => (i === binCount - 1 ? s.confidence >= from : s.confidence >= from && s.confidence < to));
    if (!inBin.length) {
      bins.push({ from, to, count: 0, predicted: 0, actual: 0, gap: 0 });
      continue;
    }
    const predicted = inBin.reduce((t, s) => t + s.confidence, 0) / inBin.length;
    const actual = inBin.filter((s) => s.correct).length / inBin.length;
    const gap = actual - predicted;
    bins.push({
      from,
      to,
      count: inBin.length,
      predicted: round(predicted),
      actual: round(actual),
      gap: round(gap),
    });
    ece += (inBin.length / n) * Math.abs(gap);
    mce = Math.max(mce, Math.abs(gap));
  }

  const brier = n ? usable.reduce((t, s) => t + (s.confidence - (s.correct ? 1 : 0)) ** 2, 0) / n : 0;

  return {
    bins,
    ece: round(ece),
    mce: round(mce),
    brier: round(brier),
    samples: n,
    verdict: verdictFor(n, ece, bins),
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

function verdictFor(n: number, ece: number, bins: ReliabilityBin[]): string {
  if (n < 50) {
    return `Only ${n} scored prediction${n === 1 ? '' : 's'} — too few to say whether the confidence means anything.`;
  }

  // Over-confidence in the bands that get acted on is the failure that costs
  // money here, so it is called out separately from the average.
  const highBands = bins.filter((b) => b.from >= 0.8 && b.count >= 10);
  const overconfident = highBands.filter((b) => b.gap < -0.1);
  if (overconfident.length) {
    const worst = overconfident.sort((a, b) => a.gap - b.gap)[0];
    return (
      `Over-confident where it matters: predictions of ${Math.round(worst.from * 100)}–${Math.round(worst.to * 100)}% ` +
      `were right ${Math.round(worst.actual * 100)}% of the time. Raise the threshold, or retrain.`
    );
  }

  if (ece <= 0.05) return 'Well calibrated: a stated probability is close to how often it turns out right.';
  if (ece <= 0.1) return 'Roughly calibrated. The confidence is usable but not precise.';
  return `Poorly calibrated (ECE ${ece}). Treat the probability as a ranking, not as a likelihood.`;
}
