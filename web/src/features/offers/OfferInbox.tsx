import { useEffect, useState } from 'react';
import {
  contributeTargetedOffer,
  dismissOffer,
  fetchOffers2,
  fetchPromotionEvidence,
  fetchTrackedOffers,
  money,
  sweepPromotions,
  trackOffer,
  type OfferInbox as Inbox,
  type PromotionEvidence,
  type RelevantPromotion,
  type TrackedOffer,
} from '../../api';

/**
 * Offers worth your attention.
 *
 * A feed of every promotion every bank is running is not a feature — it is a
 * list nobody reads, with the two that mattered buried in it. So this leads
 * with the ones that apply to cards you hold and spending you actually do, and
 * every offer carries the reason it is being shown.
 */

const money0 = (c: unknown) => (typeof c === 'number' ? `$${money(c)}` : null);

const TIER_NAME: Record<number, string> = {
  1: 'the bank itself',
  2: 'a specialist publication',
  3: 'a comparison site',
  4: 'a search result',
  5: 'an unclassified source',
};

/**
 * Why we think this is current.
 *
 * These numbers came from somewhere the person did not choose — they did not
 * read the blog, the app did. So the evidence has to be one tap away, and it
 * has to be able to say something unflattering: one site, three weeks ago,
 * nobody else repeating it is a legitimate answer and a useful one.
 *
 * Loaded only when opened. Most people never ask, and fetching the provenance
 * of every offer to render a list nobody expanded is work for nothing.
 */
function Confidence({ id, note }: { id: number; note: string }) {
  const [ev, setEv] = useState<PromotionEvidence | null>(null);
  const [err, setErr] = useState<string | null>(null);

  return (
    <details
      className="batches"
      onToggle={(e) => {
        if (!(e.target as HTMLDetailsElement).open || ev || err) return;
        fetchPromotionEvidence(id)
          .then(setEv)
          .catch((x) => setErr((x as Error).message));
      }}
    >
      <summary>Why we think this is current</summary>
      <p className="sub">{note}</p>
      {err && <p className="err-text">{err}</p>}
      {!ev && !err && <p className="sub">Looking it up…</p>}
      {ev && (
        <>
          <p className="offer2-why">{ev.headline}</p>

          {ev.fields.some((f) => !f.agreed) && (
            <p className="warn-num">
              Sources disagree here. Both readings are below — the app has not picked one for you.
            </p>
          )}

          <ul className="rules">
            {ev.fields.map((f) => (
              <li key={f.field} className={f.agreed ? 'pass' : 'fail'}>
                <span>
                  <strong>{f.label}</strong>
                  {f.claims.map((c, i) => (
                    <span key={i}>
                      {i > 0 ? ' · but ' : ': '}
                      {typeof c.value === 'number' ? c.value.toLocaleString() : String(c.value)}{' '}
                      <span className="sub">({c.hosts.join(', ')})</span>
                    </span>
                  ))}
                </span>
              </li>
            ))}
            {!ev.fields.length && <li className="unknown">No claims are recorded — this was entered by hand.</li>}
          </ul>

          {ev.sources.length > 0 && (
            <>
              <p className="sub">Read from:</p>
              <ul className="rules">
                {ev.sources.map((sc) => (
                  <li key={sc.url} className="unknown">
                    <span>
                      <a className="link" href={sc.url} target="_blank" rel="noreferrer">
                        {sc.host}
                      </a>{' '}
                      — {TIER_NAME[sc.tier] ?? 'an unknown source'}
                      {sc.seen_at && ` · read ${sc.seen_at}`}
                    </span>
                    {sc.excerpt && <p className="sub mono">“{sc.excerpt}”</p>}
                  </li>
                ))}
              </ul>
            </>
          )}

          {ev.timeline.length > 0 && (
            <>
              <p className="sub">What has changed:</p>
              <ul className="rules">
                {ev.timeline.map((t, i) => (
                  <li key={i} className="unknown">
                    <span>
                      {t.at || 'at some point'} — {t.detail}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {ev.currency.stale && (
            <p className="warn-num">
              Nobody has checked this recently. Read the bank's own page before you spend against it.
            </p>
          )}
        </>
      )}
    </details>
  );
}

/**
 * The shapes one offer comes in.
 *
 * A new-customer bonus shown to someone who already holds the card is the most
 * common way an app like this misleads. Hiding it is not the fix — the fix is
 * showing it beside the sentence that says why it is not theirs.
 */
function Variants({ o }: { o: RelevantPromotion }) {
  if (o.variants.length < 2 && !o.variants.some((v) => !v.available)) return null;
  return (
    <ul className="rules">
      {o.variants.map((v) => (
        <li key={v.variant.variant_key} className={v.available ? 'pass' : 'fail'}>
          <span>
            <strong>{v.reward_text ?? 'terms unknown'}</strong>
            {v.variant.minimum_spend_cents ? ` on $${money(v.variant.minimum_spend_cents)}` : ''} · {v.audience_label} ·{' '}
            {v.channel_label}
          </span>
          {v.blocker && <p className="sub">{v.blocker}</p>}
        </li>
      ))}
    </ul>
  );
}

/**
 * An offer the bank sent this person directly.
 *
 * This is the only place promotion terms come from the user rather than a
 * source, and it is trusted — they are holding the email. It is kept as its own
 * variant so it never changes what the app believes the public offer to be.
 */
function Targeted({ id, onChange }: { id: number; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ miles: '', cashback: '', spend: '', note: '' });
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    const reward: Record<string, number> = {};
    if (f.miles.trim()) reward.miles = Number(f.miles);
    if (f.cashback.trim()) reward.cashback_cents = Math.round(Number(f.cashback) * 100);
    const r = await contributeTargetedOffer(id, {
      reward,
      minimum_spend_cents: f.spend.trim() ? Math.round(Number(f.spend) * 100) : null,
      note: f.note.trim() || null,
    });
    setMsg(r.ok ? 'Saved as yours.' : (r.error ?? 'that did not work'));
    if (r.ok) {
      setOpen(false);
      setF({ miles: '', cashback: '', spend: '', note: '' });
      onChange();
    }
  }

  return (
    <>
      <button className="secondary" onClick={() => setOpen((v) => !v)}>
        {open ? 'Cancel' : 'I was sent a different offer'}
      </button>
      {open && (
        <div className="addrule">
          <p className="sub">
            Targeted offers are real but private — the app cannot read them anywhere. Put yours in and it is kept as
            yours, without changing what the app believes the public offer is.
          </p>
          <div className="entry-grid">
            <label className="f">
              <span>Miles</span>
              <input value={f.miles} onChange={(e) => setF({ ...f, miles: e.target.value })} inputMode="numeric" placeholder="20000" />
            </label>
            <label className="f">
              <span>Or cashback</span>
              <input value={f.cashback} onChange={(e) => setF({ ...f, cashback: e.target.value })} inputMode="decimal" placeholder="150" />
            </label>
            <label className="f">
              <span>Spend needed</span>
              <input value={f.spend} onChange={(e) => setF({ ...f, spend: e.target.value })} inputMode="decimal" placeholder="800" />
            </label>
            <label className="f f-note">
              <span>Note</span>
              <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="emailed 12 Sep, code ABC" />
            </label>
          </div>
          <div className="entry-foot">
            <button className="secondary" onClick={save} disabled={!f.miles.trim() && !f.cashback.trim()}>
              Save it as mine
            </button>
          </div>
        </div>
      )}
      {msg && <p className="ok-text">{msg}</p>}
    </>
  );
}

function Offer({ o, onChange }: { o: RelevantPromotion; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const t = o.terms as Record<string, number | undefined>;

  const pays =
    t.reward_miles ? `${t.reward_miles.toLocaleString()} miles` :
    t.reward_points ? `${t.reward_points.toLocaleString()} bonus points` :
    t.reward_cashback_cents ? `$${money(t.reward_cashback_cents)} cashback` :
    t.bonus_pct ? `${t.bonus_pct}% bonus` : null;

  return (
    <li className={`offer2 ${o.relevance}`}>
      <div className="offer2-head">
        <span className="offer2-title">{o.promotion.title}</span>
        {o.days_left !== null && (
          <span className={`chip ${o.days_left <= 7 ? 'critical' : o.days_left <= 14 ? 'soon' : 'never'}`}>
            {o.days_left < 0 ? 'ended' : `${o.days_left}d`}
          </span>
        )}
      </div>
      <p className="sub">
        {o.promotion.issuer && `${o.promotion.issuer} · `}
        {t.minimum_spend_cents ? `Spend ${money0(t.minimum_spend_cents)}` : null}
        {t.minimum_spend_cents && pays ? ' → ' : null}
        {pays}
        {o.promotion.end_at && ` · by ${o.promotion.end_at}`}
      </p>

      {o.why.length > 0 && (
        <p className="offer2-why">
          <b>Why you're seeing this:</b> {o.why.join(' ')}
        </p>
      )}

      {o.pays_varies && (
        <p className="warn-num">
          What this pays depends on how you apply: {o.pays}.
        </p>
      )}
      <Variants o={o} />
      {o.blockers.map((b, i) => (
        <p key={i} className="warn-num">
          {b}
        </p>
      ))}

      <div className="entry-foot rule-actions">
        {!o.tracked && (
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await trackOffer(o.promotion.id);
              setMsg(r.ok ? (r.summary ?? 'Tracking it.') : (r.error ?? 'that did not work'));
              setBusy(false);
              onChange();
            }}
          >
            Track this offer
          </button>
        )}
        {o.tracked && <span className="chip ok">tracked</span>}
        <button
          className="secondary"
          disabled={busy}
          onClick={async () => {
            await dismissOffer(o.promotion.id);
            onChange();
          }}
        >
          Not interested
        </button>
        {o.promotion.source_url && (
          <a className="link" href={o.promotion.source_url} target="_blank" rel="noreferrer">
            View terms
          </a>
        )}
        <Targeted id={o.promotion.id} onChange={onChange} />
      </div>
      {msg && <p className="ok-text">{msg}</p>}

      <p className={`sub ${o.currency.stale ? 'warn-num' : ''}`}>{o.currency.text}</p>
      <Confidence id={o.promotion.id} note={o.currency.text} />
    </li>
  );
}

function Section({ title, rows, onChange }: { title: string; rows: RelevantPromotion[]; onChange: () => void }) {
  if (!rows.length) return null;
  return (
    <section className="card">
      <h2>
        {title} ({rows.length})
      </h2>
      <ul className="offers2">
        {rows.map((o) => (
          <Offer key={o.promotion.id} o={o} onChange={onChange} />
        ))}
      </ul>
    </section>
  );
}

function Tracked({ rows, onChange }: { rows: TrackedOffer[]; onChange: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  if (!rows.length) return null;

  return (
    <section className="card">
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>Offers you are chasing ({rows.length})</h2>
        <button
          className="secondary"
          onClick={async () => {
            const r = await sweepPromotions();
            setMsg(
              r.completed.length
                ? r.completed.map((c) => `${c.title}: ${c.expected}`).join(' · ')
                : 'Nothing has been met yet.'
            );
            onChange();
          }}
        >
          Check for completions
        </button>
      </div>
      <p className="sub">
        Progress comes from the same minimum-spend engine the cards use, not a second one — so these numbers agree with
        the Cards tab.
      </p>
      {msg && <p className="ok-text">{msg}</p>}
      <ul className="offers2">
        {rows.map((t) => (
          <li key={t.tracking_id} className="offer2">
            <div className="offer2-head">
              <span className="offer2-title">{t.promotion.title}</span>
              {t.status === 'completed' && <span className="chip ok">met — waiting on the bank</span>}
            </div>
            {t.progress ? (
              <>
                <p className="sub">
                  ${money(t.progress.spent_cents)} of ${money(t.progress.required_cents)}
                  {t.card && ` on ${t.card.nickname}`} · {t.progress.days_left} days left
                </p>
                <div className="bar">
                  <span
                    style={{ width: `${Math.min(100, (t.progress.spent_cents / t.progress.required_cents) * 100)}%` }}
                  />
                </div>
              </>
            ) : (
              <p className="sub">Followed — there is no spend threshold to track.</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function OfferInbox() {
  const [box, setBox] = useState<Inbox | null>(null);
  const [tracked, setTracked] = useState<TrackedOffer[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function load() {
    fetchOffers2()
      .then(setBox)
      .catch((e) => setErr((e as Error).message));
    fetchTrackedOffers()
      .then((d) => setTracked(d.offers ?? []))
      .catch(() => void 0);
  }
  useEffect(load, []);

  if (err) return <p className="pad error">{err}</p>;
  if (!box) return <p className="pad sub">Loading…</p>;

  const nothing =
    !box.worth_checking.length && !box.ending_soon.length && !box.your_cards.length && !box.transfers.length;

  return (
    <>
      <Tracked rows={tracked} onChange={load} />
      <Section title="Worth checking" rows={box.worth_checking} onChange={load} />
      <Section title="Ending soon" rows={box.ending_soon} onChange={load} />
      <Section title="Your cards" rows={box.your_cards} onChange={load} />
      <Section title="Point transfers" rows={box.transfers} onChange={load} />

      {nothing && (
        <section className="card">
          <h2>Offers for you</h2>
          <p className="sub">
            Nothing relevant right now. Offers appear here once they are published with terms the app can check —
            an offer whose threshold nobody knows is worse than none, because someone spends against it.
          </p>
        </section>
      )}

      <section className="card">
        <div className="section-head" style={{ marginTop: 0 }}>
          <h2>Everything ({box.everything.length})</h2>
          <button className="secondary" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Hide' : 'Show'}
          </button>
        </div>
        <p className="sub">Including the ones that do not apply to you, and why they do not.</p>
        {showAll && (
          <ul className="offers2">
            {box.everything.map((o) => (
              <li key={o.promotion.id} className={`offer2 ${o.relevance}`}>
                <div className="offer2-head">
                  <span className="offer2-title">{o.promotion.title}</span>
                  <span className={`chip ${o.relevance === 'not_applicable' ? 'never' : 'soon'}`}>{o.relevance}</span>
                </div>
                <p className="sub">{[...o.why, ...o.blockers].join(' ') || 'No reason recorded.'}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
