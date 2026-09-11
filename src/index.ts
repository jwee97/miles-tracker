import { safeEqual, verifyToken } from './auth';
import { buildDigest, checkAlerts } from './digest';
import { evaluateOffer } from './eligibility';
import { handleUpdate, pushFeedMatches, send } from './telegram';
import {
  activeCards,
  parseMoney,
  requirementProgress,
  requirementsFor,
  today,
  utilization,
} from './spend';
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

      if (url.pathname === '/api/offers') {
        const { results } = await env.DB.prepare(
          `SELECT * FROM offers WHERE status IN ('tracked','applied') ORDER BY created_at DESC LIMIT 50`
        ).all<Offer>();
        const out = [];
        for (const o of results ?? []) out.push({ ...o, eligibility: await evaluateOffer(env, o.id) });
        return json({ offers: out });
      }

      // Target for the iOS Shortcut: POST {nickname, amount, note}
      if (url.pathname === '/api/tx' && req.method === 'POST') {
        const body = (await req.json()) as { nickname?: string; amount?: string | number; note?: string };
        const card = await env.DB.prepare(`SELECT * FROM cards WHERE nickname = ? COLLATE NOCASE`)
          .bind(String(body.nickname ?? '').trim())
          .first<any>();
        if (!card) return json({ error: 'unknown card nickname' }, 400);
        const cents = parseMoney(String(body.amount ?? ''));
        if (cents === null) return json({ error: 'bad amount' }, 400);

        await env.DB.prepare(
          `INSERT INTO transactions (card_id, amount_cents, occurred_at, merchant, source) VALUES (?, ?, ?, ?, 'manual')`
        )
          .bind(card.id, cents, today(env), body.note ?? null)
          .run();

        const alerts = await checkAlerts(env, card);
        for (const a of alerts) await send(env, env.OWNER_CHAT_ID, a);
        return json({ ok: true, card: card.product, alerts: alerts.length });
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
        }
      })()
    );
  },
};
