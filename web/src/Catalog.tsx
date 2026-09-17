import { useEffect, useState } from 'react';
import { fetchCatalog, fetchCatalogCard, fetchStaleProducts, money, type CatalogDetail, type CatalogProduct, type StaleProduct } from './api';
import CatalogAdmin from './CatalogAdmin';

const STATUS: Record<string, { label: string; cls: string }> = {
  verified: { label: 'verified', cls: 'ok' },
  needs_review: { label: 'needs review', cls: 'soon' },
  stale: { label: 'stale', cls: 'critical' },
  draft: { label: 'draft', cls: 'never' },
  migrated_unverified: { label: 'imported, unchecked', cls: 'soon' },
};

const badge = (s: string) => STATUS[s] ?? { label: s, cls: 'never' };

function Detail({ k, onClose, onChanged }: { k: string; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<CatalogDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  function load() {
    fetchCatalogCard(k)
      .then(setD)
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(load, [k]);

  if (err) return <p className="error">{err}</p>;
  if (!d) return <p className="sub">Loading…</p>;

  const b = badge(d.product.verification_status);

  return (
    <div className="catalog-detail">
      <div className="section-head" style={{ marginTop: 0 }}>
        <h3>
          {d.product.issuer} {d.product.product_name} <span className={`chip ${b.cls}`}>{b.label}</span>
        </h3>
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="sub">
        <span className="mono">{d.product.product_key}</span>
        {d.product.network && ` · ${d.product.network}`}
        {d.product.reward_type && ` · ${d.product.reward_type}`}
        {d.product.program_key && ` · ${d.product.program_key}`}
        {d.product.annual_fee_cents ? ` · $${money(d.product.annual_fee_cents)} a year` : ''}
      </p>
      {d.product.official_url && (
        <p className="sub">
          <a className="link" href={d.product.official_url} target="_blank" rel="noreferrer">
            The bank's own page
          </a>
        </p>
      )}

      {d.overlaps.length > 0 && (
        <p className="err-text">
          {d.overlaps.length} pair{d.overlaps.length > 1 ? 's' : ''} of published versions cover the same days — a
          purchase in that range has two answers. Withdraw or re-date one.
        </p>
      )}

      {d.versions.length === 0 ? (
        <p className="sub">
          No rule versions yet, so this product earns nothing and never wins a recommendation. Add a card on it and read
          its rewards page to give it a first version.
        </p>
      ) : (
        <ul className="rules versions">
          {d.versions.map((v) => (
            <li key={v.id} className={v.status === 'published' ? 'pass' : v.status === 'draft' ? 'unknown' : ''}>
              <span>
                <strong>Version {v.version}</strong> <span className={`chip ${v.status === 'published' ? 'ok' : 'never'}`}>{v.status}</span>{' '}
                {v.effective_from} → {v.effective_until ?? 'current'}
              </span>
              {v.notes && <p className="sub">{v.notes}</p>}
              <ul className="sub version-rules">
                {v.rules.map((r) => (
                  <li key={r.id}>
                    {r.category} — {r.reward_type === 'cashback' ? `${r.mpd}%` : `${r.mpd} mpd`}
                    {r.cap_cents ? `, capped at $${money(r.cap_cents)}` : ''}
                    {r.channel ? `, ${r.channel}` : ''}
                    {r.min_tier_cents ? ` · from the $${(r.min_tier_cents / 100).toFixed(0)} tier` : ''}
                    {r.mcc_include ? ` · only codes ${r.mcc_include}` : ''}
                    {r.mcc_exclude ? ` · never ${r.mcc_exclude}` : ''}
                  </li>
                ))}
                {v.rules.length === 0 && <li>no rules in this version</li>}
                {v.exclusions.length > 0 && (
                  <li className="bad-text">excluded: {v.exclusions.map((e) => e.mcc).join(', ')}</li>
                )}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <div className="entry-foot rule-actions">
        <button className="secondary" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Done' : 'Edit its rules'}
        </button>
      </div>

      {editing && (
        <CatalogAdmin
          d={d}
          onChange={() => {
            load();
            onChanged();
          }}
        />
      )}

      {d.sources.length > 0 && (
        <>
          <h4>Where it came from</h4>
          <ul className="rules">
            {d.sources.map((s) => (
              <li key={s.id}>
                <span>
                  {s.title ?? s.source_type} · read {s.retrieved_at}
                </span>
                <p className="sub">
                  <a className="link" href={s.source_url} target="_blank" rel="noreferrer">
                    {s.source_url}
                  </a>
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Every card the app knows about, whether or not you hold it.
 *
 * The list is honest about what it does not know: a product with no published
 * rules says so rather than appearing complete, because an empty product that
 * looks filled in is the one failure mode that would quietly misdirect every
 * recommendation made on it.
 */
export default function Catalog() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<CatalogProduct[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const [stale, setStale] = useState<StaleProduct[]>([]);

  function load(query = q) {
    fetchCatalog(query)
      .then((d) => setRows(d.products))
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(() => {
    load('');
    fetchStaleProducts()
      .then((d) => setStale(d.products ?? []))
      .catch(() => void 0);
  }, []);

  if (err) return <p className="pad error">{err}</p>;
  if (!rows) return <p className="pad sub">Loading…</p>;

  const shown = onlyMine ? rows.filter((r) => r.held_by.length > 0) : rows;
  const withRules = rows.filter((r) => r.rules > 0).length;

  return (
    <section className="card">
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>Card catalogue</h2>
        <button className={onlyMine ? 'secondary on' : 'secondary'} onClick={() => setOnlyMine((v) => !v)}>
          {onlyMine ? 'All cards' : 'Only mine'}
        </button>
      </div>
      <p className="sub">
        {rows.length} products · {withRules} with rules · {rows.length - withRules} still waiting for theirs. A product
        arrives with its identity only — issuer, name, network, programme — and never with a rate nobody checked.
      </p>

      {stale.length > 0 && (
        <div className="stale-note">
          <p className="warn-num">
            {stale.length} card{stale.length === 1 ? '' : 's'} you hold have rates nobody has checked lately.
          </p>
          <ul className="sub">
            {stale.map((s) => (
              <li key={s.product.id}>
                <b>{s.product.product_name}</b> — {s.reason} · {s.held_by.join(', ')}
              </li>
            ))}
          </ul>
          <p className="sub">
            They are still used, because a stale rate beats no rate — but every recommendation made from them says it is
            uncertain.
          </p>
        </div>
      )}

      <form
        className="advisor-row"
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search issuer or card" />
        <button type="submit">Search</button>
      </form>

      <ul className="rules catalog-list">
        {shown.map((p) => {
          const b = badge(p.verification_status);
          return (
            <li key={p.id} className={p.rules > 0 ? 'pass' : 'unknown'}>
              <span>
                <strong>
                  {p.issuer} {p.product_name}
                </strong>{' '}
                <span className={`chip ${b.cls}`}>{b.label}</span>
                {p.held_by.length > 0 && <span className="chip ok">you hold it</span>}
                {p.stale && <span className="chip soon">unchecked</span>}
              </span>
              <p className="sub">
                {p.rules > 0
                  ? `${p.rules} rule${p.rules > 1 ? 's' : ''} · version ${p.current_rule_set?.version} since ${p.current_rule_set?.effective_from}`
                  : 'no rules yet — earns nothing until a rewards page is read into it'}
                {p.held_by.length > 0 && ` · ${p.held_by.join(', ')}`}
              </p>
              <div className="entry-foot rule-actions">
                <button onClick={() => setOpen(open === p.product_key ? null : p.product_key)}>
                  {open === p.product_key ? 'Hide' : 'Versions'}
                </button>
                {p.official_url && (
                  <a className="link" href={p.official_url} target="_blank" rel="noreferrer">
                    Bank page
                  </a>
                )}
              </div>
              {open === p.product_key && <Detail k={p.product_key} onClose={() => setOpen(null)} onChanged={() => load()} />}
            </li>
          );
        })}
        {!shown.length && <li className="unknown">Nothing matches. Send /migrate to the bot to seed the catalogue.</li>}
      </ul>
    </section>
  );
}
