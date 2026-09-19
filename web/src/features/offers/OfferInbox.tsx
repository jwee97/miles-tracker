import { useEffect, useState } from 'react';
import {
  analyseAcquisition,
  contributeTargetedOffer,
  correctPromotion,
  ELIGIBILITY_LABEL,
  RELATIONSHIP_LABEL,
  PROMOTION_KINDS,
  dismissOffer,
  fetchOffers2,
  fetchPromotionEvidence,
  fetchTrackedOffers,
  money,
  sweepPromotions,
  trackOffer,
  type OfferInbox as Inbox,
  type AcquisitionOpportunity,
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

const RELATIONSHIP_CLASS: Record<string, string> = {
  held_card: 'ok',
  acquisition_opportunity: 'ok',
  programme_offer: 'ok',
  issuer_offer: 'ok',
  general_offer: 'never',
  targeted_offer: 'soon',
  unknown: 'soon',
  not_relevant: 'critical',
};

const ELIGIBILITY_CLASS: Record<string, string> = {
  eligible: 'ok',
  potentially_eligible: 'ok',
  ineligible: 'critical',
  unknown: 'soon',
  needs_review: 'soon',
};

/**
 * What a card would be worth, opened from the offer that prompted it.
 *
 * Two numbers kept apart on purpose. What the card earns every year from how
 * you already spend is recurring; the welcome bonus happens once. Adding them
 * into a single figure makes a mediocre card look excellent for exactly one
 * year, which is the most common way a card comparison misleads.
 */
function Analyse({ o }: { o: RelevantPromotion }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<AcquisitionOpportunity | null>(null);

  async function run() {
    if (!o.acquisition_product) return;
    setOpen(true);
    setBusy(true);
    setErr(null);
    try {
      setResult(await analyseAcquisition(o.acquisition_product.product_id, o.promotion.id));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const value = (c: number) => `$${money(Math.abs(c))}`;

  return (
    <>
      <button className="secondary" onClick={run} disabled={busy}>
        {busy ? 'Analysing…' : 'Analyse card'}
      </button>
      {open && (
        <div className="addrule acq-analysis">
          {err && <p className="err-text">{err}</p>}
          {!result && !err && <p className="sub">Working it out…</p>}
          {result && (
            <>
              <p className="sub">
                <b>{result.product.product_name}</b>
              </p>
              <ul className="rules">
                <li className="pass">
                  <span>Ongoing value {value(result.value.ongoing_annual_cents)} a year</span>
                  <p className="sub">From how you already spend, net of the annual fee.</p>
                </li>
                <li className="unknown">
                  <span>Current welcome offer {value(result.value.welcome_once_cents)} once</span>
                  <p className="sub">
                    {result.promotion?.reward ?? 'a one-off bonus'}
                    {result.promotion?.end_at ? ` · ends ${result.promotion.end_at}` : ''}
                  </p>
                </li>
                <li className="pass">
                  <span>First year {value(result.value.first_year_cents)}</span>
                </li>
                <li className="unknown">
                  <span>After the offer ends {value(result.value.after_offer_annual_cents)} a year</span>
                </li>
              </ul>
              {result.eligibility && (
                <p className="sub">
                  Eligibility: <b>{ELIGIBILITY_LABEL[result.eligibility.status]}</b>
                  {result.eligibility.unresolved.length > 0 && ` · ${result.eligibility.unresolved.length} still to check`}
                </p>
              )}
              {result.notes.map((n, i) => (
                <p key={i} className="sub">
                  {n}
                </p>
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}

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
 * Fixing a number on an offer that is already here.
 *
 * The likeliest correction by far is one figure being out — a source misread
 * it, or somebody typed dollars into a field that meant cents and a $400
 * cashback bonus became $4. Rejecting the whole offer to get it rediscovered
 * would take the tracking and the history with it, so this edits it in place
 * and records who said so.
 *
 * Amounts are dollars. The box says so, and the server refuses a figure that
 * could only be a units mistake rather than storing it.
 */
function Correct({ o, onChange }: { o: RelevantPromotion; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const t = o.terms as Record<string, number | undefined>;

  const fields: { key: string; label: string; money?: boolean }[] = [
    { key: 'reward_miles', label: 'Miles' },
    { key: 'reward_points', label: 'Points' },
    { key: 'reward_cashback_cents', label: 'Cashback ($)', money: true },
    { key: 'bonus_pct', label: 'Bonus %' },
    { key: 'minimum_spend_cents', label: 'Minimum spend ($)', money: true },
    { key: 'window_days', label: 'Window (days)' },
  ];

  const shown = (f: { key: string; money?: boolean }) => {
    const v = t[f.key];
    if (v === undefined || v === null) return '';
    return f.money ? String(v / 100) : String(v);
  };

  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, shown(f)]))
  );
  const [title, setTitle] = useState(o.promotion.title);
  const [kind, setKind] = useState(o.promotion.promotion_type);

  /**
   * Start each editing session from what the offer says now.
   *
   * Without this the boxes keep whatever was typed last time, so a second
   * correction resubmits the first one's values as though they were fresh
   * edits — which is exactly the "only send what changed" rule being quietly
   * defeated by stale state.
   */
  function toggle() {
    if (!open) {
      setForm(Object.fromEntries(fields.map((f) => [f.key, shown(f)])));
      setTitle(o.promotion.title);
      setKind(o.promotion.promotion_type);
      setErr(null);
    }
    setOpen((v) => !v);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      // Only what was actually edited. The form is filled from the offer's
      // current values, so sending everything would resubmit figures the
      // person never touched — and one of those is usually the wrong one they
      // came here about, which would get the whole correction refused for a
      // field they were not editing.
      const terms: Record<string, number> = {};
      for (const f of fields) {
        const raw = form[f.key]?.trim() ?? '';
        if (raw === shown(f)) continue;
        if (!raw) continue;
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          setErr(`${f.label} is not a number.`);
          return;
        }
        terms[f.key] = f.money ? Math.round(n * 100) : n;
      }
      // What it is, alongside what it pays. An offer filed as the wrong kind
      // sits in a section nobody would look in — a cashback welcome offer
      // under "Point transfers" is invisible however right its figures are —
      // and nothing else in the app could put that right.
      const identity: { title?: string; promotion_type?: string } = {};
      if (title.trim() && title.trim() !== o.promotion.title) identity.title = title.trim();
      if (kind !== o.promotion.promotion_type) identity.promotion_type = kind;

      if (!Object.keys(terms).length && !Object.keys(identity).length) {
        setErr('Nothing was changed.');
        return;
      }

      const r = await correctPromotion(o.promotion.id, terms, {
        identity: Object.keys(identity).length ? identity : undefined,
      });
      if (!r.ok) {
        setErr(r.error ?? 'that did not work');
        return;
      }
      setMsg(`Corrected ${r.changed?.length ?? 0} value${r.changed?.length === 1 ? '' : 's'}.`);
      setOpen(false);
      onChange();
    } catch (e) {
      // A rejected request used to escape here, leaving the button stuck on
      // "Saving…" with nothing said. A refusal is an answer and has to be
      // shown.
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="secondary" onClick={() => toggle()}>
        {open ? 'Cancel' : 'These numbers are wrong'}
      </button>
      {open && (
        <div className="addrule correct-form">
          <p className="sub">
            Amounts are in dollars. What you type is recorded as coming from you, which outranks any article — so a
            later scan will not quietly put the old number back.
          </p>
          <div className="entry-grid">
            <label className="f f-note">
              <span>Name</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="f">
              <span>Kind of offer</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {PROMOTION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>
            {fields.map((f) => (
              <label className="f" key={f.key}>
                <span>{f.label}</span>
                <input
                  inputMode="decimal"
                  value={form[f.key] ?? ''}
                  placeholder="—"
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <p className="sub">
            The kind decides which section it appears under — a cashback welcome offer filed as a transfer bonus sits
            where nobody would look for it.
          </p>
          <div className="entry-foot">
            <button className="secondary" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : 'Save the correction'}
            </button>
            {err && <span className="err-text">{err}</span>}
          </div>
        </div>
      )}
      {msg && <p className="ok-text">{msg}</p>}
    </>
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
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const reward: Record<string, number> = {};
      if (f.miles.trim()) reward.miles = Number(f.miles);
      if (f.cashback.trim()) reward.cashback_cents = Math.round(Number(f.cashback) * 100);
      const r = await contributeTargetedOffer(id, {
        reward,
        minimum_spend_cents: f.spend.trim() ? Math.round(Number(f.spend) * 100) : null,
        note: f.note.trim() || null,
      });
      if (!r.ok) {
        setErr(r.error ?? 'that did not work');
        return;
      }
      setMsg('Saved as yours.');
      setOpen(false);
      setF({ miles: '', cashback: '', spend: '', note: '' });
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
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
            <button className="secondary" onClick={save} disabled={busy || (!f.miles.trim() && !f.cashback.trim())}>
              {busy ? 'Saving…' : 'Save it as mine'}
            </button>
            {err && <span className="err-text">{err}</span>}
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

      {/* What this is, and whether it can be had — said in words. The enum
          never reaches the screen: a person once saw "not_applicable", which
          reads as system noise rather than as an answer. */}
      <p className="sub">
        <span className={`chip ${RELATIONSHIP_CLASS[o.relationship] ?? 'never'}`}>
          {RELATIONSHIP_LABEL[o.relationship]}
        </span>{' '}
        <span className={`chip ${ELIGIBILITY_CLASS[o.eligibility.status] ?? 'never'}`}>
          {ELIGIBILITY_LABEL[o.eligibility.status]}
        </span>
      </p>

      {o.relationship === 'acquisition_opportunity' && (
        <p className="sub">You don’t currently hold this card. This offer may apply if you apply for it.</p>
      )}
      {o.relationship === 'unknown' && (
        <p className="warn-num">
          Miles Tracker could not determine whether this is intended for existing cardholders or new applicants.
          Read the bank’s terms before relying on it.
        </p>
      )}
      {o.relationship === 'targeted_offer' && (
        <p className="warn-num">
          This appears to be a targeted offer. Confirm that you received it before tracking it.
        </p>
      )}
      <p className="sub">
        {o.promotion.issuer && `${o.promotion.issuer} · `}
        {t.minimum_spend_cents ? `Spend ${money0(t.minimum_spend_cents)}` : null}
        {t.minimum_spend_cents && pays ? ' → ' : null}
        {pays}
        {o.promotion.end_at && ` · by ${o.promotion.end_at}`}
      </p>

      {o.why.length > 0 && (
        <p className="offer2-why">
          <b>Why it may be relevant:</b> {o.why.join(' ')}
        </p>
      )}

      {(o.eligibility.confirmed.length > 0 || o.eligibility.unresolved.length > 0 || o.eligibility.failed.length > 0) && (
        <details className="batches">
          <summary>Eligibility — {ELIGIBILITY_LABEL[o.eligibility.status]}</summary>
          {o.eligibility.confirmed.length > 0 && (
            <>
              <p className="sub">Confirmed from your own card history:</p>
              <ul className="rules">
                {o.eligibility.confirmed.map((c, i) => (
                  <li key={i} className="pass">
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {o.eligibility.failed.length > 0 && (
            <>
              <p className="sub">Ruled out:</p>
              <ul className="rules">
                {o.eligibility.failed.map((c, i) => (
                  <li key={i} className="fail">
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {o.eligibility.unresolved.length > 0 && (
            <>
              <p className="sub">Not knowable from what the app holds:</p>
              <ul className="rules">
                {o.eligibility.unresolved.map((c, i) => (
                  <li key={i} className="unknown">
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </details>
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
        {o.relationship === 'acquisition_opportunity' && o.acquisition_product && (
          <Analyse o={o} />
        )}
        {/* Track is withheld for a card you do not hold: there is nothing for
            the spend to land on, and a progress bar that cannot move is worse
            than none. Saving it is offered instead, and it starts counting by
            itself once the card is added. */}
        {!o.tracked && o.relationship === 'acquisition_opportunity' && (
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await trackOffer(o.promotion.id);
                setMsg(r.ok ? (r.summary ?? 'Saved.') : (r.error ?? 'that did not work'));
                onChange();
              } catch (e) {
                setMsg((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save this offer
          </button>
        )}
        {!o.tracked && o.relationship !== 'acquisition_opportunity' && (
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await trackOffer(o.promotion.id);
                setMsg(r.ok ? (r.summary ?? 'Tracking it.') : (r.error ?? 'that did not work'));
                onChange();
              } catch (e) {
                setMsg((e as Error).message);
              } finally {
                setBusy(false);
              }
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
            try {
              await dismissOffer(o.promotion.id);
              onChange();
            } catch (e) {
              setMsg((e as Error).message);
            }
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
        <Correct o={o} onChange={onChange} />
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
            try {
              const r = await sweepPromotions();
              setMsg(
                r.completed.length
                  ? r.completed.map((c) => `${c.title}: ${c.expected}`).join(' · ')
                  : 'Nothing has been met yet.'
              );
              onChange();
            } catch (e) {
              setMsg((e as Error).message);
            }
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
    !box.worth_checking.length &&
    !box.ending_soon.length &&
    !box.your_cards.length &&
    !box.acquisition.length &&
    !box.transfers.length;

  return (
    <>
      <Tracked rows={tracked} onChange={load} />
      <Section title="Worth checking" rows={box.worth_checking} onChange={load} />
      {/* Its own section, because the old model had nowhere to put a welcome
          offer for a card you do not hold and buried it under Everything —
          the one place nobody looks. */}
      <Section title="New-card offers" rows={box.acquisition} onChange={load} />
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
                  {/* The relationship in words, not the relevance enum. */}
                  <span className={`chip ${RELATIONSHIP_CLASS[o.relationship] ?? 'never'}`}>
                    {RELATIONSHIP_LABEL[o.relationship]}
                  </span>
                </div>
                <p className="sub">{[...o.why, ...o.blockers].join(' ')}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
