import { useEffect, useState } from 'react';
import {
  fetchGoals,
  fetchProgrammes,
  money,
  optimiseTransfer,
  saveRewardGoal,
  setGoalStatus,
  type GoalProgress,
  type Programme,
  type TransferPlanResult,
} from '../../api';

/**
 * What to do with the points you have.
 *
 * The plan is discrete, and the screen says so: blocks, what gets stranded, the
 * fee over the miles it buys, and which points were moved because they were
 * about to lapse. A plan that reads as one ratio would hide every one of those.
 *
 * Nothing here transfers anything. The app writes the instruction; a person
 * carries it out at the bank.
 */

const OBJECTIVES: [string, string][] = [
  ['maximize_destination_units', 'See the most miles available'],
  ['reach_target', 'Reach a target'],
  ['minimize_expiry_loss', 'Use points before they expire'],
  ['minimize_fees', 'Pay the least in fees'],
];

function Plan({ p }: { p: TransferPlanResult }) {
  return (
    <div className="plan">
      <div className="plan-headline">
        <span className="mono plan-total">
          {p.resulting_units.toLocaleString()} {p.destination.unit}
        </span>
        {p.total_fees_cents > 0 && <span className="sub">for ${money(p.total_fees_cents)} in fees</span>}
      </div>
      {p.target_units !== null && (
        <p className={p.shortfall_units > 0 ? 'err-text' : 'ok-text'}>
          {p.shortfall_units > 0
            ? `${p.shortfall_units.toLocaleString()} short of ${p.target_units.toLocaleString()}`
            : `Target of ${p.target_units.toLocaleString()} met`}
        </p>
      )}

      {p.routes.length === 0 ? (
        <p className="sub">Nothing can be transferred right now.</p>
      ) : (
        <ol className="plan-routes">
          {p.routes.map((r) => (
            <li key={r.from_program}>
              <p className="plan-move">
                Transfer <b className="mono">{r.source_units.toLocaleString()}</b> {r.from_name}
                {r.route && r.route !== 'direct' ? ` via ${r.route}` : ''} → <b className="mono">{r.destination_units.toLocaleString()}</b>{' '}
                {p.destination.unit}
              </p>
              <p className="sub">{r.reason}</p>
              {r.promotion && (
                <p className="ok-text">
                  {r.promotion.title ?? `${r.promotion.bonus_pct}% bonus`} — ends {r.promotion.ends}
                  {r.promotion.registration_required && <span className="chip soon">registration required</span>}
                </p>
              )}
              {r.processing_days.max && <p className="sub">Takes up to {r.processing_days.max} days.</p>}
            </li>
          ))}
        </ol>
      )}

      {p.expiring_points_saved > 0 && (
        <p className="ok-text">{p.expiring_points_saved.toLocaleString()} points that would have expired are used.</p>
      )}
      {p.warnings.map((w, i) => (
        <p key={i} className="warn-num">
          {w}
        </p>
      ))}
      <ul className="sub plan-assumptions">
        {p.assumptions.map((a, i) => (
          <li key={i}>{a}</li>
        ))}
      </ul>
    </div>
  );
}

function Goals({ goals, onChange, programmes }: { goals: GoalProgress[]; onChange: () => void; programmes: Programme[] }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ program_key: '', target_units: '', target_date: '', description: '' });
  const [err, setErr] = useState<string | null>(null);

  return (
    <section className="card">
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>What the points are for</h2>
        <button className="secondary" onClick={() => setOpen((v) => !v)}>
          {open ? 'Cancel' : 'Add a goal'}
        </button>
      </div>
      <p className="sub">
        A target changes the answer: the cheapest way to move points is not the cheapest way to reach 85,000 of them.
      </p>
      {err && <p className="err-text">{err}</p>}

      {open && (
        <div className="addrule">
          <div className="entry-grid">
            <label className="f">
              <span>Programme</span>
              <select value={f.program_key} onChange={(e) => setF({ ...f, program_key: e.target.value })}>
                <option value="">choose</option>
                {programmes.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="f">
              <span>Target</span>
              <input value={f.target_units} onChange={(e) => setF({ ...f, target_units: e.target.value })} inputMode="numeric" placeholder="85000" />
            </label>
            <label className="f">
              <span>By</span>
              <input type="date" value={f.target_date} onChange={(e) => setF({ ...f, target_date: e.target.value })} />
            </label>
            <label className="f f-note">
              <span>What for</span>
              <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Japan business class" />
            </label>
          </div>
          <div className="entry-foot">
            <button
              className="secondary"
              disabled={!f.program_key || !f.target_units}
              onClick={async () => {
                try {
                  await saveRewardGoal({
                    program_key: f.program_key,
                    target_units: parseInt(f.target_units, 10),
                    target_date: f.target_date || undefined,
                    description: f.description || undefined,
                  });
                  setF({ program_key: '', target_units: '', target_date: '', description: '' });
                  setOpen(false);
                  onChange();
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              Save the goal
            </button>
          </div>
        </div>
      )}

      <ul className="rules">
        {goals.map((g) => (
          <li key={g.goal.id} className={g.at_risk ? 'unknown' : 'pass'}>
            <span>
              <strong>
                {g.goal.target_units.toLocaleString()} {g.unit} — {g.program_name}
              </strong>
              {g.goal.description && <span className="sub"> {g.goal.description}</span>}
            </span>
            <p className="sub">
              {g.held_units.toLocaleString()} held
              {g.convertible_units > 0 && ` · ${g.convertible_units.toLocaleString()} could be transferred in`}
              {g.shortfall_units > 0
                ? ` · ${g.shortfall_units.toLocaleString()} short`
                : ' · reachable today'}
              {g.days_left !== null && ` · ${g.days_left} days left`}
            </p>
            <div className="entry-foot rule-actions">
              <button
                className="secondary"
                onClick={async () => {
                  await setGoalStatus(g.goal.id, 'abandoned');
                  onChange();
                }}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
        {!goals.length && <li className="unknown">No goals yet.</li>}
      </ul>
    </section>
  );
}

export default function TransferPlanner() {
  const [programmes, setProgrammes] = useState<Programme[]>([]);
  const [goals, setGoals] = useState<GoalProgress[]>([]);
  const [destination, setDestination] = useState('');
  const [objective, setObjective] = useState('maximize_destination_units');
  const [target, setTarget] = useState('');
  const [by, setBy] = useState('');
  const [plan, setPlan] = useState<TransferPlanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function load() {
    fetchProgrammes()
      .then((d) => {
        setProgrammes(d.programmes ?? []);
        setDestination((k) => k || (d.programmes ?? []).find((p) => p.kind === 'airline')?.key || '');
      })
      .catch((e) => setErr((e as Error).message));
    fetchGoals()
      .then((d) => setGoals(d.goals ?? []))
      .catch(() => void 0);
  }
  useEffect(load, []);

  return (
    <>
      <section className="card">
        <h2>Plan a transfer</h2>
        <p className="sub">
          Points move in whole blocks, the fee is charged once per transfer, and a bonus may or may not apply — so the
          best headline ratio is often the worse deal. The plan works that out; you carry it out at the bank.
        </p>
        {err && <p className="err-text">{err}</p>}

        <div className="entry-grid">
          <label className="f">
            <span>Into</span>
            <select value={destination} onChange={(e) => setDestination(e.target.value)}>
              {programmes.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {objective === 'reach_target' && (
            <>
              <label className="f">
                <span>Target</span>
                <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="numeric" placeholder="85000" />
              </label>
              <label className="f">
                <span>By</span>
                <input type="date" value={by} onChange={(e) => setBy(e.target.value)} />
              </label>
            </>
          )}
        </div>

        <div className="seg wrap" role="group" aria-label="What to optimise for">
          {OBJECTIVES.map(([k, label]) => (
            <button key={k} type="button" className={objective === k ? 'on' : ''} onClick={() => setObjective(k)}>
              {label}
            </button>
          ))}
        </div>

        <div className="entry-foot">
          <button
            disabled={busy || !destination}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                setPlan(
                  await optimiseTransfer({
                    destination,
                    objective,
                    target_units: objective === 'reach_target' && target ? parseInt(target, 10) : null,
                    target_date: by || null,
                  })
                );
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Working it out…' : 'Plan a transfer'}
          </button>
        </div>

        {plan && <Plan p={plan} />}
      </section>

      <Goals goals={goals} programmes={programmes} onChange={load} />
    </>
  );
}
