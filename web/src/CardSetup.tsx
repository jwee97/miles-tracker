import { useEffect, useState } from 'react';
import {
  addCard,
  fetchCatalog,
  type CatalogProduct,
  addEarnRule,
  addRequirement,
  saveExclusion,
  scanCardPage,
  type CardPageScan,
  type ScanCandidate,
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

/**
 * Which months a quarter anchored here begins in.
 *
 * Shown beside the date because the anchor is the single field that decides
 * whether this card's quarters are Jan-Mar or Feb-Apr, and being one month out
 * moves every quarter for as long as the card is held. Months are counted from
 * the anchor's own month, which is what the engine does; the exact dates depend
 * on the statement day and are shown on the card itself.
 */
function quarterMonths(anchor: string): string {
  const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = Number(anchor.slice(5, 7)) - 1;
  if (!Number.isFinite(m) || m < 0 || m > 11) return '—';
  return [0, 1, 2, 3]
    .map((n) => (m + n * 3) % 12)
    .sort((a, b) => a - b)
    .map((x) => NAMES[x])
    .join(', ');
}

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
      {(r.mcc_include || r.mcc_exclude || r.channel || r.min_txn_cents || r.min_tier_cents) && (
        <p className="sub">
          {r.mcc_include ? `only ${r.mcc_include}` : ''}
          {r.mcc_exclude ? ` · never ${r.mcc_exclude}` : ''}
          {r.channel ? ` · ${r.channel} only` : ''}
          {r.min_txn_cents ? ` · transactions of $${money(r.min_txn_cents)}+` : ''}
          {r.min_tier_cents ? ` · only at the $${money(r.min_tier_cents)} tier and above` : ''}
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
    min_tier: '',
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
        min_tier: f.min_tier || undefined,
        note: f.note || undefined,
      });
      setF({ ...f, rate: '', cap: '', mcc_include: '', mcc_exclude: '', min_tier: '', note: '' });
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
        <label className="f">
          <span>Only at this tier</span>
          <input
            value={f.min_tier}
            onChange={(e) => setF({ ...f, min_tier: e.target.value })}
            placeholder="blank · 1000"
            inputMode="decimal"
          />
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
      <p className="sub">
        <strong>Only at this tier</strong> is for cards whose rate moves with the spend rung — UOB One pays 3.33% on
        groceries at $600 a month but 6% at $1,000. Add one rate per rung with the rung&rsquo;s monthly spend here, and
        the app uses whichever the card is actually holding.
      </p>
    </div>
  );
}

/**
 * Reading a rewards page.
 *
 * A bank writes its terms in prose, and prose is not a rule. What can be read
 * mechanically is the numbers — a rate, a cap, a list of merchant codes, a
 * sentence that says something earns nothing — and the sentence each came from.
 * So every candidate below arrives with its quote and nothing is saved until
 * you say so: a rate lifted out of the wrong paragraph would quietly misdirect
 * every recommendation the app makes, which is worse than having no rate.
 */
/** A number for a field someone will type over — no thousands separator. */
const plain = (cents: number) => String(cents / 100);

function RateCandidate({
  c,
  card,
  categories,
  onSaved,
}: {
  c: ScanCandidate;
  card: CardRow;
  categories: string[];
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    category: c.category ?? '*',
    rate: String(c.rate ?? ''),
    reward_type: (c.reward_type ?? 'miles') as 'miles' | 'cashback',
    cap: c.cap_cents ? plain(c.cap_cents) : '',
    cap_window: c.cap_window ?? '',
    mcc_include: (c.mccs ?? []).join(','),
  });
  const [state, setState] = useState<'idle' | 'busy' | 'saved'>('idle');
  const [err, setErr] = useState<string | null>(null);

  if (state === 'saved') return <li className="pass">Added — {f.category === '*' ? 'base rate' : f.category}.</li>;

  return (
    <li className="unknown">
      <span>
        <strong>
          {c.rate}
          {c.reward_type === 'cashback' ? '%' : ' mpd'}
        </strong>{' '}
        {c.category ? `on ${c.category}` : 'category unclear'}
        {c.cap_cents ? ` · cap $${money(c.cap_cents)}` : ''}
        {(c.occurrences ?? 1) > 1 ? ` · said ${c.occurrences}×` : ''}
      </span>
      <p className="sub quote">“{c.quote}”</p>
      <div className="entry-grid compact">
        <label className="f">
          <span>Category</span>
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            <option value="*">everything else (base rate)</option>
            {categories.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <label className="f">
          <span>Rate</span>
          <input value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} inputMode="decimal" />
        </label>
        <label className="f">
          <span>Earns</span>
          <select
            value={f.reward_type}
            onChange={(e) =>
              setF({
                ...f,
                reward_type: e.target.value as 'miles' | 'cashback',
              })
            }
          >
            <option value="miles">miles per dollar</option>
            <option value="cashback">percent cashback</option>
          </select>
        </label>
        <label className="f">
          <span>Cap (spend)</span>
          <input
            value={f.cap}
            onChange={(e) => setF({ ...f, cap: e.target.value })}
            inputMode="decimal"
            placeholder="none"
          />
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
        <label className="f f-note">
          <span>Only these MCCs</span>
          <input
            value={f.mcc_include}
            onChange={(e) => setF({ ...f, mcc_include: e.target.value })}
            inputMode="numeric"
            placeholder="blank means the whole category"
          />
        </label>
      </div>
      <div className="entry-foot rule-actions">
        <button
          className="secondary"
          disabled={state === 'busy' || !f.rate}
          onClick={async () => {
            setState('busy');
            setErr(null);
            try {
              await addEarnRule({
                nickname: card.nickname,
                category: f.category,
                rate: f.rate,
                reward_type: f.reward_type,
                cap: f.cap || undefined,
                cap_window: f.cap_window || null,
                mcc_include: f.mcc_include || undefined,
                note: c.quote.slice(0, 180),
              });
              setState('saved');
              onSaved();
            } catch (e) {
              setErr((e as Error).message);
              setState('idle');
            }
          }}
        >
          Add this rate
        </button>
        {err && <span className="err-text">{err}</span>}
      </div>
    </li>
  );
}

function ExclusionCandidate({ c, card, onSaved }: { c: ScanCandidate; card: CardRow; onSaved: () => void }) {
  const [done, setDone] = useState<string[]>([]);
  const codes = c.mccs ?? [];
  return (
    <li className="fail">
      <span>
        <strong>Earns nothing</strong>
        {codes.length ? ` — ${codes.join(', ')}` : ' — no codes named'}
      </span>
      <p className="sub quote">“{c.quote}”</p>
      {codes.length > 0 && (
        <div className="entry-foot rule-actions">
          {codes.map((m) => (
            <button
              key={m}
              className="secondary"
              disabled={done.includes(m)}
              onClick={async () => {
                await saveExclusion({
                  mcc: m,
                  nickname: card.nickname,
                  reason: c.quote.slice(0, 120),
                });
                setDone((d) => [...d, m]);
                onSaved();
              }}
            >
              {done.includes(m) ? `${m} excluded` : `Exclude ${m}`}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function MinSpendCandidate({ c, card, onSaved }: { c: ScanCandidate; card: CardRow; onSaved: () => void }) {
  const [done, setDone] = useState(false);
  return (
    <li className="unknown">
      <span>
        <strong>Minimum spend</strong> — ${money(c.min_spend_cents ?? 0)}
      </span>
      <p className="sub quote">“{c.quote}”</p>
      <div className="entry-foot rule-actions">
        <button
          className="secondary"
          disabled={done}
          onClick={async () => {
            await addRequirement({
              nickname: card.nickname,
              kind: 'monthly_min',
              amount: plain(c.min_spend_cents ?? 0),
              window: c.cap_window === 'statement_cycle' ? 'statement_cycle' : 'calendar_month',
              reward_note: c.quote.slice(0, 120),
            });
            setDone(true);
            onSaved();
          }}
        >
          {done ? 'Added' : 'Add as a minimum'}
        </button>
      </div>
    </li>
  );
}

function ReadPage({ card, categories, onSaved }: { card: CardRow; categories: string[]; onSaved: () => void }) {
  const [src, setSrc] = useState({ url: '', text: '' });
  const [scan, setScan] = useState<CardPageScan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function read() {
    setBusy(true);
    setErr(null);
    setScan(null);
    try {
      const r = await scanCardPage({
        nickname: card.nickname,
        url: src.url,
        text: src.text,
      });
      setScan(r);
      if (r.error) setErr(r.error);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const rates = scan?.candidates.filter((c) => c.kind === 'rate') ?? [];
  const exclusions = scan?.candidates.filter((c) => c.kind === 'exclusion') ?? [];
  const minspends = scan?.candidates.filter((c) => c.kind === 'minspend') ?? [];
  const rest = scan?.candidates.filter((c) => c.kind === 'mcc' || c.kind === 'cap') ?? [];

  return (
    <div className="addrule">
      <div className="entry-grid">
        <label className="f f-note">
          <span>Rewards page</span>
          <input
            value={src.url}
            onChange={(e) => setSrc({ ...src, url: e.target.value })}
            placeholder="https://… the card's rewards or T&C page"
            inputMode="url"
          />
        </label>
        <label className="f f-note">
          <span>…or paste the terms</span>
          <textarea
            value={src.text}
            onChange={(e) => setSrc({ ...src, text: e.target.value })}
            rows={4}
            placeholder="Most bank sites refuse anything that is not a browser. Selecting the page and pasting it here always works."
          />
        </label>
      </div>
      <div className="entry-foot">
        <button className="secondary" onClick={read} disabled={busy || (!src.url && !src.text.trim())}>
          {busy ? 'Reading…' : 'Read it'}
        </button>
        {err && <span className="err-text">{err}</span>}
      </div>

      {scan && !scan.error && (
        <>
          <p className="sub">
            {scan.title ? `${scan.title} · ` : ''}
            {scan.text_length.toLocaleString()} characters read · {scan.candidates.length} claim
            {scan.candidates.length === 1 ? '' : 's'} found. Nothing is saved until you add it.
          </p>

          {scan.candidates.length === 0 && (
            <p className="cap">
              No rates, caps or merchant codes stated in words this can read. Copy the prompt below into Claude, which
              reads the prose rather than the numbers.
            </p>
          )}

          {rates.length > 0 && (
            <ul className="rules">
              {rates.map((c, i) => (
                <RateCandidate key={`r${i}`} c={c} card={card} categories={categories} onSaved={onSaved} />
              ))}
            </ul>
          )}
          {exclusions.length > 0 && (
            <ul className="rules">
              {exclusions.map((c, i) => (
                <ExclusionCandidate key={`x${i}`} c={c} card={card} onSaved={onSaved} />
              ))}
            </ul>
          )}
          {minspends.length > 0 && (
            <ul className="rules">
              {minspends.map((c, i) => (
                <MinSpendCandidate key={`m${i}`} c={c} card={card} onSaved={onSaved} />
              ))}
            </ul>
          )}
          {rest.length > 0 && (
            <ul className="rules">
              {rest.map((c, i) => (
                <li key={`o${i}`} className="dim">
                  <span>
                    <strong>{c.kind === 'cap' ? 'Cap' : 'Merchant codes'}</strong>
                    {c.cap_cents ? ` — $${money(c.cap_cents)}` : ''}
                    {c.mccs?.length ? ` — ${c.mccs.join(', ')}` : ''}
                  </span>
                  <p className="sub quote">“{c.quote}”</p>
                </li>
              ))}
            </ul>
          )}

          {scan.codes.length > 0 && (
            <div className="scroller" style={{ marginTop: 12 }}>
              <table className="pts">
                <caption>Every code the page names, and what this app already calls it</caption>
                <thead>
                  <tr>
                    <th scope="col">MCC</th>
                    <th scope="col">This app calls it</th>
                    <th scope="col">Category</th>
                    <th scope="col">On this page</th>
                  </tr>
                </thead>
                <tbody>
                  {scan.codes.map((c) => (
                    <tr key={c.mcc}>
                      <th scope="row">{c.mcc}</th>
                      <td>{c.description ?? <span className="dim">not in the code list</span>}</td>
                      <td>{c.category ?? '—'}</td>
                      <td className={c.excluded_here ? 'bad-text' : 'ok-text'}>
                        {c.excluded_here ? '✕ excluded' : '✓ earns'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="entry-foot">
            <button
              className="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(scan.prompt);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy the prompt for Claude'}
            </button>
          </div>
          <p className="sub">
            The reader above finds numbers. The prompt hands the whole page to Claude, which reads the prose — paste its
            reply to the bot, or type the rates in yourself.
          </p>
        </>
      )}
    </div>
  );
}

const WINDOW_LABEL: Record<string, string> = {
  calendar_month: 'each calendar month',
  calendar_quarter: 'each calendar quarter',
  statement_cycle: 'each statement cycle',
  statement_quarter: 'every statement month of a rolling quarter',
  fixed_window: 'once, by the deadline',
};

/**
 * Minimum spend: the thing that decides whether a bonus is earned at all, and
 * until now only the bot could set one.
 */
function Requirements({ card, onChanged }: { card: CardRow; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  /** The requirement being changed, or null when adding a new one. */
  const [editing, setEditing] = useState<RequirementRow | null>(null);
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
    anchor_at: card.opened_at ?? '',
    prorate_first: true,
  });

  /** Loads an existing requirement into the form, ladder and all. */
  function edit(q: RequirementRow) {
    setEditing(q);
    setR({
      kind: q.kind,
      amount: money(q.amount_cents),
      window: q.window,
      deadline: q.deadline ?? '',
      starts_at: q.starts_at ?? '',
      min_txns: q.min_txns ? String(q.min_txns) : '',
      bonus_cap: q.bonus_cap_cents ? money(q.bonus_cap_cents) : '',
      reward_note: q.reward_note ?? '',
      anchor_at: q.anchor_at ?? card.opened_at ?? '',
      prorate_first: !!q.prorate_first,
    });
    setTiers((q.tiers ?? []).map((t) => ({ min_spend: money(t.min_spend_cents), reward: money(t.reward_cents), label: t.label ?? '' })));
    setOpen(true);
  }
  // A tiered card pays a different amount at each rung, so the tiers are rows
  // the user adds, not three fixed boxes.
  const [tiers, setTiers] = useState<{ min_spend: string; reward: string; label: string }[]>([]);
  const quarterly = r.window === 'statement_quarter';

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await addRequirement({
        id: editing?.id,
        nickname: card.nickname,
        kind: r.kind,
        amount: r.amount,
        window: r.window,
        deadline: r.deadline || null,
        starts_at: r.starts_at || null,
        min_txns: r.min_txns ? Number(r.min_txns) : null,
        bonus_cap: r.bonus_cap || null,
        reward_note: r.reward_note || null,
        anchor_at: quarterly ? r.anchor_at || null : null,
        per_month: quarterly,
        prorate_first: quarterly && r.prorate_first,
        tiers: tiers
          .filter((t) => t.min_spend && t.reward)
          .map((t) => ({ min_spend: t.min_spend, reward: t.reward, label: t.label || null })),
      });
      setR({ ...r, amount: '', min_txns: '', bonus_cap: '', reward_note: '' });
      setTiers([]);
      setEditing(null);
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
              {q.window === 'statement_quarter' && (
                <p className="sub">
                  Counted from {q.anchor_at ?? card.opened_at ?? 'the card\u2019s opening date'}
                  {q.prorate_first ? ' · the first quarter pro-rates' : ' · all three months or nothing'}
                </p>
              )}
              {q.tiers?.length > 0 && (
                <p className="sub">
                  {q.tiers
                    .map((t) => `$${money(t.min_spend_cents)}/mth → $${money(t.reward_cents)}/qtr`)
                    .join(' · ')}
                </p>
              )}
              <div className="entry-foot rule-actions">
                <button className="secondary" onClick={() => edit(q)}>
                  Edit
                </button>
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
                <option value="statement_quarter">every statement month of a rolling quarter</option>
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
            {quarterly && (
              <>
                <label className="f">
                  <span>Quarter anchored to</span>
                  <input type="date" value={r.anchor_at} onChange={(e) => setR({ ...r, anchor_at: e.target.value })} />
                  {r.anchor_at && (
                    <span className="sub">
                      quarters begin in {quarterMonths(r.anchor_at)}
                    </span>
                  )}
                </label>
                <label className="f">
                  <span>First quarter</span>
                  <select
                    value={r.prorate_first ? 'yes' : 'no'}
                    onChange={(e) => setR({ ...r, prorate_first: e.target.value === 'yes' })}
                  >
                    <option value="yes">pays in thirds for the months you hit</option>
                    <option value="no">all three months or nothing</option>
                  </select>
                </label>
              </>
            )}
          </div>

          {quarterly && (
            <>
              <p className="sub">
                A rolling quarter is three <em>statement</em> months counted from the month the card was issued — a card
                issued in February runs Feb&ndash;Mar&ndash;Apr, then May&ndash;Jun&ndash;Jul, and a &ldquo;month&rdquo;
                runs from the day after one statement closes to the day the next one does. The minimum above has to be
                hit in <strong>every</strong> one of the three.
              </p>
              <div className="tiers">
                <div className="quarter-head">
                  <span>Tiers</span>
                  <span>spend per month → what the quarter pays</span>
                </div>
                {tiers.map((t, i) => (
                  <div className="entry-grid compact" key={i}>
                    <label className="f">
                      <span>Spend a month</span>
                      <input
                        value={t.min_spend}
                        onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, min_spend: e.target.value } : x)))}
                        placeholder="600"
                        inputMode="decimal"
                      />
                    </label>
                    <label className="f">
                      <span>Pays a quarter</span>
                      <input
                        value={t.reward}
                        onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, reward: e.target.value } : x)))}
                        placeholder="50"
                        inputMode="decimal"
                      />
                    </label>
                    <label className="f f-note">
                      <span>Label</span>
                      <input
                        value={t.label}
                        onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                        placeholder="optional"
                      />
                    </label>
                    <div className="entry-foot" style={{ gridColumn: '1 / -1', margin: 0 }}>
                      <button className="secondary danger" onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>
                        Remove tier
                      </button>
                    </div>
                  </div>
                ))}
                <div className="entry-foot">
                  <button
                    className="secondary"
                    onClick={() => setTiers([...tiers, { min_spend: '', reward: '', label: '' }])}
                  >
                    Add a tier
                  </button>
                </div>
                <p className="sub">
                  The quarter pays at the <strong>lowest</strong> tier you held across its three months, so one big month
                  does not carry two thin ones. Leave the tiers empty if the reward is a flat amount.
                </p>
              </div>
            </>
          )}
          <div className="entry-foot">
            <button className="secondary" onClick={save} disabled={busy || !r.amount}>
              {editing ? 'Save this minimum' : 'Add this minimum'}
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
        <button
          className="secondary"
          onClick={() => {
            setEditing(null);
            setTiers([]);
            setOpen((v) => !v);
          }}
        >
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
  const [reading, setReading] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<CatalogProduct[]>([]);
  const [picked, setPicked] = useState<CatalogProduct | null>(null);
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
        product_id: picked?.id,
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
        `Added ${r.product} as "${r.nickname}"` +
          (r.program_key ? ` · points go to ${r.program_key}` : ' · no programme set, so points cannot be banked') +
          (r.rules
            ? `. It already knows what this card pays — ${r.rules} rule${r.rules === 1 ? '' : 's'} from the catalogue.`
            : '. Add its rates below, or it will not appear in any recommendation.')
      );
      setPicked(null);
      setSearch('');
      setMatches([]);
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

          {/*
            Pick the card, do not describe it. The issuer, the programme and
            every rate are facts about the product, already recorded against it
            — asking for them again is asking you to look up something the app
            knows, and to be wrong about it on your own.
          */}
          <div className="advisor-row">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search the catalogue — DBS Woman…"
              autoComplete="off"
            />
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                try {
                  const d = await fetchCatalog(search);
                  setMatches(d.products.slice(0, 8));
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              Search
            </button>
          </div>

          {matches.length > 0 && !picked && (
            <ul className="rules picker">
              {matches.map((m) => (
                <li key={m.id}>
                  <span>
                    <strong>
                      {m.issuer} {m.product_name}
                    </strong>
                    {m.rules > 0 ? (
                      <span className="chip ok">{m.rules} rules known</span>
                    ) : (
                      <span className="chip never">no rates yet</span>
                    )}
                  </span>
                  <div className="entry-foot rule-actions">
                    <button
                      onClick={() => {
                        setPicked(m);
                        setC({ ...c, issuer: m.issuer, product: m.product_name });
                        setMatches([]);
                      }}
                    >
                      Use this one
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {picked && (
            <p className="sub">
              <b>
                {picked.issuer} {picked.product_name}
              </b>{' '}
              — {picked.rules > 0 ? 'its rates come with it' : 'the catalogue has no rates for it yet'}.{' '}
              <button type="button" className="link-btn" onClick={() => setPicked(null)}>
                Choose another
              </button>
            </p>
          )}

          <div className="entry-grid">
            {!picked && (
              <>
                <label className="f">
                  <span>Issuer</span>
                  <input value={c.issuer} onChange={(e) => setC({ ...c, issuer: e.target.value })} placeholder="UOB" />
                </label>
                <label className="f">
                  <span>Product</span>
                  <input value={c.product} onChange={(e) => setC({ ...c, product: e.target.value })} placeholder="Lady's Card" />
                </label>
              </>
            )}
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
            {!picked && (
              <label className="f">
                <span>Base rate</span>
                <input value={c.base_mpd} onChange={(e) => setC({ ...c, base_mpd: e.target.value })} placeholder="0.4" inputMode="decimal" />
              </label>
            )}
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
            <button className="secondary" onClick={() => setReading(reading === card.nickname ? null : card.nickname)}>
              {reading === card.nickname ? 'Close reader' : 'Read a rewards page'}
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

          {reading === card.nickname && <ReadPage card={card} categories={categories} onSaved={load} />}

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
