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
