import { useState } from 'react';

/**
 * Categorical palette: the reference dark steps, validated against this app's
 * own chart surface (#161a21) — lightness band, chroma floor, adjacent-pair CVD
 * separation, normal-vision floor and 3:1 contrast all pass for all eight.
 * Assigned in fixed order and never cycled; a ninth entity folds into "Other".
 */
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
export const OTHER = '#5b6370';

/**
 * Colour follows the entity, not its rank: slots are assigned from a sorted key
 * list, so changing the month never repaints the survivors.
 */
export function slotMap(keys: string[]): Map<string, string> {
  const sorted = [...new Set(keys)].sort();
  return new Map(sorted.map((k, i) => [k, i < SERIES.length ? SERIES[i] : OTHER]));
}

export const money = (c: number) =>
  (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const short = (c: number) => {
  const d = c / 100;
  if (Math.abs(d) >= 1000) return `$${(d / 1000).toFixed(d >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(d)}`;
};

/** Rounded only at the data end, anchored square to the baseline. */
function vBar(x: number, y: number, w: number, h: number, r = 4) {
  const rr = Math.min(r, w / 2, h);
  if (h <= 0) return '';
  return `M${x} ${y + h} L${x} ${y + rr} Q${x} ${y} ${x + rr} ${y} L${x + w - rr} ${y} Q${x + w} ${y} ${x + w} ${y + rr} L${x + w} ${y + h} Z`;
}
function hBar(x: number, y: number, w: number, h: number, r = 4) {
  const rr = Math.min(r, h / 2, w);
  if (w <= 0) return '';
  return `M${x} ${y} L${x + w - rr} ${y} Q${x + w} ${y} ${x + w} ${y + rr} L${x + w} ${y + h - rr} Q${x + w} ${y + h} ${x + w - rr} ${y + h} L${x} ${y + h} Z`;
}

export function Tip({ x, y, lines }: { x: number; y: number; lines: string[] }) {
  return (
    <div className="tip" style={{ left: `${x}%`, top: y }}>
      {lines.map((l, i) => (
        <div key={i} className={i === 0 ? 'tip-head' : ''}>
          {l}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function DailyBars({ data }: { data: { date: string; cents: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 170;
  const pad = { t: 12, r: 6, b: 22, l: 6 };
  const max = Math.max(1, ...data.map((d) => d.cents));
  const bw = (W - pad.l - pad.r) / data.length;
  const plotH = H - pad.t - pad.b;

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Spend by day">
        <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} className="axis-line" />
        {data.map((d, i) => {
          const h = (d.cents / max) * plotH;
          const x = pad.l + i * bw;
          const y = H - pad.b - h;
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {/* Hit target wider than the mark. */}
              <rect x={x} y={pad.t} width={bw} height={plotH} fill="transparent" />
              <path d={vBar(x + 1, y, Math.max(1, bw - 2), h)} fill={hover === i ? '#7fb2f0' : SERIES[0]} />
            </g>
          );
        })}
        {data.map((d, i) =>
          (i + 1) % 5 === 0 || i === 0 ? (
            <text key={d.date} x={pad.l + i * bw + bw / 2} y={H - 7} className="tick" textAnchor="middle">
              {Number(d.date.slice(8))}
            </text>
          ) : null
        )}
      </svg>
      {hover !== null && (
        <Tip
          x={((hover + 0.5) / data.length) * 100}
          y={8}
          lines={[`$${money(data[hover].cents)}`, new Date(data[hover].date + 'T00:00:00Z').toUTCString().slice(0, 11)]}
        />
      )}
    </div>
  );
}

export function CumulativeLine({
  data,
  month,
  prevMonth,
}: {
  data: { day: number; cents: number; prev_cents: number | null }[];
  month: string;
  prevMonth: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 200;
  const pad = { t: 14, r: 52, b: 24, l: 6 };
  const max = Math.max(1, ...data.map((d) => Math.max(d.cents, d.prev_cents ?? 0)));
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const X = (day: number) => pad.l + ((day - 1) / Math.max(1, data.length - 1)) * plotW;
  const Y = (c: number) => H - pad.b - (c / max) * plotH;

  // The current month stops at the last day with data rather than flat-lining.
  const lastLive = data.reduce((acc, d, i) => (d.cents > 0 ? i : acc), 0);
  const live = data.slice(0, lastLive + 1);
  const path = (pts: { day: number; v: number }[]) =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.day).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(' ');

  const curPts = live.map((d) => ({ day: d.day, v: d.cents }));
  const prevPts = data.filter((d) => d.prev_cents !== null).map((d) => ({ day: d.day, v: d.prev_cents! }));
  const h = hover !== null ? data[hover] : null;

  // Direct labels collide whenever the two months finish close together, which
  // is exactly when the comparison is most worth reading. Push them apart.
  const curEnd = curPts.length ? Y(curPts[curPts.length - 1].v) : null;
  const prevEnd = prevPts.length ? Y(prevPts[prevPts.length - 1].v) : null;
  let curLabelY = curEnd;
  let prevLabelY = prevEnd;
  if (curEnd !== null && prevEnd !== null && Math.abs(curEnd - prevEnd) < 13) {
    const mid = (curEnd + prevEnd) / 2;
    const above = curEnd <= prevEnd;
    curLabelY = above ? mid - 7 : mid + 7;
    prevLabelY = above ? mid + 7 : mid - 7;
  }

  return (
    <div className="chart-wrap">
      <div className="legend">
        <span>
          <i style={{ background: SERIES[0] }} /> {month}
        </span>
        <span>
          <i style={{ background: OTHER }} /> {prevMonth}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart"
        role="img"
        aria-label={`Cumulative spend, ${month} against ${prevMonth}`}
        onMouseLeave={() => setHover(null)}
      >
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={pad.l} y1={Y(max * f)} x2={W - pad.r} y2={Y(max * f)} className="grid" />
        ))}
        <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} className="axis-line" />

        {prevPts.length > 1 && <path d={path(prevPts)} className="line" stroke={OTHER} strokeDasharray="4 4" />}
        {curPts.length > 1 && <path d={path(curPts)} className="line" stroke={SERIES[0]} />}

        {/* Direct labels at the line ends — no legend hunting. */}
        {prevPts.length > 0 && prevLabelY !== null && (
          <text x={W - pad.r + 6} y={prevLabelY + 4} className="end-label">
            {short(prevPts[prevPts.length - 1].v)}
          </text>
        )}
        {curPts.length > 0 && curLabelY !== null && (
          <text x={W - pad.r + 6} y={curLabelY + 4} className="end-label strong-label">
            {short(curPts[curPts.length - 1].v)}
          </text>
        )}

        {h && (
          <>
            <line x1={X(h.day)} y1={pad.t} x2={X(h.day)} y2={H - pad.b} className="crosshair" />
            {h.prev_cents !== null && <circle cx={X(h.day)} cy={Y(h.prev_cents)} r={4.5} fill={OTHER} className="dot" />}
            {h.day <= lastLive + 1 && <circle cx={X(h.day)} cy={Y(h.cents)} r={4.5} fill={SERIES[0]} className="dot" />}
          </>
        )}

        {data.map((d, i) => (
          <rect
            key={d.day}
            x={X(d.day) - plotW / data.length / 2}
            y={pad.t}
            width={plotW / data.length}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}

        {data.map((d) =>
          d.day % 5 === 0 || d.day === 1 ? (
            <text key={d.day} x={X(d.day)} y={H - 8} className="tick" textAnchor="middle">
              {d.day}
            </text>
          ) : null
        )}
      </svg>
      {h && (
        <Tip
          x={((h.day - 1) / Math.max(1, data.length - 1)) * 92}
          y={8}
          lines={[
            `Day ${h.day}`,
            `${month}: $${money(h.cents)}`,
            h.prev_cents !== null ? `${prevMonth}: $${money(h.prev_cents)}` : `${prevMonth}: —`,
          ]}
        />
      )}
    </div>
  );
}

export function RankedBars({
  rows,
  colors,
  total,
  unit = '',
}: {
  rows: { key: string; label: string; cents: number; count: number }[];
  colors: Map<string, string>;
  total: number;
  unit?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.cents));
  if (!rows.length) return <p className="sub">Nothing in this month.</p>;
  return (
    <ul className="ranked">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="ranked-head">
            <span className="ranked-label">
              <i style={{ background: colors.get(r.key) ?? OTHER }} />
              {r.label}
            </span>
            <span className="mono ranked-val">
              ${money(r.cents)}
              <em>{total > 0 ? `${Math.round((r.cents / total) * 100)}%` : ''}</em>
            </span>
          </div>
          <svg viewBox="0 0 100 6" preserveAspectRatio="none" className="ranked-bar" aria-hidden="true">
            <path d={hBar(0, 0, (r.cents / max) * 100, 6, 1.5)} fill={colors.get(r.key) ?? OTHER} />
          </svg>
          <span className="ranked-sub">
            {r.count} transaction{r.count === 1 ? '' : 's'}
            {unit}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function WeekdayBars({ rows }: { rows: { dow: number; label: string; cents: number; count: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.cents));
  const W = 320;
  const H = 110;
  const pad = { t: 10, b: 20 };
  const bw = W / rows.length;
  const plotH = H - pad.t - pad.b;
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Spend by day of week">
        <line x1={0} y1={H - pad.b} x2={W} y2={H - pad.b} className="axis-line" />
        {rows.map((r, i) => {
          const h = (r.cents / max) * plotH;
          const x = i * bw;
          return (
            <g key={r.dow} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={x} y={pad.t} width={bw} height={plotH} fill="transparent" />
              <path
                d={vBar(x + 5, H - pad.b - h, bw - 10, h, 3)}
                fill={hover === i ? '#7fb2f0' : r.cents === max ? SERIES[0] : '#33506f'}
              />
              <text x={x + bw / 2} y={H - 6} className="tick" textAnchor="middle">
                {r.label}
              </text>
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <Tip
          x={((hover + 0.5) / rows.length) * 100}
          y={4}
          lines={[rows[hover].label, `$${money(rows[hover].cents)}`, `${rows[hover].count} txn`]}
        />
      )}
    </div>
  );
}
