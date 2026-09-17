import { useEffect, useState } from 'react';
import {
  dismissOffer,
  fetchOffers2,
  fetchTrackedOffers,
  money,
  sweepPromotions,
  trackOffer,
  type OfferInbox as Inbox,
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
      </div>
      {msg && <p className="ok-text">{msg}</p>}
      {o.promotion.source_quote && (
        <details className="batches">
          <summary>Where these numbers came from</summary>
          <p className="sub mono">{o.promotion.source_quote}</p>
        </details>
      )}
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
