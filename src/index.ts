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
  standings,
  today,
  utilization,
} from './spend';
import { balances, categoryForMerchant, planRoutes, rankCards, ratesReview, rememberMerchant } from './points';
import { buildAnalytics } from './analytics';
import { EDITABLE, readSettings, readUsage, withSettings, writeSetting } from './settings';
import { platformReport } from './platform';
import { evaluate, lookupMerchant, recommend, type Channel, type Objective } from './rules';
import { buildAudit } from './audit';
import { optimise } from './advice';
import { mccMatrix } from './mcc';
import { runMigrations, runSeed } from './migrate';
import { defaultCardPossible, METHODS, monthOfOther, otherMonths } from './other';
import {
  assignMerchantCode,
  ignoredMerchants,
  ignoreMerchant,
  importMerchantCodes,
  lookupMerchantOnline,
  unknownMerchants,
} from './mccscan';
import { scanCardPage } from './cardscan';
import { markDuplicates, parseStatement, type ParsedRow } from './statement';
import { merchantGroups, renameMerchant } from './tidy';
import { acceptCredits, guessProgram, pendingCredits, programForCard, undoCredit, wallet } from './wallet';
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
          // Led by minimum spend, not by the credit limit. The limit is what a
          // credit score reads; the minimum is the thing you can still act on,
          // and the order is most-at-risk first.
          const rows = await standings(env);
          const out = rows.map(({ card, utilization: u, requirements, headline, percent, lost }) => ({
            id: card.id,
            issuer: card.issuer,
            product: card.product,
            nickname: card.nickname,
            limit_cents: u.limit_cents,
            balance_cents: u.balance_cents,
            at_risk_cents: u.at_risk_cents,
            /** Progress toward the minimum that matters, or utilization when there is none. */
            percent,
            /** Kept so the limit is still reportable, just not as the headline. */
            util_percent: u.percent,
            headline_id: headline?.requirement.id ?? null,
            /** The window's reward is already gone; spending here cannot bring it back. */
            lost,
            cycle: u.cycle,
            days_left: u.days_left,
            requirements: requirements.map((p) => ({
              id: p.requirement.id,
              kind: p.requirement.kind,
              amount_cents: p.requirement.amount_cents,
              reward_note: p.requirement.reward_note,
              bonus_cap_cents: p.requirement.bonus_cap_cents,
              window_kind: p.requirement.window,
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
              // The quarter a per-month minimum sits in, and every month of it,
              // so a month already missed is visible rather than discovered.
              quarter: p.quarter,
              months: p.months,
              tiers: p.tiers,
              tier: p.tier,
              quarter_tier: p.quarter_tier,
              thirds: p.thirds,
              projected_reward_cents: p.projected_reward_cents,
              months_missed: p.months_missed,
            })),
          }));

          const totalBal = out.reduce((s, c) => s + c.balance_cents, 0);
          const totalLimit = out.reduce((s, c) => s + c.limit_cents, 0);
          const all = rows.flatMap((r) => r.requirements);
          return json({
            today: today(env),
            cards: out,
            overall: {
              balance_cents: totalBal,
              limit_cents: totalLimit,
              percent: totalLimit ? (totalBal / totalLimit) * 100 : 0,
              // What the dashboard now leads with.
              minimums_total: all.length,
              minimums_met: all.filter((p) => p.met).length,
              minimums_at_risk: all.filter((p) => !p.met && p.days_left <= parseInt(env.MIN_SPEND_WARN_DAYS || '7', 10)).length,
              still_needed_cents: all.reduce((s, p) => s + p.remaining_cents, 0),
              soonest_days: all.filter((p) => !p.met).reduce<number | null>((lo, p) => (lo === null ? p.days_left : Math.min(lo, p.days_left)), null),
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

        // Merchants in your own spend whose code is still unknown — the gaps
        // that stop the earn engine seeing a card's MCC rules at all.
        if (url.pathname === '/api/mcc/unknown') {
          const page = parseInt(url.searchParams.get('page') ?? '1', 10) || 1;
          const per = parseInt(url.searchParams.get('per') ?? '25', 10) || 25;
          return json({ ...(await unknownMerchants(env, { page, per })), ignored_list: await ignoredMerchants(env) });
        }

        // Stop asking about a merchant that has no code to find, or start again.
        if (url.pathname === '/api/mcc/ignore' && req.method === 'POST') {
          const b = (await req.json()) as { merchant?: string; reason?: string; undo?: boolean };
          if (!b.merchant?.trim()) return json({ error: 'a merchant is required' }, 400);
          return json({ ok: true, ...(await ignoreMerchant(env, b.merchant, { reason: b.reason, undo: b.undo })) });
        }

        // One merchant, looked up by name. Ours first, then the directory's
        // page for that name. Nothing is written — recording it is a choice.
        if (url.pathname === '/api/mcc/lookup') {
          const q = (url.searchParams.get('q') ?? '').trim();
          if (!q) return json({ error: 'a merchant name is required' }, 400);
          if (q.length > 120) return json({ error: 'that name is too long' }, 400);
          return json(await lookupMerchantOnline(env, q));
        }

        // Read a published merchant-code directory and record what it says.
        if (url.pathname === '/api/mcc/scan' && req.method === 'POST') {
          const body = (await req.json().catch(() => ({}))) as { budget?: number };
          return json(await importMerchantCodes(env, { budget: body.budget }));
        }

        // Record a code for a merchant, and apply it to the spend already
        // logged under that name.
        if (url.pathname === '/api/mcc/assign' && req.method === 'POST') {
          const b = (await req.json()) as {
            merchant?: string;
            mcc?: string;
            channel?: string;
            backfill?: boolean;
            categorise?: boolean;
          };
          const code = String(b.mcc ?? '').trim();
          if (!b.merchant?.trim() || !/^\d{4}$/.test(code))
            return json({ error: 'merchant and a four-digit mcc are required' }, 400);
          const res = await assignMerchantCode(env, b.merchant, code, {
            channel: b.channel ?? null,
            backfill: b.backfill,
            categorise: b.categorise,
          });
          return json({ ok: true, ...res });
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

        // Bringing the database up to date, and loading the reference data —
        // both were bot-only, which is an odd place for them when the error
        // that needs them shows up in the app.
        if (url.pathname === '/api/migrate' && req.method === 'POST') {
          return json(await runMigrations(env));
        }

        if (url.pathname === '/api/seed' && req.method === 'POST') {
          return json(await runSeed(env));
        }

        // What Cloudflare's own meters say this app costs. Read-only, and the
        // token never leaves the Worker — the response carries numbers, never
        // credentials.
        if (url.pathname === '/api/platform') {
          const days = parseInt(url.searchParams.get('days') ?? '7', 10) || 7;
          return json(await platformReport(env, days));
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

        // --- spending that never touched a card ---------------------------
        if (url.pathname === '/api/other') {
          const month = url.searchParams.get('month') ?? undefined;
          return json({
            ...(await monthOfOther(env, month && /^\d{4}-\d{2}$/.test(month) ? month : undefined)),
            months: await otherMonths(env),
            methods: METHODS,
          });
        }

        if (url.pathname === '/api/other' && req.method === 'POST') return json({ error: 'use /api/other/add' }, 400);

        if (url.pathname === '/api/other/add' && req.method === 'POST') {
          const b = (await req.json()) as {
            amount?: string | number;
            date?: string;
            method?: string;
            merchant?: string;
            category?: string;
            card_possible?: boolean;
            note?: string;
          };
          const cents = parseMoney(String(b.amount ?? ''));
          if (!cents || cents <= 0) return json({ error: 'an amount is required' }, 400);

          const date = b.date ? parseDateToken(String(b.date), env) : today(env);
          if (!date) return json({ error: 'bad date' }, 400);
          if (date > today(env)) return json({ error: 'that date is in the future' }, 400);

          const method = String(b.method ?? 'other').trim().toLowerCase() || 'other';
          const merchant = b.merchant?.trim() || null;
          // Merchant categories are shared with card spend: tag a merchant once
          // and it categorises itself everywhere.
          let category = b.category?.trim().toLowerCase() || null;
          if (category === '?' || category === 'unknown') category = null;
          if (category) await rememberMerchant(env, merchant, category);
          else category = await categoryForMerchant(env, merchant);

          const possible = b.card_possible === undefined ? defaultCardPossible(method) : b.card_possible ? 1 : 0;

          const ins = await env.DB.prepare(
            `INSERT INTO other_spend (occurred_at, amount_cents, method, merchant, category, card_possible, note)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(date, cents, method, merchant, category, possible, b.note?.trim() || null)
            .run();
          return json({ ok: true, id: ins.meta.last_row_id, date, category, card_possible: possible });
        }

        if (url.pathname === '/api/other/update' && req.method === 'POST') {
          const { id, field, value } = (await req.json()) as { id?: number; field?: string; value?: string | null };
          const columns: Record<string, (v: string | null) => unknown> = {
            amount_cents: (v) => parseMoney(String(v ?? '')),
            occurred_at: (v) => (v ? parseDateToken(String(v), env) : null),
            method: (v) => (v ?? 'other').trim().toLowerCase(),
            merchant: (v) => v?.trim() || null,
            category: (v) => v?.trim().toLowerCase() || null,
            card_possible: (v) => (v === '1' || v === 'true' ? 1 : 0),
            note: (v) => v?.trim() || null,
          };
          if (!id || !field || !(field in columns)) return json({ error: 'id and a known field are required' }, 400);
          const next = columns[field](value ?? null);
          if (next === null && ['amount_cents', 'occurred_at'].includes(field))
            return json({ error: `bad ${field}` }, 400);

          const res = await env.DB.prepare(`UPDATE other_spend SET ${field} = ? WHERE id = ?`).bind(next, id).run();
          if ((res.meta.changes ?? 0) === 0) return json({ error: 'no such row' }, 404);
          if (field === 'category' && next) {
            const row = await env.DB.prepare(`SELECT merchant FROM other_spend WHERE id = ?`)
              .bind(id)
              .first<{ merchant: string | null }>();
            await rememberMerchant(env, row?.merchant ?? null, String(next));
          }
          return json({ ok: true });
        }

        if (url.pathname === '/api/other/delete' && req.method === 'POST') {
          const { id } = (await req.json()) as { id?: number };
          if (!id) return json({ error: 'id required' }, 400);
          const res = await env.DB.prepare(`DELETE FROM other_spend WHERE id = ?`).bind(id).run();
          if ((res.meta.changes ?? 0) === 0) return json({ error: 'no such row' }, 404);
          return json({ ok: true });
        }

        // --- pasting a statement -----------------------------------------
        // Read the rows and hand them back for checking. Nothing is written.
        if (url.pathname === '/api/statement/parse' && req.method === 'POST') {
          const b = (await req.json()) as { text?: string; nickname?: string; statement_date?: string | null };
          const text = String(b.text ?? '');
          if (!text.trim()) return json({ error: 'paste the statement text first' }, 400);
          if (text.length > 200_000) return json({ error: 'that is too much text for one paste' }, 400);

          // The statement's own date makes an unprinted year exact rather than
          // inferred: nothing on a statement happened after it was issued.
          const stmtDate = b.statement_date ? parseDateToken(String(b.statement_date), env) : null;
          const parsed = parseStatement(text, today(env), stmtDate);
          let rows = parsed.rows;

          const card = b.nickname
            ? await env.DB.prepare(`SELECT * FROM cards WHERE nickname = ? COLLATE NOCASE`)
                .bind(b.nickname.trim())
                .first<any>()
            : null;
          if (b.nickname && !card) return json({ error: 'no such card' }, 404);
          if (card) rows = await markDuplicates(env, card.id, rows);

          // What the app already knows about each merchant, so the preview
          // shows what would be recorded rather than only what was pasted.
          const enriched: ParsedRow[] = [];
          for (const r of rows) {
            const guess = await lookupMerchant(env, r.merchant);
            enriched.push({
              ...r,
              mcc: guess?.confidence === 'unknown' ? null : guess?.mcc ?? null,
              category: (await categoryForMerchant(env, r.merchant)) ?? guess?.category ?? null,
            });
          }

          return json({
            rows: enriched,
            skipped: parsed.skipped,
            total_cents: parsed.total_cents,
            duplicates: enriched.filter((r) => r.duplicate).length,
            statement_date: stmtDate,
          });
        }

        // Write the rows you kept, through the same path a single entry takes:
        // evaluated, categorised, and queued for the wallet.
        if (url.pathname === '/api/statement/import' && req.method === 'POST') {
          const b = (await req.json()) as { nickname?: string; rows?: ParsedRow[] };
          const card = await env.DB.prepare(`SELECT * FROM cards WHERE nickname = ? COLLATE NOCASE`)
            .bind(String(b.nickname ?? '').trim())
            .first<any>();
          if (!card) return json({ error: 'no such card' }, 404);
          const rows = (b.rows ?? []).filter((r) => r && r.occurred_at && Number.isFinite(r.amount_cents));
          if (!rows.length) return json({ error: 'nothing to import' }, 400);
          if (rows.length > 500) return json({ error: 'at most 500 rows at a time' }, 400);

          let imported = 0;
          let miles = 0;
          for (const r of rows) {
            const merchant = (r.merchant ?? '').trim() || null;
            let category = r.category ?? (await categoryForMerchant(env, merchant));
            const guess = merchant ? await lookupMerchant(env, merchant) : null;
            const mcc = r.mcc ?? (guess?.confidence === 'unknown' ? null : guess?.mcc ?? null);
            if (!category && guess?.category) category = guess.category;

            // A refund earns nothing; evaluating it would predict miles on a
            // negative amount.
            const expected =
              r.amount_cents > 0
                ? await evaluate(env, card, { amount_cents: r.amount_cents, mcc, category, channel: null })
                : null;
            const program = expected && expected.miles > 0 ? await programForCard(env, card.id, expected.rule?.id) : null;

            await env.DB.prepare(
              `INSERT INTO transactions (card_id, amount_cents, occurred_at, posted_at, merchant, category,
                 category_source, needs_review, mcc, channel, expected_miles, expected_cashback_cents,
                 expected_program, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'statement')`
            )
              .bind(
                card.id,
                r.amount_cents,
                r.occurred_at,
                r.posted_at ?? null,
                merchant,
                category,
                category ? 'learned' : null,
                category ? 0 : 1,
                mcc,
                expected?.miles ?? 0,
                expected?.cashback_cents ?? 0,
                program
              )
              .run();
            imported++;
            miles += expected?.miles ?? 0;
          }

          return json({ ok: true, imported, expected_miles: miles });
        }

        // --- cards and their earn rules, from the app --------------------
        if (url.pathname === '/api/cards') {
          const { results: cards } = await env.DB.prepare(
            `SELECT * FROM cards ORDER BY closed_at IS NOT NULL, issuer, product`
          ).all<any>();
          const { results: rules } = await env.DB.prepare(
            `SELECT * FROM earn_rules WHERE active = 1 ORDER BY card_id, mpd DESC`
          ).all<any>();
          const { results: reqs } = await env.DB.prepare(
            `SELECT * FROM requirements WHERE active = 1 ORDER BY card_id, id`
          ).all<any>();
          const { results: tierRows } = await env.DB.prepare(
            `SELECT t.* FROM requirement_tiers t
             JOIN requirements r ON r.id = t.requirement_id
             WHERE r.active = 1 ORDER BY t.requirement_id, t.min_spend_cents`
          ).all<any>();
          const { results: programs } = await env.DB.prepare(
            `SELECT key, name, kind, unit FROM programs ORDER BY kind, name`
          ).all<any>();
          const { results: categories } = await env.DB.prepare(
            `SELECT DISTINCT category FROM mcc_codes ORDER BY category`
          ).all<{ category: string }>();
          return json({
            cards: (cards ?? []).map((c) => ({
              ...c,
              rules: (rules ?? []).filter((r) => r.card_id === c.id),
              requirements: (reqs ?? [])
                .filter((r) => r.card_id === c.id)
                .map((r) => ({ ...r, tiers: (tierRows ?? []).filter((t) => t.requirement_id === r.id) })),
            })),
            programs: programs ?? [],
            categories: (categories ?? []).map((c) => c.category),
          });
        }

        // Read a card's rewards page and report what it says. Nothing is
        // written: a rate lifted from the wrong paragraph would quietly
        // misdirect every recommendation, so each candidate comes back with the
        // sentence it came from, to be confirmed or thrown away.
        if (url.pathname === '/api/card/scan' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as {
            nickname?: string;
            url?: string;
            text?: string;
          };
          const nickname = String(b.nickname ?? '').trim().toLowerCase();
          if (!nickname) return json({ error: 'which card is this page for?' }, 400);
          const card = await env.DB.prepare(`SELECT id FROM cards WHERE nickname = ? COLLATE NOCASE`)
            .bind(nickname)
            .first<{ id: number }>();
          if (!card) return json({ error: 'no such card' }, 404);
          return json(await scanCardPage(env, nickname, String(b.url ?? '').trim(), b.text));
        }

        if (url.pathname === '/api/card' && req.method === 'POST') {
          const b = (await req.json()) as {
            issuer?: string;
            product?: string;
            nickname?: string;
            limit?: string | number;
            statement_day?: number;
            opened_at?: string;
            program_key?: string | null;
            base_mpd?: number | string;
          };
          const issuer = (b.issuer ?? '').trim();
          const product = (b.product ?? '').trim();
          const nickname = (b.nickname ?? '').trim().toLowerCase();
          if (!issuer || !product || !nickname) return json({ error: 'issuer, product and nickname are required' }, 400);
          if (!/^[a-z0-9]{2,16}$/.test(nickname))
            return json({ error: 'nickname must be 2-16 letters or digits — it is what you type when logging spend' }, 400);

          const exists = await env.DB.prepare(`SELECT id FROM cards WHERE nickname = ? COLLATE NOCASE`)
            .bind(nickname)
            .first();
          if (exists) return json({ error: `the nickname ${nickname} is already taken` }, 400);

          const day = Math.min(Math.max(parseInt(String(b.statement_day ?? 1), 10) || 1, 1), 28);
          const opened = b.opened_at ? parseDateToken(String(b.opened_at), env) : null;
          if (b.opened_at && !opened) return json({ error: 'bad opening date' }, 400);

          // A programme is guessed from the issuer so points have somewhere to
          // go; it is reported back rather than applied silently.
          const program = b.program_key === undefined ? await guessProgram(env, issuer) : b.program_key || null;
          const ins = await env.DB.prepare(
            `INSERT INTO cards (issuer, product, product_key, nickname, credit_limit_cents, statement_day,
               opened_at, base_mpd, program_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              issuer,
              product,
              `${issuer}_${product}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
              nickname,
              parseMoney(String(b.limit ?? '0')) ?? 0,
              day,
              opened,
              parseFloat(String(b.base_mpd ?? '0')) || 0,
              program
            )
            .run();
          return json({ ok: true, id: ins.meta.last_row_id, nickname, program_key: program });
        }

        if (url.pathname === '/api/card/rule' && req.method === 'POST') {
          const b = (await req.json()) as {
            nickname?: string;
            category?: string;
            rate?: string | number;
            reward_type?: string;
            cap?: string | number | null;
            cap_window?: string | null;
            cap_group?: string | null;
            mcc_include?: string | null;
            mcc_exclude?: string | null;
            channel?: string | null;
            min_txn?: string | number | null;
            program_key?: string | null;
            note?: string | null;
          };
          const card = await env.DB.prepare(`SELECT id FROM cards WHERE nickname = ? COLLATE NOCASE`)
            .bind(String(b.nickname ?? '').trim())
            .first<{ id: number }>();
          if (!card) return json({ error: 'no such card' }, 404);

          const rate = parseFloat(String(b.rate ?? ''));
          if (!Number.isFinite(rate) || rate < 0) return json({ error: 'a rate is required' }, 400);
          const category = (b.category ?? '').trim().toLowerCase() || '*';
          const rewardType = b.reward_type === 'cashback' ? 'cashback' : 'miles';
          const window = b.cap_window ?? null;
          if (window && !['statement_cycle', 'calendar_month', 'calendar_quarter'].includes(window))
            return json({ error: 'cap window must be statement_cycle, calendar_month or calendar_quarter' }, 400);

          // A list of codes is what makes a rule precise: "4 mpd online" is not
          // the same thing as "4 mpd on 5262, 5964, 5969".
          const codes = (v: string | null | undefined) => {
            const list = (v ?? '')
              .split(/[,\s]+/)
              .map((x) => x.trim())
              .filter(Boolean);
            return list.length ? list.join(',') : null;
          };
          const include = codes(b.mcc_include);
          const exclude = codes(b.mcc_exclude);
          for (const list of [include, exclude]) {
            if (list && !/^(\d{4})(,\d{4})*$/.test(list))
              return json({ error: 'MCC lists must be four-digit codes, comma separated' }, 400);
          }

          const ins = await env.DB.prepare(
            `INSERT INTO earn_rules (card_id, category, mpd, reward_type, mcc_include, mcc_exclude, channel,
               min_txn_cents, program_key, cap_cents, cap_group, cap_window, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              card.id,
              category,
              rate,
              rewardType,
              include,
              exclude,
              b.channel || null,
              b.min_txn ? parseMoney(String(b.min_txn)) : null,
              b.program_key || null,
              b.cap ? parseMoney(String(b.cap)) : null,
              b.cap_group || null,
              window,
              b.note?.trim() || null
            )
            .run();
          return json({ ok: true, id: ins.meta.last_row_id });
        }

        // Minimum-spend requirements, which until now only the bot could set.
        if (url.pathname === '/api/card/requirement' && req.method === 'POST') {
          const b = (await req.json()) as {
            nickname?: string;
            kind?: string;
            amount?: string | number;
            window?: string;
            deadline?: string | null;
            starts_at?: string | null;
            min_txns?: number | null;
            bonus_cap?: string | number | null;
            reward_note?: string | null;
            anchor_at?: string | null;
            per_month?: boolean;
            prorate_first?: boolean;
            tiers?: { min_spend?: string | number; reward?: string | number; label?: string | null }[];
          };
          const card = await env.DB.prepare(`SELECT id, opened_at FROM cards WHERE nickname = ? COLLATE NOCASE`)
            .bind(String(b.nickname ?? '').trim())
            .first<{ id: number; opened_at: string | null }>();
          if (!card) return json({ error: 'no such card' }, 404);

          const kind = b.kind === 'signup_min' ? 'signup_min' : 'monthly_min';
          const amount = parseMoney(String(b.amount ?? ''));
          if (!amount || amount <= 0) return json({ error: 'an amount is required' }, 400);

          const window = String(b.window ?? 'calendar_month');
          if (!['calendar_month', 'calendar_quarter', 'statement_cycle', 'statement_quarter', 'fixed_window'].includes(window))
            return json({ error: 'unknown window' }, 400);

          const deadline = b.deadline ? parseDateToken(String(b.deadline), env) : null;
          if (b.deadline && !deadline) return json({ error: 'bad deadline' }, 400);
          const starts = b.starts_at ? parseDateToken(String(b.starts_at), env) : null;
          if (b.starts_at && !starts) return json({ error: 'bad start date' }, 400);
          // A fixed window with no end is not a window; the progress bar would
          // have nothing to count down to.
          if (window === 'fixed_window' && !deadline)
            return json({ error: 'a fixed window needs a deadline' }, 400);

          // A statement quarter is counted from a date, so without one there is
          // nothing to anchor it to and every month would be quarter one.
          const anchor = b.anchor_at ? parseDateToken(String(b.anchor_at), env) : null;
          if (b.anchor_at && !anchor) return json({ error: 'bad anchor date' }, 400);
          if (window === 'statement_quarter' && !(anchor ?? card.opened_at))
            return json(
              { error: 'a statement quarter is counted from the month the card was issued — set the card\u2019s opening date, or give an anchor date' },
              400
            );

          const tiers = (b.tiers ?? [])
            .map((t) => ({
              min_spend: parseMoney(String(t.min_spend ?? '')),
              reward: parseMoney(String(t.reward ?? '')),
              label: t.label?.trim() || null,
            }))
            .filter((t) => t.min_spend !== null || t.reward !== null);
          for (const t of tiers) {
            if (!t.min_spend || t.min_spend <= 0 || t.reward === null || t.reward < 0)
              return json({ error: 'each tier needs a spend and what it pays' }, 400);
          }

          const ins = await env.DB.prepare(
            `INSERT INTO requirements (card_id, kind, amount_cents, window, deadline, starts_at, min_txns,
               bonus_cap_cents, reward_note, anchor_at, per_month, prorate_first, active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
          )
            .bind(
              card.id,
              kind,
              amount,
              window,
              deadline,
              starts,
              b.min_txns ? Math.max(0, Math.round(Number(b.min_txns))) : null,
              b.bonus_cap ? parseMoney(String(b.bonus_cap)) : null,
              b.reward_note?.trim() || null,
              anchor,
              b.per_month ? 1 : 0,
              b.prorate_first ? 1 : 0
            )
            .run();

          for (const t of tiers) {
            await env.DB.prepare(
              `INSERT INTO requirement_tiers (requirement_id, min_spend_cents, reward_cents, label) VALUES (?, ?, ?, ?)`
            )
              .bind(ins.meta.last_row_id, t.min_spend, t.reward, t.label)
              .run();
          }
          return json({ ok: true, id: ins.meta.last_row_id, tiers: tiers.length });
        }

        if (url.pathname === '/api/card/requirement/delete' && req.method === 'POST') {
          const { id } = (await req.json()) as { id?: number };
          if (!id) return json({ error: 'id required' }, 400);
          const res = await env.DB.prepare(`UPDATE requirements SET active = 0 WHERE id = ?`).bind(id).run();
          if ((res.meta.changes ?? 0) === 0) return json({ error: 'no such requirement' }, 404);
          return json({ ok: true });
        }

        if (url.pathname === '/api/card/rule/delete' && req.method === 'POST') {
          const { id } = (await req.json()) as { id?: number };
          if (!id) return json({ error: 'id required' }, 400);
          const res = await env.DB.prepare(`UPDATE earn_rules SET active = 0 WHERE id = ?`).bind(id).run();
          if ((res.meta.changes ?? 0) === 0) return json({ error: 'no such rule' }, 404);
          return json({ ok: true });
        }

        if (url.pathname === '/api/card/close' && req.method === 'POST') {
          const { nickname, closed_at } = (await req.json()) as { nickname?: string; closed_at?: string | null };
          const card = await env.DB.prepare(`SELECT id FROM cards WHERE nickname = ? COLLATE NOCASE`)
            .bind(String(nickname ?? '').trim())
            .first<{ id: number }>();
          if (!card) return json({ error: 'no such card' }, 404);
          // Closing date drives eligibility cooldowns, so it is kept, not deleted.
          const date = closed_at === null ? null : parseDateToken(String(closed_at ?? today(env)), env);
          if (closed_at !== null && !date) return json({ error: 'bad closing date' }, 400);
          await env.DB.prepare(`UPDATE cards SET closed_at = ? WHERE id = ?`).bind(date, card.id).run();
          return json({ ok: true, closed_at: date });
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
        // --- transfer routes, which only the bot could edit ---------------
        if (url.pathname === '/api/routes') {
          const { results } = await env.DB.prepare(
            `SELECT c.*, pf.name AS from_name, pt.name AS to_name FROM conversions c
               JOIN programs pf ON pf.key = c.from_program
               JOIN programs pt ON pt.key = c.to_program
              WHERE c.active = 1 ORDER BY pf.name, pt.name, c.id`
          ).all<any>();
          return json({ routes: results ?? [], today: today(env), recheck_days: parseInt(env.RATE_RECHECK_DAYS || '90', 10) });
        }

        if (url.pathname === '/api/route' && req.method === 'POST') {
          const b = (await req.json()) as {
            id?: number;
            from_program?: string;
            to_program?: string;
            from_units?: number | string;
            to_units?: number | string;
            fee_cents?: string | number;
            min_block?: number | string;
            block_increment?: number | string;
            route?: string;
            bonus_pct?: number | string;
            bonus_until?: string | null;
            source_url?: string;
            note?: string;
            verified?: boolean;
          };

          // Marking a rate checked is the common case and needs nothing else.
          if (b.id && b.verified !== undefined && b.from_program === undefined) {
            const res = await env.DB.prepare(`UPDATE conversions SET verified_at = ? WHERE id = ?`)
              .bind(b.verified ? today(env) : null, b.id)
              .run();
            if ((res.meta.changes ?? 0) === 0) return json({ error: 'no such route' }, 404);
            return json({ ok: true });
          }

          const from = String(b.from_program ?? '').trim();
          const to = String(b.to_program ?? '').trim();
          for (const key of [from, to]) {
            if (!key) return json({ error: 'both programmes are required' }, 400);
            if (!(await env.DB.prepare(`SELECT key FROM programs WHERE key = ?`).bind(key).first()))
              return json({ error: `unknown programme: ${key}` }, 400);
          }
          const fromUnits = Math.round(Number(b.from_units ?? 0));
          const toUnits = Math.round(Number(b.to_units ?? 0));
          if (!(fromUnits > 0 && toUnits > 0)) return json({ error: 'a ratio needs both sides' }, 400);

          const bonusUntil = b.bonus_until ? parseDateToken(String(b.bonus_until), env) : null;
          if (b.bonus_until && !bonusUntil) return json({ error: 'bad bonus end date' }, 400);

          const fields = [
            from,
            to,
            fromUnits,
            toUnits,
            b.fee_cents ? parseMoney(String(b.fee_cents)) ?? 0 : 0,
            Math.round(Number(b.min_block ?? fromUnits)),
            Math.round(Number(b.block_increment ?? fromUnits)),
            b.route?.trim() || 'direct',
            Number(b.bonus_pct ?? 0) || 0,
            bonusUntil,
            b.source_url?.trim() || null,
            b.note?.trim() || null,
            // A rate entered by hand is only verified if you say so; the seeded
            // ones are deliberately left unverified.
            b.verified ? today(env) : null,
          ];

          if (b.id) {
            const res = await env.DB.prepare(
              `UPDATE conversions SET from_program=?, to_program=?, from_units=?, to_units=?, fee_cents=?,
                 min_block=?, block_increment=?, route=?, bonus_pct=?, bonus_until=?, source_url=?, note=?, verified_at=?
               WHERE id = ?`
            )
              .bind(...fields, b.id)
              .run();
            if ((res.meta.changes ?? 0) === 0) return json({ error: 'no such route' }, 404);
            return json({ ok: true, id: b.id });
          }

          const ins = await env.DB.prepare(
            `INSERT INTO conversions (from_program, to_program, from_units, to_units, fee_cents, min_block,
               block_increment, route, bonus_pct, bonus_until, source_url, note, verified_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(...fields)
            .run();
          return json({ ok: true, id: ins.meta.last_row_id });
        }

        if (url.pathname === '/api/route/delete' && req.method === 'POST') {
          const { id } = (await req.json()) as { id?: number };
          if (!id) return json({ error: 'id required' }, 400);
          const res = await env.DB.prepare(`UPDATE conversions SET active = 0 WHERE id = ?`).bind(id).run();
          if ((res.meta.changes ?? 0) === 0) return json({ error: 'no such route' }, 404);
          return json({ ok: true });
        }

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
          // `limit` is how many rows to return; `page` walks through them. The
          // ledger used to only ever grow its limit, which meant scrolling past
          // everything already read to reach anything new.
          const limit = Math.min(500, parseInt(url.searchParams.get('limit') ?? '25', 10) || 25);
          const wanted = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);

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
          // One card's rows, so a minimum-spend figure can be checked against
          // the purchases it was added up from.
          const nick = (url.searchParams.get('card') ?? '').trim();
          if (nick) {
            where.push(`t.card_id = (SELECT id FROM cards WHERE nickname = ? COLLATE NOCASE)`);
            binds.push(nick);
          }
          const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

          // The ledger edits these in place, so every editable column has to
          // come back — category especially: without it every row reads as
          // uncategorised and the whole table highlights as needing review.
          const rows = env.DB.prepare(
            `SELECT t.id, t.card_id, t.amount_cents, t.occurred_at, t.posted_at, t.merchant,
                    t.category, t.category_source, t.needs_review, t.source,
                    t.mcc, t.channel, t.expected_miles, t.expected_cashback_cents,
                    t.actual_miles, t.actual_cashback_cents,
                    c.nickname, c.product
             FROM transactions t JOIN cards c ON c.id = t.card_id
             ${clause}
             ORDER BY COALESCE(t.posted_at, t.occurred_at) DESC, t.id DESC LIMIT ? OFFSET ?`
          );

          // A total, so the view can say whether you are seeing everything.
          const totals = await env.DB.prepare(
            `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END), 0) AS cents
             FROM transactions t ${clause}`
          )
            .bind(...binds)
            .first<{ n: number; cents: number }>();

          // Clamp the page to what exists: narrowing the range while on page 7
          // would otherwise show an empty table rather than the rows.
          const pages = Math.max(1, Math.ceil((totals?.n ?? 0) / limit));
          const page = Math.min(wanted, pages);
          const { results } = await rows.bind(...binds, limit, (page - 1) * limit).all<any>();

          return json({
            transactions: results ?? [],
            range: { from, to, label: rangeLabel },
            total_count: totals?.n ?? 0,
            total_cents: totals?.cents ?? 0,
            page,
            pages,
            per_page: limit,
          });
        }

        // Spellings that look like one merchant. Suggested, never applied:
        // two different shops can share an opening, and only you can tell.
        if (url.pathname === '/api/tx/groups') {
          return json({ groups: await merchantGroups(env, parseInt(url.searchParams.get('limit') ?? '20', 10) || 20) });
        }

        // Rename every transaction whose merchant matches. Without apply it
        // reports what it WOULD change, which is the only safe way to offer a
        // bulk edit over a name you typed.
        if (url.pathname === '/api/tx/rename' && req.method === 'POST') {
          const b = (await req.json()) as { match?: string; to?: string; mode?: string; apply?: boolean };
          try {
            return json(
              await renameMerchant(env, {
                match: String(b.match ?? ''),
                to: String(b.to ?? ''),
                mode: b.mode,
                apply: !!b.apply,
              })
            );
          } catch (e) {
            return json({ error: (e as Error).message }, 400);
          }
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
