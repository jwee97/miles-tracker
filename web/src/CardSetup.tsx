import { useEffect, useState } from 'react';
import {
  addCard,
  addEarnRule,
  addRequirement,
  deleteRequirement,
  closeCard,
  deleteEarnRule,
  fetchCards,
  money,
  type CardRow,
  type EarnRuleRow,
  type ProgramRow,
  type RequirementRow,
  setCardProgram,
} from './api';

/**
 * Adding a card and telling the app what it actually pays.
 *
 * A card with no earn rules is invisible to every recommendation the app
 * makes, so the two belong on one screen: the card, then the rates — including
 * the merchant codes a rate is restricted to, which is what separates "4 mpd
 * online" from "4 mpd on 5262, 5964 and 5969".
 */

const WINDOWS = [
  { key: '', label: 'no cap' },
  { key: 'calendar_month', label: 'per calendar month' },
  { key: 'statement_cycle', label: 'per statement cycle' },
  { key: 'calendar_quarter', label: 'per calendar quarter' },
];

function rateText(r: EarnRuleRow) {
  return r.reward_type === 'cashback' ? `${r.mpd}%` : `${r.mpd} mpd`;
}

function RuleLine({ r, onGone }: { r: EarnRuleRow; onGone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <li className={r.category === '*' ? 'unknown' : 'pass'}>
      <span>
        <strong>{r.category === '*' ? 'everything else' : r.category}</strong> — {rateText(r)}
        {r.cap_cents ? ` up to $${money(r.cap_cents)} ${(r.cap_window ?? '').replace(/_/g, ' ')}` : ''}
        {r.cap_group ? ` · shares the "${r.cap_group}" cap` : ''}
      </span>
      {(r.mcc_include || r.mcc_exclude || r.channel || r.min_txn_cents) && (
        <p className="sub">
          {r.mcc_include ? `only ${r.mcc_include}` : ''}
          {r.mcc_exclude ? ` · never ${r.mcc_exclude}` : ''}
          {r.channel ? ` · ${r.channel} only` : ''}
          {r.min_txn_cents ? ` · transactions of $${money(r.min_txn_cents)}+` : ''}
        </p>
      )}
      {r.note && <p className="sub note">{r.note}</p>}
      <div className="entry-foot rule-actions">
        <button
          className="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await deleteEarnRule(r.id);
            onGone();
          }}
        >
          Remove
        </button>
      </div>
    </li>
  );
}

function AddRule({ card, categories, onSaved }: { card: CardRow; categories: string[]; onSaved: () => void }) {
  const [f, setF] = useState({
    category: '*',
    rate: '',
    reward_type: 'miles' as 'miles' | 'cashback',
    cap: '',
    cap_window: '',
    cap_group: '',
    mcc_include: '',
    mcc_exclude: '',
    channel: '',
    min_txn: '',
    note: '',
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await addEarnRule({
        nickname: card.nickname,
        category: f.category,
        rate: f.rate,
        reward_type: f.reward_type,
        cap: f.cap || undefined,
        cap_window: f.cap_window || null,
        cap_group: f.cap_group || null,
        mcc_include: f.mcc_include || undefined,
        mcc_exclude: f.mcc_exclude || undefined,
        channel: f.channel || null,
        min_txn: f.min_txn || undefined,
        note: f.note || undefined,
      });
      setF({ ...f, rate: '', cap: '', mcc_include: '', mcc_exclude: '', note: '' });
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="addrule">
      <div className="entry-grid">
        <label className="f">
          <span>Category</span>
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            <option value="*">everything else (base rate)</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="f">
          <span>Rate</span>
          <input
            value={f.rate}
            onChange={(e) => setF({ ...f, rate: e.target.value })}
            placeholder={f.reward_type === 'cashback' ? '5' : '4'}
            inputMode="decimal"
          />
        </label>
        <label className="f">
          <span>Earns</span>
          <select
            value={f.reward_type}
            onChange={(e) => setF({ ...f, reward_type: e.target.value as 'miles' | 'cashback' })}
          >
            <option value="miles">miles per dollar</option>
            <option value="cashback">percent cashback</option>
          </select>
        </label>
        <label className="f">
          <span>Cap (spend)</span>
          <input value={f.cap} onChange={(e) => setF({ ...f, cap: e.target.value })} placeholder="1000" inputMode="decimal" />
        </label>
        <label className="f">
          <span>Cap resets</span>
          <select value={f.cap_window} onChange={(e) => setF({ ...f, cap_window: e.target.value })}>
            {WINDOWS.map((w) => (
              <option key={w.key} value={w.key}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <label className="f">
          <span>Shared cap name</span>
          <input
            value={f.cap_group}
            onChange={(e) => setF({ ...f, cap_group: e.target.value })}
            placeholder="blank unless shared"
          />
        </label>
        <label className="f f-note">
          <span>Only these MCCs</span>
          <input
            value={f.mcc_include}
            onChange={(e) => setF({ ...f, mcc_include: e.target.value })}
            placeholder="5262, 5964, 5969 — blank means the whole category"
            inputMode="numeric"
          />
        </label>
        <label className="f f-note">
          <span>Never these MCCs</span>
          <input
            value={f.mcc_exclude}
            onChange={(e) => setF({ ...f, mcc_exclude: e.target.value })}
            placeholder="4900, 9311"
            inputMode="numeric"
          />
        </label>
        <label className="f">
          <span>Channel</span>
          <select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
            <option value="">any</option>
            <option value="online">online only</option>
            <option value="offline">in person only</option>
            <option value="contactless">contactless only</option>
          </select>
        </label>
        <label className="f">
          <span>Minimum per txn</span>
          <input value={f.min_txn} onChange={(e) => setF({ ...f, min_txn: e.target.value })} placeholder="blank" inputMode="decimal" />
        </label>
        <label className="f f-note">
          <span>Note</span>
          <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="where this came from" />
        </label>
      </div>
      <div className="entry-foot">
        <button className="secondary" onClick={save} disabled={busy || !f.rate}>
          Add this rate
        </button>
        {msg && <span className="err-text">{msg}</span>}
      </div>
      <p className="sub">
        A shared cap name matters: if one cap covers several categories, giving them the same name is what stops the app
        thinking you have more bonus headroom than you do.
      </p>
    </div>
  );
}

const WINDOW_LABEL: Record<string, string> = {
  calendar_month: 'each calendar month',
  calendar_quarter: 'each calendar quarter',
  statement_cycle: 'each statement cycle',
  fixed_window: 'once, by the deadline',
};

/**
 * Minimum spend: the thing that decides whether a bonus is earned at all, and
 * until now only the bot could set one.
 */
function Requirements({ card, onChanged }: { card: CardRow; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [r, setR] = useState({
    kind: 'monthly_min' as 'monthly_min' | 'signup_min',
    amount: '',
    window: 'calendar_month',
    deadline: '',
    starts_at: '',
    min_txns: '',
    bonus_cap: '',
    reward_note: '',
  });

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await addRequirement({
        nickname: card.nickname,
        kind: r.kind,
        amount: r.amount,
        window: r.window,
        deadline: r.deadline || null,
        starts_at: r.starts_at || null,
        min_txns: r.min_txns ? Number(r.min_txns) : null,
        bonus_cap: r.bonus_cap || null,
        reward_note: r.reward_note || null,
      });
      setR({ ...r, amount: '', min_txns: '', bonus_cap: '', reward_note: '' });
      setOpen(false);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {card.requirements.length > 0 && (
        <ul className="rules">
          {card.requirements.map((q: RequirementRow) => (
            <li key={q.id} className={q.kind === 'signup_min' ? 'pass' : 'unknown'}>
              <span>
                <strong>{q.kind === 'signup_min' ? 'Sign-up minimum' : 'Minimum'}</strong> — ${money(q.amount_cents)}{' '}
                {WINDOW_LABEL[q.window] ?? q.window}
                {q.min_txns ? ` and ${q.min_txns} transaction${q.min_txns === 1 ? '' : 's'}` : ''}
                {q.deadline ? ` · by ${q.deadline}` : ''}
              </span>
              {(q.bonus_cap_cents || q.reward_note) && (
                <p className="sub">
                  {q.reward_note ?? ''}
                  {q.bonus_cap_cents ? ` · elevated rate stops after $${money(q.bonus_cap_cents)}` : ''}
                </p>
              )}
              <div className="entry-foot rule-actions">
                <button
                  className="danger"
                  onClick={async () => {
                    await deleteRequirement(q.id);
                    onChanged();
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="addrule">
          <div className="entry-grid">
            <label className="f">
              <span>Kind</span>
              <select value={r.kind} onChange={(e) => setR({ ...r, kind: e.target.value as typeof r.kind })}>
                <option value="monthly_min">recurring minimum</option>
                <option value="signup_min">sign-up bonus minimum</option>
              </select>
            </label>
            <label className="f">
              <span>Spend</span>
              <input value={r.amount} onChange={(e) => setR({ ...r, amount: e.target.value })} placeholder="1000" inputMode="decimal" />
            </label>
            <label className="f">
              <span>Measured over</span>
              <select value={r.window} onChange={(e) => setR({ ...r, window: e.target.value })}>
                <option value="calendar_month">each calendar month</option>
                <option value="statement_cycle">each statement cycle</option>
                <option value="calendar_quarter">each calendar quarter</option>
                <option value="fixed_window">a one-off window</option>
              </select>
            </label>
            <label className="f">
              <span>Deadline</span>
              <input type="date" value={r.deadline} onChange={(e) => setR({ ...r, deadline: e.target.value })} />
            </label>
            <label className="f">
              <span>Starts</span>
              <input type="date" value={r.starts_at} onChange={(e) => setR({ ...r, starts_at: e.target.value })} />
            </label>
            <label className="f">
              <span>Transactions too</span>
              <input value={r.min_txns} onChange={(e) => setR({ ...r, min_txns: e.target.value })} placeholder="5" inputMode="numeric" />
            </label>
            <label className="f">
              <span>Bonus cap</span>
              <input value={r.bonus_cap} onChange={(e) => setR({ ...r, bonus_cap: e.target.value })} placeholder="1000" inputMode="decimal" />
            </label>
            <label className="f f-note">
              <span>What it earns</span>
              <input
                value={r.reward_note}
                onChange={(e) => setR({ ...r, reward_note: e.target.value })}
                placeholder="30,000 miles"
              />
            </label>
          </div>
          <div className="entry-foot">
            <button className="secondary" onClick={save} disabled={busy || !r.amount}>
              Add this minimum
            </button>
            {err && <span className="err-text">{err}</span>}
          </div>
          <p className="sub">
            A one-off window needs a deadline — it is what the countdown counts down to. The bonus cap is the mirror of a
            minimum: past it, the elevated rate is gone and further spend belongs on another card.
          </p>
        </div>
      )}
      <div className="entry-foot">
        <button className="secondary" onClick={() => setOpen((v) => !v)}>
          {open ? 'Cancel' : 'Add a minimum'}
        </button>
      </div>
    </>
  );
}

export default function CardSetup({ onChanged }: { onChanged: () => void }) {
  const [cards, setCards] = useState<CardRow[] | null>(null);
  const [programs, setPrograms] = useState<ProgramRow[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const [c, setC] = useState({
    issuer: '',
    product: '',
    nickname: '',
    limit: '',
    statement_day: '1',
    opened_at: '',
    program_key: '',
    base_mpd: '',
  });

  function load() {
    fetchCards()
      .then((d) => {
        setCards(d.cards);
        setPrograms(d.programs);
        setCategories(d.categories);
      })
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(load, []);

  async function save() {
    setErr(null);
    setMsg(null);
    try {
      const r = await addCard({
        issuer: c.issuer,
        product: c.product,
        nickname: c.nickname,
        limit: c.limit,
        statement_day: parseInt(c.statement_day, 10) || 1,
        opened_at: c.opened_at || undefined,
        program_key: c.program_key || undefined,
        base_mpd: c.base_mpd || undefined,
      });
      setMsg(
        `Added ${c.product} as "${r.nickname}"` +
          (r.program_key ? ` · points go to ${r.program_key}` : ' · no programme set, so points cannot be banked') +
          '. Add its rates below, or it will not appear in any recommendation.'
      );
      setC({ issuer: '', product: '', nickname: '', limit: '', statement_day: '1', opened_at: '', program_key: '', base_mpd: '' });
      setAdding(false);
      setOpen(r.nickname);
      load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!cards) return err ? <p className="pad error">{err}</p> : <p className="pad sub">Loading…</p>;
  const shown = cards.filter((x) => showClosed || !x.closed_at);

  return (
    <>
      <div className="section-head">
        <h2>Your cards</h2>
        <div className="entry-foot" style={{ margin: 0 }}>
          <button className="secondary" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add a card'}
          </button>
          {cards.some((x) => x.closed_at) && (
            <button className="secondary" onClick={() => setShowClosed((v) => !v)}>
              {showClosed ? 'Hide closed' : 'Show closed'}
            </button>
          )}
        </div>
      </div>

      {adding && (
        <section className="card entry">
          <h2>New card</h2>
          <div className="entry-grid">
            <label className="f">
              <span>Issuer</span>
              <input value={c.issuer} onChange={(e) => setC({ ...c, issuer: e.target.value })} placeholder="UOB" />
            </label>
            <label className="f">
              <span>Product</span>
              <input value={c.product} onChange={(e) => setC({ ...c, product: e.target.value })} placeholder="Lady's Card" />
            </label>
            <label className="f">
              <span>Nickname</span>
              <input
                value={c.nickname}
                onChange={(e) => setC({ ...c, nickname: e.target.value })}
                placeholder="lady"
                autoCapitalize="none"
              />
            </label>
            <label className="f">
              <span>Credit limit</span>
              <input value={c.limit} onChange={(e) => setC({ ...c, limit: e.target.value })} placeholder="8000" inputMode="decimal" />
            </label>
            <label className="f">
              <span>Statement closes on</span>
              <input
                value={c.statement_day}
                onChange={(e) => setC({ ...c, statement_day: e.target.value })}
                inputMode="numeric"
                placeholder="15"
              />
            </label>
            <label className="f">
              <span>Opened</span>
              <input type="date" value={c.opened_at} onChange={(e) => setC({ ...c, opened_at: e.target.value })} />
            </label>
            <label className="f">
              <span>Points go to</span>
              <select value={c.program_key} onChange={(e) => setC({ ...c, program_key: e.target.value })}>
                <option value="">guess from the issuer</option>
                <option value="none">none — cashback card</option>
                {programs.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="f">
              <span>Base rate</span>
              <input value={c.base_mpd} onChange={(e) => setC({ ...c, base_mpd: e.target.value })} placeholder="0.4" inputMode="decimal" />
            </label>
          </div>
          <div className="entry-foot">
            <button onClick={save} disabled={!c.issuer || !c.product || !c.nickname}>
              Add the card
            </button>
            {err && <span className="err-text">{err}</span>}
          </div>
          <p className="sub">
            The nickname is what you type when logging spend, so keep it short. The opening date drives eligibility
            cooldowns on future offers.
          </p>
        </section>
      )}

      {msg && <p className="pad sub">{msg}</p>}

      {shown.map((card) => (
        <section key={card.id} className={`card ${card.closed_at ? 'dim' : ''}`}>
          <header>
            <div>
              <h2>{card.product}</h2>
              <p className="sub">
                {card.issuer} · {card.nickname} · limit ${money(card.credit_limit_cents)} · closes day{' '}
                {card.statement_day}
                {card.program_key ? ` · earns into ${card.program_key}` : ' · no programme'}
                {card.closed_at ? ` · closed ${card.closed_at}` : ''}
              </p>
            </div>
          </header>

          {card.rules.length ? (
            <ul className="rules">
              {card.rules.map((r) => (
                <RuleLine key={r.id} r={r} onGone={load} />
              ))}
            </ul>
          ) : (
            <p className="cap">
              No rates recorded, so this card never wins a recommendation and its rewards cannot be predicted.
            </p>
          )}

          <div className="entry-foot">
            <button className="secondary" onClick={() => setOpen(open === card.nickname ? null : card.nickname)}>
              {open === card.nickname ? 'Done' : 'Add a rate'}
            </button>
            {!card.closed_at ? (
              <button
                className="secondary danger"
                onClick={async () => {
                  await closeCard(card.nickname, new Date().toISOString().slice(0, 10));
                  load();
                  onChanged();
                }}
              >
                Mark closed
              </button>
            ) : (
              <button
                className="secondary"
                onClick={async () => {
                  await closeCard(card.nickname, null);
                  load();
                  onChanged();
                }}
              >
                Reopen
              </button>
            )}
          </div>

          {open === card.nickname && <AddRule card={card} categories={categories} onSaved={load} />}

          <Requirements card={card} onChanged={load} />

          <div className="entry-foot">
            <label className="tick">
              <span>Points go to</span>
            </label>
            <select
              className="range-select"
              value={card.program_key ?? ''}
              onChange={async (e) => {
                await setCardProgram(card.nickname, e.target.value || null);
                load();
                onChanged();
              }}
            >
              <option value="">no programme</option>
              {programs.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </section>
      ))}
    </>
  );
}
