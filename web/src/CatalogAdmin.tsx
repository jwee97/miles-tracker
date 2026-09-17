import { useState } from 'react';
import {
  addDraftRule,
  addProductSource,
  checkProductSource,
  deleteDraftRule,
  draftRuleSet,
  fetchRuleSetDiff,
  money,
  publishRuleSet,
  type CatalogDetail,
  type CatalogRuleSet,
  type RuleSetDiff,
} from './api';

/**
 * Changing what a card is believed to pay.
 *
 * The shape of this panel is the safety property. A draft can be edited freely
 * because nothing can reach it; publishing is one button and it is behind the
 * comparison, because the only moment anyone is in a position to say "yes, the
 * bank really did cut this to 1.2 mpd" is after reading what would change.
 */
export default function CatalogAdmin({ d, onChange }: { d: CatalogDetail; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [diff, setDiff] = useState<RuleSetDiff | null>(null);
  const [from, setFrom] = useState('');
  const [rule, setRule] = useState({ category: '', mpd: '', reward_type: 'miles', cap: '', mcc_include: '' });
  const [src, setSrc] = useState({ source_type: 'bank_rewards_terms', source_url: '', title: '', text: '' });
  const [checkText, setCheckText] = useState('');

  const draft = d.versions.find((v) => v.status === 'draft') ?? null;

  async function run(what: () => Promise<string | void>) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const said = await what();
      if (said) setMsg(said);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin">
      <h4>Change what this card pays</h4>
      {err && <p className="err-text">{err}</p>}
      {msg && <p className="ok-text">{msg}</p>}

      {!draft ? (
        <div className="advisor-row">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <button
            disabled={busy || !from}
            onClick={() =>
              run(async () => {
                const r = await draftRuleSet(d.product.id, { effective_from: from });
                return r.copied_rules
                  ? `Version ${r.draft.version} drafted, copying ${r.copied_rules} rule${r.copied_rules === 1 ? '' : 's'} from what is live.`
                  : `Version ${r.draft.version} drafted. There was nothing live to copy.`;
              })
            }
          >
            Start a new version
          </button>
          <span className="sub">from this date</span>
        </div>
      ) : (
        <DraftEditor
          draft={draft}
          busy={busy}
          rule={rule}
          setRule={setRule}
          onAdd={() =>
            run(async () => {
              await addDraftRule(draft.id, {
                category: rule.category.trim().toLowerCase(),
                mpd: Number(rule.mpd),
                reward_type: rule.reward_type,
                cap_cents: rule.cap ? Math.round(Number(rule.cap) * 100) : null,
                mcc_include: rule.mcc_include.trim() || null,
              });
              setRule({ ...rule, category: '', mpd: '', cap: '', mcc_include: '' });
              setDiff(null);
            })
          }
          onRemove={(id) =>
            run(async () => {
              await deleteDraftRule(draft.id, id);
              setDiff(null);
            })
          }
          onCompare={() =>
            run(async () => {
              setDiff(await fetchRuleSetDiff(draft.id));
            })
          }
          onPublish={() =>
            run(async () => {
              const r = await publishRuleSet(draft.id);
              if (r.error) throw new Error(r.error);
              setDiff(null);
              return `Version ${draft.version} is live from ${draft.effective_from}.`;
            })
          }
          diff={diff}
        />
      )}

      <h4>Where its numbers come from</h4>
      <div className="entry-grid">
        <label className="f">
          <span>Kind</span>
          <select value={src.source_type} onChange={(e) => setSrc({ ...src, source_type: e.target.value })}>
            <option value="bank_terms">Bank terms</option>
            <option value="bank_rewards_terms">Rewards terms</option>
            <option value="bank_product_page">Product page</option>
            <option value="bank_faq">FAQ</option>
            <option value="manual_verified">Checked by hand</option>
          </select>
        </label>
        <label className="f f-note">
          <span>Address</span>
          <input value={src.source_url} onChange={(e) => setSrc({ ...src, source_url: e.target.value })} placeholder="https://…" />
        </label>
        <label className="f f-note">
          <span>Title</span>
          <input value={src.title} onChange={(e) => setSrc({ ...src, title: e.target.value })} placeholder="Rewards terms, Sep 2026" />
        </label>
      </div>
      <textarea
        rows={3}
        value={src.text}
        onChange={(e) => setSrc({ ...src, text: e.target.value })}
        placeholder="Paste the page text, so a later change can be detected"
      />
      <div className="entry-foot">
        <button
          className="secondary"
          disabled={busy || !src.source_url.trim()}
          onClick={() =>
            run(async () => {
              await addProductSource(d.product.id, {
                source_type: src.source_type,
                source_url: src.source_url.trim(),
                title: src.title.trim() || undefined,
                text: src.text.trim() || undefined,
              });
              setSrc({ ...src, source_url: '', title: '', text: '' });
              return 'Source recorded.';
            })
          }
        >
          Record the source
        </button>
      </div>

      {d.sources.length > 0 && (
        <details className="batches">
          <summary>Has a source changed?</summary>
          <p className="sub">
            Paste the page as it reads today. A change marks this card for review and leaves the published rules exactly
            as they are — a page moving is not an approval.
          </p>
          <textarea rows={3} value={checkText} onChange={(e) => setCheckText(e.target.value)} placeholder="Paste the page text" />
          <div className="entry-foot rule-actions">
            {d.sources.map((s) => (
              <button
                key={s.id}
                className="secondary"
                disabled={busy || !checkText.trim()}
                onClick={() =>
                  run(async () => {
                    const r = await checkProductSource(s.id, checkText);
                    return r.changed
                      ? 'That page has changed since it was read. This card is now marked for review.'
                      : 'No change since it was last read.';
                  })
                }
              >
                Check {s.title ?? s.source_type}
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function DraftEditor({
  draft,
  busy,
  rule,
  setRule,
  onAdd,
  onRemove,
  onCompare,
  onPublish,
  diff,
}: {
  draft: CatalogRuleSet;
  busy: boolean;
  rule: { category: string; mpd: string; reward_type: string; cap: string; mcc_include: string };
  setRule: (r: any) => void;
  onAdd: () => void;
  onRemove: (id: number) => void;
  onCompare: () => void;
  onPublish: () => void;
  diff: RuleSetDiff | null;
}) {
  return (
    <>
      <p className="sub">
        Version {draft.version} is a draft from {draft.effective_from}. Nothing can reach it until it is published, so
        it can be built up a rule at a time.
      </p>

      <ul className="rules draft-rules">
        {draft.rules.map((r) => (
          <li key={r.id}>
            <span>
              <strong>{r.category}</strong> — {r.reward_type === 'cashback' ? `${r.mpd}%` : `${r.mpd} mpd`}
              {r.cap_cents ? `, capped at $${money(r.cap_cents)}` : ''}
              {r.mcc_include ? ` · codes ${r.mcc_include}` : ''}
            </span>
            <div className="entry-foot rule-actions">
              <button className="danger" disabled={busy} onClick={() => onRemove(r.id)}>
                Remove
              </button>
            </div>
          </li>
        ))}
        {!draft.rules.length && <li className="unknown">No rules in this draft yet.</li>}
      </ul>

      <div className="entry-grid">
        <label className="f">
          <span>Category</span>
          <input value={rule.category} onChange={(e) => setRule({ ...rule, category: e.target.value })} placeholder="online" />
        </label>
        <label className="f">
          <span>Rate</span>
          <input value={rule.mpd} onChange={(e) => setRule({ ...rule, mpd: e.target.value })} inputMode="decimal" placeholder="4" />
        </label>
        <label className="f">
          <span>Pays</span>
          <select value={rule.reward_type} onChange={(e) => setRule({ ...rule, reward_type: e.target.value })}>
            <option value="miles">miles per dollar</option>
            <option value="cashback">percent back</option>
          </select>
        </label>
        <label className="f">
          <span>Cap</span>
          <input value={rule.cap} onChange={(e) => setRule({ ...rule, cap: e.target.value })} inputMode="decimal" placeholder="1000" />
        </label>
        <label className="f f-note">
          <span>Only these codes</span>
          <input
            value={rule.mcc_include}
            onChange={(e) => setRule({ ...rule, mcc_include: e.target.value })}
            placeholder="5262,5964,5969"
          />
        </label>
      </div>
      <div className="entry-foot rule-actions">
        <button className="secondary" disabled={busy || !rule.category.trim() || !rule.mpd} onClick={onAdd}>
          Add to the draft
        </button>
        <button className="secondary" disabled={busy} onClick={onCompare}>
          Compare with what is live
        </button>
      </div>

      {diff && (
        <div className="diff">
          <p className="sub">
            {diff.from ? `Version ${diff.from.version} → ${diff.to.version}` : `First version`}
          </p>
          {diff.identical ? (
            <p className="sub">Nothing about what this card pays would change.</p>
          ) : (
            <ul className="diff-list">
              {[...diff.rules, ...diff.exclusions].map((c, i) => (
                <li key={i} className={c.kind}>
                  {c.summary}
                </li>
              ))}
            </ul>
          )}
          <div className="entry-foot rule-actions">
            <button disabled={busy} onClick={onPublish}>
              Publish version {diff.to.version}
            </button>
            <span className="sub">This is the moment the numbers change for every card on this product.</span>
          </div>
        </div>
      )}
    </>
  );
}
