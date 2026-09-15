import { useEffect, useState } from 'react';
import { deleteRoute, fetchRoutes, money, saveRoute, type ProgramRow, type RouteRow } from './api';

/**
 * The transfer routes the planner uses, editable here rather than only through
 * the bot.
 *
 * Every rate is a claim about a bank's current terms, and those move — ratios
 * change, fees appear, promotional bonuses end. So a route carries the date it
 * was last checked, an unchecked one says so, and marking one verified is a
 * single button rather than a form.
 */
export default function Routes({ programs }: { programs: ProgramRow[] }) {
  const [rows, setRows] = useState<RouteRow[] | null>(null);
  const [meta, setMeta] = useState<{ today: string; recheck_days: number }>({ today: '', recheck_days: 90 });
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    from_program: '',
    to_program: '',
    from_units: '',
    to_units: '',
    fee_cents: '',
    min_block: '',
    block_increment: '',
    route: 'direct',
    bonus_pct: '',
    bonus_until: '',
    source_url: '',
    note: '',
    verified: true,
  });

  function load() {
    fetchRoutes()
      .then((d) => {
        setRows(d.routes);
        setMeta({ today: d.today, recheck_days: d.recheck_days });
      })
      .catch((e) => setErr((e as Error).message));
  }
  useEffect(load, []);

  const stale = (r: RouteRow) => {
    if (!r.verified_at) return true;
    const days = (Date.parse(meta.today) - Date.parse(r.verified_at)) / 86_400_000;
    return days > meta.recheck_days;
  };

  async function add() {
    setErr(null);
    try {
      await saveRoute({ ...f, from_units: Number(f.from_units), to_units: Number(f.to_units) });
      setF({ ...f, from_units: '', to_units: '', fee_cents: '', bonus_pct: '', note: '' });
      setOpen(false);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!rows) return err ? <p className="pad error">{err}</p> : <p className="pad sub">Loading…</p>;

  return (
    <section className="card">
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>Transfer routes</h2>
        <button className="secondary" onClick={() => setOpen((v) => !v)}>
          {open ? 'Cancel' : 'Add a route'}
        </button>
      </div>
      <p className="sub">
        What the planner converts with. A rate older than {meta.recheck_days} days, or never checked, is flagged — banks
        change ratios and fees without much warning.
      </p>

      {open && (
        <div className="addrule">
          <div className="entry-grid">
            <label className="f">
              <span>From</span>
              <select value={f.from_program} onChange={(e) => setF({ ...f, from_program: e.target.value })}>
                <option value="">choose</option>
                {programs.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="f">
              <span>To</span>
              <select value={f.to_program} onChange={(e) => setF({ ...f, to_program: e.target.value })}>
                <option value="">choose</option>
                {programs.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="f">
              <span>Give</span>
              <input value={f.from_units} onChange={(e) => setF({ ...f, from_units: e.target.value })} placeholder="25000" inputMode="numeric" />
            </label>
            <label className="f">
              <span>Get</span>
              <input value={f.to_units} onChange={(e) => setF({ ...f, to_units: e.target.value })} placeholder="10000" inputMode="numeric" />
            </label>
            <label className="f">
              <span>Fee</span>
              <input value={f.fee_cents} onChange={(e) => setF({ ...f, fee_cents: e.target.value })} placeholder="27.25" inputMode="decimal" />
            </label>
            <label className="f">
              <span>Route</span>
              <input value={f.route} onChange={(e) => setF({ ...f, route: e.target.value })} placeholder="direct" />
            </label>
            <label className="f">
              <span>Smallest block</span>
              <input value={f.min_block} onChange={(e) => setF({ ...f, min_block: e.target.value })} placeholder="25000" inputMode="numeric" />
            </label>
            <label className="f">
              <span>Then in steps of</span>
              <input
                value={f.block_increment}
                onChange={(e) => setF({ ...f, block_increment: e.target.value })}
                placeholder="25000"
                inputMode="numeric"
              />
            </label>
            <label className="f">
              <span>Bonus %</span>
              <input value={f.bonus_pct} onChange={(e) => setF({ ...f, bonus_pct: e.target.value })} placeholder="0" inputMode="decimal" />
            </label>
            <label className="f">
              <span>Bonus ends</span>
              <input type="date" value={f.bonus_until} onChange={(e) => setF({ ...f, bonus_until: e.target.value })} />
            </label>
            <label className="f f-note">
              <span>Where you read it</span>
              <input value={f.source_url} onChange={(e) => setF({ ...f, source_url: e.target.value })} placeholder="https://…" />
            </label>
          </div>
          <div className="entry-foot">
            <button className="secondary" onClick={add} disabled={!f.from_program || !f.to_program || !f.from_units || !f.to_units}>
              Add the route
            </button>
            {err && <span className="err-text">{err}</span>}
          </div>
          <p className="sub">
            Blocks matter: a route that only moves 25,000 at a time turns "I have 30,000" into one transfer and 5,000
            stranded.
          </p>
        </div>
      )}

      <ul className="rules">
        {rows.map((r) => (
          <li key={r.id} className={stale(r) ? 'unknown' : 'pass'}>
            <span>
              <strong>
                {r.from_name} → {r.to_name}
              </strong>{' '}
              {r.from_units.toLocaleString()} : {r.to_units.toLocaleString()}
              {r.route && r.route !== 'direct' ? ` via ${r.route}` : ''}
              {r.fee_cents ? ` · $${money(r.fee_cents)} fee` : ' · no fee'}
              {r.bonus_pct ? ` · +${r.bonus_pct}%${r.bonus_until ? ` until ${r.bonus_until}` : ''}` : ''}
            </span>
            <p className="sub">
              {r.verified_at ? `checked ${r.verified_at}` : 'never checked — treat the ratio as a guess'}
              {r.min_block ? ` · blocks of ${r.min_block.toLocaleString()}` : ''}
              {r.note ? ` · ${r.note}` : ''}
            </p>
            <div className="entry-foot rule-actions">
              <button
                onClick={async () => {
                  await saveRoute({ id: r.id, verified: true });
                  load();
                }}
              >
                Checked today
              </button>
              <button
                className="danger"
                onClick={async () => {
                  await deleteRoute(r.id);
                  load();
                }}
              >
                Remove
              </button>
              {r.source_url && (
                <a className="link" href={r.source_url} target="_blank" rel="noreferrer">
                  Source
                </a>
              )}
            </div>
          </li>
        ))}
        {!rows.length && <li className="unknown">No routes. Send /seed to the bot, or add one above.</li>}
      </ul>
    </section>
  );
}
