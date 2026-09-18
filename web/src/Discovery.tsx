import { useEffect, useState } from 'react';
import {
  fetchDiscoveryStatus,
  fetchPromotionReview,
  money,
  publishCandidateEdit,
  rejectCandidate,
  runDiscovery,
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

/** A status count that has not happened yet is absent from the payload, not zero. */
const n = (counts: Record<string, number>, key: string) => counts[key] ?? 0;

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

function Sources({ status }: { status: DiscoveryStatus }) {
  return (
    <section className="card">
      <h2>Where the app reads</h2>
      <p className="sub">
        A site that says no — a block, a bot check, a robots rule — is recorded and left alone, not worked around. Losing
        one lowers confidence rather than stopping discovery.
      </p>
      <ul className="rules">
        {status.sources.map((h) => (
          <li key={h.source.source_key} className={h.ailing ? 'fail' : h.source.last_success_at ? 'pass' : 'unknown'}>
            <span>
              <strong>{h.source.name}</strong> · {TIER_NAME[h.source.trust_tier] ?? 'unknown'} ·{' '}
              {CADENCE[h.source.scan_frequency] ?? h.source.scan_frequency}
            </span>
            <p className="sub">
              {h.source.last_scanned_at ? `last read ${h.source.last_scanned_at}` : 'never read'}
              {h.days_since_success !== null && ` · last found something ${h.days_since_success} days ago`}
              {h.source.scans > 0 && ` · ${Math.round(h.success_rate * 100)}% of reads succeed`}
              {!h.source.active && ' · switched off'}
            </p>
            <p className="sub">{h.note}</p>
            {h.source.last_error && <p className="warn-num">{h.source.last_error}</p>}
          </li>
        ))}
        {!status.sources.length && <li className="unknown">No sources yet. Run a scan to seed them.</li>}
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

  function load() {
    fetchDiscoveryStatus().then(setStatus).catch((e) => setErr((e as Error).message));
    fetchPromotionReview()
      .then((d) => setItems(d.items))
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(load, []);

  async function run(stage: 'discover' | 'extract' | 'corroborate') {
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
          <li className={status.today.changed || status.today.new ? 'unknown' : 'pass'}>
            <span>
              Today: <strong>{status.today.new}</strong> new · {status.today.changed} changed ·{' '}
              {status.today.awaiting_review} waiting for you
            </span>
          </li>
          <li className={n(status.candidates, 'review') ? 'unknown' : 'pass'}>
            <span>
              <strong>{n(status.candidates, 'review')}</strong> to review · {n(status.candidates, 'extracted')} extracted
              · {n(status.candidates, 'published')} published · {n(status.candidates, 'rejected')} left out
            </span>
          </li>
          <li className={n(status.items, 'failed') ? 'fail' : 'pass'}>
            <span>
              <strong>{n(status.items, 'pending')}</strong> articles to read · {n(status.items, 'processed')} read ·{' '}
              {n(status.items, 'irrelevant')} not about offers · {n(status.items, 'failed')} could not be read
            </span>
          </li>
        </ul>

        <div className="entry-foot rule-actions">
          <button className="secondary" disabled={!!busy} onClick={() => run('discover')}>
            {busy === 'discover' ? 'Reading…' : 'Check the sources'}
          </button>
          <button className="secondary" disabled={!!busy} onClick={() => run('extract')}>
            {busy === 'extract' ? 'Reading…' : 'Read the articles'}
          </button>
          <button className="secondary" disabled={!!busy} onClick={() => run('corroborate')}>
            {busy === 'corroborate' ? 'Weighing…' : 'Weigh the evidence'}
          </button>
        </div>
        {ran && <p className="ok-text">{ran}</p>}
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
