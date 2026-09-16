import { useEffect, useState } from 'react';
import Advisor from './Advisor';
import Catalog from './Catalog';
import Home from './Home';
import Audit from './Audit';
import Analytics from './Analytics';
import Ledger from './Ledger';
import ExpiryTab from './Expiry';
import CardSetup from './CardSetup';
import Mcc from './Mcc';
import Other from './Other';
import Routes from './Routes';
import Pager from './Pager';
import Settings from './Settings';
import {
  addProgram,
  addTranche,
  addTransaction,
  deleteTranche,
  fetchCategories,
  fetchConvert,
  fetchPoints,
  fetchWhich,
  bootstrapToken,
  deleteTransaction,
  decideRule,
  deleteFeed,
  deleteRule,
  acceptCredits,
  fetchExtractPrompt,
  fetchFeed,
  fetchFeedStorage,
  fetchFeeds,
  fetchOffers,
  fetchSummary,
  feedActionMany,
  purgeFeed,
  runScan,
  saveExtraction,
  saveFeed,
  fetchWallet,
  sweepOffers,
  undoCredit,
  setOfferStatus,
  fetchTransactions,
  markPosted,
  money,
  type CardSummary,
  type Eligibility,
  type FeedItemRow,
  type FeedPage,
  type FeedRow,
  type FeedStorage,
  type FeedState,
  type RangeName,
  type OfferRow,
  type RuleDecision,
  type RuleRow,
  type Wallet,
  type ScanSummary,
  type MonthSlice,
  type Progress,
  type Summary,
  type Txn,
  type BalanceRow,
  type Pick,
  type Plan,
  type ProgramRow,
  type Tranche,
} from './api';

const tone = (pct: number) => (pct >= 90 ? 'bad' : pct >= 80 ? 'warn' : pct >= 50 ? 'mid' : 'ok');

/**
 * Progress toward a minimum reads the opposite way round from a credit limit:
 * full is good, and empty with the window closing is the thing to worry about.
 */
const minTone = (p: Progress) => (p.met ? 'ok' : p.days_left <= 3 ? 'bad' : p.days_left <= 7 ? 'warn' : 'mid');

function Meter({ percent, tone: t }: { percent: number; tone: string }) {
  return (
    <div className="meter" role="img" aria-label={`${percent.toFixed(0)} percent`}>
      <span className={`fill ${t}`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

const WINDOW_NAME: Record<string, string> = {
  calendar_month: 'calendar month',
  calendar_quarter: 'calendar quarter',
  statement_cycle: 'statement cycle',
  statement_quarter: 'statement month of a rolling quarter',
  fixed_window: 'one-off window',
};

/**
 * The purchases a minimum-spend figure was added up from.
 *
 * A total on its own cannot be checked, and the commonest way for one to look
 * wrong is that it is counting a different window from the one you had in mind
 * — a calendar quarter rather than a statement month adds three months
 * together and looks like a bug. This shows the dates and the rows, so the
 * answer is visible rather than argued about.
 */
function CountedRows({ p, nickname }: { p: Progress; nickname: string }) {
  const [rows, setRows] = useState<Txn[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchTransactions(500, { from: p.window.start, to: p.window.end, card: nickname })
      .then((d) => setRows(d.transactions))
      .catch((e) => setErr((e as Error).message));
  }, [p.window.start, p.window.end, nickname]);

  if (err) return <p className="cap">{err}</p>;
  if (!rows) return <p className="sub">Loading…</p>;

  const total = rows.reduce((n, r) => n + r.amount_cents, 0);
  return (
    <div className="counted">
      <p className="sub">
        Counting <strong>{p.window.start} → {p.window.end}</strong>, which is one{' '}
        {WINDOW_NAME[p.window_kind] ?? p.window_kind}. {rows.length} purchase{rows.length === 1 ? '' : 's'} on this card
        in that range.
      </p>
      <ul className="txns counted-list">
        {rows.map((r) => (
          <li key={r.id}>
            <span className="t-date">{(r.posted_at ?? r.occurred_at).slice(5)}</span>
            <span className="t-note">{r.merchant ?? r.category ?? '—'}</span>
            <span className="t-amt">${money(r.amount_cents)}</span>
          </li>
        ))}
      </ul>
      <p className="sub mono">
        ${money(total)} in the window · ${money(p.spent_cents)} counted toward the minimum
        {total !== p.spent_cents && (
          <> · the difference is spend on excluded codes, which the issuer leaves out</>
        )}
      </p>
    </div>
  );
}

function RequirementRow({ p, nickname }: { p: Progress; nickname: string }) {
  const [open, setOpen] = useState(false);
  const label =
    p.kind === 'signup_min'
      ? 'Sign-up minimum'
      : p.quarter
        ? `Month ${p.months.find((m) => m.state === 'current')?.index ?? 3} of Q${p.quarter.index}`
        : 'Monthly minimum';
  // The ladder decides the minimum: a card with rungs at $600/$1,000/$2,000 has
  // a minimum of $600, whatever number the requirement was created with.
  const floor = p.floor_cents || p.amount_cents;
  const pct = (p.spent_cents / floor) * 100;
  const urgent = !p.met && p.days_left <= 7;

  return (
    <div className={`req ${p.met ? 'done' : urgent ? 'urgent' : ''}`}>
      <div className="req-head">
        <span>{label}</span>
        <span className="mono">
          ${money(p.spent_cents)} / ${money(floor)}
          {p.txns_required > 0 && ` · ${p.txn_count}/${p.txns_required} txns`}
        </span>
      </div>
      {/* Which window this total covers. A figure that looks too big is almost
          always a window wider than the one you had in mind. */}
      <p className="sub window-line">
        {p.window.start} → {p.window.end} · {WINDOW_NAME[p.window_kind] ?? p.window_kind}
        <button className="linky" onClick={() => setOpen((v) => !v)}>
          {open ? 'hide the purchases' : "what's counted?"}
        </button>
      </p>
      {/* A window that adds three months together reads as a total four times
          what you spent. Saying which, and what to change it to, is the
          difference between a wrong number and a fixable one. */}
      {p.shape_warning && (
        <p className="cap">
          {p.shape_warning} <span className="dim">Cards → this card → edit the minimum.</span>
        </p>
      )}
      {open && <CountedRows p={p} nickname={nickname} />}
      <Meter percent={pct} tone={p.met ? 'ok' : urgent ? 'warn' : 'mid'} />
      <div className="req-foot">
        {p.met && p.met_only_with_at_risk ? (
          <span className="risk-text">
            Met only if ${money(p.at_risk_cents)} posts in time · ${money(p.confirmed_cents)} confirmed
          </span>
        ) : p.met ? (
          <span className="ok-text">Met</span>
        ) : (
          <span>
            {p.remaining_cents > 0 && <>${money(p.remaining_cents)} to go</>}
            {p.remaining_cents > 0 && p.txns_remaining > 0 && <> and </>}
            {p.txns_remaining > 0 && <>{p.txns_remaining} more txn{p.txns_remaining > 1 ? 's' : ''}</>}
            {' · '}{p.days_left}d
            {p.remaining_cents > 0 && p.days_left > 0 && <> · ~${money(p.per_day_cents)}/day</>}
          </span>
        )}
        {p.reward_note && <span className="note">{p.reward_note}</span>}
      </div>
      <QuarterStrip p={p} />
      {/* The mirror of a minimum: past the cap the elevated rate is gone. */}
      {p.cap_reached && <div className="cap">Bonus cap reached — further spend earns the base rate.</div>}
      {!p.met && p.at_risk_cents > 0 && (
        <div className="risk">⏳ ${money(p.at_risk_cents)} of this may post after {p.window.end}.</div>
      )}
      {/* Spend the issuer will not count is the difference between thinking a
          minimum is met and finding out it was not. */}
      {p.excluded_cents > 0 && (
        <div className="risk">
          ${money(p.excluded_cents)} on {p.excluded_count} excluded purchase{p.excluded_count === 1 ? '' : 's'} is not
          counted — see the Codes tab.
        </div>
      )}
    </div>
  );
}

/**
 * The three statement months of a quarter, as a row you can read at a glance.
 *
 * A card like UOB One pays nothing for the whole quarter if one statement month
 * falls short, and the months are anchored to the card's issuance date rather
 * than the calendar. Showing all three is the difference between knowing that
 * in month two and finding out when the cashback does not arrive.
 */
function QuarterStrip({ p }: { p: Progress }) {
  if (!p.quarter || !p.months.length) return null;
  const mark = (m: MonthSlice) =>
    m.qualified ? '✓' : m.state === 'past' ? '✕' : m.state === 'current' ? '›' : '·';
  const cls = (m: MonthSlice) =>
    m.qualified ? 'ok' : m.state === 'past' ? 'bad' : m.state === 'current' ? 'now' : 'ahead';
  // Urging more spend into a quarter that already pays nothing is the opposite
  // of useful, so the next rung is only offered while there is one to earn.
  // Urging more spend into a quarter that already pays nothing is the opposite
  // of useful — and so is urging a rung the quarter can no longer reach.
  const dead = p.months_missed > 0 && !p.thirds;
  const tiers = p.tiers;
  const next = dead || p.ceiling_tier ? undefined : tiers.find((t) => t.min_spend_cents > p.spent_cents);

  return (
    <div className="quarter">
      <div className="quarter-head">
        <span>Quarter {p.quarter.index}</span>
        <span className="mono">
          {p.quarter.start} → {p.quarter.end}
        </span>
      </div>
      {/* The anchor decides which months a quarter covers, and being one month
          out moves every quarter for the life of the card. Saying it here is
          what makes "why is this the September quarter" checkable. */}
      <p className="sub qpattern">
        Counted from {p.quarter.anchor_month} — this card&rsquo;s quarters begin in {p.quarter.pattern}.
      </p>
      <ol className="months">
        {p.months.map((m) => (
          <li key={m.index} className={cls(m)}>
            <span className="mark" aria-hidden="true">
              {mark(m)}
            </span>
            <span className="mno">Month {m.index}</span>
            <span className="mono amt">${money(m.spent_cents)}</span>
            {p.txns_required > 0 && (
              <span className="mono tx">
                {m.txn_count}/{p.txns_required} tx
              </span>
            )}
            <span className="state">
              {m.qualified ? 'qualified' : m.state === 'past' ? 'missed' : m.state === 'current' ? 'in progress' : 'ahead'}
            </span>
          </li>
        ))}
      </ol>
      {dead ? (
        <p className="cap">
          {p.months_missed} statement month{p.months_missed === 1 ? '' : 's'} closed short — this quarter pays nothing.
          The next one starts after {p.quarter.end}.
        </p>
      ) : (
        <>
          {p.quarter_tier && p.thirds ? (
            <p className="sub">
              On course for <strong>${money(p.projected_reward_cents)}</strong> at the $
              {money(p.quarter_tier.min_spend_cents)} tier{p.thirds < 3 ? ` · pro-rated to ${p.thirds}/3` : ''} — a
              projection, not a promise: the months ahead have to hold.
            </p>
          ) : null}

          {/* The thing that was missing. The quarter pays at its weakest month,
              so once one has closed a rung down, spending to a higher rung in
              the months after it buys nothing more that quarter. */}
          {p.ceiling_tier ? (
            <p className="sub">
              <strong>Aim for ${money(p.ceiling_tier.min_spend_cents)} this month.</strong> {p.ceiling_reason}, and a
              quarter pays at its weakest month — so anything above $
              {money(p.ceiling_tier.min_spend_cents)} still pays ${money(p.ceiling_tier.reward_cents)} this quarter.
              {p.to_target_cents > 0 ? (
                <> ${money(p.to_target_cents)} to go.</>
              ) : p.beyond_target_cents > 0 ? (
                <> You are ${money(p.beyond_target_cents)} past it — further spend here earns only the base rate.</>
              ) : null}
            </p>
          ) : (
            tiers.length > 0 && (
              <p className="sub">
                Nothing is capped yet — every rung is still reachable. Whichever one you hold in all three months is
                what the quarter pays.
              </p>
            )
          )}

          {/* The ladder, with the rung this month sits on. A tier table is
              unreadable as prose and this is the card's whole reward shape. */}
          {tiers.length > 0 && (
            <ul className="ladder">
              {tiers.map((t, i) => {
                const reached = p.spent_cents >= t.min_spend_cents;
                const ruled = p.ceiling_tier ? t.min_spend_cents > p.ceiling_tier.min_spend_cents : false;
                const here = reached && p.spent_cents < (tiers[i + 1]?.min_spend_cents ?? Infinity);
                return (
                  <li key={t.id} className={ruled ? 'ruled' : reached ? 'ok' : ''}>
                    <span className="mark" aria-hidden="true">
                      {ruled ? '✕' : reached ? '✓' : '·'}
                    </span>
                    <span className="mono">${money(t.min_spend_cents)} a month</span>
                    <span className="pays">${money(t.reward_cents)} a quarter</span>
                    <span className="state">
                      {ruled
                        ? 'out of reach this quarter'
                        : here
                          ? 'where you are'
                          : reached
                            ? 'cleared'
                            : `$${money(t.min_spend_cents - p.spent_cents)} more`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {next && (
        <p className="sub">
          ${money(next.min_spend_cents - p.spent_cents)} more this month reaches the ${money(next.min_spend_cents)} tier,
          worth ${money(next.reward_cents)} a quarter.
        </p>
      )}
    </div>
  );
}

function Card({ c }: { c: CardSummary }) {
  const headline = c.requirements.find((r) => r.id === c.headline_id) ?? null;
  return (
    <section className="card">
      <header>
        <div>
          <h2>{c.product}</h2>
          <p className="sub">
            {c.issuer} · {c.nickname}
          </p>
        </div>
        <div className={`pct ${c.lost ? 'bad' : headline ? minTone(headline) : tone(c.percent)}`}>
          {c.percent.toFixed(0)}%
        </div>
      </header>
      <Meter percent={c.percent} tone={c.lost ? 'bad' : headline ? minTone(headline) : tone(c.percent)} />
      {/* The minimum is what you can still act on today; the limit is what a
          credit score reads. So the minimum leads and the balance follows. */}
      {c.lost && headline?.quarter ? (
        /* A quarter with a month already closed short pays nothing whatever you
           spend now. Saying so is the difference between chasing it and moving
           the spend to a card where it still counts. */
        <p className="cap">
          This quarter is already short — spend here earns only the base rate until {headline.quarter.end}.
        </p>
      ) : null}
      {headline ? (
        <p className="sub mono">
          ${money(headline.spent_cents)} / ${money(headline.amount_cents)} minimum
          {headline.txns_required > 0 && ` · ${headline.txn_count}/${headline.txns_required} txns`} ·{' '}
          {headline.met ? 'met' : `$${money(headline.remaining_cents)} to go`} by {headline.window.end} (
          {headline.days_left}d)
        </p>
      ) : (
        <p className="sub mono">
          No minimum to hit · ${money(c.balance_cents)} / ${money(c.limit_cents)} · closes {c.cycle.end} ({c.days_left}d)
        </p>
      )}
      {headline && (
        <p className="sub dim">
          Balance ${money(c.balance_cents)} of ${money(c.limit_cents)} ({c.util_percent.toFixed(0)}%) · statement closes{' '}
          {c.cycle.end}
        </p>
      )}
      {c.at_risk_cents > 0 && (
        <p className="risk">⏳ ${money(c.at_risk_cents)} may post after this cycle closes</p>
      )}
      {c.requirements.map((r) => (
        <RequirementRow key={r.id} p={r} nickname={c.nickname} />
      ))}
    </section>
  );
}

/**
 * The scan the cron runs twice a day, on a button. Matches land in the inbox
 * below as well as in Telegram.
 */
function Scanner({ onScanned }: { onScanned: () => void }) {
  const [stats, setStats] = useState<ScanSummary | null>(null);
  const [busy, setBusy] = useState<'' | 'deep' | 'quick' | 'url'>('');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function scan(mode: 'deep' | 'quick' | 'url') {
    setBusy(mode);
    setErr(null);
    try {
      setStats(await runScan(mode === 'url' ? { url } : { deep: mode === 'deep' }));
      if (mode === 'url') setUrl('');
      onScanned();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="card entry">
      <h2>Scan for offers</h2>
      <p className="sub">
        Runs automatically at 06:00 and 14:00. A deep scan opens each article to read past the headline; a quick scan
        only reads feed summaries.
      </p>
      <div className="entry-foot">
        <button onClick={() => scan('deep')} disabled={!!busy}>
          {busy === 'deep' ? 'Scanning…' : 'Scan now'}
        </button>
        <button className="secondary" onClick={() => scan('quick')} disabled={!!busy}>
          {busy === 'quick' ? 'Scanning…' : 'Quick scan'}
        </button>
      </div>
      <div className="entry-grid" style={{ marginTop: 12 }}>
        <label className="f f-note">
          <span>Or read one page</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://milelion.com/2026/…"
            inputMode="url"
          />
        </label>
      </div>
      <div className="entry-foot">
        <button onClick={() => scan('url')} disabled={!!busy || !/^https?:\/\//i.test(url)}>
          {busy === 'url' ? 'Reading…' : 'Read page'}
        </button>
        {stats && (
          <span className="sub">
            {stats.feeds_read} source{stats.feeds_read === 1 ? '' : 's'} · {stats.items_seen} new · {stats.pages_fetched}{' '}
            opened · {stats.fresh.length} match{stats.fresh.length === 1 ? '' : 'es'}
            {stats.feeds_failed.length ? ` · unreachable: ${stats.feeds_failed.join(', ')}` : ''}
          </span>
        )}
        {err && <span className="err-text">{err}</span>}
      </div>
    </section>
  );
}

const STATES: { key: FeedState; label: string; count: (c: FeedPage['counts']) => number | null }[] = [
  { key: 'new', label: 'Inbox', count: (c) => c.new },
  { key: 'tracked', label: 'Tracked', count: (c) => c.tracked },
  { key: 'ignored', label: 'Ignored', count: (c) => c.ignored },
  { key: 'all', label: 'Everything', count: (c) => c.all },
];

const RANGES: { key: RangeName; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: 'month', label: 'This month' },
  { key: 'lastmonth', label: 'Last month' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'ytd', label: 'Year to date' },
];

/** How strongly the scanner thought this was an offer, in words. */
function strength(score: number | null) {
  if (score == null) return null;
  if (score >= 5) return { label: 'Strong match', cls: 'strong-match' };
  if (score >= 3) return { label: 'Match', cls: 'fair-match' };
  return { label: 'Weak match', cls: 'weak-match' };
}

/** Everything the scanner has seen, a page at a time. */
function Inbox({ tick, onTracked }: { tick: number; onTracked: () => void }) {
  const [state, setState] = useState<FeedState>('new');
  const [range, setRange] = useState<RangeName>('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<FeedPage | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function load() {
    fetchFeed({ state, range, page })
      .then((d) => {
        setData(d);
        // The server clamps the page; follow it rather than arguing.
        if (d.page !== page) setPage(d.page);
      })
      .catch((e) => setErr(e.message));
  }
  useEffect(load, [state, range, page, tick]);
  // A filter change starts at the top.
  useEffect(() => setPage(1), [state, range]);
  // Selection never outlives the rows it was made on: a tick on page 1 that
  // survived to page 3 would leave "Ignore 2" acting on items you cannot see.
  useEffect(() => setPicked(new Set()), [state, range, page]);

  const items = data?.items ?? [];
  const allPicked = items.length > 0 && items.every((i) => picked.has(i.id));

  function toggle(id: number) {
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function act(ids: number[], action: 'track' | 'ignore') {
    if (!ids.length) return;
    setBusy(true);
    setErr(null);
    try {
      await feedActionMany(ids, action);
      setPicked(new Set());
      load();
      if (action === 'track') onTracked();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const first = data ? (data.page - 1) * data.per_page + 1 : 0;
  const last = data ? Math.min(data.page * data.per_page, data.total) : 0;

  return (
    <section className="card entry">
      <header className="inbox-head">
        <h2>Scanned items</h2>
        <select className="range-select" value={range} onChange={(e) => setRange(e.target.value as RangeName)}>
          {RANGES.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
      </header>

      <div className="chips">
        {STATES.map((st) => (
          <button
            key={st.key}
            className={`chip ${state === st.key ? 'on' : ''}`}
            onClick={() => setState(st.key)}
          >
            {st.label}
            {data ? <span className="chip-n">{st.count(data.counts)}</span> : null}
          </button>
        ))}
      </div>

      {items.length > 0 && (
        <div className="bulk">
          <label className="tick">
            <input
              type="checkbox"
              checked={allPicked}
              onChange={() => setPicked(allPicked ? new Set() : new Set(items.map((i) => i.id)))}
            />
            <span>{allPicked ? 'Clear page' : 'Select page'}</span>
          </label>
          <span className="sub">
            {picked.size ? `${picked.size} selected` : `${first}–${last} of ${data?.total ?? 0}`}
          </span>
          {picked.size > 0 && (
            <>
              <button className="secondary" onClick={() => act([...picked], 'track')} disabled={busy}>
                Track {picked.size}
              </button>
              <button className="secondary danger" onClick={() => act([...picked], 'ignore')} disabled={busy}>
                Ignore {picked.size}
              </button>
            </>
          )}
          {err && <span className="err-text">{err}</span>}
        </div>
      )}

      <ul className="feed">
        {items.map((i) => {
          const s = strength(i.score);
          return (
            <li key={i.id} className={`feed-item ${picked.has(i.id) ? 'picked' : ''}`}>
              <label className="tick">
                <input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} />
              </label>
              <div className="feed-body">
                <a className="feed-title" href={i.link} target="_blank" rel="noreferrer">
                  {i.title || i.link}
                </a>
                <p className="meta">
                  <span className="tag">{i.feed}</span>
                  <span>{(i.published_at ?? i.seen_at).slice(0, 10)}</span>
                  {s && <span className={s.cls}>{s.label}</span>}
                  <span>{i.deep ? 'article read' : 'headline only'}</span>
                  {i.action && <span className={`state ${i.action}`}>{i.action}</span>}
                  {i.offer_id && <span className="state tracked">offer #{i.offer_id}</span>}
                </p>
                {i.excerpt && <p className="excerpt">{i.excerpt}</p>}
                {i.terms && (
                  <p className="terms">
                    {i.terms.split('|').map((t) => (
                      <span key={t} className="term">
                        {t.trim()}
                      </span>
                    ))}
                  </p>
                )}
                <div className="feed-actions">
                  {!i.action && (
                    <>
                      <button className="secondary" onClick={() => act([i.id], 'track')} disabled={busy}>
                        Track
                      </button>
                      <button className="secondary" onClick={() => act([i.id], 'ignore')} disabled={busy}>
                        Ignore
                      </button>
                    </>
                  )}
                  {i.action === 'ignored' && (
                    <button className="secondary" onClick={() => act([i.id], 'track')} disabled={busy}>
                      Track after all
                    </button>
                  )}
                  {i.apply_url && i.apply_url !== i.link && (
                    <a className="link" href={i.apply_url} target="_blank" rel="noreferrer">
                      Offer page
                    </a>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {data && !items.length && (
        <p className="sub">
          {state === 'new'
            ? 'Nothing waiting. New matches appear here and in Telegram.'
            : 'Nothing in this range. Try a wider one.'}
        </p>
      )}

      {data && data.pages > 1 && <Pager page={data.page} pages={data.pages} onGo={setPage} />}

      <Housekeeping onChanged={load} />
    </section>
  );
}

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * Scanned history is the only table that grows without you doing anything.
 * Compacting keeps each item's id — so it is never shown to you twice — and
 * drops its bulk. Deleting forgets it, which means a feed that still carries it
 * will surface it again; that is said plainly rather than discovered later.
 */
function Housekeeping({ onChanged }: { onChanged: () => void }) {
  const [store, setStore] = useState<FeedStorage | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  function load() {
    fetchFeedStorage()
      .then(setStore)
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(load, []);

  async function run(mode: 'compact' | 'delete') {
    setBusy(true);
    setErr(null);
    try {
      const r = await purgeFeed(
        mode === 'compact'
          ? { mode: 'compact', scope: 'decided', older_than_days: store?.retention_days }
          : { mode: 'delete', scope: 'ignored' }
      );
      setStore(r.storage);
      setMsg(
        mode === 'compact'
          ? `Compacted ${r.affected} item(s), freeing ${kb(r.freed_bytes)}.`
          : `Deleted ${r.affected} ignored item(s), freeing ${kb(r.freed_bytes)}.`
      );
      setConfirming(false);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!store) return null;
  return (
    <div className="keeping">
      <p className="sub">
        {store.total.toLocaleString()} item(s) stored · {kb(store.text_bytes)} of text ·{' '}
        {store.compactable.toLocaleString()} compactable ({kb(store.reclaimable_bytes)})
      </p>
      <div className="entry-foot">
        <button className="secondary" onClick={() => run('compact')} disabled={busy || !store.compactable}>
          Compact judged items
        </button>
        <button className="secondary danger" onClick={() => setConfirming((v) => !v)} disabled={busy || !store.ignored}>
          Delete {store.ignored} ignored
        </button>
        {msg && <span className="sub">{msg}</span>}
        {err && <span className="err-text">{err}</span>}
      </div>
      {confirming && (
        <div className="warnbox">
          Deleting forgets these items. Compacting keeps the id, so an item is never shown twice; deleting means any of
          them still carried by a feed will come back on the next scan and be offered to you again.
          <div className="entry-foot">
            <button className="secondary danger" onClick={() => run('delete')} disabled={busy}>
              Delete anyway
            </button>
            <button className="secondary" onClick={() => setConfirming(false)}>
              Keep them
            </button>
          </div>
        </div>
      )}
      <p className="sub">
        Judged items older than {store.retention_days} days are compacted nightly; change that on the Settings tab.
      </p>
    </div>
  );
}

const VERDICT_LABEL = {
  eligible: 'Eligible',
  not_eligible: 'Not eligible',
  needs_review: 'Needs review',
} as const;

const DECISION_TEXT: Record<RuleDecision, string> = {
  pass: 'You confirmed this',
  fail: 'You said you do not meet this',
  na: 'Does not apply to you',
};

/** One clause, with the answer only you can give. */
function Rule({ r, onChange }: { r: RuleRow; onChange: (e: Eligibility) => void }) {
  const [note, setNote] = useState(r.note ?? '');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function decide(decision: RuleDecision | null) {
    setBusy(true);
    setErr(null);
    try {
      onChange((await decideRule(r.id, decision, decision ? note || null : null)).eligibility);
      setEditing(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      onChange((await deleteRule(r.id)).eligibility);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <li className={r.verdict}>
      <span>{r.decision ? DECISION_TEXT[r.decision] : r.reason}</span>
      {/* Every verdict stays traceable to the sentence it came from. */}
      {r.quote && <blockquote>{r.quote}</blockquote>}
      {r.decision && (
        <p className="sub">
          Your answer{r.decided_at ? ` on ${r.decided_at}` : ''}
          {r.note ? ` — ${r.note}` : ''}
          {/* An override is never silent: the computed verdict stays visible. */}
          {r.overridden ? ` · overrides the data, which says: ${r.reason}` : ''}
        </p>
      )}
      {editing && (
        <input
          className="rule-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why? e.g. closed this card in 2023, before I started tracking"
        />
      )}
      <div className="entry-foot rule-actions">
        <button onClick={() => decide('pass')} disabled={busy || r.decision === 'pass'}>
          I meet this
        </button>
        <button onClick={() => decide('fail')} disabled={busy || r.decision === 'fail'}>
          I do not
        </button>
        <button onClick={() => decide('na')} disabled={busy || r.decision === 'na'}>
          N/A
        </button>
        {r.decision && (
          <button onClick={() => decide(null)} disabled={busy}>
            Clear
          </button>
        )}
        <button onClick={() => setEditing((v) => !v)} disabled={busy}>
          {editing ? 'Hide note' : 'Note'}
        </button>
        <button className="danger" onClick={remove} disabled={busy}>
          Remove clause
        </button>
        {err && <span className="err-text">{err}</span>}
      </div>
    </li>
  );
}

/** The T&C extraction flow, without leaving the app: copy prompt, paste reply. */
function Extract({ id, onSaved }: { id: number; onSaved: (e: Eligibility) => void }) {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [paste, setPaste] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadPrompt() {
    setErr(null);
    try {
      const d = await fetchExtractPrompt(id);
      setPrompt(d.prompt);
      try {
        await navigator.clipboard.writeText(d.prompt);
        setMsg('Prompt copied. Paste it into Claude with the T&C text.');
      } catch {
        // Clipboard needs a secure context and permission; the textarea below
        // is the fallback, so this is not worth surfacing as an error.
        setMsg('Select the text below and copy it into Claude with the T&C.');
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const res = await saveExtraction(id, paste);
      setPaste('');
      setPrompt(null);
      setMsg(
        `Saved ${res.rules_saved} clause(s)` +
          (res.decisions_kept ? `, keeping ${res.decisions_kept} of your answers` : '') +
          '.'
      );
      onSaved(res.eligibility);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="extract">
      <p className="sub">
        The terms have not been read yet. Copy the prompt, paste it into Claude with the offer's T&amp;C, then paste the
        JSON it returns back here.
      </p>
      <div className="entry-foot">
        <button onClick={loadPrompt}>Copy the prompt</button>
      </div>
      {prompt && <textarea className="prompt" readOnly rows={6} value={prompt} onFocus={(e) => e.target.select()} />}
      <textarea
        className="prompt"
        rows={4}
        value={paste}
        onChange={(e) => setPaste(e.target.value)}
        placeholder="Paste Claude's JSON reply here"
      />
      <div className="entry-foot">
        <button onClick={save} disabled={busy || !paste.trim()}>
          {busy ? 'Saving…' : 'Save the terms'}
        </button>
        {msg && <span className="sub">{msg}</span>}
        {err && <span className="err-text">{err}</span>}
      </div>
    </div>
  );
}

function Offer({ o, onChange }: { o: OfferRow; onChange: () => void }) {
  const [elig, setElig] = useState<Eligibility>(o.eligibility);
  const [status, setStatus] = useState(o.status);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setElig(o.eligibility), [o.eligibility]);

  function update(e: Eligibility) {
    setElig(e);
    onChange();
  }

  async function move(next: OfferRow['status']) {
    setErr(null);
    try {
      await setOfferStatus(o.id, next);
      setStatus(next);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const v = elig.verdict;
  return (
    <section className={`card offer ${status === 'dismissed' ? 'dim' : ''}`}>
      <header>
        <div>
          <h2>
            #{o.id} {o.product ?? o.source_title ?? 'Untitled offer'}
          </h2>
          <p className="sub">
            {o.issuer ?? 'Issuer unknown'}
            {status !== 'tracked' ? ` · ${status}` : ''}
          </p>
        </div>
        <div className={`badge ${v}`}>{VERDICT_LABEL[v]}</div>
      </header>
      <p className="sub">
        {o.bonus_miles ? `${o.bonus_miles.toLocaleString()} miles` : o.bonus_note ?? 'Bonus not extracted'}
        {o.min_spend_cents ? ` for $${money(o.min_spend_cents)} in ${o.spend_window_days ?? '?'}d` : ''}
      </p>
      {/* When the offer ends is the thing that decides whether to act today. */}
      <p className={`deadline ${o.expired ? 'gone' : o.days_left !== null && o.days_left <= 14 ? 'soon' : ''}`}>
        {o.valid_until === null
          ? 'No end date extracted — read the terms before counting on it'
          : o.expired
            ? `Ended ${o.valid_until}${o.days_left !== null ? ` · ${-o.days_left} days ago` : ''}`
            : o.days_left === 0
              ? `Ends today (${o.valid_until})`
              : `Ends in ${o.days_left} days · ${o.valid_until}`}
      </p>

      {elig.open_questions > 0 && (
        <p className="cap">
          {elig.open_questions} clause{elig.open_questions === 1 ? '' : 's'} the card history cannot settle — answer
          below.
        </p>
      )}

      <ul className="rules">
        {elig.rules.map((r) => (
          <Rule key={r.id} r={r} onChange={update} />
        ))}
      </ul>

      {!elig.rules.length && <Extract id={o.id} onSaved={update} />}

      <div className="entry-foot">
        {status !== 'applied' && <button onClick={() => move('applied')}>Mark applied</button>}
        {status !== 'dismissed' && (
          <button className="danger" onClick={() => move('dismissed')}>
            Dismiss
          </button>
        )}
        {status !== 'tracked' && <button onClick={() => move('tracked')}>Back to tracked</button>}
        {!!elig.rules.length && <Reextract id={o.id} onSaved={update} />}
        {o.source_url && (
          <a className="link" href={o.source_url} target="_blank" rel="noreferrer">
            Source
          </a>
        )}
        {err && <span className="err-text">{err}</span>}
      </div>
    </section>
  );
}

/** Re-run the extraction on an offer that already has clauses. */
function Reextract({ id, onSaved }: { id: number; onSaved: (e: Eligibility) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen((v) => !v)}>{open ? 'Close' : 'Re-read the terms'}</button>
      {open && (
        <div className="extract-wide">
          <Extract id={id} onSaved={onSaved} />
        </div>
      )}
    </>
  );
}

/** The sources the scanner reads, editable here rather than only via the bot. */
function Sources() {
  const [feeds, setFeeds] = useState<FeedRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState({ url: '', label: '', kind: '' });
  const [busy, setBusy] = useState(false);

  function load() {
    fetchFeeds()
      .then((d) => setFeeds(d.feeds))
      .catch((e) => setErr(e.message));
  }
  useEffect(load, []);

  async function add() {
    setBusy(true);
    setErr(null);
    try {
      await saveFeed({ url: draft.url, label: draft.label, kind: draft.kind || null, active: true });
      setDraft({ url: '', label: '', kind: '' });
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card entry">
      <h2>Sources</h2>
      <p className="sub">
        Where the scan looks. <strong>rss</strong> is a feed, <strong>page</strong> is an ordinary listing page whose
        headline links get harvested, blank detects from the response.
      </p>
      {feeds?.map((f) => (
        <SourceRow key={f.url} f={f} onSaved={load} />
      ))}
      {feeds && !feeds.length && <p className="sub">No sources. Add one below, or send /seed to the bot.</p>}

      <div className="entry-grid">
        <label className="f f-note">
          <span>New source URL</span>
          <input
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            placeholder="https://milelion.com/feed/"
            inputMode="url"
          />
        </label>
        <label className="f">
          <span>Label</span>
          <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="MileLion" />
        </label>
        <label className="f">
          <span>Kind</span>
          <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
            <option value="">detect</option>
            <option value="rss">rss</option>
            <option value="page">page</option>
          </select>
        </label>
      </div>
      <div className="entry-foot">
        <button onClick={add} disabled={busy || !/^https?:\/\//i.test(draft.url)}>
          Add source
        </button>
        {err && <span className="err-text">{err}</span>}
      </div>
    </section>
  );
}

function SourceRow({ f, onSaved }: { f: FeedRow; onSaved: () => void }) {
  const [url, setUrl] = useState(f.url);
  const [label, setLabel] = useState(f.label);
  const [kind, setKind] = useState(f.kind ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = url !== f.url || label !== f.label || (kind || null) !== f.kind;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`source ${f.active ? '' : 'dim'}`}>
      <div className="entry-grid">
        <label className="f f-note">
          <span>URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" />
        </label>
        <label className="f">
          <span>Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="f">
          <span>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">detect</option>
            <option value="rss">rss</option>
            <option value="page">page</option>
          </select>
        </label>
      </div>
      <div className="entry-foot">
        <button
          onClick={() => run(() => saveFeed({ url, label, kind: kind || null, active: !!f.active, old_url: f.url }))}
          disabled={busy || !dirty}
        >
          {dirty ? 'Save' : 'Saved'}
        </button>
        <button
          onClick={() => run(() => saveFeed({ url: f.url, label: f.label, kind: f.kind, active: !f.active }))}
          disabled={busy}
        >
          {f.active ? 'Pause' : 'Resume'}
        </button>
        <button className="danger" onClick={() => run(() => deleteFeed(f.url))} disabled={busy}>
          Remove
        </button>
        <span className="sub">
          {f.items} item{f.items === 1 ? '' : 's'}
          {f.last_seen ? ` · last ${f.last_seen.slice(0, 10)}` : ' · never read'}
        </span>
        {err && <span className="err-text">{err}</span>}
      </div>
    </div>
  );
}

function AddSpend({
  cards,
  categories,
  onSaved,
}: {
  cards: CardSummary[];
  categories: string[];
  onSaved: () => void;
}) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const [nickname, setNickname] = useState(cards[0]?.nickname ?? '');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso);
  const [posted, setPosted] = useState('');
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const backdated = date !== todayIso;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await addTransaction({ nickname, amount, date, note, posted, category });
      // Keep the card and date, clear the entry — several receipts from the
      // same day is the common case.
      setAmount('');
      setNote('');
      setPosted('');
      setMsg({
        kind: 'ok',
        text:
          `Added $${amount} to ${r.card}` +
          (r.posted_at ? `, posted ${r.posted_at}` : '') +
          (r.category ? ` · ${r.category}` : ''),
      });
      onSaved();
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!cards.length) return null;

  return (
    <form className="card entry" onSubmit={submit}>
      <h2>Log spend</h2>
      <div className="entry-grid">
        <label className="f f-amount">
          <span>Amount</span>
          <input
            id="amt"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="25.40"
            required
          />
        </label>
        <label className="f">
          <span>Card</span>
          <select id="card" value={nickname} onChange={(e) => setNickname(e.target.value)}>
            {cards.map((c) => (
              <option key={c.id} value={c.nickname}>
                {c.product}
              </option>
            ))}
          </select>
        </label>
        <label className="f">
          <span>Date</span>
          <input id="date" type="date" value={date} max={todayIso} onChange={(e) => setDate(e.target.value)} />
        </label>
        {/* Windows are judged on the posting date. For an older purchase you
            often already know it; leave it blank while it is still pending. */}
        <label className="f">
          <span>Posted {backdated ? '' : '(optional)'}</span>
          <input
            id="posted"
            type="date"
            value={posted}
            min={date}
            max={todayIso}
            onChange={(e) => setPosted(e.target.value)}
          />
        </label>
        {categories.length > 0 && (
          <label className="f">
            <span>Category</span>
            <select id="cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">auto</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="f f-note">
          <span>Note</span>
          <input id="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="merchant" />
        </label>
      </div>
      <div className="entry-foot">
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Add'}
        </button>
        {msg && <span className={msg.kind === 'ok' ? 'ok-text' : 'err-text'}>{msg.text}</span>}
      </div>
      {backdated && !posted && (
        <p className="risk">
          ⏳ Backdated with no posting date — it will count from {date} until you set one.
        </p>
      )}
    </form>
  );
}

function Recent({
  txns,
  count,
  setCount,
  onDelete,
  onPosted,
}: {
  txns: Txn[];
  count: number;
  setCount: (n: number) => void;
  onDelete: (id: number) => void;
  onPosted: (id: number, date: string) => void;
}) {
  if (!txns.length) return null;
  return (
    <section className="card">
      <header>
        <div>
          <h2>Recent</h2>
          <p className="sub">Newest first</p>
        </div>
        <div className="seg" role="group" aria-label="How many to show">
          {[5, 10, 25].map((n) => (
            <button key={n} type="button" className={count === n ? 'on' : ''} onClick={() => setCount(n)}>
              {n}
            </button>
          ))}
        </div>
      </header>
      <ul className="txns">
        {txns.map((t) => (
          <li key={t.id} className={t.posted_at ? '' : 'unposted'}>
            <span className="mono t-date">{t.occurred_at.slice(5)}</span>
            <span className="t-card">{t.nickname}</span>
            <span className="t-note">{t.merchant ?? ''}</span>
            {/* The posting date is what windows are judged on, so make it
                settable in one tap rather than hiding it behind the bot. */}
            {t.posted_at ? (
              <span className="mono t-posted" title={`Posted ${t.posted_at}`}>
                → {t.posted_at.slice(5)}
              </span>
            ) : (
              <input
                id={`posted-${t.id}`}
                className="t-posted-input"
                type="date"
                min={t.occurred_at}
                title="Set the date the bank posted this"
                onChange={(e) => e.target.value && onPosted(t.id, e.target.value)}
              />
            )}
            <span className="mono t-amt">${money(t.amount_cents)}</span>
            <button type="button" className="t-del" onClick={() => onDelete(t.id)} aria-label={`Delete entry ${t.id}`}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function WhichCard({ categories }: { categories: string[] }) {
  const [category, setCategory] = useState(categories[0] ?? 'dining');
  const [amount, setAmount] = useState('');
  const [picks, setPicks] = useState<Pick[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      setPicks((await fetchWhich(category, amount)).picks);
    } finally {
      setBusy(false);
    }
  }

  if (!categories.length) return null;

  return (
    <section className="card">
      <header>
        <div>
          <h2>Which card?</h2>
          <p className="sub">Ranked by what you actually get back — cashback and miles on one scale</p>
        </div>
      </header>
      <form className="entry-grid" onSubmit={run}>
        <label className="f">
          <span>Category</span>
          <select id="wc-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="f">
          <span>Amount (optional)</span>
          <input id="wc-amt" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="120" />
        </label>
      </form>
      <div className="entry-foot">
        <button type="button" onClick={run as unknown as () => void} disabled={busy}>
          {busy ? 'Checking…' : 'Rank cards'}
        </button>
      </div>
      {picks && (
        <ol className="picks">
          {picks.map((p, i) => (
            <li key={p.card_id} className={i === 0 ? 'best' : ''}>
              <div className="pick-head">
                <span>{p.product}</span>
                {/* Value in dollars is the only scale on which a cashback card
                    and a miles card can be compared. */}
                <span className="mono">
                  {p.reward_type === 'cashback' ? `${p.effective_mpd}% back` : `${p.effective_mpd} mpd`}
                  {p.value_cents > 0 && <> · ≈${money(Math.round(p.value_cents))}</>}
                </span>
              </div>
              {p.reasons.map((r, j) => (
                <p key={j} className="sub">
                  {r}
                </p>
              ))}
            </li>
          ))}
          {!picks.length && <li className="sub">No earn rules yet — add them with /addearn in the bot.</li>}
        </ol>
      )}
    </section>
  );
}

/**
 * The wallet: everything held, what is waiting to go in, and what it is worth.
 *
 * Bank points and airline miles are shown in their own units and, separately,
 * as the miles they convert to. Adding 50,000 Citi points to 50,000 KrisFlyer
 * miles and calling it 100,000 would be a lie, so the total is in miles after
 * conversion, with the raw balances beside it.
 */
function WalletPanel({ onChanged }: { onChanged: () => void }) {
  const [w, setW] = useState<Wallet | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  function load() {
    fetchWallet()
      .then(setW)
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(load, []);

  async function accept(body: { ids?: number[]; program_key?: string }) {
    setBusy(true);
    setErr(null);
    try {
      setW((await acceptCredits(body)).wallet);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function undo(id: number) {
    setBusy(true);
    try {
      setW((await undoCredit(id)).wallet);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (err) return <p className="pad error">{err}</p>;
  if (!w) return <p className="pad sub">Loading…</p>;

  const held = w.programs.filter((p) => p.points > 0 || p.pending > 0);
  const pending = w.pending;

  return (
    <>
      <section className="card hero">
        <span className="stat-label">Wallet</span>
        <span className="hero-value">{w.totals.miles_equivalent.toLocaleString()} miles</span>
        <span className="sub">
          after conversion · about ${money(w.totals.value_cents)} at your mile value
          {w.totals.pending_points > 0 ? ` · ${w.totals.pending_points.toLocaleString()} waiting to be banked` : ''}
        </span>
      </section>

      {pending.total_points > 0 && (
        <section className="card">
          <header>
            <div>
              <h2>Waiting to be banked</h2>
              <p className="sub">
                What your spending should have earned. Accept it to add it to the balance — banks sometimes credit
                something else, so nothing goes in on its own.
              </p>
            </div>
          </header>
          {pending.by_program.map((g) => (
            <div key={g.program_key} className="bal">
              <div className="pick-head">
                <span>{g.program_name}</span>
                <span className="mono">
                  +{g.points.toLocaleString()} {g.unit}
                </span>
              </div>
              <p className="sub">from {g.count} purchase(s)</p>
              <div className="entry-foot">
                <button className="secondary" onClick={() => accept({ program_key: g.program_key })} disabled={busy}>
                  Accept {g.points.toLocaleString()}
                </button>
              </div>
            </div>
          ))}
          <div className="entry-foot">
            <button onClick={() => accept({ ids: pending.credits.map((c) => c.id) })} disabled={busy}>
              Accept everything
            </button>
            <button className="secondary" onClick={() => setOpen((v) => !v)}>
              {open ? 'Hide the list' : `Show all ${pending.credits.length}`}
            </button>
          </div>
          {open && (
            <ul className="txns credits">
              {pending.credits.map((c) => (
                <li key={c.id}>
                  <span className="t-date">{c.date.slice(5)}</span>
                  <span className="t-card">{c.card}</span>
                  <span className="t-note">{c.merchant ?? '—'}</span>
                  <span className="t-amt mono">
                    +{c.miles.toLocaleString()} {c.unit}
                  </span>
                  <button className="secondary" onClick={() => accept({ ids: [c.id] })} disabled={busy}>
                    Accept
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {pending.unassigned.length > 0 && (
        <section className="card">
          <header>
            <div>
              <h2>Earning with nowhere to go</h2>
              <p className="sub">These cards earn, but no programme is set, so the points cannot be banked.</p>
            </div>
          </header>
          <ul className="notes">
            {pending.unassigned.map((u) => (
              <li key={u.nickname}>
                <strong>{u.card}</strong> — {u.miles.toLocaleString()} from {u.count} purchase(s). Set one with{' '}
                <code>/setprogram {u.nickname} &lt;programme&gt;</code> in the bot.
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <header>
          <div>
            <h2>Balances</h2>
            <p className="sub">Every programme you hold something in</p>
          </div>
        </header>
        {held.map((p) => (
          <div key={p.program_key} className="bal">
            <div className="pick-head">
              <span>{p.name}</span>
              <span className="mono">
                {p.points.toLocaleString()} {p.unit}
              </span>
            </div>
            <p className="sub">
              {p.unit === 'miles'
                ? `about $${money(p.value_cents ?? 0)}`
                : p.miles_equivalent !== null
                  ? `≈ ${p.miles_equivalent.toLocaleString()} miles ${p.rate_note ?? ''} · about $${money(p.value_cents ?? 0)}`
                  : 'no conversion recorded, so no miles value'}
              {p.pending ? ` · ${p.pending.toLocaleString()} waiting` : ''}
            </p>
            {p.expiring_soon > 0 && (
              <p className="cap">
                {p.expiring_soon.toLocaleString()} expiring by {p.next_expiry}
              </p>
            )}
          </div>
        ))}
        {!held.length && <p className="sub">Nothing yet. Log some spend, or record a balance below.</p>}
      </section>

      {w.expiring.length > 0 && (
        <section className="card">
          <header>
            <div>
              <h2>Expiring within 90 days</h2>
            </div>
          </header>
          <ul className="rules">
            {w.expiring.map((e, i) => (
              <li key={i} className={e.days < 30 ? 'fail' : 'unknown'}>
                <span>
                  {e.points.toLocaleString()} {e.name} on {e.expires_at} ({e.days}d)
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function PointsTab() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const [data, setData] = useState<{ balances: BalanceRow[]; programs: ProgramRow[]; tranches: Tranche[] } | null>(null);
  const [points, setPoints] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [plans, setPlans] = useState<Plan[] | null>(null);

  // Add-a-balance form
  const [bProg, setBProg] = useState('');
  const [bPoints, setBPoints] = useState('');
  const [bExpires, setBExpires] = useState('');
  const [bNote, setBNote] = useState('');
  const [bMsg, setBMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Add-a-programme form
  const [pName, setPName] = useState('');
  const [pKind, setPKind] = useState('airline');
  const [pUnit, setPUnit] = useState('miles');

  function load() {
    return fetchPoints()
      .then((d) => {
        setData(d);
        setFrom((f) => f || d.programs.find((p) => p.kind === 'bank')?.key || '');
        setTo((t) => t || d.programs.find((p) => p.kind === 'airline')?.key || '');
        setBProg((b) => b || d.programs[0]?.key || '');
      })
      .catch(() => void 0);
  }

  useEffect(() => {
    load();
  }, []);

  async function convert(e: React.FormEvent) {
    e.preventDefault();
    if (!points || !from || !to) return;
    setPlans((await fetchConvert(points, from, to)).plans);
  }

  async function saveBalance(e: React.FormEvent) {
    e.preventDefault();
    setBMsg(null);
    try {
      const r = await addTranche({ program_key: bProg, points: bPoints, expires_at: bExpires, note: bNote });
      setBPoints('');
      setBNote('');
      setBExpires('');
      setBMsg({ kind: 'ok', text: r.expires_at ? `Saved, expires ${r.expires_at}` : 'Saved' });
      await load();
    } catch (err) {
      setBMsg({ kind: 'err', text: (err as Error).message });
    }
  }

  async function saveProgram(e: React.FormEvent) {
    e.preventDefault();
    if (!pName.trim()) return;
    await addProgram({ key: pName, name: pName.trim(), kind: pKind, unit: pUnit });
    setPName('');
    await load();
  }

  async function removeTranche(id: number) {
    await deleteTranche(id);
    await load();
  }

  if (!data) return <p className="pad sub">Loading…</p>;

  const nameOf = (key: string) => data.programs.find((p) => p.key === key)?.name ?? key;

  return (
    <>
      {/* The dashboard: totals, what is waiting to be banked, and balances. */}
      <WalletPanel onChanged={load} />

      <section className="card">
        <header>
          <div>
            <h2>Batches</h2>
            <p className="sub">Points expire in batches, so these are the rows you act on</p>
          </div>
        </header>
        {data.tranches.length ? (
          <ul className="txns">
            {data.tranches.map((t) => (
              <li key={t.id}>
                <span className="t-card">{nameOf(t.program_key)}</span>
                <span className="t-note">{t.note ?? ''}</span>
                <span className="mono t-posted">{t.expires_at ?? 'no expiry'}</span>
                <span className="mono t-amt">{t.points.toLocaleString()}</span>
                <button type="button" className="t-del" onClick={() => removeTranche(t.id)} aria-label="Delete batch">
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sub">Nothing recorded yet. Spend on a card, or add a balance below.</p>
        )}
      </section>

      <form className="card entry" onSubmit={saveBalance}>
        <h2>Add a balance</h2>
        <div className="entry-grid">
          <label className="f">
            <span>Programme</span>
            <select id="b-prog" value={bProg} onChange={(e) => setBProg(e.target.value)}>
              <optgroup label="Airline">
                {data.programs.filter((p) => p.kind === 'airline').map((p) => (
                  <option key={p.key} value={p.key}>{p.name}</option>
                ))}
              </optgroup>
              <optgroup label="Bank & other">
                {data.programs.filter((p) => p.kind === 'bank').map((p) => (
                  <option key={p.key} value={p.key}>{p.name}</option>
                ))}
              </optgroup>
            </select>
          </label>
          <label className="f">
            <span>Amount</span>
            <input id="b-pts" value={bPoints} onChange={(e) => setBPoints(e.target.value)} inputMode="numeric" placeholder="50000" required />
          </label>
          <label className="f">
            <span>Expires (optional)</span>
            <input id="b-exp" type="date" value={bExpires} min={todayIso} onChange={(e) => setBExpires(e.target.value)} />
          </label>
          <label className="f">
            <span>Note</span>
            <input id="b-note" value={bNote} onChange={(e) => setBNote(e.target.value)} placeholder="statement balance" />
          </label>
        </div>
        <div className="entry-foot">
          <button type="submit">Add</button>
          {bMsg && <span className={bMsg.kind === 'ok' ? 'ok-text' : 'err-text'}>{bMsg.text}</span>}
        </div>
        <p className="sub">
          Record each batch separately when they expire on different dates — a single total hides the one about to lapse.
        </p>

        <details className="batches">
          <summary>Programme not listed?</summary>
          <div className="entry-grid" style={{ marginTop: 10 }}>
            <label className="f f-note">
              <span>Name</span>
              <input id="p-name" value={pName} onChange={(e) => setPName(e.target.value)} placeholder="Malaysia Airlines Enrich" />
            </label>
            <label className="f">
              <span>Kind</span>
              <select id="p-kind" value={pKind} onChange={(e) => setPKind(e.target.value)}>
                <option value="airline">Airline</option>
                <option value="bank">Bank / other</option>
              </select>
            </label>
            <label className="f">
              <span>Unit</span>
              <input id="p-unit" value={pUnit} onChange={(e) => setPUnit(e.target.value)} />
            </label>
          </div>
          <div className="entry-foot">
            <button type="button" onClick={saveProgram}>Add programme</button>
          </div>
        </details>
      </form>

      <Routes programs={data.programs} />

      <section className="card">
        <header>
          <div>
            <h2>Transfer planner</h2>
            <p className="sub">Blocks and per-transfer fees, not a flat ratio</p>
          </div>
        </header>
        <form className="entry-grid" onSubmit={convert}>
          <label className="f">
            <span>Points</span>
            <input id="cv-pts" value={points} onChange={(e) => setPoints(e.target.value)} inputMode="numeric" placeholder="50000" />
          </label>
          <label className="f">
            <span>From</span>
            <select id="cv-from" value={from} onChange={(e) => setFrom(e.target.value)}>
              {data.programs.filter((p) => p.kind === 'bank').map((p) => (
                <option key={p.key} value={p.key}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="f">
            <span>To</span>
            <select id="cv-to" value={to} onChange={(e) => setTo(e.target.value)}>
              {data.programs.filter((p) => p.kind === 'airline').map((p) => (
                <option key={p.key} value={p.key}>{p.name}</option>
              ))}
            </select>
          </label>
        </form>
        <div className="entry-foot">
          <button type="button" onClick={convert as unknown as () => void}>Plan</button>
        </div>
        {plans && (
          <ol className="picks">
            {plans.map((p, i) => (
              <li key={i} className={i === 0 && p.possible ? 'best' : ''}>
                <div className="pick-head">
                  <span>{p.conversion.route ?? 'route'}</span>
                  <span className="mono">{p.possible ? `${p.miles.toLocaleString()} mi` : '—'}</span>
                </div>
                {p.possible ? (
                  <>
                    <p className="sub">
                      {p.transferable.toLocaleString()} transferred in {p.conversion.block_increment.toLocaleString()} blocks
                      {p.stranded > 0 && <> · {p.stranded.toLocaleString()} stranded</>}
                    </p>
                    <p className="sub">
                      {p.fee_cents ? `Fee $${money(p.fee_cents)} · ${p.cents_per_mile.toFixed(3)}¢ per mile` : 'No fee'}
                      {p.bonus_miles > 0 && <> · incl. {p.bonus_miles.toLocaleString()} bonus</>}
                    </p>
                  </>
                ) : (
                  <p className="risk">{p.reason}</p>
                )}
              </li>
            ))}
            {!plans.length && <li className="sub">No route configured. Add one with <code>/addconv</code>.</li>}
          </ol>
        )}
      </section>
    </>
  );
}

/**
 * Everything that is not the everyday product.
 *
 * These are management tools — the ledger of merchant codes, the Cloudflare
 * meters, the reward audit. They earned top-level tabs while the app was being
 * built and kept them out of habit, which left the screen that answers "which
 * card?" competing with eleven siblings.
 */
const MORE: [string, string][] = [
  ['use', 'Advisor'],
  ['catalog', 'Catalogue'],
  ['other', 'Off-card'],
  ['expiry', 'Expiry'],
  ['trends', 'Trends'],
  ['audit', 'Audit'],
  ['codes', 'Codes'],
  ['offers', 'Offers'],
  ['settings', 'Settings'],
];

export default function App() {
  const [more, setMore] = useState(false);
  const [tab, setTab] = useState<
    | 'home'
    | 'use'
    | 'cards'
    | 'catalog'
    | 'ledger'
    | 'other'
    | 'trends'
    | 'audit'
    | 'points'
    | 'expiry'
    | 'codes'
    | 'offers'
    | 'settings'
  >('home');
  const [categories, setCategories] = useState<string[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [offers, setOffers] = useState<OfferRow[] | null>(null);
  const [offerScope, setOfferScope] = useState<'open' | 'all'>('open');
  const [offersError, setOffersError] = useState<string | null>(null);
  const [sweepMsg, setSweepMsg] = useState<string | null>(null);
  const [scanTick, setScanTick] = useState(0);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [recentCount, setRecentCount] = useState(10);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    fetchSummary().then(setSummary).catch((e) => setError(e.message));
    fetchTransactions(recentCount)
      .then((d) => setTxns(d.transactions))
      .catch(() => void 0);
  }

  function loadOffers() {
    setOffersError(null);
    fetchOffers(offerScope)
      .then((d) => setOffers(d.offers))
      .catch((e) => {
        setOffers([]);
        setOffersError((e as Error).message);
      });
  }

  useEffect(() => {
    if (!bootstrapToken()) return;
    loadOffers();
  }, [offerScope]);

  // Refetch when the row count changes, without re-running the whole load.
  useEffect(() => {
    if (!bootstrapToken()) return;
    fetchTransactions(recentCount)
      .then((d) => setTxns(d.transactions))
      .catch(() => void 0);
  }, [recentCount]);

  useEffect(() => {
    if (!bootstrapToken()) {
      setError('No access token. Send /app to your Telegram bot and open the link it replies with.');
      return;
    }
    refresh();
    fetchCategories()
      .then((d) => setCategories(d.categories))
      .catch(() => void 0);
  }, []);

  async function removeTxn(id: number) {
    await deleteTransaction(id);
    refresh();
  }

  async function confirmPosted(id: number, date: string) {
    await markPosted(id, date);
    refresh();
  }

  if (error && tab !== 'use' && tab !== 'home') return <main className="pad"><p className="error">{error}</p></main>;

  return (
    <main>
      <nav className="tabs primary">
        <button className={tab === 'home' ? 'on' : ''} onClick={() => setTab('home')}>
          Home
        </button>
        <button className={tab === 'ledger' ? 'on' : ''} onClick={() => setTab('ledger')}>
          Activity
        </button>
        <button className={tab === 'cards' ? 'on' : ''} onClick={() => setTab('cards')}>
          Cards
        </button>
        <button className={tab === 'points' ? 'on' : ''} onClick={() => setTab('points')}>
          Rewards
        </button>
        <button className={more || MORE.some(([k]) => k === tab) ? 'on' : ''} onClick={() => setMore((v) => !v)}>
          More{offers?.length ? ` (${offers.length})` : ''}
        </button>
      </nav>

      {more && (
        <nav className="tabs secondary">
          {MORE.map(([k, label]) => (
            <button
              key={k}
              className={tab === k ? 'on' : ''}
              onClick={() => {
                setTab(k as typeof tab);
                setMore(false);
              }}
            >
              {label}
              {k === 'offers' && offers?.length ? ` (${offers.length})` : ''}
            </button>
          ))}
        </nav>
      )}

      {tab === 'cards' &&
        (summary ? (
          <>
            <section className="card overall">
              <header>
                <div>
                  <h2>Minimums</h2>
                  <p className="sub">
                    What you can still act on — miss one and the month&rsquo;s bonus is gone
                  </p>
                </div>
                <div
                  className={`pct ${
                    summary.overall.minimums_total === 0
                      ? 'ok'
                      : summary.overall.minimums_at_risk > 0
                        ? 'bad'
                        : summary.overall.minimums_met === summary.overall.minimums_total
                          ? 'ok'
                          : 'mid'
                  }`}
                >
                  {summary.overall.minimums_met}/{summary.overall.minimums_total}
                </div>
              </header>
              <Meter
                percent={
                  summary.overall.minimums_total
                    ? (summary.overall.minimums_met / summary.overall.minimums_total) * 100
                    : 100
                }
                tone={summary.overall.minimums_at_risk > 0 ? 'warn' : 'ok'}
              />
              <p className="sub mono">
                {summary.overall.minimums_total === 0
                  ? 'No minimums recorded — add one under a card below'
                  : summary.overall.still_needed_cents > 0
                    ? `$${money(summary.overall.still_needed_cents)} still to spend` +
                      (summary.overall.soonest_days !== null
                        ? ` · soonest closes in ${summary.overall.soonest_days}d`
                        : '')
                    : 'Every minimum met'}
              </p>
              {/* Total utilization is what actually moves a credit score, so it
                  stays — just not as the thing being asked about. */}
              <p className="sub dim">
                Total balance ${money(summary.overall.balance_cents)} of ${money(summary.overall.limit_cents)} (
                {summary.overall.percent.toFixed(0)}% utilization)
              </p>
            </section>
            <AddSpend cards={summary.cards} categories={categories} onSaved={refresh} />
            <WhichCard categories={categories} />
            {summary.cards.map((c) => (
              <Card key={c.id} c={c} />
            ))}
            <Recent txns={txns} count={recentCount} setCount={setRecentCount} onDelete={removeTxn} onPosted={confirmPosted} />
            <CardSetup onChanged={refresh} />
          </>
        ) : (
          <p className="pad sub">Loading…</p>
        ))}

      {tab === 'home' && <Home onGo={(t) => setTab(t as typeof tab)} />}

      {tab === 'use' && <Advisor />}

      {tab === 'catalog' && <Catalog />}

      {tab === 'ledger' && <Ledger />}

      {tab === 'audit' && <Audit />}

      {tab === 'trends' && <Analytics />}

      {tab === 'expiry' && <ExpiryTab />}

      {tab === 'other' && <Other />}

      {tab === 'codes' && <Mcc />}

      {tab === 'settings' && <Settings />}

      {tab === 'points' && <PointsTab />}

      {tab === 'offers' && (
        <>
          <Scanner onScanned={() => setScanTick((t) => t + 1)} />
          <Inbox tick={scanTick} onTracked={loadOffers} />
          <div className="section-head">
            <h2>Tracked offers{offers?.length ? ` (${offers.length})` : ''}</h2>
            <div className="entry-foot" style={{ margin: 0 }}>
              <button
                className="secondary"
                onClick={async () => {
                  const r = await sweepOffers();
                  setSweepMsg(
                    `${r.expired} marked expired` +
                      (r.deleted ? `, ${r.deleted} removed (ended over ${r.retention_days} days ago)` : '') +
                      '.'
                  );
                  loadOffers();
                }}
              >
                Clear ended
              </button>
              <button className="secondary" onClick={() => setOfferScope((v) => (v === 'open' ? 'all' : 'open'))}>
                {offerScope === 'open' ? 'Show all' : 'Hide closed'}
              </button>
            </div>
          </div>
          {sweepMsg && <p className="pad sub">{sweepMsg}</p>}
          {offersError && (
            <p className="card err-text">
              {offersError}{' '}
              <button className="secondary" onClick={loadOffers}>
                Try again
              </button>
            </p>
          )}
          {offers ? (
            offers.length ? (
              offers.map((o) => <Offer key={o.id} o={o} onChange={loadOffers} />)
            ) : (
              !offersError && (
                <p className="pad sub">No offers yet. Scan above, then Track one to start reading its terms.</p>
              )
            )
          ) : (
            <p className="pad sub">Loading…</p>
          )}
          <Sources />
        </>
      )}
    </main>
  );
}
