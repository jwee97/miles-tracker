import { safeEqual, verifyToken } from './auth';
import { buildDigest, checkAlerts } from './digest';
import { evaluateOffer } from './eligibility';
import { handleUpdate, pushFeedMatches, send } from './telegram';
import {
  activeCards,
  localNow,
  parseDateToken,
  parseMoney,
  requirementProgress,
  requirementsFor,
  today,
  utilization,
} from './spend';
import { balances, planRoutes, rankCards, ratesReview } from './points';
import type { Env, Offer } from './types';

// The dashboard is served from this same Worker, so there is no cross-origin
// request to permit and no CORS headers to set.
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

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
            headroom_cents: p.headroom_cents,
            miles: p.miles,
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

        const ins = await env.DB.prepare(
          `INSERT INTO transactions (card_id, amount_cents, occurred_at, merchant, source) VALUES (?, ?, ?, ?, 'manual')`
        )
          .bind(card.id, cents, date, body.note ?? null)
          .run();

        const alerts = await checkAlerts(env, card);
        for (const a of alerts) await send(env, env.OWNER_CHAT_ID, a);
        return json({ ok: true, id: ins.meta.last_row_id, card: card.product, date, alerts: alerts.length });
      }

      if (url.pathname === '/api/transactions' && req.method === 'GET') {
        const limit = Math.min(100, parseInt(url.searchParams.get('limit') ?? '25', 10) || 25);
        const { results } = await env.DB.prepare(
          `SELECT t.id, t.amount_cents, t.occurred_at, t.posted_at, t.merchant, t.source, c.nickname, c.product
           FROM transactions t JOIN cards c ON c.id = t.card_id
           ORDER BY COALESCE(t.posted_at, t.occurred_at) DESC, t.id DESC LIMIT ?`
        )
          .bind(limit)
          .all<any>();
        return json({ transactions: results ?? [] });
      }

      // Confirm when the bank actually posted a transaction, which is the date
      // every window is really judged on.
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
    }

    if (url.pathname === '/health') return new Response('ok');

    // Anything else is a static asset or the SPA fallback, handled by the
    // assets binding before this script ever runs.
    return new Response('not found', { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        // Two crons share one handler; event.cron says which fired.
        if (event.cron === '0 0 * * *') {
          await pushFeedMatches(env, env.OWNER_CHAT_ID);
        } else {
          await send(env, env.OWNER_CHAT_ID, await buildDigest(env));
          for (const alert of await checkAlerts(env)) await send(env, env.OWNER_CHAT_ID, alert);

          // The weekly rates review rides on the daily cron rather than taking
          // a third trigger, which the free plan limits.
          if (localNow(env).getUTCDay() === 0) {
            await send(env, env.OWNER_CHAT_ID, await ratesReview(env));
          }
        }
      })()
    );
  },
};
