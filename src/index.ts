import { safeEqual, verifyToken } from './auth';
import { buildDigest, checkAlerts } from './digest';
import { decideRule, evaluateOffer } from './eligibility';
import { extractionPrompt } from './extraction';
import { daysUntil, OFFER_STATUSES, offerRetentionDays, parseExtraction, saveExtraction, sweepExpiredOffers, type OfferStatus } from './offers';
import { canonicalUrl } from './rss';
import { handleUpdate, pushFeedItem, pushFeedMatches, send } from './telegram';
import { feedStorage, ignoreFeedItem, purgeFeedItems, retentionDays, scanFeedsDetailed, scanUrl, trackFeedItem } from './rss';
import {
  activeCards,
  addMonths,
  EFFECTIVE_DATE,
  resolveRange,
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
import { mccMatrix } from './mcc';
import { acceptCredits, pendingCredits, programForCard, undoCredit, wallet } from './wallet';
import { executeTransfer, tranchesByExpiry } from './points';
import type { Env, Offer } from './types';

// The dashboard is served from this same Worker, so there is no cross-origin
// request to permit and no CORS headers to set.
/** Must match the scan entries in wrangler.toml's `crons`. Anything not listed
 *  here runs the spend digest instead. */
const SCAN_CRONS = ['0 22 * * *', '0 6 * * *'];

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
                excluded_cents: p.excluded_cents,
                excluded_count: p.excluded_count,
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

        // The merchant-code table seen from your own cards: which codes earn
        // nothing, which earn a bonus, and which you actually spend on.
        if (url.pathname === '/api/mcc/matrix') {
          return json(
            await mccMatrix(env, {
              q: url.searchParams.get('q') ?? undefined,
              filter: url.searchParams.get('filter') ?? undefined,
              category: url.searchParams.get('category') ?? undefined,
              page: parseInt(url.searchParams.get('page') ?? '1', 10) || 1,
              per_page: parseInt(url.searchParams.get('per_page') ?? '50', 10) || 50,
              carriers: url.searchParams.get('carriers') === '1',
            })
          );
        }

        // Adding and removing exclusions from the app, not only the bot.
        if (url.pathname === '/api/exclusion' && req.method === 'POST') {
          const b = (await req.json()) as { mcc?: string; nickname?: string | null; reason?: string; active?: boolean };
          const code = String(b.mcc ?? '').trim();
          if (!/^\d{4}$/.test(code)) return json({ error: 'a four-digit mcc is required' }, 400);

          let cardId: number | null = null;
          if (b.nickname) {
            const card = await env.DB.prepare(`SELECT id FROM cards WHERE nickname = ? COLLATE NOCASE`)
              .bind(b.nickname.trim())
              .first<{ id: number }>();
            if (!card) return json({ error: 'no such card' }, 404);
            cardId = card.id;
          }

          if (b.active === false) {
            // `active = 1` in the filter so removing the same one twice is
            // reported as "nothing to remove" rather than a silent success.
            const res = await env.DB.prepare(
              `UPDATE exclusions SET active = 0
                WHERE mcc = ? AND active = 1 AND ((card_id IS NULL AND ? IS NULL) OR card_id = ?)`
            )
              .bind(code, cardId, cardId)
              .run();
            if ((res.meta.changes ?? 0) === 0) return json({ error: 'no such exclusion' }, 404);
            return json({ ok: true, removed: res.meta.changes });
          }

          await env.DB.prepare(
            `INSERT INTO exclusions (card_id, mcc, reason, source, active) VALUES (?, ?, ?, 'user', 1)`
          )
            .bind(cardId, code, b.reason?.trim() || 'excluded')
            .run();
          return json({ ok: true });
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

        // --- the points wallet ---------------------------------------------
        if (url.pathname === '/api/wallet') {
          return json(await wallet(env));
        }

        if (url.pathname === '/api/credits') {
          return json(await pendingCredits(env));
        }

        // Nothing reaches the wallet without this call: a bank can credit
        // something other than what the rules predicted, so the prediction
        // waits to be confirmed.
        if (url.pathname === '/api/credits/accept' && req.method === 'POST') {
          const body = (await req.json()) as { ids?: number[]; program_key?: string };
          let ids = (body.ids ?? []).filter((n) => Number.isInteger(n));

          if (!ids.length && body.program_key) {
            const pending = await pendingCredits(env);
            ids = pending.credits.filter((c) => c.program_key === body.program_key).map((c) => c.id);
          }
          if (!ids.length) return json({ error: 'ids or program_key required' }, 400);
          if (ids.length > 500) return json({ error: 'at most 500 at a time' }, 400);

          const res = await acceptCredits(env, ids);
          return json({ ...res, wallet: await wallet(env) });
        }

        if (url.pathname === '/api/credits/undo' && req.method === 'POST') {
          const { id } = (await req.json()) as { id?: number };
          if (!id) return json({ error: 'id required' }, 400);
          if (!(await undoCredit(env, id))) return json({ error: 'not credited' }, 404);
          return json({ ok: true, wallet: await wallet(env) });
        }

        // Which programme a card earns into. Without it the engine knows what
        // a purchase earns but not where it goes.
        if (url.pathname === '/api/card/program' && req.method === 'POST') {
          const { nickname, program_key } = (await req.json()) as { nickname?: string; program_key?: string | null };
          const card = await env.DB.prepare(`SELECT id FROM cards WHERE nickname = ? COLLATE NOCASE`)
            .bind(String(nickname ?? '').trim())
            .first<{ id: number }>();
          if (!card) return json({ error: 'no such card' }, 404);
          if (program_key) {
            const prog = await env.DB.prepare(`SELECT key FROM programs WHERE key = ?`).bind(program_key).first();
            if (!prog) return json({ error: 'unknown programme' }, 400);
          }
          await env.DB.prepare(`UPDATE cards SET program_key = ? WHERE id = ?`)
            .bind(program_key || null, card.id)
            .run();
          return json({ ok: true });
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

        // On-demand scan. The nightly cron does the same thing; this is the
        // button for when a promo lands during the day.
        if (url.pathname === '/api/scan' && req.method === 'POST') {
          const body = (await req.json().catch(() => ({}))) as {
            url?: string;
            deep?: boolean;
            push?: boolean;
          };
          const push = body.push !== false && !!env.OWNER_CHAT_ID;

          if (body.url) {
            const hit = await scanUrl(env, body.url);
            if (!hit) return json({ error: 'Could not read that page.' }, 502);
            if (push) await pushFeedItem(env, env.OWNER_CHAT_ID, hit);
            return json({ fresh: [hit], feeds_read: 0, feeds_failed: [], items_seen: 1, pages_fetched: 1 });
          }

          const scan = await scanFeedsDetailed(env, { deep: body.deep !== false });
          if (push) for (const item of scan.fresh) await pushFeedItem(env, env.OWNER_CHAT_ID, item);
          return json(scan);
        }

        // Everything the scanner has seen, so a match can be judged in the app
        // rather than only from the Telegram card.
        if (url.pathname === '/api/feed') {
          const state = url.searchParams.get('state') ?? 'new';
          const perPage = Math.min(Math.max(parseInt(url.searchParams.get('per_page') ?? '10', 10) || 10, 5), 50);
          const { from, to, label: rangeLabel } = resolveRange(
            env,
            url.searchParams.get('range') ?? 'all',
            url.searchParams.get('from'),
            url.searchParams.get('to')
          );

          const where: string[] = [];
          const binds: unknown[] = [];
          // `new` is the inbox: matched, undecided. The others are history.
          if (state === 'new') where.push(`action IS NULL AND topic IS NOT NULL`);
          else if (state === 'tracked') where.push(`action = 'tracked'`);
          else if (state === 'ignored') where.push(`action = 'ignored'`);
          else if (state === 'promo') where.push(`topic = 'promo'`);
          // Items are dated by publication where the source gave one, and by
          // when we first saw them otherwise — the same date the list sorts on.
          if (from) {
            where.push(`DATE(COALESCE(published_at, seen_at)) >= ?`);
            binds.push(from);
          }
          if (to) {
            where.push(`DATE(COALESCE(published_at, seen_at)) <= ?`);
            binds.push(to);
          }
          const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

          const counted = await env.DB.prepare(`SELECT COUNT(*) AS n FROM feed_items ${clause}`)
            .bind(...binds)
            .first<{ n: number }>();
          const total = counted?.n ?? 0;
          const pages = Math.max(1, Math.ceil(total / perPage));
          // A filter change can leave you past the end; clamp rather than
          // showing an empty page with no way to tell why.
          const page = Math.min(Math.max(parseInt(url.searchParams.get('page') ?? '1', 10) || 1, 1), pages);

          const { results } = await env.DB.prepare(
            `SELECT id, feed, title, link, apply_url, excerpt, terms, score, topic, action, deep,
                    published_at, seen_at, offer_id
             FROM feed_items ${clause}
             ORDER BY COALESCE(published_at, seen_at) DESC, id DESC
             LIMIT ? OFFSET ?`
          )
            .bind(...binds, perPage, (page - 1) * perPage)
            .all<any>();

          // Counts for the filter chips, so switching state is not a guess.
          const tally = await env.DB.prepare(
            `SELECT
               SUM(CASE WHEN action IS NULL AND topic IS NOT NULL THEN 1 ELSE 0 END) AS new_count,
               SUM(CASE WHEN action = 'tracked' THEN 1 ELSE 0 END) AS tracked_count,
               SUM(CASE WHEN action = 'ignored' THEN 1 ELSE 0 END) AS ignored_count,
               COUNT(*) AS all_count
             FROM feed_items`
          ).first<any>();

          return json({
            items: results ?? [],
            page,
            pages,
            per_page: perPage,
            total,
            state,
            range: { from, to, label: rangeLabel },
            counts: {
              new: tally?.new_count ?? 0,
              tracked: tally?.tracked_count ?? 0,
              ignored: tally?.ignored_count ?? 0,
              all: tally?.all_count ?? 0,
            },
          });
        }

        // Takes one id or many: judging a batch of headlines is the common
        // case after a scan, and one request per row is the wrong shape for it.
        if (url.pathname === '/api/feed/action' && req.method === 'POST') {
          const body = (await req.json()) as { id?: number; ids?: number[]; action?: string };
          const ids = (body.ids ?? (body.id ? [body.id] : [])).filter((n) => Number.isInteger(n));
          if (!ids.length || !['track', 'ignore'].includes(body.action ?? ''))
            return json({ error: 'id or ids, and action (track|ignore), required' }, 400);
          if (ids.length > 200) return json({ error: 'at most 200 items at a time' }, 400);

          if (body.action === 'ignore') {
            for (const id of ids) await ignoreFeedItem(env, id);
            return json({ ok: true, ignored: ids.length });
          }

          const tracked: { id: number; offer_id: number }[] = [];
          const missing: number[] = [];
          for (const id of ids) {
            const offerId = await trackFeedItem(env, id);
            if (offerId) tracked.push({ id, offer_id: offerId });
            else missing.push(id);
          }
          if (!tracked.length) return json({ error: 'no such feed item' }, 404);
          return json({ ok: true, tracked, missing, offer_id: tracked[0].offer_id });
        }

        // `pending` offers are included: a tracked feed item lives there until
        // its T&C is extracted, and hiding it made the Track button look inert.
        if (url.pathname === '/api/offers') {
          const wanted: OfferStatus[] =
            url.searchParams.get('status') === 'all' ? [...OFFER_STATUSES] : ['pending', 'tracked', 'applied'];
          const { results } = await env.DB.prepare(
            `SELECT * FROM offers WHERE status IN (${wanted.map(() => '?').join(',')})
             ORDER BY created_at DESC LIMIT 50`
          )
            .bind(...wanted)
            .all<Offer>();
          const out = [];
          for (const o of results ?? []) {
            const days = daysUntil(o.valid_until, today(env));
            out.push({
              ...o,
              days_left: days,
              expired: days !== null && days < 0,
              eligibility: await evaluateOffer(env, o.id),
            });
          }
          return json({ offers: out, today: today(env), offer_retention_days: offerRetentionDays(env) });
        }

        // The prompt to paste into Claude, so the extraction flow works from
        // the app as well as the bot.
        if (url.pathname === '/api/offer/prompt') {
          const id = parseInt(url.searchParams.get('id') ?? '', 10);
          const offer = await env.DB.prepare(`SELECT * FROM offers WHERE id = ?`).bind(id).first<Offer>();
          if (!offer) return json({ error: 'no such offer' }, 404);
          return json({ id, prompt: extractionPrompt(id, offer.source_url), source_url: offer.source_url });
        }

        // Paste back what Claude returned.
        if (url.pathname === '/api/offer/extract' && req.method === 'POST') {
          const { id, json: raw } = (await req.json()) as { id?: number; json?: string };
          if (!id || !raw) return json({ error: 'id and json required' }, 400);
          let data: any;
          try {
            data = parseExtraction(raw);
          } catch (e) {
            return json({ error: `That is not valid JSON: ${(e as Error).message}` }, 400);
          }
          try {
            return json(await saveExtraction(env, id, data));
          } catch (e) {
            return json({ error: (e as Error).message }, 404);
          }
        }

        // Answer, or withdraw your answer to, one clause.
        if (url.pathname === '/api/offer/rule' && req.method === 'POST') {
          const { rule_id, decision, note } = (await req.json()) as {
            rule_id?: number;
            decision?: string | null;
            note?: string | null;
          };
          if (!rule_id) return json({ error: 'rule_id required' }, 400);
          if (decision != null && !['pass', 'fail', 'na'].includes(decision))
            return json({ error: 'decision must be pass, fail, na or null' }, 400);
          const offerId = await decideRule(env, rule_id, (decision ?? null) as any, note ?? null);
          if (!offerId) return json({ error: 'no such rule' }, 404);
          return json({ ok: true, offer_id: offerId, eligibility: await evaluateOffer(env, offerId) });
        }

        // A mis-extracted clause blocks a verdict for ever; let it be removed.
        if (url.pathname === '/api/offer/rule/delete' && req.method === 'POST') {
          const { rule_id } = (await req.json()) as { rule_id?: number };
          if (!rule_id) return json({ error: 'rule_id required' }, 400);
          const row = await env.DB.prepare(`SELECT offer_id FROM offer_rules WHERE id = ?`)
            .bind(rule_id)
            .first<{ offer_id: number }>();
          if (!row) return json({ error: 'no such rule' }, 404);
          await env.DB.prepare(`DELETE FROM offer_rules WHERE id = ?`).bind(rule_id).run();
          return json({ ok: true, offer_id: row.offer_id, eligibility: await evaluateOffer(env, row.offer_id) });
        }

        if (url.pathname === '/api/offer/status' && req.method === 'POST') {
          const { id, status } = (await req.json()) as { id?: number; status?: string };
          if (!id || !OFFER_STATUSES.includes(status as OfferStatus))
            return json({ error: `status must be one of ${OFFER_STATUSES.join(', ')}` }, 400);
          const res = await env.DB.prepare(`UPDATE offers SET status = ? WHERE id = ?`).bind(status, id).run();
          if ((res.meta.changes ?? 0) === 0) return json({ error: 'no such offer' }, 404);
          return json({ ok: true });
        }

        // What the scanner's history costs, and what can be given back.
        if (url.pathname === '/api/feed/storage') {
          return json(await feedStorage(env));
        }

        // Two different things, deliberately named differently: compacting
        // keeps the row (so the item is never shown to you twice) and drops its
        // bulk; deleting forgets it, and a feed that still carries it will
        // surface it again on the next scan.
        if (url.pathname === '/api/feed/purge' && req.method === 'POST') {
          const body = (await req.json()) as {
            mode?: string;
            scope?: string;
            older_than_days?: number;
            ids?: number[];
          };
          if (!['compact', 'delete'].includes(body.mode ?? ''))
            return json({ error: "mode must be 'compact' or 'delete'" }, 400);
          if (!['ignored', 'decided'].includes(body.scope ?? ''))
            return json({ error: "scope must be 'ignored' or 'decided'" }, 400);

          const result = await purgeFeedItems(env, {
            mode: body.mode as 'compact' | 'delete',
            scope: body.scope as 'ignored' | 'decided',
            older_than_days: body.older_than_days,
            ids: body.ids,
          });
          return json({ ...result, storage: await feedStorage(env) });
        }

        // Offers whose end date has passed are no longer decisions; they are
        // marked expired and, once old enough, removed.
        if (url.pathname === '/api/offers/sweep' && req.method === 'POST') {
          const sweep = await sweepExpiredOffers(env, today(env));
          return json(sweep);
        }

        // --- sources the scanner reads -------------------------------------
        if (url.pathname === '/api/feeds') {
          const { results } = await env.DB.prepare(
            `SELECT f.url, f.label, f.active, f.kind,
                    (SELECT COUNT(*) FROM feed_items i WHERE i.feed = f.label) AS items,
                    (SELECT MAX(seen_at) FROM feed_items i WHERE i.feed = f.label) AS last_seen
             FROM feeds f ORDER BY f.active DESC, f.label`
          ).all<any>();
          return json({ feeds: results ?? [] });
        }

        if (url.pathname === '/api/feeds/save' && req.method === 'POST') {
          const body = (await req.json()) as {
            url?: string;
            label?: string;
            kind?: string | null;
            active?: boolean;
            old_url?: string;
          };
          const clean = canonicalUrl(body.url ?? '');
          if (!clean) return json({ error: 'a valid http(s) URL is required' }, 400);
          if (body.kind && !['rss', 'page'].includes(body.kind))
            return json({ error: "kind must be 'rss', 'page' or empty" }, 400);

          const label = (body.label ?? '').trim() || new URL(clean).hostname;
          const active = body.active === false ? 0 : 1;
          // Changing the URL keeps the row: the label is what feed_items point
          // at, so replacing it would orphan everything already scanned.
          if (body.old_url && body.old_url !== clean) {
            const prior = await env.DB.prepare(`SELECT label FROM feeds WHERE url = ?`)
              .bind(body.old_url)
              .first<{ label: string }>();
            if (!prior) return json({ error: 'no such feed' }, 404);
            await env.DB.prepare(`UPDATE feeds SET url = ?, label = ?, kind = ?, active = ? WHERE url = ?`)
              .bind(clean, label, body.kind || null, active, body.old_url)
              .run();
            if (prior.label !== label)
              await env.DB.prepare(`UPDATE feed_items SET feed = ? WHERE feed = ?`).bind(label, prior.label).run();
            return json({ ok: true, url: clean, renamed_from: body.old_url });
          }

          const existing = await env.DB.prepare(`SELECT label FROM feeds WHERE url = ?`)
            .bind(clean)
            .first<{ label: string }>();
          await env.DB.prepare(
            `INSERT INTO feeds (url, label, kind, active) VALUES (?, ?, ?, ?)
             ON CONFLICT(url) DO UPDATE SET label = excluded.label, kind = excluded.kind, active = excluded.active`
          )
            .bind(clean, label, body.kind || null, active)
            .run();
          if (existing && existing.label !== label)
            await env.DB.prepare(`UPDATE feed_items SET feed = ? WHERE feed = ?`).bind(label, existing.label).run();
          return json({ ok: true, url: clean });
        }

        if (url.pathname === '/api/feeds/delete' && req.method === 'POST') {
          const { url: target } = (await req.json()) as { url?: string };
          if (!target) return json({ error: 'url required' }, 400);
          const res = await env.DB.prepare(`DELETE FROM feeds WHERE url = ?`).bind(target).run();
          if ((res.meta.changes ?? 0) === 0) return json({ error: 'no such feed' }, 404);
          // Items already scanned stay: they are history, not configuration.
          return json({ ok: true });
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

          // Which wallet these points land in, resolved now rather than when
          // you accept them: changing a card's programme later must not
          // retroactively move points you already earned.
          const program = expected.miles > 0 ? await programForCard(env, card.id, expected.rule?.id) : null;

          const ins = await env.DB.prepare(
            `INSERT INTO transactions (card_id, amount_cents, occurred_at, posted_at, merchant, category,
               category_source, needs_review, mcc, channel, expected_miles, expected_cashback_cents,
               expected_program, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`
          )
            .bind(
              card.id, cents, date, posted, note, category, source, category ? 0 : 1,
              mcc, channel, expected.miles, expected.cashback_cents, program
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
            expected_program: program,
            trace: expected.trace,
            alerts: alerts.length,
          });
        }

        if (url.pathname === '/api/transactions' && req.method === 'GET') {
          const limit = Math.min(500, parseInt(url.searchParams.get('limit') ?? '25', 10) || 25);

          // Named ranges are resolved in spend.ts rather than in the browser,
          // so they follow the app's configured timezone, not the device's.
          const { from, to, label: rangeLabel } = resolveRange(
            env,
            url.searchParams.get('range'),
            url.searchParams.get('from'),
            url.searchParams.get('to')
          );

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
            range: { from, to, label: rangeLabel },
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
        if (SCAN_CRONS.includes(event.cron)) {
          // 06:00 local: new promos, then anything that changed about the
          // transfer routes. The review is quiet — it stays silent unless
          // something is urgent or genuinely new, so a daily job does not
          // become noise you stop reading.
          await pushFeedMatches(env, env.OWNER_CHAT_ID);
          const review = await ratesReview(env, { quiet: true });
          if (review) await send(env, env.OWNER_CHAT_ID, review);

          // Scanned history is the only table that grows on its own. Judged
          // items older than the retention window keep their id — so they are
          // never shown twice — and lose their bulk. Silent by design: it is
          // housekeeping, not news.
          const days = retentionDays(env);
          if (days > 0) await purgeFeedItems(env, { mode: 'compact', scope: 'decided', older_than_days: days });

          // An offer that has ended is not a decision you can still make.
          await sweepExpiredOffers(env, today(env));
        } else {
          await send(env, env.OWNER_CHAT_ID, await buildDigest(env));
          for (const alert of await checkAlerts(env)) await send(env, env.OWNER_CHAT_ID, alert);
        }
      })()
    );
  },
};
