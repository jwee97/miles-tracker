import { useEffect, useState } from 'react';
import Pager, { PageSize, usePageSize } from './Pager';
import {
  assignMerchantCode,
  fetchMccMatrix,
  fetchUnknownMerchants,
  ignoreMerchant as ignoreMerchantApi,
  lookupMerchant,
  money,
  resolveDescriptor,
  saveExclusion,
  scanMccDirectory,
  type MccCell,
  type MccMatrix,
  type MccRow,
  type MccScanResult,
  type MerchantLookup,
  type MerchantResolution,
  type UnknownMerchant,
  type UnknownPage,
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

/**
 * What the app works out from a line on a statement, and how it got there.
 *
 * The directory lookup above answers "what code does this shop use?". This
 * answers a different question — "what will this app do with THIS line?" —
 * which is the one that decides a recommendation, and until now could only be
 * asked through the API.
 *
 * It shows the whole trail rather than the answer alone, including the two
 * steps that are deliberately not implemented. A resolver that only printed
 * its conclusion would be impossible to argue with, and the times it matters
 * most are exactly the times it is wrong.
 *
 * Nothing here writes anything. Recording a code is a separate, explicit
 * press, because this screen exists partly to find out what the app believes
 * without teaching it anything new by accident.
 */
function DescriptorResolver() {
  const [raw, setRaw] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<MerchantResolution | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    setRes(null);
    try {
      const dollars = parseFloat(amount);
      setRes(
        await resolveDescriptor({
          descriptor: raw.trim(),
          amount_cents: Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : undefined,
        })
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function record(mcc: string) {
    if (!res?.merchant) return;
    try {
      const r = await assignMerchantCode(res.merchant.name, mcc);
      setMsg(`${res.merchant.name} is ${mcc}${r.updated ? ` · ${r.updated} past purchase(s) updated` : ''}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  const pct = (n: number) => `${Math.round(n * 100)}%`;

  return (
    <section className="card entry">
      <h2>Work out a code from a statement line</h2>
      <p className="sub">
        Paste a descriptor exactly as the bank printed it. This runs the same resolution the app uses when a
        transaction arrives, and shows every step it took — including the ones that found nothing.
      </p>
      <div className="entry-grid">
        <label className="f f-note">
          <span>Statement line</span>
          <input
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && raw.trim() && run()}
            placeholder="GRAB*RIDE 8829 SINGAPORE SG"
          />
        </label>
        <label className="f">
          <span>Amount (optional)</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="42.50"
          />
        </label>
      </div>
      <p className="sub dim">
        An amount is only needed to price the difference between candidate codes — without one the app cannot say
        whether the answer is worth knowing.
      </p>
      <div className="entry-foot">
        <button onClick={run} disabled={busy || !raw.trim()}>
          {busy ? 'Working it out…' : 'Work it out'}
        </button>
        {msg && <span className="sub">{msg}</span>}
        {err && <span className="err-text">{err}</span>}
      </div>

      {res && (
        <>
          <ul className="stmt-summary">
            <li>
              reads as <span className="mono">{res.descriptor.normalized || '—'}</span>
            </li>
            {res.descriptor.processor && (
              <li>
                routed by <span className="mono">{res.descriptor.processor}</span>
              </li>
            )}
            {res.descriptor.country_hint && (
              <li>
                country <span className="mono">{res.descriptor.country_hint}</span>
              </li>
            )}
            {res.descriptor.reference && (
              <li>
                reference <span className="mono">{res.descriptor.reference}</span> (ignored)
              </li>
            )}
          </ul>

          <p className="sub">
            {res.merchant ? (
              <>
                Recognised as <strong>{res.merchant.name}</strong> at {pct(res.merchant.confidence)} confidence, from{' '}
                {res.provenance.prediction_source.replace(/_/g, ' ')}.
              </>
            ) : (
              <>Not recognised. Nothing was created — asking is not the same as deciding.</>
            )}
          </p>

          {res.category.value && (
            <p className="sub">
              Treated as <strong>{res.category.value}</strong> ({pct(res.category.confidence)}).
            </p>
          )}

          {res.mcc_candidates.length > 0 ? (
            <ul className="notes">
              {res.mcc_candidates.map((c) => (
                <li key={c.mcc}>
                  <strong>{c.mcc}</strong> · {pct(c.probability)}
                  <div className="sub">{c.evidence}</div>
                  <button className="secondary" onClick={() => record(c.mcc)} disabled={!res.merchant}>
                    Record {c.mcc}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sub">No code has been observed for this merchant yet.</p>
          )}

          {res.reward_impact && (
            <div className={`impact ${res.reward_impact.outcome_insensitive ? 'impact-none' : 'impact-real'}`}>
              <p className="impact-note">
                {res.reward_impact.outcome_insensitive
                  ? 'Every candidate code earns the same on your cards, so which one it is does not change anything.'
                  : `The code is worth $${money(res.reward_impact.spread_cents)} on this amount.`}
              </p>
              {!res.reward_impact.outcome_insensitive && (
                <ul className="impact-rows">
                  {res.reward_impact.per_mcc.map((m) => (
                    <li key={m.mcc}>
                      <span className="mono">{m.mcc}</span> → {m.card ?? 'no card qualifies'}{' '}
                      <span className="mono">${money(m.value_cents)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {res.needs_review && res.review_reason && (
            <p className="sub">Would be sent to review: {res.review_reason}.</p>
          )}

          <details className="trail">
            <summary>How it got there ({res.provenance.trail.length} steps)</summary>
            <ol className="notes">
              {res.provenance.trail.map((t, i) => (
                <li key={i}>
                  <strong>{t.step.replace(/_/g, ' ')}</strong>
                  <div className="sub">{t.outcome}</div>
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </section>
  );
}

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
        Search the public directory of Singapore merchants by name. It matches on fragments, so “kopi” finds every
        kopitiam; pick the one that is yours.
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
        <>
          {res.known && (
            <p className="sub">
              You already have <strong>{res.known.merchant}</strong> → {res.known.mcc} ({res.known.confidence}, from{' '}
              {res.known.source}). That stays unless you record something else.
            </p>
          )}
          {res.error ? (
            <p className="err-text">
              {res.source} {res.error}.
            </p>
          ) : res.results.length ? (
            <ul className="notes">
              {res.results.map((r, i) => (
                <li key={i}>
                  <strong>{r.store}</strong> → {r.mcc}
                  {r.channel ? ` · ${r.channel}` : ''}
                  <div className="sub">
                    {r.description ?? r.their_description ?? 'this app does not carry that code'}
                    {r.category ? ` · treated as ${r.category}` : ''}
                  </div>
                  {res.known && res.known.mcc !== r.mcc && (
                    <div className="sub warn-num">differs from the {res.known.mcc} you already have</div>
                  )}
                  <div className="entry-foot rule-actions">
                    <button onClick={() => record(res.query, r.mcc)}>Record for “{res.query}”</button>
                    {r.store.toLowerCase() !== res.query.trim().toLowerCase() && (
                      <button onClick={() => record(r.store, r.mcc)}>Record for “{r.store}”</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sub">
              Nothing at {res.source} for “{res.query}”. A raw statement descriptor rarely matches — try the trading
              name, or set the code by hand once your statement shows what it earned.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function MerchantScan() {
  const [rows, setRows] = useState<UnknownPage | null>(null);
  const [page, setPage] = useState(1);
  const [per, setPer] = usePageSize('mcc.unknown', 10);
  const [showIgnored, setShowIgnored] = useState(false);
  const [scan, setScan] = useState<MccScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  function load() {
    fetchUnknownMerchants(page, per)
      .then((d) => {
        setRows(d);
        // Clearing the last entry on page 5 leaves page 5 empty; follow the
        // server back to a page that exists.
        if (d.page !== page) setPage(d.page);
      })
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(load, [page, per]);
  useEffect(() => setPage(1), [per]);

  async function skip(merchant: string, undo = false) {
    setMsg(null);
    try {
      await ignoreMerchantApi(merchant, undo);
      setMsg(undo ? `${merchant} is back on the list.` : `${merchant} will not be listed again.`);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

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

      <div className="section-head" style={{ marginTop: 18 }}>
        <h2>Spend with no code yet</h2>
        {rows && rows.total > 0 && (
          <p className="sub" style={{ margin: 0 }}>
            {rows.total.toLocaleString()} merchant{rows.total === 1 ? '' : 's'}
            {rows.pages > 1 ? ` · page ${rows.page} of ${rows.pages}` : ''}
          </p>
        )}
      </div>
      {rows && rows.merchants.length > 0 ? (
        <>
          <ul className="txns codes-unknown">
            {rows.merchants.map((m) => (
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
                {/* Some spend has no code to find — a hawker stall, a transfer
                    to a friend. Taking it off the list is the honest answer,
                    and a better one than inventing a code for it. */}
                <button className="secondary t-del" title="Stop asking about this one" onClick={() => skip(m.merchant)}>
                  Ignore
                </button>
              </li>
            ))}
          </ul>
          <div className="list-foot">
            <PageSize per={per} onChange={setPer} label="Per page" />
            {rows.pages > 1 && <Pager page={rows.page} pages={rows.pages} onGo={setPage} />}
          </div>
        </>
      ) : (
        <p className="sub">
          {rows
            ? rows.total === 0 && rows.ignored === 0
              ? 'Every merchant you have spent at has a code.'
              : 'Nothing left to code here.'
            : 'Loading…'}
        </p>
      )}

      {rows && rows.ignored > 0 && (
        <>
          <div className="entry-foot">
            <button className="secondary" onClick={() => setShowIgnored((v) => !v)}>
              {showIgnored ? 'Hide ignored' : `${rows.ignored} ignored`}
            </button>
          </div>
          {showIgnored && (
            <ul className="notes">
              {rows.ignored_list.map((g) => (
                <li key={g.merchant}>
                  <strong>{g.merchant}</strong>
                  {g.reason ? ` — ${g.reason}` : ''}{' '}
                  <button className="secondary" onClick={() => skip(g.merchant, true)}>
                    Put back
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
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
  const [per, setPer] = usePageSize('mcc.codes', 25);
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
    fetchMccMatrix({ q, filter, category, page, per, carriers })
      .then((d) => {
        setData(d);
        if (d.page !== page) setPage(d.page);
      })
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(load, [q, filter, category, page, per, carriers]);
  useEffect(() => setPage(1), [q, filter, category, per, carriers]);

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

      <DescriptorResolver />

      <MerchantLookupBox />

      <MerchantScan />

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
        <div className="list-foot">
          <PageSize per={per} onChange={setPer} label="Codes per page" />
          {data.pages > 1 && <Pager page={data.page} pages={data.pages} onGo={setPage} />}
        </div>
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
