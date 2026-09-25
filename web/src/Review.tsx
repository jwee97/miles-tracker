import { useEffect, useState } from 'react';
import { fetchReviewQueue, money, resolveReview, type ReviewItem, type ReviewReason } from './api';

const HEADING: Record<ReviewReason, string> = {
  possible_duplicate: 'Is this the same purchase twice?',
  unknown_card: 'Which card was this on?',
  ambiguous_mcc: 'This merchant uses more than one code',
  unknown_mcc: 'We could not confirm its merchant code',
  reward_rule_uncertain: 'The rules do not clearly say what this earns',
  statement_match_ambiguous: 'This statement row matched more than one thing',
  unknown_merchant: 'Who was this paid to?',
  unknown_category: 'What kind of spending was this?',
};

const CATEGORIES = ['dining', 'groceries', 'transport', 'online', 'travel', 'utilities', 'shopping', 'other'];

function Item({ i, onDone }: { i: ReviewItem; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  async function answer(body: Parameters<typeof resolveReview>[1]) {
    setBusy(true);
    setErr(null);
    try {
      const r = await resolveReview(i.id, body);
      if (!r.ok) setErr(r.error ?? 'that did not work');
      else onDone(r.applied ?? 'done');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`review-item ${i.reason}`}>
      <div className="review-head">
        <span className="review-merchant">{i.merchant ?? i.merchant_raw ?? 'unnamed'}</span>
        <span className="mono">${money(i.amount_cents)}</span>
      </div>
      <p className="review-meta">
        {i.occurred_at} · {i.product}
        {i.merchant_raw && i.merchant_raw !== i.merchant && <> · printed as “{i.merchant_raw}”</>}
      </p>
      <p className="review-question">{HEADING[i.reason]}</p>
      {i.detail && <p className="sub">{i.detail}</p>}

      {/*
        What answering is worth. When the codes pay the same, saying so is more
        respectful of someone's time than asking and letting them assume it
        mattered.
      */}
      {i.reward_impact && i.impact_note && (
        <div className={`impact ${i.reward_impact.outcome_insensitive ? 'impact-none' : 'impact-real'}`}>
          <p className="impact-note">{i.impact_note}</p>
          {!i.reward_impact.outcome_insensitive && (
            <ul className="impact-rows">
              {i.reward_impact.per_mcc.map((m) => (
                <li key={m.mcc}>
                  <span className="mono">{m.mcc}</span> → {m.card ?? 'no card qualifies'}{' '}
                  <span className="mono">${money(m.value_cents)}</span>
                  {m.reward ? <span className="sub"> ({m.reward})</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(i.reason === 'unknown_mcc' || i.reason === 'ambiguous_mcc') && (
        <>
          {i.suggestion && (
            <button disabled={busy} onClick={() => answer({ action: 'confirm', mcc: i.suggestion! })}>
              Confirm {i.suggestion}
              {i.options.find((o) => o.mcc === i.suggestion)?.description
                ? ` — ${i.options.find((o) => o.mcc === i.suggestion)!.description}`
                : ''}
            </button>
          )}
          <div className="review-options">
            {i.options
              .filter((o) => o.mcc !== i.suggestion)
              .map((o) => (
                <button key={o.mcc} className="secondary" disabled={busy} onClick={() => answer({ action: 'confirm', mcc: o.mcc })}>
                  {o.mcc}
                  {o.description ? ` — ${o.description}` : ''}
                </button>
              ))}
          </div>
          <div className="advisor-row">
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              inputMode="numeric"
              placeholder="or type the code"
            />
            <button className="secondary" disabled={busy || !/^\d{4}$/.test(typed)} onClick={() => answer({ action: 'confirm', mcc: typed })}>
              Set
            </button>
          </div>
        </>
      )}

      {i.reason === 'unknown_category' && (
        <div className="review-options">
          {CATEGORIES.map((c) => (
            <button key={c} className="secondary" disabled={busy} onClick={() => answer({ action: 'confirm', category: c })}>
              {c}
            </button>
          ))}
        </div>
      )}

      {i.reason === 'unknown_merchant' && (
        <div className="advisor-row">
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Merchant name" />
          <button className="secondary" disabled={busy || !typed.trim()} onClick={() => answer({ action: 'confirm', merchant: typed.trim() })}>
            Save
          </button>
        </div>
      )}

      {i.reason === 'possible_duplicate' && (
        <div className="review-options">
          <button disabled={busy} onClick={() => answer({ action: 'merge' })}>
            Merge — it is one purchase
          </button>
          <button className="secondary" disabled={busy} onClick={() => answer({ action: 'keep_both' })}>
            Keep both
          </button>
        </div>
      )}

      <div className="entry-foot rule-actions">
        <button className="secondary" disabled={busy} onClick={() => answer({ action: 'ignore' })}>
          Ignore for now
        </button>
        {err && <span className="err-text">{err}</span>}
      </div>
    </li>
  );
}

/**
 * The questions the pipeline could not answer.
 *
 * Nothing here is a bug report. Each row is a place where the app declined to
 * guess at something that would have changed a number — which card earned what,
 * whether a purchase happened once or twice — and saved the transaction with
 * the question attached instead of quietly picking.
 */
export default function Review() {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  function load() {
    fetchReviewQueue()
      .then((d) => setItems(d.items))
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(load, []);

  if (err) return <p className="pad error">{err}</p>;
  if (!items) return <p className="pad sub">Loading…</p>;

  return (
    <section className="card">
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>Needs an answer{items.length ? ` (${items.length})` : ''}</h2>
      </div>
      <p className="sub">
        Where the app would have had to guess at something that changes a number, it saved the transaction and asked
        instead. An answer here is remembered against the merchant, so the next one does not ask.
      </p>
      {msg && <p className="ok-text">{msg}</p>}
      {items.length === 0 ? (
        <p className="sub">Nothing outstanding.</p>
      ) : (
        <ul className="review-list">
          {items.map((i) => (
            <Item
              key={i.id}
              i={i}
              onDone={(m) => {
                setMsg(m);
                load();
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
