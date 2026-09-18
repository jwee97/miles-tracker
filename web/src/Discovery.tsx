import { useEffect, useState } from 'react';
import {
  fetchDiscoveryStatus,
  fetchPromotionReview,
  money,
  publishCandidateEdit,
  rejectCandidate,
  runDiscovery,
  runDiscoveryAll,
  testDiscoverySource,
  type DiscoveryPipelineReport,
  type DiscoverySourceHealth,
  type SourceTestResult,
  type DiscoveryReport,
  type DiscoveryStatus,
  type PromotionReviewItem,
} from './api';

/**
 * What the app read, and what is left for a person.
 *
 * The system is meant to make this screen boring: discovery runs on a schedule,
 * most offers resolve themselves, and only the genuinely ambiguous ones arrive
 * here. So the queue leads, and the machinery — which sites were read, which
 * are failing — sits underneath it, where it is available when something looks
 * wrong and out of the way when it does not.
 *
 * Everything needed to answer an item is already on it. Nobody should have to
 * open the articles: the numbers, who said each one, the sentence they said it
 * in, and the change against what is already published are all here.
 */

const TIER_NAME: Record<number, string> = {
  1: 'the bank itself',
  2: 'a specialist publication',
  3: 'a comparison site',
  4: 'a search result',
  5: 'unclassified',
};

const FIELD_LABEL: Record<string, string> = {
  reward_miles: 'Miles',
  reward_points: 'Points',
  reward_cashback_cents: 'Cashback',
  bonus_pct: 'Bonus %',
  minimum_spend_cents: 'Minimum spend',
  window_days: 'Window (days)',
  application_start: 'Opens',
  application_end: 'Closes',
  registration_required: 'Registration',
  eligibility_text: 'Who for',
};

const CADENCE: Record<string, string> = {
  daily: 'daily',
  every3days: 'every 3 days',
  weekly: 'weekly',
  monthly: 'monthly',
};

const HEALTH_LABEL: Record<string, string> = {
  healthy: 'Running normally',
  degraded: 'Running, with a gap',
  failing: 'Not discovering anything',
  not_configured: 'Not configured',
};

const HEALTH_CLASS: Record<string, string> = {
  healthy: 'pass',
  degraded: 'unknown',
  failing: 'fail',
  not_configured: 'fail',
};

const CHANNEL_LABEL = (c: string) => (c === 'rss' ? 'a feed' : c === 'search' ? 'search' : 'by hand');

const STATE_LABEL: Record<string, string> = {
  never_scanned: 'never scanned',
  healthy: 'working',
  quiet: 'working, nothing found',
  degraded: 'unreliable',
  failing: 'failing',
  not_configured: 'not configured',
};

const STATE_CLASS: Record<string, string> = {
  never_scanned: 'unknown',
  healthy: 'pass',
  quiet: 'pass',
  degraded: 'unknown',
  failing: 'fail',
  not_configured: 'fail',
};

const host = (u: string) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return u;
  }
};

const show = (field: string, v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (field.endsWith('_cents') && typeof v === 'number') return `$${money(v)}`;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return v.toLocaleString();
  return String(v);
};

function Item({ item, onDone }: { item: PromotionReviewItem; onDone: () => void }) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const editable = ['reward_miles', 'reward_points', 'reward_cashback_cents', 'bonus_pct', 'minimum_spend_cents', 'window_days'];

  async function publish() {
    setBusy(true);
    setMsg(null);
    // Only the fields actually touched are sent. An edit is the strongest
    // evidence the system ever gets, and sending every field back would record
    // a person as the source of numbers they merely looked at.
    const terms: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(edits)) {
      if (v.trim() === '') continue;
      terms[k] = Number(v);
    }
    const r = await publishCandidateEdit(item.candidate_id, Object.keys(terms).length ? terms : undefined);
    setBusy(false);
    setMsg(r.ok ? 'Published.' : (r.error ?? 'that did not work'));
    if (r.ok) onDone();
  }

  return (
    <li className={`offer2 ${item.conflicts.length ? 'bad' : 'medium'}`}>
      <div className="offer2-head">
        <span className="offer2-title">
          {item.issuer ?? 'Unknown bank'} · {item.product ?? 'unknown card'}
        </span>
        <span className={`chip ${item.verification_state === 'conflicting' ? 'critical' : 'never'}`}>
          {item.verification_state.replace(/_/g, ' ')}
        </span>
      </div>

      <p className="sub">
        {item.promotion_type?.replace(/_/g, ' ') ?? 'promotion'} · via {item.application_channel.replace(/_/g, ' ')}
        {item.resolved_product_id === null && ' · the card could not be matched to the catalogue'}
      </p>

      {/* How this was found, which is a different question from what it says.
          A search-originated offer is not less trustworthy — the article is
          still the source — but a reviewer should be able to see it. */}
      <p className="sub">
        Discovered through {item.provenance.discovery_channels.map(CHANNEL_LABEL).join(' and ')}
        {item.provenance.article_sources.length > 0 &&
          ` · ${item.provenance.article_sources.map((a) => a.name).join(', ')}`}
        {' · '}
        {item.provenance.official_verified ? "confirmed on the bank's own page" : 'no official confirmation'}
      </p>
      {item.provenance.search_query && (
        <p className="sub mono">found by searching “{item.provenance.search_query}”</p>
      )}

      {item.review_reason && <p className="offer2-why"><b>Why you are being asked:</b> {item.review_reason}</p>}
      {item.conflicts.map((c, i) => (
        <p key={i} className="warn-num">
          {c}
        </p>
      ))}

      {item.existing && (
        <div className="addrule">
          <p className="sub">
            This changes <b>{item.existing.title}</b>, already published.
          </p>
          {item.diff.length ? (
            <ul className="rules">
              {item.diff.map((d) => (
                <li key={d.field} className="unknown">
                  <span>
                    {FIELD_LABEL[d.field] ?? d.field}: {show(d.field, d.before)} → <b>{show(d.field, d.after)}</b>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sub">Nothing that decides money moved.</p>
          )}
        </div>
      )}

      <div className="entry-grid">
        {editable.map((f) => (
          <label className="f" key={f}>
            <span>{FIELD_LABEL[f] ?? f}</span>
            <input
              inputMode="numeric"
              placeholder={item.terms[f] === undefined || item.terms[f] === null ? 'not stated' : String(item.terms[f])}
              value={edits[f] ?? ''}
              onChange={(e) => setEdits({ ...edits, [f]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <p className="sub">
        Leave a field alone to accept what was read. Anything you type is recorded as coming from you, which outranks
        every article.
      </p>

      <details className="batches" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>What the evidence says ({item.sources.length} source{item.sources.length === 1 ? '' : 's'})</summary>
        <ul className="rules">
          {item.evidence.map((f) => (
            <li key={f.field} className={f.conflicting_values.length ? 'fail' : f.official_confirmation ? 'pass' : 'unknown'}>
              <span>
                <strong>{FIELD_LABEL[f.field] ?? f.field}</strong>: {show(f.field, f.value)}{' '}
                <span className="sub">
                  ({f.sources} independent source{f.sources === 1 ? '' : 's'}, {TIER_NAME[f.highest_trust_tier] ?? 'unknown'}
                  , {f.confidence} confidence)
                </span>
              </span>
              <p className="sub">{f.note}</p>
              {f.conflicting_values.length > 0 && (
                <p className="warn-num">
                  Also claimed: {f.conflicting_values.map((v) => show(f.field, v)).join(', ')}. Nothing has picked
                  between them.
                </p>
              )}
              {f.excerpt && <p className="sub mono">“{f.excerpt}”</p>}
            </li>
          ))}
        </ul>
        <p className="sub">Read from:</p>
        <ul className="rules">
          {item.sources.map((sc) => (
            <li key={sc.url} className="unknown">
              <span>
                <a className="link" href={sc.url} target="_blank" rel="noreferrer">
                  {host(sc.url)}
                </a>{' '}
                — {TIER_NAME[sc.tier] ?? 'unknown'}
              </span>
            </li>
          ))}
        </ul>
      </details>

      <div className="entry-foot rule-actions">
        <button disabled={busy} onClick={publish}>
          Publish it
        </button>
        <button
          className="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await rejectCandidate(item.candidate_id, 'not a real offer');
            setBusy(false);
            onDone();
          }}
        >
          Leave it out
        </button>
        {item.article?.url && (
          <a className="link" href={item.article.url} target="_blank" rel="noreferrer">
            The article
          </a>
        )}
      </div>
      {msg && <p className={msg === 'Published.' ? 'ok-text' : 'err-text'}>{msg}</p>}
    </li>
  );
}

/**
 * The funnel, one line per step it could have stopped at.
 *
 * Every row is a place the pipeline can fail quietly. Sources checked but no
 * results, results but no new URLs, new URLs but none relevant, articles read
 * but no candidates — each is a different problem, and a single "nothing new"
 * covers all of them.
 */
function Funnel({ r }: { r: DiscoveryReport }) {
  const rows: [string, number, string][] = [
    ['Sources checked', r.sources_scanned, 'feeds and searches that were due'],
    ['Feed entries seen', r.feed_items_seen, 'what the feeds listed, new or not'],
    ['Search queries run', r.search_queries_executed, `of ${r.search_queries_planned} planned`],
    ['Search results seen', r.search_results_seen, 'what the provider returned'],
    ['New URLs', r.items_found, 'articles nobody had seen before'],
    ['Relevant articles', r.relevant_items_found, 'of those, about an offer'],
    ['Articles read', r.articles_fetched, `${r.articles_failed} could not be read`],
    ['Candidates', r.candidates_created, `${r.candidates_merged} merged into offers already known`],
    ['Published', r.published, 'the evidence carried them'],
    ['Waiting for you', r.held_for_review, 'the evidence did not'],
  ];
  return (
    <>
      {rows.map(([label, value, detail]) => (
        <li key={label} className={value > 0 ? 'pass' : 'unknown'}>
          <span>
            <strong>{value.toLocaleString()}</strong> {label.toLowerCase()}
          </span>
          <p className="sub">{detail}</p>
        </li>
      ))}
    </>
  );
}

/**
 * One source, with a button that tells you why it is quiet.
 *
 * The test is diagnostic only — it reads the source and writes nothing back,
 * so pressing it while debugging cannot demote a source or mark it failing.
 * That matters because the moment you most want to press it is the moment the
 * source is already in trouble.
 */
function Source({ h }: { h: DiscoverySourceHealth }) {
  const [result, setResult] = useState<SourceTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const s = h.source;

  return (
    <li className={STATE_CLASS[h.state] ?? 'unknown'}>
      <span>
        <strong>{s.name}</strong> · {TIER_NAME[s.trust_tier] ?? 'unknown'} ·{' '}
        {CADENCE[s.scan_frequency] ?? s.scan_frequency}
        {s.adaptive_frequency === 0 && ' (fixed)'}
        {' · '}
        <span className="chip never">{STATE_LABEL[h.state] ?? h.state}</span>
      </span>

      <p className="sub">
        {s.last_scanned_at ? `Last scan ${s.last_scanned_at}` : 'Never scanned'}
        {h.last_result &&
          ` · last result: ${h.last_result.items_seen ?? 0} entries, ${h.last_result.relevant_items_found ?? 0} relevant`}
        {s.scans > 0 && ` · ${Math.round(h.success_rate * 100)}% of scans succeed`}
      </p>
      <p className="sub">{h.note}</p>
      {s.last_error && <p className="warn-num">{s.last_error}</p>}

      <div className="entry-foot rule-actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setResult(null);
            try {
              setResult(await testDiscoverySource(s.id));
            } catch (e) {
              setResult({
                ok: false,
                type: s.source_type,
                source_key: s.source_key,
                name: s.name,
                examples: [],
                note: (e as Error).message,
                as_of: '',
              });
            }
            setBusy(false);
          }}
        >
          {busy ? 'Testing…' : 'Test source'}
        </button>
        {s.feed_url && (
          <a className="link" href={s.feed_url} target="_blank" rel="noreferrer">
            The feed
          </a>
        )}
      </div>

      {result && (
        <div className="addrule">
          <p className={result.ok ? 'ok-text' : 'err-text'}>{result.note}</p>
          {result.error_code && <p className="sub mono">{result.error_code}</p>}
          {result.examples.length > 0 && (
            <>
              <p className="sub">How the classifier read the first few:</p>
              <ul className="rules">
                {result.examples.map((ex) => (
                  <li key={ex.url} className={ex.relevant ? 'pass' : 'unknown'}>
                    <span>{ex.title}</span>
                    <p className="sub">
                      {ex.classification.replace(/_/g, ' ')} — {ex.relevant ? 'worth reading' : 'skipped'}
                      {ex.signals.length > 0 && ` · on: ${ex.signals.join(', ')}`}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function Sources({ status }: { status: DiscoveryStatus }) {
  return (
    <section className="card">
      <h2>Where the app reads</h2>
      <p className="sub">
        A site that says no — a block, a bot check, a robots rule — is recorded and left alone, not worked around.
        Losing one lowers confidence rather than stopping discovery.
      </p>
      <ul className="rules">
        {status.sources.map((h) => (
          <Source key={h.source.source_key} h={h} />
        ))}
        {!status.sources.length && <li className="unknown">No sources yet. Run the seed.</li>}
      </ul>
    </section>
  );
}

export default function Discovery() {
  const [status, setStatus] = useState<DiscoveryStatus | null>(null);
  const [items, setItems] = useState<PromotionReviewItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ran, setRan] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<DiscoveryPipelineReport | null>(null);

  function load() {
    fetchDiscoveryStatus().then(setStatus).catch((e) => setErr((e as Error).message));
    fetchPromotionReview()
      .then((d) => setItems(d.items))
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(load, []);

  async function runAll() {
    setBusy('all');
    setErr(null);
    setRan(null);
    try {
      setPipeline(await runDiscoveryAll());
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(null);
    load();
  }

  async function run(stage: 'discover' | 'extract' | 'corroborate' | 'expire') {
    setBusy(stage);
    setRan(null);
    try {
      const r = (await runDiscovery(stage)) as Record<string, number | string>;
      const bits = Object.entries(r)
        .filter(([k, v]) => typeof v === 'number' && v > 0 && k !== 'as_of')
        .map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`);
      setRan(bits.length ? bits.join(', ') : 'nothing new');
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(null);
    load();
  }

  if (err && !status) return <p className="pad error">{err}</p>;
  if (!status) return <p className="pad sub">Loading…</p>;

  return (
    <>
      <section className="card">
        <div className="section-head" style={{ marginTop: 0 }}>
          <h2>Promotion discovery</h2>
          <span className="sub">as of {status.as_of}</span>
        </div>
        <p className="sub">
          The app reads the sites that cover these offers, turns what they say into claims, and weighs the claims
          against each other. Nothing an article says becomes a published number on its own — only the bank's own page,
          or an offer already published whose end date moved with two sites agreeing.
        </p>

        <ul className="rules">
          <li className={HEALTH_CLASS[status.health.overall]}>
            <span>
              <strong>{HEALTH_LABEL[status.health.overall]}</strong>
              {status.latest_run?.finished_at && ` · last run ${status.latest_run.finished_at.replace('T', ' ').slice(0, 16)}`}
            </span>
            <p className="sub">{status.health.note}</p>
          </li>
          <li className={status.today.changed || status.today.new ? 'unknown' : 'pass'}>
            <span>
              Today: <strong>{status.today.new}</strong> new · {status.today.changed} changed ·{' '}
              {status.today.awaiting_review} waiting for you
            </span>
          </li>
          <li className={status.pipeline.candidates_review ? 'unknown' : 'pass'}>
            <span>
              <strong>{status.pipeline.candidates_review}</strong> to review ·{' '}
              {status.pipeline.candidates_extracted} extracted · {status.pipeline.candidates_published} published ·{' '}
              {status.pipeline.candidates_rejected} left out
            </span>
          </li>
          <li className={status.pipeline.items_failed ? 'fail' : 'pass'}>
            {/* `new`, not `pending`: the backend has only ever written `new`,
                and counting the other string here showed an empty queue while
                articles were waiting. */}
            <span>
              <strong>{status.pipeline.items_new}</strong> articles waiting to be read ·{' '}
              {status.pipeline.items_processed} processed · {status.pipeline.items_irrelevant} unrelated ·{' '}
              {status.pipeline.items_failed} could not be read
            </span>
          </li>
        </ul>

        {!status.sources_configured && (
          <p className="warn-num">
            No discovery sources are configured. Nothing is being read at all — run the seed.
          </p>
        )}

        {!status.search.configured && (
          <div className="addrule">
            <p className="warn-num">Search discovery is not configured.</p>
            <p className="sub">
              RSS discovery will continue working, but offers outside the tracked publications may be missed.
              SEARCH_PROVIDER and SEARCH_API_KEY are required — the key is a secret, set with{' '}
              <span className="mono">wrangler secret put SEARCH_API_KEY</span>.
            </p>
          </div>
        )}

        {status.search.configured && (
          <p className="sub">
            Search: {status.search.provider} · {status.search.searches_today} of {status.search.budget} searches used
            today.
          </p>
        )}

        <div className="entry-foot rule-actions">
          <button disabled={!!busy} onClick={runAll}>
            {busy === 'all' ? 'Running…' : 'Run discovery now'}
          </button>
        </div>

        {pipeline && (
          <div className="addrule">
            {/* The outcome names the step the run actually reached. "Nothing
                left to do" was true and useless: it covered a run that read
                five feeds and found nothing new, one that scanned nothing
                because no source was due, and one with no sources at all. */}
            <p className={pipeline.stopped_because === 'nothing_to_scan' ? 'warn-num' : 'ok-text'}>
              {pipeline.outcome}
            </p>
            <p className="sub">
              {pipeline.cycles} cycle{pipeline.cycles === 1 ? '' : 's'}
              {pipeline.stopped_because === 'cycle_limit' && ' · stopped at the cycle limit, so there may be more'}
            </p>
            <ul className="rules">
              <Funnel r={pipeline.summary} />
            </ul>
            {pipeline.summary.notes.slice(0, 8).map((note, i) => (
              <p key={i} className="sub">
                {note}
              </p>
            ))}
          </div>
        )}

        {/* The three stages remain, because they are how you find out which one
            is stuck — but as a debugging tool rather than the way to ask
            whether anything is new. */}
        <details className="batches">
          <summary>Advanced</summary>
          <div className="entry-foot rule-actions">
            <button className="secondary" disabled={!!busy} onClick={() => run('discover')}>
              {busy === 'discover' ? 'Reading…' : 'Discover only'}
            </button>
            <button className="secondary" disabled={!!busy} onClick={() => run('extract')}>
              {busy === 'extract' ? 'Reading…' : 'Extract only'}
            </button>
            <button className="secondary" disabled={!!busy} onClick={() => run('corroborate')}>
              {busy === 'corroborate' ? 'Weighing…' : 'Corroborate only'}
            </button>
            <button className="secondary" disabled={!!busy} onClick={() => run('expire')}>
              {busy === 'expire' ? 'Sweeping…' : 'Expire finished offers'}
            </button>
          </div>
          {ran && <p className="ok-text">{ran}</p>}
        </details>
        {err && <p className="err-text">{err}</p>}
      </section>

      <section className="card">
        <h2>Waiting for you{items?.length ? ` (${items.length})` : ''}</h2>
        {!items ? (
          <p className="sub">Loading…</p>
        ) : items.length === 0 ? (
          <p className="sub">
            Nothing. Either everything resolved itself, or nothing new has been found — the status above says which.
          </p>
        ) : (
          <ul className="offers2">
            {items.map((i) => (
              <Item key={i.candidate_id} item={i} onDone={load} />
            ))}
          </ul>
        )}
      </section>

      <Sources status={status} />
    </>
  );
}
