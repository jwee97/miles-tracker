import { useEffect, useState } from 'react';
import {
  addCard,
  attachOffer,
  completeOnboarding,
  fetchOnboarding,
  onboardingFields,
  searchCatalogue,
  setOnboardingState,
  type CardMatch,
  type CatalogProduct,
  type OnboardingField,
  type OnboardingView,
} from '../../api';

/**
 * Setting the app up.
 *
 * The rule the whole flow follows: a person is asked only for what the
 * catalogue cannot know. Nobody is shown a merchant code, a cap window or a
 * reward rate, because those are facts about the product — asking for them is
 * asking someone to go and look something up, and to be wrong about it alone.
 *
 * Nothing here blocks either. Statements and points balances are offered and
 * can be skipped, and the app says what is less accurate without them rather
 * than refusing to start.
 */

type Step = 'welcome' | 'cards' | 'details' | 'wallet' | 'done';

interface Picked {
  product: CatalogProduct;
  nickname: string;
  statement_day: string;
  opened_at: string;
  limit: string;
  /** Set once the card is created, so details can be saved against it. */
  card_id?: number;
}

const suggestNickname = (p: CatalogProduct, taken: string[]) => {
  const words = `${p.product_name}`.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  let base = words.map((w) => w[0]).join('').toLowerCase().slice(0, 6);
  if (base.length < 2) base = p.issuer.toLowerCase().slice(0, 4);
  let n = base;
  let i = 2;
  while (taken.includes(n)) n = `${base}${i++}`;
  return n;
};

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <section className="card onb">
      <h2>Welcome to Miles Tracker</h2>
      <p className="sub">It will help you:</p>
      <ul className="onb-list">
        <li>choose the right card for each purchase</li>
        <li>track minimum spend and reward caps</li>
        <li>check whether your rewards were credited correctly</li>
        <li>manage expiring points</li>
      </ul>
      <p className="sub">
        You will not be asked for reward rates, merchant codes or cap rules. Those come with the card.
      </p>
      <div className="entry-foot">
        <button onClick={onNext}>Get started</button>
      </div>
    </section>
  );
}

function CardPicker({
  picked,
  onAdd,
  onRemove,
  onNext,
}: {
  picked: Picked[];
  onAdd: (p: CatalogProduct) => void;
  onRemove: (key: string) => void;
  onNext: () => void;
}) {
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState<CardMatch[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    searchCatalogue(q)
      .then((d) => live && setMatches(d.matches))
      .catch((e) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [q]);

  const has = (key: string) => picked.some((p) => p.product.product_key === key);

  return (
    <section className="card onb">
      <h2>Which cards do you have?</h2>
      <p className="sub">Search by name, issuer, or whatever you call it — "wwmc" works.</p>
      <input className="big-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search cards" autoComplete="off" />
      {err && <p className="err-text">{err}</p>}

      <ul className="rules picker">
        {matches.map((m) => (
          <li key={m.product.id}>
            <span>
              <strong>
                {m.product.issuer} {m.product.product_name}
              </strong>
              {m.product.rules > 0 ? (
                <span className="chip ok">rates known</span>
              ) : (
                <span className="chip never">no rates yet</span>
              )}
              {m.held_as && <span className="chip soon">already added as {m.held_as}</span>}
            </span>
            <div className="entry-foot rule-actions">
              <button
                disabled={has(m.product.product_key) || !!m.held_as}
                onClick={() => onAdd(m.product)}
              >
                {has(m.product.product_key) ? 'Added' : 'Add'}
              </button>
            </div>
          </li>
        ))}
        {!matches.length && <li className="unknown">Nothing matches. You can add a card by hand later.</li>}
      </ul>

      {picked.length > 0 && (
        <>
          <h3>Your cards</h3>
          <ul className="onb-chosen">
            {picked.map((p) => (
              <li key={p.product.product_key}>
                ✓ {p.product.issuer} {p.product.product_name}
                <button className="link-btn" onClick={() => onRemove(p.product.product_key)}>
                  remove
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="entry-foot">
        <button disabled={!picked.length} onClick={onNext}>
          Continue
        </button>
      </div>
    </section>
  );
}

function Details({
  picked,
  setPicked,
  onNext,
  onBack,
}: {
  picked: Picked[];
  setPicked: (p: Picked[]) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const [fields, setFields] = useState<Record<number, OnboardingField[]>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [offers, setOffers] = useState<Record<string, { amount: string; days: string; note: string }>>({});

  useEffect(() => {
    for (const p of picked) {
      if (fields[p.product.id]) continue;
      onboardingFields(p.product.id)
        .then((d) => setFields((f) => ({ ...f, [p.product.id]: d.fields })))
        .catch(() => void 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);

  const update = (key: string, patch: Partial<Picked>) =>
    setPicked(picked.map((p) => (p.product.product_key === key ? { ...p, ...patch } : p)));

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const saved: Picked[] = [];
      for (const p of picked) {
        const r = await addCard({
          product_id: p.product.id,
          nickname: p.nickname,
          limit: p.limit || undefined,
          statement_day: p.statement_day ? parseInt(p.statement_day, 10) : undefined,
          opened_at: p.opened_at || undefined,
        });
        saved.push({ ...p, card_id: r.id });

        const o = offers[p.product.product_key];
        if (o?.amount && o.days) {
          // An offer that cannot be attached is not a reason to lose the card
          // that was just created, so this failure is reported and stepped over.
          const res = await attachOffer(r.id, {
            amount: o.amount,
            window_days: parseInt(o.days, 10),
            reward_note: o.note || 'welcome offer',
          });
          if (!res.ok) setErr(res.error ?? 'the welcome offer could not be attached');
        }
      }
      setPicked(saved);
      onNext();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card onb">
      <h2>A few details</h2>
      <p className="sub">Only what the catalogue cannot know about your copy of the card.</p>
      {err && <p className="err-text">{err}</p>}

      {picked.map((p) => {
        const fs = fields[p.product.id] ?? [];
        const needsOpened = fs.find((f) => f.key === 'opened_at');
        const recent = p.opened_at && Date.parse(p.opened_at) > Date.now() - 180 * 86_400_000;
        return (
          <div key={p.product.product_key} className="onb-card">
            <h3>
              {p.product.issuer} {p.product.product_name}
            </h3>
            <div className="entry-grid">
              <label className="f">
                <span>Nickname</span>
                <input
                  value={p.nickname}
                  onChange={(e) => update(p.product.product_key, { nickname: e.target.value })}
                  autoCapitalize="none"
                />
              </label>
              <label className="f">
                <span>
                  Statement closes on{' '}
                  {fs.find((f) => f.key === 'statement_day')?.required && <em className="req">needed</em>}
                </span>
                <input
                  value={p.statement_day}
                  onChange={(e) => update(p.product.product_key, { statement_day: e.target.value })}
                  inputMode="numeric"
                  placeholder="15"
                />
              </label>
              <label className="f">
                <span>
                  When did you get it? {needsOpened?.required && <em className="req">needed</em>}
                </span>
                <input
                  type="date"
                  value={p.opened_at}
                  onChange={(e) => update(p.product.product_key, { opened_at: e.target.value })}
                />
              </label>
              <label className="f">
                <span>Credit limit (optional)</span>
                <input
                  value={p.limit}
                  onChange={(e) => update(p.product.product_key, { limit: e.target.value })}
                  inputMode="decimal"
                  placeholder="8000"
                />
              </label>
            </div>
            {needsOpened?.required && needsOpened.help_text && <p className="sub">{needsOpened.help_text}</p>}

            {recent && (
              <details className="batches">
                <summary>Did this card come with a welcome offer?</summary>
                <p className="sub">
                  A sign-up minimum is usually the most consequential thing about a new card — miss it and the whole
                  bonus is gone.
                </p>
                <div className="entry-grid">
                  <label className="f">
                    <span>Spend</span>
                    <input
                      value={offers[p.product.product_key]?.amount ?? ''}
                      onChange={(e) =>
                        setOffers({
                          ...offers,
                          [p.product.product_key]: {
                            ...(offers[p.product.product_key] ?? { amount: '', days: '', note: '' }),
                            amount: e.target.value,
                          },
                        })
                      }
                      placeholder="800"
                      inputMode="decimal"
                    />
                  </label>
                  <label className="f">
                    <span>Within (days)</span>
                    <input
                      value={offers[p.product.product_key]?.days ?? ''}
                      onChange={(e) =>
                        setOffers({
                          ...offers,
                          [p.product.product_key]: {
                            ...(offers[p.product.product_key] ?? { amount: '', days: '', note: '' }),
                            days: e.target.value,
                          },
                        })
                      }
                      placeholder="60"
                      inputMode="numeric"
                    />
                  </label>
                  <label className="f f-note">
                    <span>What it pays</span>
                    <input
                      value={offers[p.product.product_key]?.note ?? ''}
                      onChange={(e) =>
                        setOffers({
                          ...offers,
                          [p.product.product_key]: {
                            ...(offers[p.product.product_key] ?? { amount: '', days: '', note: '' }),
                            note: e.target.value,
                          },
                        })
                      }
                      placeholder="20,000 bonus points"
                    />
                  </label>
                </div>
              </details>
            )}
          </div>
        );
      })}

      <div className="entry-foot">
        <button className="secondary" onClick={onBack}>
          Back
        </button>
        <button disabled={busy || picked.some((p) => !p.nickname.trim())} onClick={save}>
          {busy ? 'Saving…' : 'Save cards'}
        </button>
      </div>
    </section>
  );
}

function Optional({ onFinish }: { onFinish: (opts: { statements: boolean; wallet: boolean }) => void }) {
  return (
    <section className="card onb">
      <h2>Two optional things</h2>
      <p className="sub">
        Recommendations work now. These make cap and minimum-spend tracking accurate sooner — neither is required.
      </p>
      <ul className="onb-list">
        <li>
          <b>Import a recent statement.</b> You may be halfway through a statement month or a bonus cap already, and the
          app cannot know that until it sees the transactions.
        </li>
        <li>
          <b>Add your points balances.</b> Needed only for transfers and expiry, not for choosing a card.
        </li>
      </ul>
      <div className="entry-foot">
        <button onClick={() => onFinish({ statements: false, wallet: false })}>Do these later</button>
        <button className="secondary" onClick={() => onFinish({ statements: true, wallet: true })}>
          I'll do them now
        </button>
      </div>
    </section>
  );
}

export default function Onboarding({ onGo }: { onGo: (tab: string) => void }) {
  const [view, setView] = useState<OnboardingView | null>(null);
  const [step, setStep] = useState<Step>('welcome');
  const [picked, setPicked] = useState<Picked[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchOnboarding()
      .then((v) => {
        setView(v);
        if (v.state.status === 'in_progress') setStep('cards');
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  if (err) return <p className="pad error">{err}</p>;
  if (!view) return <p className="pad sub">Loading…</p>;

  if (step === 'welcome') {
    return (
      <>
        {view.state.status === 'in_progress' && (
          <section className="card">
            <h2>Finish setting up Miles Tracker</h2>
            <p className="sub">{view.state.cards_completed} card(s) configured so far.</p>
            <div className="entry-foot">
              <button onClick={() => setStep('cards')}>Continue setup</button>
            </div>
          </section>
        )}
        <Welcome
          onNext={async () => {
            await setOnboardingState({ status: 'in_progress' });
            setStep('cards');
          }}
        />
      </>
    );
  }

  if (step === 'cards') {
    return (
      <CardPicker
        picked={picked}
        onAdd={(p) =>
          setPicked([
            ...picked,
            {
              product: p,
              nickname: suggestNickname(p, picked.map((x) => x.nickname)),
              statement_day: '',
              opened_at: '',
              limit: '',
            },
          ])
        }
        onRemove={(key) => setPicked(picked.filter((p) => p.product.product_key !== key))}
        onNext={() => setStep('details')}
      />
    );
  }

  if (step === 'details') {
    return <Details picked={picked} setPicked={setPicked} onNext={() => setStep('wallet')} onBack={() => setStep('cards')} />;
  }

  if (step === 'wallet') {
    return (
      <Optional
        onFinish={async (opts) => {
          await completeOnboarding();
          await setOnboardingState({
            statements_offered: opts.statements ? 1 : 0,
            wallet_offered: opts.wallet ? 1 : 0,
          });
          setStep('done');
        }}
      />
    );
  }

  return (
    <section className="card onb">
      <h2>You're ready</h2>
      <p className="sub">
        {picked.length} card{picked.length === 1 ? '' : 's'} added. Miles Tracker can now say which one to use.
      </p>
      <div className="entry-foot">
        <button onClick={() => onGo('home')}>Find the best card</button>
      </div>
      <p className="sub">Optional next steps: import a recent statement, add reward balances, set up Telegram entry.</p>
    </section>
  );
}
