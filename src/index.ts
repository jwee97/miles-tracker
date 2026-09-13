import { safeEqual, verifyToken } from './auth';
import { buildDigest, checkAlerts } from './digest';
import { evaluateOffer } from './eligibility';
import { handleUpdate, pushFeedMatches, send } from './telegram';
import {
  activeCards,
  addMonths,
  EFFECTIVE_DATE,
  parseDateToken,
  parseMoney,
  requirementProgress,
  requirementsFor,
  today,
  utilization,
} from './spend';
import { balances, categoryForMerchant, planRoutes, rankCards, ratesReview, rememberMerchant } from './points';
import { buildAnalytics } from './analytics';
import { EDITABLE, readSettings, readUsage, withSettings, writeSetting } from './settings';
import { evaluate, lookupMerchant, recommend, type Channel, type Objective } from './rules';
import { buildAudit } from './audit';
import { optimise } from './advice';
import { executeTransfer, tranchesByExpiry } from './points';
import type { Env, Offer } from './types';

// The dashboard is served from this same Worker, so there is no cross-origin
// request to permit and no CORS headers to set.
/** Must match the first entry in wrangler.toml's `crons`. */
const MORNING_SCAN_CRON = '0 22 * * *';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export default {
  async fetch(req: Request, rawEnv: Env): Promise<Response> {
    const url = new URL(req.url);
    // Stored settings overlay the deployed config, so everything downstream
    // reads resolved values without knowing they are overridable.
    const env = await withSettings(rawEnv);

    // --- Telegram webhook -------------------------------------------------
    // Telegram echoes the secret we registered with setWebhook; anything else
    // hitting this path is not Telegram.
    if (url.pathname === '/tg' && req.method === 'POST') {
      const given = req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
      if (!safeEqual(given, env.TELEGRAM_SECRET)) return new Response('forbidden', { status: 403 });
      const update = await req.json();
      // Always 200 quickly — Telegram retries on non-2xx and will duplicate work.
      try {
        await handleUpdate(env, update, url.origin);
      } catch (err) {
        console.error('update failed', err);
      }
      return new Response('ok');
    }

    // --- JSON API for the PWA and the iOS Shortcut -------------------------
    if (url.pathname.startsWith('/api/')) {
      const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '') || url.searchParams.get('t');
      if (!(await verifyToken(env.APP_SECRET, token))) return json({ error: 'unauthorized' }, 401);

      // Every handler below touches the database, and an unhandled throw here
      // surfaced as a bare 500 with no message — which made a schema that had
      // fallen behind the deployed code impossible to diagnose from the UI.
      try {

        if (url.pathname === '/api/summary') {
          const cards = await activeCards(env);
          const out = [];
          for (const card of cards) {
            const u = await utilization(env, card);
            const reqs = await requirementsFor(env, card.id);
            const progress = [];
            for (const r of reqs) {
              const p = await requirementProgress(env, card, r);
              progress.push({
                id: r.id,
                kind: r.kind,
                amount_cents: r.amount_cents,
                reward_note: r.reward_note,
                bonus_cap_cents: r.bonus_cap_cents,
                spent_cents: p.spent_cents,
                remaining_cents: p.remaining_cents,
                days_left: p.days_left,
                per_day_cents: p.per_day_cents,
                met: p.met,
                confirmed_cents: p.confirmed_cents,
                at_risk_cents: p.at_risk_cents,
                met_only_with_at_risk: p.met_only_with_at_risk,
                txn_count: p.txn_count,
                txns_required: p.txns_required,
                txns_remaining: p.txns_remaining,
                cap_reached: p.cap_reached,
                window: p.window,
              });
            }
            out.push({
              id: card.id,
              issuer: card.issuer,
              product: card.product,
              nickname: card.nickname,
              limit_cents: u.limit_cents,
              balance_cents: u.balance_cents,
              at_risk_cents: u.at_risk_cents,
              percent: u.percent,
              cycle: u.cycle,
              days_left: u.days_left,
              requirements: progress,
            });
          }
          const totalBal = out.reduce((s, c) => s + c.balance_cents, 0);
          const totalLimit = out.reduce((s, c) => s + c.limit_cents, 0);
          return json({
            today: today(env),
            cards: out,
            overall: {
              balance_cents: totalBal,
              limit_cents: totalLimit,
              percent: totalLimit ? (totalBal / totalLimit) * 100 : 0,
            },
          });
        }

        // The heart of it: merchant in, ranked cards out, with the reasoning.
        if (url.pathname === '/api/recommend') {
          const q = url.searchParams.get('merchant') ?? '';
          const amt = url.searchParams.get('amount');
          const cents = amt ? parseMoney(amt) : null;
          const objective = (url.searchParams.get('objective') ?? '') as Objective;
          const r = await recommend(
            env,
            {
              amount_cents: cents,
              mcc: url.searchParams.get('mcc'),
              category: url.searchParams.get('category'),
              channel: (url.searchParams.get('channel') as Channel) || null,
            },
            {
              merchantQuery: q || undefined,
              objective: ['miles', 'cashback', 'balanced', 'minspend'].includes(objective) ? objective : undefined,
            }
          );
          return json(r);
        }

        if (url.pathname === '/api/mcc') {
          const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (url.searchParams.get('merchant')) {
            return json(await lookupMerchant(env, url.searchParams.get('merchant')!));
          }
          const { results } = await env.DB.prepare(
            `SELECT code, description, category FROM mcc_codes
             WHERE ? = '' OR code LIKE ? OR LOWER(description) LIKE ? OR category LIKE ?
             ORDER BY code LIMIT 100`
          )
            .bind(q, `${q}%`, `%${q}%`, `%${q}%`)
            .all<any>();
          return json({ codes: results ?? [] });
        }

        // Confirming a code from a posted transaction beats any guess.
        if (url.pathname === '/api/mcc/merchant' && req.method === 'POST') {
          const b = (await req.json()) as { merchant?: string; mcc?: string; channel?: string; confirmed?: boolean };
          const m = String(b.merchant ?? '').trim().toLowerCase();
          const code = String(b.mcc ?? '').trim();
          if (!m || !/^\d{4}$/.test(code)) return json({ error: 'merchant and a four-digit mcc are required' }, 400);
          await env.DB.prepare(
            `INSERT INTO merchant_mcc (merchant, mcc, channel, source, confidence, updated_at)
             VALUES (?, ?, ?, 'user', ?, datetime('now'))
             ON CONFLICT(merchant) DO UPDATE SET mcc = excluded.mcc, channel = excluded.channel,
               source = 'user', confidence = excluded.confidence, updated_at = datetime('now')`
          )
            .bind(m, code, b.channel ?? null, b.confirmed === false ? 'guess' : 'confirmed')
            .run();
          return json({ ok: true, merchant: await lookupMerchant(env, m) });
        }

        if (url.pathname === '/api/exclusions') {
          const { results } = await env.DB.prepare(
            `SELECT e.*, c.description, c.category, cards.product FROM exclusions e
             LEFT JOIN mcc_codes c ON c.code = e.mcc
             LEFT JOIN cards ON cards.id = e.card_id
             WHERE e.active = 1 ORDER BY e.card_id IS NOT NULL, e.mcc`
          ).all<any>();
          return json({ exclusions: results ?? [] });
        }

        if (url.pathname === '/api/exclusions' && req.method === 'POST') {
          const b = (await req.json()) as { mcc?: string; card_id?: number | null; reason?: string; remove?: number };
          if (b.remove) {
            await env.DB.prepare(`UPDATE exclusions SET active = 0 WHERE id = ?`).bind(b.remove).run();
            return json({ ok: true });
          }
          const code = String(b.mcc ?? '').trim();
          if (!/^\d{4}$/.test(code)) return json({ error: 'a four-digit mcc is required' }, 400);
          await env.DB.prepare(`INSERT INTO exclusions (card_id, mcc, reason, source) VALUES (?, ?, ?, 'user')`)
            .bind(b.card_id ?? null, code, b.reason ?? null)
            .run();
          return json({ ok: true });
        }

        if (url.pathname === '/api/optimise') {
          const m = parseInt(url.searchParams.get('months') ?? '3', 10);
          return json(await optimise(env, Math.min(12, Math.max(1, m || 3))));
        }

        if (url.pathname === '/api/audit') {
          return json(
            await buildAudit(env, {
              cardId: url.searchParams.get('card_id') ? Number(url.searchParams.get('card_id')) : undefined,
              from: url.searchParams.get('from') ?? undefined,
              to: url.searchParams.get('to') ?? undefined,
            })
          );
        }

        // Recording what the bank actually credited.
        if (url.pathname === '/api/tx/credited' && req.method === 'POST') {
          const b = (await req.json()) as { id?: number; miles?: number | null; cashback?: string | null };
          const id = Number(b.id);
          if (!id) return json({ error: 'id is required' }, 400);
          const cash = b.cashback === null || b.cashback === undefined ? null : parseMoney(String(b.cashback));
          await env.DB.prepare(
            `UPDATE transactions SET actual_miles = ?, actual_cashback_cents = ? WHERE id = ?`
          )
            .bind(b.miles === null || b.miles === undefined ? null : Math.round(Number(b.miles)), cash, id)
            .run();
          return json({ ok: true });
        }

        if (url.pathname === '/api/settings' && req.method === 'GET') {
          return json({ settings: await readSettings(rawEnv), editable: EDITABLE.map((e) => e.key) });
        }

        if (url.pathname === '/api/settings' && req.method === 'POST') {
          const b = (await req.json()) as { key?: string; value?: string | null };
          const r = await writeSetting(env, String(b.key ?? ''), b.value ?? null);
          if (!r.ok) return json({ error: r.error }, 400);
          return json({ ok: true, settings: await readSettings(rawEnv) });
        }

        if (url.pathname === '/api/usage') {
          return json(await readUsage(env));
        }

        if (url.pathname === '/api/analytics') {
          return json(await buildAnalytics(env, url.searchParams.get('month') ?? undefined));
        }

        // Months that actually have data, so the picker offers only real options.
        if (url.pathname === '/api/months') {
          const { results } = await env.DB.prepare(
            `SELECT DISTINCT substr(${EFFECTIVE_DATE}, 1, 7) AS month FROM transactions
             WHERE amount_cents > 0 ORDER BY month DESC LIMIT 24`
          ).all<{ month: string }>();
          return json({ months: (results ?? []).map((r) => r.month) });
        }

        if (url.pathname === '/api/points') {
          const rows = await balances(env, 90);
          const { results: programs } = await env.DB.prepare(
            `SELECT key, name, kind, unit FROM programs ORDER BY kind, name`
          ).all<any>();
          const { results: tranches } = await env.DB.prepare(
            `SELECT t.id, t.program_key, t.points, t.expires_at, t.note, p.unit
             FROM balance_tranches t JOIN programs p ON p.key = t.program_key
             ORDER BY t.expires_at IS NULL, t.expires_at`
          ).all<any>();
          return json({ balances: rows, programs: programs ?? [], tranches: tranches ?? [] });
        }

        // Recording and correcting balances from the dashboard, rather than
        // only through the bot.
        if (url.pathname === '/api/tranche' && req.method === 'POST') {
          const b = (await req.json()) as {
            program_key?: string;
            points?: string | number;
            expires_at?: string;
            note?: string;
          };
          const key = String(b.program_key ?? '').trim();
          const prog = await env.DB.prepare(`SELECT key, expiry_months FROM programs WHERE key = ?`)
            .bind(key)
            .first<{ key: string; expiry_months: number | null }>();
          if (!prog) return json({ error: 'unknown programme' }, 400);

          const points = parseInt(String(b.points ?? '').replace(/[, ]/g, ''), 10);
          if (!Number.isFinite(points) || points === 0) return json({ error: 'bad points' }, 400);

          let expires: string | null = null;
          if (b.expires_at) {
            expires = parseDateToken(String(b.expires_at), env);
            if (!expires) return json({ error: 'bad expiry date' }, 400);
          } else if (prog.expiry_months) {
            // The programme's own rule as a starting point when none is given.
            expires = addMonths(today(env), prog.expiry_months);
          }

          const ins = await env.DB.prepare(
            `INSERT INTO balance_tranches (program_key, points, earned_at, expires_at, note) VALUES (?, ?, ?, ?, ?)`
          )
            .bind(key, points, today(env), expires, b.note?.trim() || null)
            .run();
          return json({ ok: true, id: ins.meta.last_row_id, expires_at: expires });
        }

        if (url.pathname === '/api/tranche/delete' && req.method === 'POST') {
          const { id } = (await req.json()) as { id?: number };
          if (!id) return json({ error: 'missing id' }, 400);
          const r = await env.DB.prepare(`DELETE FROM balance_tranches WHERE id = ?`).bind(id).run();
          return json({ ok: true, deleted: r.meta.changes ?? 0 });
        }

        if (url.pathname === '/api/program' && req.method === 'POST') {
          const b = (await req.json()) as { key?: string; name?: string; kind?: string; unit?: string };
          const key = String(b.key ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
          const name = String(b.name ?? '').trim();
          if (!key || !name) return json({ error: 'key and name are required' }, 400);
          const kind = b.kind === 'bank' ? 'bank' : 'airline';
          await env.DB.prepare(
            `INSERT OR IGNORE INTO programs (key, name, kind, unit) VALUES (?, ?, ?, ?)`
          )
            .bind(key, name, kind, String(b.unit ?? 'miles').trim() || 'miles')
            .run();
          return json({ ok: true, key });
        }

        // Executing a transfer, as opposed to planning one.
        if (url.pathname === '/api/transfer' && req.method === 'POST') {
          const b = (await req.json()) as { conversion_id?: number; points?: string | number; note?: string };
          const id = Number(b.conversion_id);
          const pts = parseInt(String(b.points ?? '').replace(/[, ]/g, ''), 10);
          if (!id || !Number.isFinite(pts)) return json({ error: 'conversion_id and points are required' }, 400);
          const r = await executeTransfer(env, id, pts, b.note);
          return json(r, r.ok ? 200 : 400);
        }

        if (url.pathname === '/api/transfers') {
          const { results } = await env.DB.prepare(
            `SELECT * FROM transfers ORDER BY executed_at DESC, id DESC LIMIT 30`
          ).all<any>();
          return json({ transfers: results ?? [] });
        }

        if (url.pathname === '/api/expiry') {
          return json({ tranches: await tranchesByExpiry(env) });
        }

        // Everything that still needs a category, split by whether the MCC is
        // knowable yet — a purchase that has not posted cannot be looked up.
        if (url.pathname === '/api/review') {
          const { results } = await env.DB.prepare(
            `SELECT t.id, t.amount_cents, t.occurred_at, t.posted_at, t.merchant, c.product, c.nickname
             FROM transactions t JOIN cards c ON c.id = t.card_id
             WHERE t.amount_cents > 0 AND t.category IS NULL
             ORDER BY t.posted_at IS NULL, ${EFFECTIVE_DATE.replace(/posted_at/g, 't.posted_at').replace(/occurred_at/g, 't.occurred_at')} DESC
             LIMIT 100`
          ).all<any>();
          const rows = results ?? [];
          return json({
            ready: rows.filter((r: any) => r.posted_at !== null),
            waiting: rows.filter((r: any) => r.posted_at === null),
          });
        }

        // Editing a transaction in place, for the spreadsheet view.
        if (url.pathname === '/api/tx/update' && req.method === 'POST') {
          const b = (await req.json()) as { id?: number; field?: string; value?: string | null };
          const id = Number(b.id);
          const field = String(b.field ?? '');
          if (!id || !field) return json({ error: 'id and field are required' }, 400);
          const raw = b.value === null ? null : String(b.value).trim();

          if (field === 'amount') {
            const cents = parseMoney(raw ?? '');
            if (cents === null) return json({ error: 'bad amount' }, 400);
            await env.DB.prepare(`UPDATE transactions SET amount_cents = ? WHERE id = ?`).bind(cents, id).run();
          } else if (field === 'occurred_at' || field === 'posted_at') {
            const d = raw ? parseDateToken(raw, env) : null;
            if (raw && !d) return json({ error: 'bad date' }, 400);
            if (d && d > today(env)) return json({ error: 'date is in the future' }, 400);
            if (field === 'posted_at' && d) {
              const row = await env.DB.prepare(`SELECT occurred_at FROM transactions WHERE id = ?`)
                .bind(id)
                .first<{ occurred_at: string }>();
              if (row && d < row.occurred_at) return json({ error: 'posted before it happened' }, 400);
            }
            await env.DB.prepare(`UPDATE transactions SET ${field} = ? WHERE id = ?`).bind(d, id).run();
          } else if (field === 'merchant') {
            await env.DB.prepare(`UPDATE transactions SET merchant = ? WHERE id = ?`).bind(raw || null, id).run();
          } else if (field === 'category') {
            const cat = raw && raw !== '?' ? raw.toLowerCase() : null;
            const row = await env.DB.prepare(`SELECT merchant FROM transactions WHERE id = ?`)
              .bind(id)
              .first<{ merchant: string | null }>();
            if (cat) await rememberMerchant(env, row?.merchant ?? null, cat);
            await env.DB.prepare(
              `UPDATE transactions SET category = ?, category_source = ?, needs_review = ? WHERE id = ?`
            )
              .bind(cat, cat ? 'manual' : null, cat ? 0 : 1, id)
              .run();
          } else if (field === 'card_id') {
            const card = await env.DB.prepare(`SELECT id FROM cards WHERE id = ?`).bind(Number(raw)).first();
            if (!card) return json({ error: 'unknown card' }, 400);
            await env.DB.prepare(`UPDATE transactions SET card_id = ? WHERE id = ?`).bind(Number(raw), id).run();
          } else {
            return json({ error: `field ${field} is not editable` }, 400);
          }

          const updated = await env.DB.prepare(
            `SELECT t.*, c.product, c.nickname FROM transactions t JOIN cards c ON c.id = t.card_id WHERE t.id = ?`
          )
            .bind(id)
            .first<any>();
          return json({ ok: true, transaction: updated });
        }

        if (url.pathname === '/api/convert') {
          const pts = parseInt((url.searchParams.get('points') ?? '').replace(/,/g, ''), 10);
          const from = url.searchParams.get('from') ?? '';
          const to = url.searchParams.get('to') ?? '';
          if (!pts || !from || !to) return json({ error: 'points, from and to are required' }, 400);
          return json({ plans: await planRoutes(env, pts, from, to) });
        }

        if (url.pathname === '/api/which') {
          const category = (url.searchParams.get('category') ?? '*').toLowerCase();
          const amt = url.searchParams.get('amount');
          const cents = amt ? parseMoney(amt) : null;
          const cards = await activeCards(env);

          const nudges: { cardId: number; remaining: number; daysLeft: number }[] = [];
          for (const c of cards) {
            for (const r of await requirementsFor(env, c.id)) {
              const p = await requirementProgress(env, c, r);
              if (!p.met) nudges.push({ cardId: c.id, remaining: p.remaining_cents, daysLeft: p.days_left });
            }
          }

          const picks = await rankCards(env, category, cents, { cards, minSpendNudge: nudges });
          return json({
            category,
            picks: picks.map((p) => ({
              card_id: p.card.id,
              product: p.card.product,
              nickname: p.card.nickname,
              effective_mpd: p.effective_mpd,
              base_mpd: p.base_mpd,
              reward_type: p.reward_type,
              headroom_cents: p.headroom_cents,
              miles: p.miles,
              cashback_cents: p.cashback_cents,
              value_cents: p.value_cents,
              reasons: p.reasons,
            })),
          });
        }

        // Categories the user actually has rules for, so the picker offers real options.
        if (url.pathname === '/api/categories') {
          const { results } = await env.DB.prepare(
            `SELECT DISTINCT category FROM earn_rules WHERE active = 1 AND category <> '*' ORDER BY category`
          ).all<{ category: string }>();
          return json({ categories: (results ?? []).map((r) => r.category) });
        }

        if (url.pathname === '/api/offers') {
          const { results } = await env.DB.prepare(
            `SELECT * FROM offers WHERE status IN ('tracked','applied') ORDER BY created_at DESC LIMIT 50`
          ).all<Offer>();
          const out = [];
          for (const o of results ?? []) out.push({ ...o, eligibility: await evaluateOffer(env, o.id) });
          return json({ offers: out });
        }

        // The dashboard's entry form and the iOS Shortcut both post here.
        // `date` is optional and defaults to today, so existing callers are unaffected.
        if (url.pathname === '/api/tx' && req.method === 'POST') {
          const body = (await req.json()) as {
            nickname?: string;
            amount?: string | number;
            note?: string;
            date?: string;
            posted?: string;
            category?: string;
          };
          const card = await env.DB.prepare(`SELECT * FROM cards WHERE nickname = ? COLLATE NOCASE`)
            .bind(String(body.nickname ?? '').trim())
            .first<any>();
          if (!card) return json({ error: 'unknown card nickname' }, 400);
          const cents = parseMoney(String(body.amount ?? ''));
          if (cents === null) return json({ error: 'bad amount' }, 400);

          const date = body.date ? parseDateToken(String(body.date), env) : today(env);
          if (!date) return json({ error: 'bad date' }, 400);
          if (date > today(env)) return json({ error: 'date is in the future' }, 400);

          // Optional: for an older purchase you may already know when it posted,
          // which is the date every window is actually judged on.
          let posted: string | null = null;
          if (body.posted) {
            posted = parseDateToken(String(body.posted), env);
            if (!posted) return json({ error: 'bad posted date' }, 400);
            if (posted < date) return json({ error: 'posted before it happened' }, 400);
            if (posted > today(env)) return json({ error: 'posted date is in the future' }, 400);
          }

          // Same merchant learning the bot uses, so the dashboard benefits too.
          const note = body.note?.trim() || null;
          let category = body.category?.trim().toLowerCase() || null;
          // '?' means "I don't know yet" — an explicit unknown, not a guess.
          if (category === '?' || category === 'unknown') category = null;
          let source: string | null = null;
          if (category) {
            source = 'manual';
            await rememberMerchant(env, note, category);
          } else {
            category = await categoryForMerchant(env, note);
            if (category) source = 'learned';
          }

          // Resolve the merchant code and record what the rules say this should
          // earn, so the audit later has a prediction to reconcile against.
          const guess = note ? await lookupMerchant(env, note) : null;
          const mcc = (body as any).mcc ?? guess?.mcc ?? null;
          const channel = ((body as any).channel as Channel) ?? guess?.channel ?? null;
          if (!category && guess?.category) {
            category = guess.category;
            source = 'learned';
          }
          const expected = await evaluate(env, card as any, {
            amount_cents: cents,
            mcc,
            category,
            channel,
          });

          const ins = await env.DB.prepare(
            `INSERT INTO transactions (card_id, amount_cents, occurred_at, posted_at, merchant, category,
               category_source, needs_review, mcc, channel, expected_miles, expected_cashback_cents, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`
          )
            .bind(
              card.id, cents, date, posted, note, category, source, category ? 0 : 1,
              mcc, channel, expected.miles, expected.cashback_cents
            )
            .run();

          const alerts = await checkAlerts(env, card);
          for (const a of alerts) await send(env, env.OWNER_CHAT_ID, a);
          return json({
            ok: true,
            id: ins.meta.last_row_id,
            card: card.product,
            date,
            posted_at: posted,
            category,
            category_source: source,
            needs_review: category ? 0 : 1,
            mcc,
            channel,
            expected_miles: expected.miles,
            expected_cashback_cents: expected.cashback_cents,
            trace: expected.trace,
            alerts: alerts.length,
          });
        }

        if (url.pathname === '/api/transactions' && req.method === 'GET') {
          const limit = Math.min(500, parseInt(url.searchParams.get('limit') ?? '25', 10) || 25);

          // Named ranges are resolved here rather than in the browser, so they
          // follow the app's configured timezone rather than the device's.
          const range = url.searchParams.get('range') ?? '';
          const day = (offset: number) =>
            new Date(Date.parse(today(env) + 'T00:00:00Z') + offset * 86400_000).toISOString().slice(0, 10);
          let from = url.searchParams.get('from') ?? null;
          let to = url.searchParams.get('to') ?? null;

          switch (range) {
            case 'today':
              from = to = today(env);
              break;
            case 'yesterday':
              from = to = day(-1);
              break;
            case '7d':
              from = day(-6);
              to = today(env);
              break;
            case '30d':
              from = day(-29);
              to = today(env);
              break;
            case 'month':
              from = today(env).slice(0, 8) + '01';
              to = today(env);
              break;
            case 'lastmonth': {
              const [y, m] = today(env).split('-').map(Number);
              const start = new Date(Date.UTC(y, m - 2, 1));
              const end = new Date(Date.UTC(y, m - 1, 0));
              from = start.toISOString().slice(0, 10);
              to = end.toISOString().slice(0, 10);
              break;
            }
            case 'ytd':
              from = `${today(env).slice(0, 4)}-01-01`;
              to = today(env);
              break;
            case 'all':
              from = to = null;
              break;
          }

          const where: string[] = [];
          const binds: unknown[] = [];
          if (from) {
            where.push(`${EFFECTIVE_DATE} >= ?`);
            binds.push(from);
          }
          if (to) {
            where.push(`${EFFECTIVE_DATE} <= ?`);
            binds.push(to);
          }
          const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

          // The ledger edits these in place, so every editable column has to
          // come back — category especially: without it every row reads as
          // uncategorised and the whole table highlights as needing review.
          const { results } = await env.DB.prepare(
            `SELECT t.id, t.card_id, t.amount_cents, t.occurred_at, t.posted_at, t.merchant,
                    t.category, t.category_source, t.needs_review, t.source,
                    t.mcc, t.channel, t.expected_miles, t.expected_cashback_cents,
                    t.actual_miles, t.actual_cashback_cents,
                    c.nickname, c.product
             FROM transactions t JOIN cards c ON c.id = t.card_id
             ${clause}
             ORDER BY COALESCE(t.posted_at, t.occurred_at) DESC, t.id DESC LIMIT ?`
          )
            .bind(...binds, limit)
            .all<any>();

          // A total, so the view can say whether you are seeing everything.
          const totals = await env.DB.prepare(
            `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END), 0) AS cents
             FROM transactions t ${clause}`
          )
            .bind(...binds)
            .first<{ n: number; cents: number }>();

          return json({
            transactions: results ?? [],
            range: { from, to, label: range || 'custom' },
            total_count: totals?.n ?? 0,
            total_cents: totals?.cents ?? 0,
          });
        }

        if (url.pathname === '/api/tx/posted' && req.method === 'POST') {
          const { id, date } = (await req.json()) as { id?: number; date?: string };
          if (!id) return json({ error: 'missing id' }, 400);
          const when = date ? parseDateToken(String(date), env) : today(env);
          if (!when) return json({ error: 'bad date' }, 400);
          const row = await env.DB.prepare(`SELECT occurred_at FROM transactions WHERE id = ?`)
            .bind(id)
            .first<{ occurred_at: string }>();
          if (!row) return json({ error: 'not found' }, 404);
          if (when < row.occurred_at) return json({ error: 'posted before it happened' }, 400);
          await env.DB.prepare(`UPDATE transactions SET posted_at = ? WHERE id = ?`).bind(when, id).run();
          return json({ ok: true, posted_at: when });
        }

        if (url.pathname === '/api/tx/delete' && req.method === 'POST') {
          const { id } = (await req.json()) as { id?: number };
          if (!id) return json({ error: 'missing id' }, 400);
          const r = await env.DB.prepare(`DELETE FROM transactions WHERE id = ?`).bind(id).run();
          return json({ ok: true, deleted: r.meta.changes ?? 0 });
        }

        return json({ error: 'not found' }, 404);
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        // This deployment applies its own migrations, so the commonest failure
        // is a database behind the code. Say so instead of a generic error.
        if (/no such (table|column)/i.test(message)) {
          return json(
            {
              error: `The database is behind the deployed code (${message}). Send /migrate to the bot, then try again.`,
              needs_migration: true,
            },
            500
          );
        }
        console.error('api error', url.pathname, message);
        return json({ error: message }, 500);
      }
    }

    if (url.pathname === '/health') return new Response('ok');

    // Anything else is a static asset or the SPA fallback, handled by the
    // assets binding before this script ever runs.
    return new Response('not found', { status: 404 });
  },

  async scheduled(event: ScheduledController, rawEnv: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const env = await withSettings(rawEnv);
        // Two crons share one handler; event.cron says which fired.
        if (event.cron === MORNING_SCAN_CRON) {
          // 06:00 local: new promos, then anything that changed about the
          // transfer routes. The review is quiet — it stays silent unless
          // something is urgent or genuinely new, so a daily job does not
          // become noise you stop reading.
          await pushFeedMatches(env, env.OWNER_CHAT_ID);
          const review = await ratesReview(env, { quiet: true });
          if (review) await send(env, env.OWNER_CHAT_ID, review);
        } else {
          await send(env, env.OWNER_CHAT_ID, await buildDigest(env));
          for (const alert of await checkAlerts(env)) await send(env, env.OWNER_CHAT_ID, alert);
        }
      })()
    );
  },
};
