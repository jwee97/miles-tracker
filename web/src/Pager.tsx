/** Page numbers, windowed so a hundred pages do not wrap the screen. */
export default function Pager({ page, pages, onGo }: { page: number; pages: number; onGo: (p: number) => void }) {
  const slots: (number | '…')[] = [];
  const push = (n: number | '…') => slots.push(n);
  const from = Math.max(2, page - 1);
  const to = Math.min(pages - 1, page + 1);
  push(1);
  if (from > 2) push('…');
  for (let n = from; n <= to; n++) push(n);
  if (to < pages - 1) push('…');
  if (pages > 1) push(pages);

  return (
    <nav className="pager">
      <button className="secondary" onClick={() => onGo(page - 1)} disabled={page <= 1}>
        ‹
      </button>
      {slots.map((n, idx) =>
        n === '…' ? (
          <span key={`gap${idx}`} className="gap">
            …
          </span>
        ) : (
          <button key={n} className={`secondary page ${n === page ? 'on' : ''}`} onClick={() => onGo(n)}>
            {n}
          </button>
        )
      )}
      <button className="secondary" onClick={() => onGo(page + 1)} disabled={page >= pages}>
        ›
      </button>
    </nav>
  );
}

export const PER_PAGE = [10, 25, 50, 100] as const;

/**
 * How many rows to show at once.
 *
 * Every long list in the app grows without a ceiling — spend, merchant codes,
 * off-card entries — and a list that renders all of it is unreadable long
 * before it is slow. Changing the size resets to page one, because staying on
 * page 7 of a list that just became four pages long shows nothing.
 */
export function PageSize({
  per,
  onChange,
  label = 'Per page',
  total,
}: {
  per: number;
  onChange: (n: number) => void;
  label?: string;
  total?: number;
}) {
  return (
    <label className="per-page">
      <span>{label}</span>
      <select className="range-select" value={per} onChange={(e) => onChange(Number(e.target.value))}>
        {PER_PAGE.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
        {total !== undefined && total > 0 && <option value={total}>all ({total})</option>}
      </select>
    </label>
  );
}
