import { useEffect, useState } from 'react';
import Pager from './Pager';
import {
  assignMerchantCode,
  fetchMccMatrix,
  fetchUnknownMerchants,
  lookupMerchant,
  money,
  saveExclusion,
  scanMccDirectory,
  type MccCell,
  type MccMatrix,
  type MccRow,
  type MccScanResult,
  type MerchantLookup,
  type UnknownMerchant,
} from './api';

/**
 * The merchant-code table, read across your own cards.
 *
 * The grid is a real table — rows are codes, columns are cards — so it is
 * readable by a screen reader and sortable by eye without a legend lookup.
 * State is carried by a glyph and a number as well as by colour: ✕ for a code
 * that earns nothing, the rate for one that earns, · for a card with no rule
 * covering it. Colour alone would fail anyone who cannot separate the red from
 * the grey.
 */

const FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All codes' },
  { key: 'excluded', label: 'Excluded' },
  { key: 'bonus', label: 'Bonus' },
  { key: 'used', label: "You've used" },
];

const rateText = (c: MccCell) =>
  c.reward_type === 'cashback' ? `${c.rate}%` : `${c.rate}`;

function Cell({ c, onPick }: { c: MccCell; onPick: () => void }) {
  const label =
    c.state === 'excluded'
      ? 'earns nothing'
      : c.state === 'none'
        ? 'no rule'
        : `${rateText(c)} ${c.reward_type === 'cashback' ? 'cashback' : 'mpd'}`;
  return (
    <td className={`cell ${c.state}`}>
      <button type="button" onClick={onPick} title={`${c.nickname}: ${label}`} aria-label={`${c.nickname}: ${label}`}>
        {c.state === 'excluded' ? '✕' : c.state === 'none' ? '·' : rateText(c)}
        {c.state !== 'excluded' && c.state !== 'none' && c.cap_cents ? <i className="capped" aria-hidden="true" /> : null}
      </button>
    </td>
  );
}

/**
 * Keeping codes current, from both ends: what a published directory says, and
 * what your own spend still has no code for.
 *
 * A code you confirmed from a statement is never overwritten by the directory —
 * your card, your statement, your answer — and a disagreement is shown rather
 * than resolved quietly.
 */
/**
 * Looking one merchant up by name.
 *
 * What this app already knows comes first — a code confirmed from your own
 * statement outranks any directory — and the directory's page for that name
 * after it. Nothing is recorded until you say so.
 */
function MerchantLookupBox() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<MerchantLookup | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function look() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      setRes(await lookupMerchant(q));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function record(merchant: string, mcc: string) {
    try {
      const r = await assignMerchantCode(merchant, mcc);
      setMsg(`${merchant} is ${mcc}${r.updated ? ` · ${r.updated} past purchase(s) updated` : ''}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <section className="card entry">
      <h2>Look up a merchant</h2>
      <p className="sub">
        Paste a name as it appears on your statement. The public directory has a page per merchant; this tries the
        obvious spellings of the name against it.
      </p>
      <div className="entry-grid">
        <label className="f f-note">
          <span>Merchant</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && q.trim() && look()}
            placeholder="Circles Life"
          />
        </label>
      </div>
      <div className="entry-foot">
        <button onClick={look} disabled={busy || !q.trim()}>
          {busy ? 'Looking…' : 'Look it up'}
        </button>
        {msg && <span className="sub">{msg}</span>}
        {err && <span className="err-text">{err}</span>}
      </div>

      {res && (
        <ul className="notes">
          {res.known && (
            <li>
              <strong>You already have this</strong> — {res.known.merchant} → {res.known.mcc} ({res.known.confidence},
              from {res.known.source})
            </li>
          )}
          {res.found ? (
            <li>
              <strong>{res.source}</strong> — {res.found.merchant} → {res.found.mcc}
              {res.found.verified ? ' (they call it verified)' : ' (listed, unverified)'}
              {res.description ? <div className="sub">{res.description}</div> : null}
              {res.category ? <div className="sub">this app treats {res.found.mcc} as {res.category}</div> : null}
              {res.known && res.known.mcc !== res.found.mcc && (
                <div className="warnbox">
                  That disagrees with the {res.known.mcc} you already have. Yours came from {res.known.source}.
                </div>
              )}
              <div className="entry-foot rule-actions">
                <button onClick={() => record(res.query, res.found!.mcc)}>Record {res.found.mcc} for “{res.query}”</button>
                <a className="link" href={res.found.url} target="_blank" rel="noreferrer">
                  Their page
                </a>
              </div>
            </li>
          ) : (
            <li>
              Nothing found for {res.tried.map((t) => `/mcc/${t}`).join(', ')}. A raw statement descriptor rarely has a
              page — try the trading name, or set the code by hand once your statement shows what it earned.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function MerchantScan() {
  const [rows, setRows] = useState<UnknownMerchant[] | null>(null);
  const [scan, setScan] = useState<MccScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  function load() {
    fetchUnknownMerchants()
      .then((d) => setRows(d.merchants))
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(load, []);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      setScan(await scanMccDirectory());
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function assign(m: UnknownMerchant, code: string) {
    setMsg(null);
    try {
      const r = await assignMerchantCode(m.merchant, code);
      setMsg(
        `${m.merchant} is ${code}` +
          (r.updated ? ` · ${r.updated} past purchase${r.updated === 1 ? '' : 's'} updated` : '')
      );
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <section className="card entry">
      <h2>Track merchant codes</h2>
      <p className="sub">
        A transaction with no code cannot be matched against a card's MCC rules at all. Scan the public directory for
        the merchants it lists, and fill the rest in from your statements.
      </p>
      <div className="entry-foot">
        <button onClick={run} disabled={busy}>
          {busy ? 'Scanning…' : 'Scan the directory'}
        </button>
        {scan && (
          <span className="sub">
            {scan.fetched} page{scan.fetched === 1 ? '' : 's'} from {scan.source} · {scan.added.length} new ·{' '}
            {scan.updated.length} corrected · {scan.unchanged} unchanged
            {scan.failed.length ? ` · ${scan.failed.length} unreadable` : ''}
          </span>
        )}
        {err && <span className="err-text">{err}</span>}
      </div>

      {scan && scan.conflicts.length > 0 && (
        <div className="warnbox">
          The directory disagrees with codes you confirmed yourself. Yours were kept.
          <ul className="notes">
            {scan.conflicts.map((c) => (
              <li key={c.merchant}>
                <strong>{c.merchant}</strong> — you have {c.yours}, {scan.source} says {c.theirs}.
              </li>
            ))}
          </ul>
        </div>
      )}

      {scan && (scan.added.length > 0 || scan.updated.length > 0) && (
        <ul className="notes">
          {[...scan.added, ...scan.updated].slice(0, 12).map((a) => (
            <li key={a.merchant}>
              <strong>{a.merchant}</strong> → {a.mcc} {a.description ? `· ${a.description}` : ''}{' '}
              {a.verified ? '· verified' : '· listed, unverified'}
            </li>
          ))}
        </ul>
      )}

      <h2 style={{ marginTop: 18 }}>Spend with no code yet</h2>
      {rows && rows.length > 0 ? (
        <ul className="txns codes-unknown">
          {rows.map((m) => (
            <li key={m.merchant}>
              <span className="t-note">{m.merchant}</span>
              <span className="t-card">
                {m.txn_count}× · ${money(m.spend_cents)}
              </span>
              <input
                className="t-posted-input"
                inputMode="numeric"
                placeholder={m.suggested_mcc ?? 'mcc'}
                value={draft[m.merchant] ?? ''}
                onChange={(e) => setDraft({ ...draft, [m.merchant]: e.target.value })}
              />
              <button
                className="secondary"
                disabled={!/^\d{4}$/.test(draft[m.merchant] ?? m.suggested_mcc ?? '')}
                onClick={() => assign(m, draft[m.merchant] || m.suggested_mcc || '')}
              >
                {draft[m.merchant] ? 'Set' : m.suggested_mcc ? `Use ${m.suggested_mcc}` : 'Set'}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sub">
          {rows ? 'Every merchant you have spent at has a code.' : 'Loading…'}
        </p>
      )}
      {msg && <p className="sub">{msg}</p>}
      <p className="sub">
        Setting a code also applies it to purchases already logged under that name, which were evaluated without one.
      </p>
    </section>
  );
}

export default function Mcc() {
  const [data, setData] = useState<MccMatrix | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  // 596 of the 923 codes are individual airlines and hotel chains. They are
  // real — a stay often posts as 3509 rather than 7011 — but they would bury
  // everything else, so they are opt-in.
  const [carriers, setCarriers] = useState(false);
  const [picked, setPicked] = useState<{ row: MccRow; cell: MccCell } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Exclusion editor
  const [xMcc, setXMcc] = useState('');
  const [xCard, setXCard] = useState('');
  const [xReason, setXReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  function load() {
    setErr(null);
    fetchMccMatrix({ q, filter, category, page, carriers })
      .then((d) => {
        setData(d);
        if (d.page !== page) setPage(d.page);
      })
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(load, [q, filter, category, page, carriers]);
  useEffect(() => setPage(1), [q, filter, category, carriers]);

  if (err) return <p className="pad error">{err}</p>;
  if (!data) return <p className="pad sub">Loading…</p>;

  const { summary: s } = data;

  async function addExclusion() {
    setMsg(null);
    try {
      await saveExclusion({ mcc: xMcc, nickname: xCard || null, reason: xReason || undefined });
      setXMcc('');
      setXReason('');
      setMsg('Added. It applies from the next purchase you log.');
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function removeExclusion(row: MccRow, cell: MccCell) {
    setMsg(null);
    try {
      await saveExclusion({
        mcc: row.code,
        nickname: row.excluded_everywhere ? null : cell.nickname,
        active: false,
      });
      setPicked(null);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <>
      <section className="card hero">
        <span className="stat-label">Merchant codes</span>
        <span className="hero-value">{s.codes.toLocaleString()}</span>
        <span className="sub">
          {s.verified_codes} match Citibank's published manual · {s.excluded_everywhere} earn nothing on any card ·{' '}
          {s.excluded_somewhere} on some · {s.bonus_codes} carry a bonus rate · {s.codes_you_have_used} you have
          actually used
        </span>
      </section>

      {s.excluded_spend_cents > 0 && (
        <section className="card">
          <p className="sub">
            <strong>${money(s.excluded_spend_cents)}</strong> of your spend in the last year was on an excluded code.
            {data.min_spend_counts_excluded
              ? ' It is counting toward your minimums, because MIN_SPEND_COUNTS_EXCLUDED is true.'
              : ' It earns nothing and does not count toward a minimum — the safer assumption, since most issuers exclude the same codes from both.'}
          </p>
        </section>
      )}

      <section className="card entry">
        <div className="entry-grid">
          <label className="f f-note">
            <span>Search</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="5812, dining, insurance…" />
          </label>
          <label className="f">
            <span>Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">every category</option>
              {data.categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="chips" style={{ marginTop: 12 }}>
          {FILTERS.map((f) => (
            <button key={f.key} className={`chip ${filter === f.key ? 'on' : ''}`} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
          <button className={`chip ${carriers ? 'on' : ''}`} onClick={() => setCarriers((v) => !v)}>
            {carriers ? 'Hide carriers' : `Airlines & hotels${data.carriers_hidden ? ` (${data.carriers_hidden})` : ''}`}
          </button>
        </div>
        <p className="sub">
          {data.total.toLocaleString()} code{data.total === 1 ? '' : 's'} match
          {data.pages > 1 ? ` · page ${data.page} of ${data.pages}` : ''}
          {!carriers && data.carriers_hidden
            ? ` · ${data.carriers_hidden} individual airline, hotel and car-rental codes hidden`
            : ''}
        </p>

        <p className="legend" role="note">
          <span className="key excluded">✕</span> earns nothing
          <span className="key bonus">4</span> bonus rate
          <span className="key base">1.4</span> base rate
          <span className="key none">·</span> no rule
          <span className="key capped-key" /> capped bonus
        </p>

        <div className="scroller">
          <table className="grid">
            <thead>
              <tr>
                <th scope="col" className="code-col">
                  Code
                </th>
                {data.cards.map((c) => (
                  <th key={c.id} scope="col" title={`${c.issuer} ${c.product}`}>
                    {c.nickname}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.code} className={r.txn_count ? 'used' : ''}>
                  <th scope="row" className="code-col">
                    <span className="mono">{r.code}</span>
                    <span className="desc">{r.description}</span>
                    <span className="cat">
                      {r.category}
                      {r.verified ? '' : ' · not in the published manual'}
                      {r.txn_count > 0 ? ` · $${money(r.spend_cents)} spent` : ''}
                    </span>
                  </th>
                  {r.cells.map((c) => (
                    <Cell key={c.card_id} c={c} onPick={() => setPicked({ row: r, cell: c })} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.cards.length > 2 && (
          <p className="sub">Swipe the table sideways for the rest of your cards. The code column stays put.</p>
        )}
        {data.pages > 1 && <Pager page={data.page} pages={data.pages} onGo={setPage} />}
        {!data.rows.length && <p className="sub">No codes match. Widen the search or the filter.</p>}
        {!data.cards.length && <p className="sub">No open cards, so there is nothing to compare codes against.</p>}

        {picked && (
          <div className="picked">
            <p>
              <strong>
                {picked.row.code} {picked.row.description}
              </strong>{' '}
              on <strong>{picked.cell.nickname}</strong>
            </p>
            <p className="sub">
              {picked.cell.state === 'excluded'
                ? `Earns nothing — ${picked.cell.reason}. It does not count toward a minimum${
                    picked.row.excluded_everywhere ? ' on any card.' : ' on this card.'
                  }`
                : picked.cell.state === 'none'
                  ? picked.cell.reason
                  : `${rateText(picked.cell)} ${picked.cell.reward_type === 'cashback' ? 'cashback' : 'mpd'} on the ${
                      picked.cell.category
                    } rule` +
                    (picked.cell.cap_cents
                      ? `, capped at $${money(picked.cell.cap_cents)} per ${(picked.cell.cap_window ?? '').replace('_', ' ')}`
                      : ', with no cap')}
            </p>
            <div className="entry-foot">
              {picked.cell.state === 'excluded' && (
                <button className="secondary danger" onClick={() => removeExclusion(picked.row, picked.cell)}>
                  This one is not excluded — remove it
                </button>
              )}
              <button className="secondary" onClick={() => setPicked(null)}>
                Close
              </button>
            </div>
          </div>
        )}
      </section>

      <MerchantLookupBox />

      <MerchantScan />

      <section className="card entry">
        <h2>Add an exclusion</h2>
        <p className="sub">
          The seeded list is a starting point from what Singapore issuers commonly exclude, not a promise about your
          card. When a statement shows something earned nothing, record it here.
        </p>
        <div className="entry-grid">
          <label className="f">
            <span>MCC</span>
            <input value={xMcc} onChange={(e) => setXMcc(e.target.value)} placeholder="6540" inputMode="numeric" />
          </label>
          <label className="f">
            <span>Card</span>
            <select value={xCard} onChange={(e) => setXCard(e.target.value)}>
              <option value="">every card</option>
              {data.cards.map((c) => (
                <option key={c.id} value={c.nickname}>
                  {c.nickname}
                </option>
              ))}
            </select>
          </label>
          <label className="f f-note">
            <span>Reason</span>
            <input
              value={xReason}
              onChange={(e) => setXReason(e.target.value)}
              placeholder="September statement showed no points"
            />
          </label>
        </div>
        <div className="entry-foot">
          <button onClick={addExclusion} disabled={!/^\d{4}$/.test(xMcc)}>
            Add
          </button>
          {msg && <span className="sub">{msg}</span>}
        </div>
      </section>
    </>
  );
}
