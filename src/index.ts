import { safeEqual, verifyToken } from './auth';
import { buildDigest, checkAlerts } from './digest';
import { decideRule, evaluateOffer } from './eligibility';
import { extractionPrompt } from './extraction';
import { daysUntil, OFFER_STATUSES, offerRetentionDays, parseExtraction, saveExtraction, sweepExpiredOffers, type OfferStatus } from './offers';
import { canonicalUrl } from './rss';
import { handleUpdate, pushFeedItem, pushFeedMatches, send } from './telegram';
import { feedStorage, ignoreFeedItem, purgeFeedItems, retentionDays, scanFeedsDetailed, scanUrl, trackFeedItem } from './rss';
import {
  cycleContaining,
  calendarMonth,
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
import { actionCentre } from './actions';
import { actualTotals, entriesIn, recordActual, recordManualTotal } from './rewards/ledger';
import { expectedTotals } from './rewards/expected';
import { applyActualMcc, reconcileAll, reconcileRewardPeriod } from './rewards/reconcile';
import { optimiseTransfer } from './transfers/optimiser';
import { promotionsFor } from './transfers/routes';
import { goalProgress, listGoals, reservedFor, saveGoal, setGoalStatus } from './transfers/goals';
import { expirePromotions, linkApplicability, publishPromotion, savePromotion } from './promotions/model';
import { extractPromotion, saveDraft } from './promotions/extract';
import { findDuplicate, merge } from './promotions/dedupe';
import { inbox, rate } from './promotions/relevance';
import { dismissPromotion, sweepCompleted, trackedOffers, trackPromotion } from './promotions/tracking';
import { syncTransferBonuses } from './promotions/bridge';
import { corroboratePending, discover, discoveryStatus, discoveryStatusV2, extractPending, recentRuns, runDiscoveryPipeline } from './promotions/discovery/run';
import { testSource } from './promotions/discovery/diagnostics';
import { backfillClassification, extractionMisses, reclassifyItem, requeueForExtraction } from './promotions/discovery/reclassify';
import { isDeepScanWindow } from './promotions/discovery/search';
import { recentSearches } from './promotions/discovery/search-runner';
import { sourceHealth, sourcesConfigured } from './promotions/discovery/sources';
import { searchConfigured } from './promotions/discovery/search-provider';
import { expireFinished } from './promotions/discovery/diff';
import { approveCandidate, reviewQueue as promotionReviewQueue } from './promotions/discovery/review';
import { promotionEvidence } from './promotions/evidence';
import { correctPromotion } from './promotions/correct';
import { contributeTargeted, removeVariant, variantsFor } from './promotions/variants';
import { portfolioGaps, spendingProfile } from './acquisition/gaps';
import { acquisitionReport } from './acquisition/economics';
import { extractRewards, pendingCandidates, saveCandidates } from './rewards/extract';
import { onboardingView, writeState } from './onboarding/state';
import { searchProducts } from './onboarding/search';
import { fieldsFor } from './onboarding/questions';
import { attachWelcomeOffer, knownOffers } from './onboarding/welcome';
import { ingestTransaction } from './transactions/ingest';
import { commitStatement, previewStatement, type ClassifiedRow } from './transactions/reconcile';
import { recalculateMany, recalculateTransaction } from './transactions/recalculate';
import { resolveReview, reviewQueue } from './transactions/review';
import { buildAudit } from './audit';
import { optimise } from './advice';
import { mccMatrix } from './mcc';
import { runMigrations, runSeed } from './migrate';
import { currentRuleSetFor } from './catalog/migrate-products';
import { confirmProductRates, diffRuleSets, draftFromCurrent, reviewAndPublish, staleProducts } from './catalog/publish';
import { addSource, checkSource, contentHash } from './catalog/sources';
import { ensureProduct, isStale, listProducts, productByKey, productById, productKeyOf } from './catalog/products';
import { recommendV2 } from './recommendations/recommend';
import { exclusionsIn, overlaps, ruleSetOn, rulesIn, versionsOf } from './catalog/rulesets';
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
              // The ladder decides the minimum; the months already closed
              // decide how high this one is still worth taking.
              floor_cents: p.floor_cents,
              tier: p.tier,
              ceiling_tier: p.ceiling_tier,
              ceiling_reason: p.ceiling_reason,
              target_cents: p.target_cents,
              to_target_cents: p.to_target_cents,
              beyond_target_cents: p.beyond_target_cents,
              quarter_tier: p.quarter_tier,
              thirds: p.thirds,
              projected_reward_cents: p.projected_reward_cents,
              months_missed: p.months_missed,
              shape_warning: p.shape_warning,
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
        // The V2 contract: a POST, because a purchase is a body rather than a
        // query string, and because the answer now carries confidence,
        // assumptions and the reasoning behind the ranking. The GET below
        // stays for the current Advisor until the new screen replaces it.
        if (url.pathname === '/api/recommend' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as {
            merchant?: string;
            amount_cents?: number | null;
            amount?: string;
            mcc?: string | null;
            category?: string | null;
            channel?: string | null;
            objective?: string;
            occurred_at?: string;
          };
          const cents =
            typeof b.amount_cents === 'number'
              ? b.amount_cents
              : b.amount
                ? parseMoney(String(b.amount))
                : null;
          const on = b.occurred_at ? parseDateToken(String(b.occurred_at), env) : null;
          if (b.occurred_at && !on) return json({ error: 'bad date' }, 400);

          return json(
            await recommendV2(
              env,
              {
                amount_cents: cents,
                mcc: b.mcc ?? null,
                category: b.category ?? null,
                channel: (b.channel as Channel) || null,
              },
              {
                merchantQuery: (b.merchant ?? '').trim() || undefined,
                objective: (b.objective as Objective) || undefined,
                on: on ?? undefined,
              }
            )
          );
        }

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

        // What to do something about, in the order it costs most to ignore.
        // Deliberately not a dashboard: every row here has an action attached.
        if (url.pathname === '/api/actions') {
          return json({ actions: await actionCentre(env), as_of: today(env) });
        }

        // "I used this card" — the recommendation, taken.
        //
        // The transaction starts PENDING because that is what it is: a purchase
        // the bank has not confirmed. Recording it as posted would put a date on
        // it that no statement has agreed to, and every window that counts by
        // posting date would then count a guess as a fact.
        if (url.pathname === '/api/tx/used' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as {
            card_id?: number;
            nickname?: string;
            amount_cents?: number | null;
            amount?: string;
            merchant?: string | null;
            mcc?: string | null;
            category?: string | null;
            channel?: string | null;
            occurred_at?: string;
          };

          const card = b.card_id
            ? await env.DB.prepare(`SELECT * FROM cards WHERE id = ?`).bind(Number(b.card_id)).first<any>()
            : await env.DB.prepare(`SELECT * FROM cards WHERE nickname = ? COLLATE NOCASE`)
                .bind(String(b.nickname ?? '').trim())
                .first<any>();
          if (!card) return json({ error: 'no such card' }, 404);

          const cents =
            typeof b.amount_cents === 'number' ? b.amount_cents : b.amount ? parseMoney(String(b.amount)) : null;
          if (cents === null || !Number.isFinite(cents) || cents <= 0) return json({ error: 'bad amount' }, 400);

          const date = b.occurred_at ? parseDateToken(String(b.occurred_at), env) : today(env);
          if (!date) return json({ error: 'bad date' }, 400);

          const result = await ingestTransaction(env, {
            source: 'advisor',
            card_id: card.id,
            amount_cents: cents,
            occurred_at: date,
            merchant: (b.merchant ?? '').trim() || null,
            mcc: b.mcc ?? null,
            category: b.category ?? null,
            channel: (b.channel as Channel) ?? null,
          });
          if (result.status === 'rejected') return json({ error: result.warnings[0]?.detail ?? 'rejected' }, 400);

          const row = await env.DB.prepare(`SELECT status, needs_review FROM transactions WHERE id = ?`)
            .bind(result.transaction_id)
            .first<{ status: string; needs_review: number }>();

          return json({
            ok: true,
            id: result.transaction_id,
            status: row?.status ?? 'pending',
            card: { id: card.id, nickname: card.nickname, product: card.product },
            occurred_at: date,
            amount_cents: cents,
            category: result.resolved.category,
            needs_review: row?.needs_review ?? 0,
            duplicate_of: result.duplicate_of ?? null,
            review: result.warnings,
            expected: {
              miles: result.reward?.miles ?? 0,
              cashback_cents: result.reward?.cashback_cents ?? 0,
            },
          });
        }

        // --- everything else that arrives as a transaction ------------------
        // One endpoint for every other channel: an iOS Shortcut, a CSV, an SMS
        // forwarder. The pipeline decides whether it is new, already known, or
        // something it has to ask about.
        if (url.pathname === '/api/transactions/ingest' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const cents =
            typeof b.amount_cents === 'number' ? b.amount_cents : b.amount ? parseMoney(String(b.amount)) : null;
          if (cents === null) return json({ error: 'bad amount' }, 400);
          const when = b.occurred_at ? parseDateToken(String(b.occurred_at), env) : today(env);
          if (!when) return json({ error: 'bad date' }, 400);
          const postedAt = b.posted_at ? parseDateToken(String(b.posted_at), env) : null;
          if (b.posted_at && !postedAt) return json({ error: 'bad posted date' }, 400);

          const result = await ingestTransaction(env, {
            source: (String(b.source ?? 'manual') as any) || 'manual',
            external_id: b.external_id ? String(b.external_id) : null,
            card_id: typeof b.card_id === 'number' ? b.card_id : null,
            card_hint: b.card_hint ? String(b.card_hint) : b.nickname ? String(b.nickname) : null,
            amount_cents: cents,
            occurred_at: when,
            posted_at: postedAt,
            merchant: b.merchant ? String(b.merchant) : null,
            mcc: b.mcc ? String(b.mcc) : null,
            category: b.category ? String(b.category) : null,
            channel: (b.channel as Channel) ?? null,
            raw_description: b.raw_description ? String(b.raw_description) : null,
            status: (b.status as any) ?? undefined,
            metadata: (b.metadata as Record<string, unknown>) ?? undefined,
          });
          return json(result, result.status === 'rejected' ? 400 : 200);
        }

        // --- re-pricing what the app believed --------------------------------
        // Rules get corrected, codes get confirmed, categories get fixed. This
        // replaces the PREDICTION with what the rules — as they now read for
        // that day — actually say, and never touches what the bank paid.
        if (url.pathname.match(/^\/api\/transactions\/\d+\/recalculate$/) && req.method === 'POST') {
          const id = Number(url.pathname.split('/')[3]);
          const r = await recalculateTransaction(env, id);
          return json(r, r.ok ? 200 : 404);
        }

        if (url.pathname === '/api/transactions/recalculate' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as {
            nickname?: string;
            from?: string;
            rule_set_id?: number;
            unpriced?: boolean;
            limit?: number;
          };
          const from = b.from ? parseDateToken(String(b.from), env) : null;
          if (b.from && !from) return json({ error: 'bad date' }, 400);

          return json(
            await recalculateMany(env, {
              nickname: b.nickname ? String(b.nickname).trim() : null,
              from,
              rule_set_id: typeof b.rule_set_id === 'number' ? b.rule_set_id : null,
              unpriced: !!b.unpriced,
              limit: typeof b.limit === 'number' ? b.limit : undefined,
            })
          );
        }

        // --- the review inbox ------------------------------------------------
        // Not `/api/review`: that is the older "needs a category" list the
        // ledger uses, and quietly taking its path would have broken a working
        // screen for the sake of a tidier name.
        if (url.pathname === '/api/review/queue' && req.method === 'GET') {
          const limit = Math.min(200, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50);
          return json({ items: await reviewQueue(env, limit) });
        }

        if (url.pathname.startsWith('/api/review/') && url.pathname.endsWith('/resolve') && req.method === 'POST') {
          const id = Number(url.pathname.slice('/api/review/'.length, -'/resolve'.length));
          if (!id) return json({ error: 'bad review id' }, 400);
          const b = (await req.json().catch(() => ({}))) as {
            action?: string;
            mcc?: string | null;
            category?: string | null;
            merchant?: string | null;
          };
          const action = String(b.action ?? 'confirm');
          if (!['confirm', 'ignore', 'merge', 'keep_both'].includes(action)) {
            return json({ error: 'action must be confirm, ignore, merge or keep_both' }, 400);
          }
          const r = await resolveReview(env, id, {
            action: action as any,
            mcc: b.mcc ?? null,
            category: b.category ?? null,
            merchant: b.merchant ?? null,
          });
          return json(r, r.ok ? 200 : 400);
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

          // With a card named, the preview is a reconciliation: each row is
          // classified against what the app already believes, so the summary
          // says what would change rather than only what was pasted.
          const preview = card ? await previewStatement(env, card, enriched, stmtDate) : null;

          // A statement carries a rewards summary as well as transactions, and
          // that summary is what a reconciliation is checked against. Read as
          // candidates only: a misread line that silently became "what the bank
          // paid" would corrupt the one record worth having.
          let rewards: ReturnType<typeof extractRewards> = [];
          if (card) {
            rewards = extractRewards(text, { program_key: card.program_key ?? null });
            if (rewards.length && stmtDate) {
              const cycle = cycleContaining(stmtDate, card.statement_day);
              await saveCandidates(env, card.id, rewards, cycle);
            }
          }

          return json({
            rows: preview ? preview.rows : enriched,
            skipped: parsed.skipped,
            total_cents: parsed.total_cents,
            duplicates: (preview ? preview.rows : enriched).filter((r) => r.duplicate).length,
            summary: preview?.summary ?? null,
            rewards,
            statement_date: stmtDate,
          });
        }

        // Write the rows you kept, through the one pipeline every other
        // channel uses. A statement is the bank's record checked against what
        // the app already believes, not a list of things to create: running the
        // same statement twice must add nothing the second time.
        if (url.pathname === '/api/statement/import' && req.method === 'POST') {
          const b = (await req.json()) as { nickname?: string; rows?: ClassifiedRow[] };
          const card = await env.DB.prepare(`SELECT * FROM cards WHERE nickname = ? COLLATE NOCASE`)
            .bind(String(b.nickname ?? '').trim())
            .first<any>();
          if (!card) return json({ error: 'no such card' }, 404);
          const rows = (b.rows ?? []).filter((r) => r && r.occurred_at && Number.isFinite(r.amount_cents));
          if (!rows.length) return json({ error: 'nothing to import' }, 400);
          if (rows.length > 500) return json({ error: 'at most 500 rows at a time' }, 400);

          // A caller that has not previewed still gets classified rows, so the
          // endpoint cannot be used to bypass the duplicate check.
          const classified = rows.every((r) => r.kind && r.external_id)
            ? rows
            : (await previewStatement(env, card, rows as any, null)).rows;

          const report = await commitStatement(env, card, classified);
          return json({
            ok: true,
            imported: report.created,
            already_known: report.already_known,
            reconciled: report.reconciled,
            queued_for_review: report.queued_for_review,
            skipped: report.skipped,
            processed: report.processed,
            expected_miles: report.expected_miles,
          });
        }

        // --- the catalogue -----------------------------------------------
        // Read-only this phase. Nothing in the UI depends on it yet; it exists
        // so the product model can be inspected before anything is built on it.
        if (url.pathname === '/api/catalog/cards' && req.method === 'GET') {
          const products = await listProducts(env, url.searchParams.get('q') ?? '');
          const out = [];
          for (const p of products) {
            const set = await ruleSetOn(env, p.id, today(env));
            out.push({
              ...p,
              stale: isStale(p, today(env)),
              current_rule_set: set ? { id: set.id, version: set.version, effective_from: set.effective_from } : null,
              rules: set ? (await rulesIn(env, set.id)).length : 0,
              held_by: (
                await env.DB.prepare(`SELECT nickname FROM cards WHERE product_id = ? ORDER BY nickname`)
                  .bind(p.id)
                  .all<{ nickname: string }>()
              ).results?.map((c) => c.nickname) ?? [],
            });
          }
          return json({ products: out });
        }

        // --- the reward ledger (P1 phase 2) --------------------------------
        // What the bank did, kept apart from what the app expected. Nothing
        // here writes the other ledger; a discrepancy is information.
        if (url.pathname === '/api/rewards/ledger') {
          const nick = url.searchParams.get('card');
          const card = nick
            ? await env.DB.prepare(`SELECT id, nickname FROM cards WHERE nickname = ? COLLATE NOCASE`)
                .bind(nick)
                .first<{ id: number; nickname: string }>()
            : null;
          if (nick && !card) return json({ error: 'no such card' }, 404);

          const start = url.searchParams.get('from') ?? calendarMonth(env).start;
          const end = url.searchParams.get('to') ?? calendarMonth(env).end;

          const cards = card
            ? [card]
            : ((await env.DB.prepare(`SELECT id, nickname FROM cards WHERE closed_at IS NULL ORDER BY nickname`).all<{
                id: number;
                nickname: string;
              }>()).results ?? []);

          const out = [];
          for (const c of cards) {
            out.push({
              card: c,
              expected: await expectedTotals(env, c.id, start, end, today(env)),
              actual: await actualTotals(env, c.id, start, end),
              entries: await entriesIn(env, c.id, start, end),
            });
          }
          return json({ period: { start, end }, cards: out, as_of: today(env) });
        }

        // A figure read off a statement, or typed in when the statement does
        // not expose one. Typed never displaces imported.
        if (url.pathname === '/api/rewards/actual' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const card = await env.DB.prepare(`SELECT id FROM cards WHERE nickname = ? COLLATE NOCASE`)
            .bind(String(b.nickname ?? '').trim())
            .first<{ id: number }>();
          if (!card) return json({ error: 'no such card' }, 404);

          const amount = Number(b.amount);
          if (!Number.isFinite(amount)) return json({ error: 'bad amount' }, 400);
          const from = b.from ? parseDateToken(String(b.from), env) : null;
          const to = b.to ? parseDateToken(String(b.to), env) : null;
          if (!from || !to) return json({ error: 'a period is required' }, 400);

          const r = b.manual
            ? await recordManualTotal(env, card.id, amount, String(b.unit ?? 'points'), { start: from, end: to }, (b.program_key as string) ?? null)
            : await recordActual(env, {
                card_id: card.id,
                program_key: (b.program_key as string) ?? null,
                entry_type: (String(b.entry_type ?? 'base_reward') as any),
                amount,
                unit: String(b.unit ?? 'points'),
                period_start: from,
                period_end: to,
                credited_at: b.credited_at ? String(b.credited_at) : to,
                source: String(b.source ?? 'manual'),
                external_reference: b.external_reference ? String(b.external_reference) : null,
                description: b.description ? String(b.description) : null,
              });
          return json(r, r.ok ? 200 : 400);
        }

        // Reward lines read off a statement, waiting to be accepted. Extraction
        // proposes; nothing becomes an observation until someone agrees.
        if (url.pathname === '/api/rewards/candidates') {
          const nick = url.searchParams.get('card');
          const card = nick
            ? await env.DB.prepare(`SELECT id FROM cards WHERE nickname = ? COLLATE NOCASE`).bind(nick).first<{ id: number }>()
            : null;
          if (nick && !card) return json({ error: 'no such card' }, 404);
          return json({ candidates: await pendingCandidates(env, card?.id) });
        }

        if (url.pathname.match(/^\/api\/rewards\/candidates\/\d+$/) && req.method === 'POST') {
          const id = Number(url.pathname.split('/')[4]);
          const b = (await req.json().catch(() => ({}))) as { action?: string };
          const action = String(b.action ?? 'accept');
          const c = await env.DB.prepare(`SELECT * FROM statement_reward_candidates WHERE id = ? AND status = 'pending'`)
            .bind(id)
            .first<any>();
          if (!c) return json({ error: 'no such pending candidate' }, 404);

          if (action === 'reject') {
            await env.DB.prepare(`UPDATE statement_reward_candidates SET status = 'rejected' WHERE id = ?`).bind(id).run();
            return json({ ok: true, applied: 'left out of the ledger' });
          }
          if (action !== 'accept') return json({ error: 'action must be accept or reject' }, 400);

          const r = await recordActual(env, {
            card_id: c.card_id,
            program_key: c.program_key,
            entry_type: c.entry_type,
            amount: c.amount,
            unit: c.unit,
            period_start: c.period_start,
            period_end: c.period_end,
            credited_at: c.credited_at ?? c.period_end,
            source: 'statement',
            external_reference: `candidate:${id}`,
            description: c.description,
            raw_description: c.raw_line,
          });
          await env.DB.prepare(`UPDATE statement_reward_candidates SET status = 'accepted' WHERE id = ?`).bind(id).run();
          return json({ ok: r.ok, ledger_id: r.id, duplicate_of: r.duplicate_of ?? null });
        }

        // --- did the bank credit what it owed? (P1 phase 3) -----------------
        // Never makes the two ledgers agree. It compares them and offers the
        // likely reasons, each a claim about evidence in the data.
        if (url.pathname === '/api/rewards/reconciliation') {
          const periods = Math.min(6, Math.max(1, parseInt(url.searchParams.get('periods') ?? '1', 10) || 1));
          return json({ results: await reconcileAll(env, periods), as_of: today(env) });
        }

        if (url.pathname === '/api/rewards/reconcile' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as {
            nickname?: string;
            from?: string;
            to?: string;
            tolerance?: { absolute?: number; percentage?: number; per_transaction?: number };
          };
          const card = await env.DB.prepare(`SELECT id, statement_day FROM cards WHERE nickname = ? COLLATE NOCASE`)
            .bind(String(b.nickname ?? '').trim())
            .first<{ id: number; statement_day: number }>();
          if (!card) return json({ error: 'no such card' }, 404);

          const from = b.from ? parseDateToken(String(b.from), env) : null;
          const to = b.to ? parseDateToken(String(b.to), env) : null;
          if ((b.from && !from) || (b.to && !to)) return json({ error: 'bad date' }, 400);

          const cycle = cycleContaining(from ?? today(env), card.statement_day);
          return json(
            await reconcileRewardPeriod(env, {
              card_id: card.id,
              start: from ?? cycle.start,
              end: to ?? cycle.end,
              tolerance: b.tolerance,
            })
          );
        }

        // The bank told us a code we had guessed wrong. This is the most
        // valuable thing a statement gives back: it corrects the transaction,
        // teaches the merchant, and re-prices — which usually makes the
        // discrepancy disappear, because the expectation was what was wrong.
        if (url.pathname.match(/^\/api\/rewards\/mcc\/\d+$/) && req.method === 'POST') {
          const id = Number(url.pathname.split('/')[4]);
          const b = (await req.json().catch(() => ({}))) as { mcc?: string };
          const r = await applyActualMcc(env, id, String(b.mcc ?? '').trim());
          return json(r, r.ok ? 200 : 400);
        }

        // --- transfers (P2 phase 4) -----------------------------------------
        // Plans only. Nothing here logs into a bank, moves points or redeems
        // anything; the app produces the instruction and a person carries it out.
        if (url.pathname === '/api/rewards/programmes') {
          const { results } = await env.DB.prepare(
            `SELECT key, name, kind, unit, expiry_months, programme_type, expiry_policy, status
               FROM programs WHERE COALESCE(status, 'active') = 'active' ORDER BY kind, name`
          ).all<any>();
          return json({ programmes: results ?? [] });
        }

        if (url.pathname === '/api/rewards/transfers/routes') {
          const on = today(env);
          const { results } = await env.DB.prepare(
            `SELECT c.*, f.name AS from_name, t.name AS to_name
               FROM conversions c
               JOIN programs f ON f.key = c.from_program
               JOIN programs t ON t.key = c.to_program
              WHERE c.active = 1
                AND (c.effective_from IS NULL OR c.effective_from <= ?)
                AND (c.effective_until IS NULL OR c.effective_until >= ?)
              ORDER BY f.name, t.name`
          )
            .bind(on, on)
            .all<any>();

          const routes = [];
          for (const r of results ?? []) {
            routes.push({ ...r, promotions: await promotionsFor(env, r.id, on) });
          }
          return json({ routes, as_of: on });
        }

        if (url.pathname === '/api/rewards/transfers/optimise' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as {
            destination?: string;
            target_units?: number;
            target_date?: string;
            objective?: string;
            include_promotions?: boolean;
            goal_id?: number;
          };
          if (!b.destination) return json({ error: 'a destination programme is required' }, 400);

          const OBJECTIVES = [
            'maximize_destination_units',
            'minimize_fees',
            'minimize_expiry_loss',
            'reach_target',
            'balanced',
          ];
          const objective = OBJECTIVES.includes(String(b.objective)) ? (b.objective as any) : undefined;

          try {
            return json(
              await optimiseTransfer(env, {
                destination: String(b.destination),
                target_units: typeof b.target_units === 'number' ? b.target_units : null,
                target_date: b.target_date ? String(b.target_date) : null,
                objective,
                include_promotions: b.include_promotions,
                // Points promised to another goal are not available to this one.
                reserved: await reservedFor(env, b.goal_id),
              })
            );
          } catch (e) {
            return json({ error: (e as Error).message }, 404);
          }
        }

        if (url.pathname === '/api/rewards/goals' && req.method === 'GET') {
          const goals = await listGoals(env, url.searchParams.get('all') === '1');
          const out = [];
          for (const g of goals) out.push(await goalProgress(env, g));
          return json({ goals: out, as_of: today(env) });
        }

        if (url.pathname === '/api/rewards/goals' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const key = String(b.program_key ?? '').trim();
          const units = Number(b.target_units);
          if (!key || !Number.isFinite(units) || units <= 0) {
            return json({ error: 'a programme and a target are required' }, 400);
          }
          const exists = await env.DB.prepare(`SELECT key FROM programs WHERE key = ?`).bind(key).first();
          if (!exists) return json({ error: 'no such programme' }, 404);

          const when = b.target_date ? parseDateToken(String(b.target_date), env) : null;
          if (b.target_date && !when) return json({ error: 'bad date' }, 400);

          const goal = await saveGoal(env, {
            id: typeof b.id === 'number' ? b.id : undefined,
            program_key: key,
            target_units: Math.round(units),
            target_date: when,
            description: b.description ? String(b.description) : null,
          });
          return json({ ok: true, goal: await goalProgress(env, goal) });
        }

        if (url.pathname.match(/^\/api\/rewards\/goals\/\d+$/) && req.method === 'POST') {
          const id = Number(url.pathname.split('/')[4]);
          const b = (await req.json().catch(() => ({}))) as { status?: string };
          const status = String(b.status ?? '');
          if (!['active', 'met', 'abandoned'].includes(status)) return json({ error: 'bad status' }, 400);
          await setGoalStatus(env, id, status as any);
          return json({ ok: true });
        }

        // --- promotions (P2 phase 5) ----------------------------------------
        // Relevance first: a feed of every offer every bank runs is a list
        // nobody reads, and the two that mattered are buried in it.
        if (url.pathname === '/api/promotions' && req.method === 'GET') {
          await expirePromotions(env);
          return json(await inbox(env));
        }

        if (url.pathname === '/api/promotions/tracked') {
          return json({ offers: await trackedOffers(env), as_of: today(env) });
        }

        if (url.pathname.match(/^\/api\/promotions\/\d+\/track$/) && req.method === 'POST') {
          const id = Number(url.pathname.split('/')[3]);
          const b = (await req.json().catch(() => ({}))) as { card_id?: number; nickname?: string };
          let cardId = typeof b.card_id === 'number' ? b.card_id : undefined;
          if (!cardId && b.nickname) {
            const c = await env.DB.prepare(`SELECT id FROM cards WHERE nickname = ? COLLATE NOCASE`)
              .bind(String(b.nickname))
              .first<{ id: number }>();
            cardId = c?.id;
          }
          const r = await trackPromotion(env, id, cardId);
          return json(r, r.ok ? 200 : 400);
        }

        if (url.pathname.match(/^\/api\/promotions\/\d+\/dismiss$/) && req.method === 'POST') {
          return json(await dismissPromotion(env, Number(url.pathname.split('/')[3])));
        }

        // Offers whose spend is done. Completing one writes what the bank now
        // owes, which is what connects an offer to the rewards check.
        if (url.pathname === '/api/promotions/sweep' && req.method === 'POST') {
          const done = await sweepCompleted(env);
          const bridged = await syncTransferBonuses(env);
          return json({ ...done, transfer_bonuses: bridged });
        }

        // Why the app believes an offer is current. The numbers came from
        // somewhere the person did not choose, so who said it, when, and
        // whether anyone disagreed has to be one tap away.
        if (url.pathname.match(/^\/api\/promotions\/\d+\/evidence$/) && req.method === 'GET') {
          const id = Number(url.pathname.split('/')[3]);
          const e = await promotionEvidence(env, id);
          return e ? json(e) : json({ error: 'no such promotion' }, 404);
        }

        // Fixing a number on an offer that is already published. The usual
        // correction is one figure, and rejecting the whole promotion to get it
        // rediscovered would throw away the tracking and the history with it.
        if (url.pathname.match(/^\/api\/promotions\/\d+\/correct$/) && req.method === 'POST') {
          const id = Number(url.pathname.split('/')[3]);
          const b = (await req.json().catch(() => ({}))) as Record<string, any>;
          const r = await correctPromotion(env, id, b.terms ?? {}, {
            note: b.note ?? null,
            source_url: b.source_url ?? null,
            allow_implausible: b.allow_implausible === true,
          });
          return json(r, r.ok ? 200 : 400);
        }

        if (url.pathname.match(/^\/api\/promotions\/\d+\/variants$/) && req.method === 'GET') {
          return json({ variants: await variantsFor(env, Number(url.pathname.split('/')[3])) });
        }

        // A targeted offer the person was actually sent. This is the only
        // place promotion terms come from the user rather than a source, and
        // it is trusted — they are holding the email. It is stored as its own
        // variant so it never changes what the app believes the public offer
        // to be.
        if (url.pathname.match(/^\/api\/promotions\/\d+\/variants$/) && req.method === 'POST') {
          const id = Number(url.pathname.split('/')[3]);
          const b = (await req.json().catch(() => ({}))) as Record<string, any>;
          const r = await contributeTargeted(env, id, {
            minimum_spend_cents: typeof b.minimum_spend_cents === 'number' ? b.minimum_spend_cents : null,
            reward: b.reward ?? null,
            application_channel: b.application_channel ?? null,
            note: b.note ?? null,
            received_at: b.received_at ?? null,
          });
          return json(r, r.ok ? 200 : 400);
        }

        if (url.pathname.match(/^\/api\/promotions\/\d+\/variants\/.+$/) && req.method === 'DELETE') {
          const parts = url.pathname.split('/');
          const removed = await removeVariant(env, Number(parts[3]), decodeURIComponent(parts[5]));
          return json({ ok: removed });
        }

        if (url.pathname.match(/^\/api\/promotions\/\d+$/) && req.method === 'GET') {
          const id = Number(url.pathname.split('/')[3]);
          const p = await env.DB.prepare(`SELECT * FROM promotions WHERE id = ?`).bind(id).first<any>();
          if (!p) return json({ error: 'no such promotion' }, 404);
          return json({ promotion: await rate(env, p) });
        }

        // --- admin: extraction proposes, a person publishes -----------------
        if (url.pathname === '/api/admin/promotions' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as Record<string, any>;

          // Reading a page produces a draft and nothing else, whatever its
          // confidence: an offer with a wrong threshold is worse than none,
          // because somebody spends against it.
          if (b.text) {
            const e = extractPromotion(String(b.text), { issuer: b.issuer ?? null, title: b.title });
            const saved = await saveDraft(env, e, { url: b.source_url ?? null, type: b.source_type ?? null });
            if (saved.ok && saved.id && b.links) await linkApplicability(env, saved.id, b.links);
            return json({ ...saved, extracted: e }, saved.ok ? 200 : 400);
          }

          const r = await savePromotion(env, {
            id: typeof b.id === 'number' ? b.id : undefined,
            promotion_type: b.promotion_type,
            issuer: b.issuer ?? null,
            title: String(b.title ?? ''),
            description: b.description ?? null,
            start_at: b.start_at ?? null,
            end_at: b.end_at ?? null,
            registration_required: !!b.registration_required,
            source_url: b.source_url ?? null,
            source_type: b.source_type ?? null,
            source_quote: b.source_quote ?? null,
            confidence: b.confidence,
            terms: b.terms ?? {},
            status: b.status,
          });
          if (r.ok && r.id && b.links) await linkApplicability(env, r.id, b.links);
          return json(r, r.ok ? 200 : 400);
        }

        if (url.pathname.match(/^\/api\/admin\/promotions\/\d+\/publish$/) && req.method === 'POST') {
          const id = Number(url.pathname.split('/')[4]);
          const r = await publishPromotion(env, id);
          // A published transfer bonus reaches the optimiser through the route
          // it applies to, rather than the optimiser learning about promotions.
          if (r.ok) await syncTransferBonuses(env);
          return json(r, r.ok ? 200 : 400);
        }

        if (url.pathname === '/api/admin/promotions/duplicates' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as { keep?: number; drop?: number };
          if (typeof b.keep !== 'number' || typeof b.drop !== 'number') {
            return json({ error: 'both promotions are required' }, 400);
          }
          const r = await merge(env, b.keep, b.drop);
          return json(r, r.ok ? 200 : 400);
        }

        if (url.pathname.match(/^\/api\/admin\/promotions\/\d+\/duplicate$/)) {
          const id = Number(url.pathname.split('/')[4]);
          const p = await env.DB.prepare(`SELECT * FROM promotions WHERE id = ?`).bind(id).first<any>();
          if (!p) return json({ error: 'no such promotion' }, 404);
          return json({ duplicate: await findDuplicate(env, p) });
        }

        // --- is a card missing from my setup? (P2 phase 6) ------------------
        // Gaps first, candidates second. Starting from cards produces a list of
        // products someone might sell you; starting from your own spending can
        // reach the answer "nothing is missing", which the other never does.
        if (url.pathname === '/api/cards/portfolio-gaps') {
          const months = Math.min(12, Math.max(1, parseInt(url.searchParams.get('history_months') ?? '6', 10) || 6));
          return json({
            gaps: await portfolioGaps(env, months),
            profile: await spendingProfile(env, months),
            as_of: today(env),
          });
        }

        if (url.pathname === '/api/cards/acquisition/simulate' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as {
            history_months?: number;
            objective?: string;
            limit?: number;
          };
          const months = Math.min(12, Math.max(1, Number(b.history_months) || 6));
          const OBJECTIVES = ['maximise_miles', 'minimise_fees', 'simpler_wallet', 'balanced'];
          return json(
            await acquisitionReport(env, {
              months,
              objective: OBJECTIVES.includes(String(b.objective)) ? (b.objective as any) : 'balanced',
              limit: typeof b.limit === 'number' ? b.limit : undefined,
            })
          );
        }

        // --- promotion discovery -------------------------------------------
        // The software does the hunting; a person only handles what is
        // ambiguous or materially changed.
        // The status the screen reads. The older shape is still served under
        // ?v=1 for anything that has not moved over.
        if (url.pathname === '/api/admin/discovery/status') {
          if (url.searchParams.get('v') === '1') {
            const configured = searchConfigured(env);
            return json({
              ...(await discoveryStatus(env)),
              sources: await sourceHealth(env, { searchConfigured: configured }),
            });
          }
          return json(await discoveryStatusV2(env));
        }

        // Diagnostic only: it reads the source and changes nothing about it,
        // so pressing Test while debugging cannot demote a source or mark it
        // failing.
        if (url.pathname.match(/^\/api\/admin\/discovery\/sources\/\d+\/test$/) && req.method === 'POST') {
          const id = Number(url.pathname.split('/')[5]);
          const src = await env.DB.prepare(`SELECT * FROM discovery_sources WHERE id = ?`).bind(id).first<any>();
          if (!src) return json({ error: 'no such source' }, 404);
          return json(await testSource(env, src));
        }

        // After a classifier improvement. Works from the stored title, so
        // nothing leaves the app and no URL has to be rediscovered.
        if (url.pathname.match(/^\/api\/admin\/discovery\/items\/\d+\/reclassify$/) && req.method === 'POST') {
          const r = await reclassifyItem(env, Number(url.pathname.split('/')[5]));
          return r ? json(r) : json({ error: 'no such article' }, 404);
        }

        // Re-reading one article costs a fetch, so it is a deliberate act
        // rather than part of the backfill.
        if (url.pathname.match(/^\/api\/admin\/discovery\/items\/\d+\/requeue$/) && req.method === 'POST') {
          const r = await requeueForExtraction(env, Number(url.pathname.split('/')[5]));
          return json(r, r.ok ? 200 : 404);
        }

        if (url.pathname === '/api/admin/discovery/backfill' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as { limit?: number };
          return json(await backfillClassification(env, { limit: b.limit }));
        }

        // Articles read successfully that named no offer, with the reason.
        if (url.pathname === '/api/admin/discovery/misses') {
          return json({ misses: await extractionMisses(env, 50), as_of: today(env) });
        }

        if (url.pathname === '/api/admin/discovery/searches') {
          return json({ searches: await recentSearches(env, 20), as_of: today(env) });
        }

        if (url.pathname === '/api/admin/discovery/run' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as { stage?: string; limit?: number };
          const limit = Math.min(20, Math.max(1, Number(b.limit) || 5));
          // Bounded stages rather than one long run: a Worker invocation is
          // short, and a scan that must finish in one go fails as soon as
          // there is enough to do.
          const stage = String(b.stage ?? 'discover');
          if (stage === 'discover') return json(await discover(env, { limit }));
          if (stage === 'extract') return json(await extractPending(env, { limit }));
          if (stage === 'corroborate') return json(await corroboratePending(env, { limit }));
          if (stage === 'expire') return json(await expireFinished(env));
          return json({ error: 'stage must be discover, extract, corroborate or expire' }, 400);
        }

        // One action that answers "is there anything new?". The three stages
        // below remain, because they are how you find out which one is stuck.
        if (url.pathname === '/api/admin/discovery/run-all' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as Record<string, number>;
          return json(
            await runDiscoveryPipeline(env, {
              max_cycles: b.max_cycles,
              discover_limit: b.discover_limit,
              extract_limit: b.extract_limit,
              corroborate_limit: b.corroborate_limit,
            })
          );
        }

        if (url.pathname === '/api/admin/discovery/runs') {
          return json({ runs: await recentRuns(env, 20), as_of: today(env) });
        }

        if (url.pathname === '/api/admin/discovery/candidates') {
          const status = url.searchParams.get('status');
          const { results } = status
            ? await env.DB.prepare(
                `SELECT c.*, d.url, d.title AS article_title FROM promotion_candidates c
                   LEFT JOIN discovery_items d ON d.id = c.discovery_id
                  WHERE c.status = ? ORDER BY c.id DESC LIMIT 100`
              )
                .bind(status)
                .all<any>()
            : await env.DB.prepare(
                `SELECT c.*, d.url, d.title AS article_title FROM promotion_candidates c
                   LEFT JOIN discovery_items d ON d.id = c.discovery_id
                  ORDER BY c.id DESC LIMIT 100`
              ).all<any>();
          return json({ candidates: results ?? [] });
        }

        if (url.pathname === '/api/admin/discovery/sources') {
          return json({ sources: await sourceHealth(env) });
        }

        // --- the review queue ------------------------------------------------
        if (url.pathname === '/api/admin/promotions/review') {
          return json({ items: await promotionReviewQueue(env), as_of: today(env) });
        }

        if (url.pathname.match(/^\/api\/admin\/promotions\/review\/\d+\/(publish|reject|merge)$/) && req.method === 'POST') {
          const parts = url.pathname.split('/');
          const id = Number(parts[5]);
          const action = parts[6];
          const b = (await req.json().catch(() => ({}))) as { into?: number; terms?: Record<string, unknown> };

          if (action === 'reject') {
            await env.DB.prepare(`UPDATE promotion_candidates SET status = 'rejected' WHERE id = ?`).bind(id).run();
            return json({ ok: true, applied: 'left out' });
          }
          if (action === 'merge') {
            if (typeof b.into !== 'number') return json({ error: 'a promotion to merge into is required' }, 400);
            await env.DB.prepare(`UPDATE promotion_claims SET promotion_id = ? WHERE candidate_id = ?`)
              .bind(b.into, id)
              .run();
            await env.DB.prepare(
              `UPDATE promotion_candidates SET status = 'published', promotion_id = ? WHERE id = ?`
            )
              .bind(b.into, id)
              .run();
            return json({ ok: true, applied: `merged into promotion #${b.into}` });
          }

          const r = await approveCandidate(env, id, b.terms);
          return json(r, r.ok ? 200 : 400);
        }

        // --- onboarding (P1 phase 1) ---------------------------------------
        // Where setup stands. Someone with cards is never shown a welcome
        // screen; they may still be missing a statement day, and that is a
        // repair rather than an onboarding.
        if (url.pathname === '/api/onboarding' && req.method === 'GET') {
          return json(await onboardingView(env));
        }

        if (url.pathname === '/api/onboarding/search') {
          const q = url.searchParams.get('q') ?? '';
          return json({ matches: await searchProducts(env, q) });
        }

        // The questions this particular card needs, which is not the same set
        // for every card and is never the rates — those come from the product.
        if (url.pathname === '/api/onboarding/fields') {
          const pid = url.searchParams.get('product_id');
          return json({ fields: await fieldsFor(env, pid ? Number(pid) : null) });
        }

        if (url.pathname === '/api/onboarding/state' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as Partial<{
            status: string;
            statements_offered: number;
            wallet_offered: number;
          }>;
          const patch: Record<string, unknown> = {};
          if (b.status && ['not_started', 'in_progress', 'completed'].includes(b.status)) {
            patch.status = b.status;
            if (b.status === 'completed') patch.completed_at = today(env);
          }
          if (typeof b.statements_offered === 'number') patch.statements_offered = b.statements_offered;
          if (typeof b.wallet_offered === 'number') patch.wallet_offered = b.wallet_offered;
          return json({ ok: true, state: await writeState(env, patch as any) });
        }

        if (url.pathname === '/api/onboarding/complete' && req.method === 'POST') {
          const view = await onboardingView(env);
          const state = await writeState(env, {
            status: 'completed',
            cards_completed: view.cards.length,
            completed_at: today(env),
          });
          return json({ ok: true, state, repairs: view.repairs });
        }

        // Welcome offers. Known ones come from published promotions; when
        // nothing is known the app asks rather than inventing a deadline
        // somebody would then plan their spending around.
        if (url.pathname.match(/^\/api\/onboarding\/cards\/\d+\/offers$/) && req.method === 'GET') {
          const cardId = Number(url.pathname.split('/')[4]);
          const card = await env.DB.prepare(`SELECT product_id FROM cards WHERE id = ?`)
            .bind(cardId)
            .first<{ product_id: number | null }>();
          if (!card) return json({ error: 'no such card' }, 404);
          return json({ offers: card.product_id ? await knownOffers(env, card.product_id) : [] });
        }

        if (url.pathname.match(/^\/api\/onboarding\/cards\/\d+\/offers$/) && req.method === 'POST') {
          const cardId = Number(url.pathname.split('/')[4]);
          const b = (await req.json().catch(() => ({}))) as {
            amount?: string | number;
            amount_cents?: number;
            window_days?: number;
            reward_note?: string;
            min_txns?: number | null;
          };
          const cents =
            typeof b.amount_cents === 'number' ? b.amount_cents : b.amount ? parseMoney(String(b.amount)) : null;
          if (cents === null) return json({ error: 'bad amount' }, 400);

          const r = await attachWelcomeOffer(env, cardId, {
            amount_cents: cents,
            window_days: Number(b.window_days ?? 0),
            reward_note: String(b.reward_note ?? 'welcome offer').trim() || 'welcome offer',
            min_txns: typeof b.min_txns === 'number' ? b.min_txns : null,
          });
          return json(r, r.ok ? 200 : 400);
        }

        // --- catalogue operations (P0 phase 5) -----------------------------
        // Everything that changes what a card is believed to pay. The shape of
        // this section is the safety property: a draft can be written by
        // anything, and only a publish — which requires having been handed the
        // comparison — changes what a calculation can reach.
        if (url.pathname === '/api/catalog/cards' && req.method === 'POST') {
          const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const issuer = String(b.issuer ?? '').trim();
          const name = String(b.product_name ?? '').trim();
          if (!issuer || !name) return json({ error: 'an issuer and a product name are required' }, 400);

          const product = await ensureProduct(env, {
            product_key: String(b.product_key ?? '').trim() || productKeyOf(issuer, name),
            issuer,
            product_name: name,
            network: b.network ? String(b.network) : null,
            reward_type: b.reward_type ? String(b.reward_type) : undefined,
            program_key: b.program_key ? String(b.program_key) : null,
            base_mpd: typeof b.base_mpd === 'number' ? b.base_mpd : null,
            base_cashback_pct: typeof b.base_cashback_pct === 'number' ? b.base_cashback_pct : null,
            annual_fee_cents: typeof b.annual_fee_cents === 'number' ? b.annual_fee_cents : null,
            official_url: b.official_url ? String(b.official_url) : null,
            // A card you added yourself is still a product, so it earns through
            // the same engine as a catalogue one rather than a parallel path.
            source: String(b.source ?? 'user'),
            verification_status: 'draft',
          });
          return json({ ok: true, product });
        }

        // Record where a product's numbers came from, or re-read a source and
        // find out whether the bank has changed it.
        if (url.pathname.match(/^\/api\/catalog\/cards\/\d+\/sources$/) && req.method === 'POST') {
          const id = Number(url.pathname.split('/')[4]);
          const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const src = String(b.source_url ?? '').trim();
          if (!src) return json({ error: 'a source url is required' }, 400);
          const source = await addSource(env, id, {
            source_type: String(b.source_type ?? 'bank_product_page'),
            source_url: src,
            title: b.title ? String(b.title) : null,
            retrieved_at: today(env),
            effective_from: b.effective_from ? String(b.effective_from) : null,
            content_hash: b.text ? contentHash(String(b.text)) : null,
          });
          return json({ ok: true, source });
        }

        if (url.pathname.match(/^\/api\/catalog\/sources\/\d+\/check$/) && req.method === 'POST') {
          const id = Number(url.pathname.split('/')[4]);
          const b = (await req.json().catch(() => ({}))) as { text?: string };
          if (!b.text) return json({ error: 'paste the page text to compare against' }, 400);
          const r = await checkSource(env, id, String(b.text), today(env));
          if (!r) return json({ error: 'no such source' }, 404);
          // A changed page never rewrites a rule. It marks the product for
          // review and leaves the published version exactly as it is.
          return json({ ok: true, changed: r.changed, previous_hash: r.previous_hash, hash: r.new_hash });
        }

        // Start a new version, copied from whatever is live so a rule nobody
        // meant to remove cannot vanish by being left out of a blank page.
        if (url.pathname.match(/^\/api\/catalog\/cards\/\d+\/rule-sets$/) && req.method === 'POST') {
          const id = Number(url.pathname.split('/')[4]);
          const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const from = b.effective_from ? parseDateToken(String(b.effective_from), env) : today(env);
          if (!from) return json({ error: 'bad effective date' }, 400);
          if (!(await productById(env, id))) return json({ error: 'no such product' }, 404);

          const made = await draftFromCurrent(env, id, from, {
            notes: b.notes ? String(b.notes) : null,
            source_id: typeof b.source_id === 'number' ? b.source_id : null,
            today: today(env),
          });
          return json({ ok: true, ...made });
        }

        // Rules go into a DRAFT only. A published version is closed off, never
        // edited: the whole point of versioning is that August cannot be
        // rewritten in October.
        if (url.pathname.match(/^\/api\/catalog\/rule-sets\/\d+\/rules$/) && req.method === 'POST') {
          const id = Number(url.pathname.split('/')[4]);
          const set = await env.DB.prepare(`SELECT * FROM rule_sets WHERE id = ?`).bind(id).first<any>();
          if (!set) return json({ error: 'no such rule set' }, 404);
          if (set.status !== 'draft') return json({ error: `a ${set.status} version cannot be edited` }, 409);

          const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const category = String(b.category ?? '').trim().toLowerCase();
          const mpd = Number(b.mpd);
          if (!category || !Number.isFinite(mpd)) return json({ error: 'a category and a rate are required' }, 400);

          const ins = await env.DB.prepare(
            `INSERT INTO earn_rules (rule_set_id, category, mpd, reward_type, mcc_include, mcc_exclude, channel,
               cap_cents, cap_window, min_tier_cents, note, active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
          )
            .bind(
              id,
              category,
              mpd,
              String(b.reward_type ?? 'miles'),
              b.mcc_include ? String(b.mcc_include) : null,
              b.mcc_exclude ? String(b.mcc_exclude) : null,
              b.channel ? String(b.channel) : null,
              typeof b.cap_cents === 'number' ? b.cap_cents : null,
              b.cap_window ? String(b.cap_window) : null,
              typeof b.min_tier_cents === 'number' ? b.min_tier_cents : null,
              b.note ? String(b.note) : null
            )
            .run();
          return json({ ok: true, id: ins.meta.last_row_id });
        }

        if (url.pathname.match(/^\/api\/catalog\/rule-sets\/\d+\/rules\/\d+$/) && req.method === 'DELETE') {
          const setId = Number(url.pathname.split('/')[4]);
          const ruleId = Number(url.pathname.split('/')[6]);
          const set = await env.DB.prepare(`SELECT status FROM rule_sets WHERE id = ?`).bind(setId).first<any>();
          if (!set) return json({ error: 'no such rule set' }, 404);
          if (set.status !== 'draft') return json({ error: `a ${set.status} version cannot be edited` }, 409);
          await env.DB.prepare(`DELETE FROM earn_rules WHERE id = ? AND rule_set_id = ?`).bind(ruleId, setId).run();
          return json({ ok: true });
        }

        // What would change if this draft went live. Read before publishing,
        // never after.
        if (url.pathname.match(/^\/api\/catalog\/rule-sets\/\d+\/diff$/)) {
          const id = Number(url.pathname.split('/')[4]);
          try {
            return json(await diffRuleSets(env, id));
          } catch (e) {
            return json({ error: (e as Error).message }, 404);
          }
        }

        if (url.pathname.match(/^\/api\/catalog\/rule-sets\/\d+\/publish$/) && req.method === 'POST') {
          const id = Number(url.pathname.split('/')[4]);
          try {
            const out = await reviewAndPublish(env, id, today(env));
            return json({ ok: true, ...out });
          } catch (e) {
            const err = e as Error & { code?: string; conflicts?: unknown };
            // An overlap is refused rather than resolved: two published versions
            // covering one day is an ambiguous answer to "what did this card pay
            // on the 14th", and something would have to pick one silently.
            if (err.code === 'RULE_VERSION_OVERLAP') {
              return json({ error: err.message, code: err.code, conflicts: err.conflicts }, 409);
            }
            return json({ error: err.message }, 400);
          }
        }

        // The other route to verified. Publishing a rule set marks a product
        // checked, which is right when the rules are changing — but left no way
        // to say "I read the bank's page and what is already here is correct",
        // so those products stayed unchecked forever.
        if (url.pathname.match(/^\/api\/catalog\/products\/\d+\/confirm$/) && req.method === 'POST') {
          const id = Number(url.pathname.split('/')[4]);
          const b = (await req.json().catch(() => ({}))) as { source_url?: string; note?: string };
          const r = await confirmProductRates(env, id, today(env), {
            source_url: String(b.source_url ?? ''),
            note: b.note ?? null,
          });
          return json(r, r.ok ? 200 : 400);
        }

        // Products whose numbers should not be trusted without another look.
        if (url.pathname === '/api/catalog/stale') {
          return json({ products: await staleProducts(env, today(env)), as_of: today(env) });
        }

        if (url.pathname.startsWith('/api/catalog/cards/')) {
          const key = decodeURIComponent(url.pathname.slice('/api/catalog/cards/'.length));
          const product = await productByKey(env, key);
          if (!product) return json({ error: 'no such product' }, 404);
          const sets = await versionsOf(env, product.id);
          const versions = [];
          for (const set of sets) {
            versions.push({ ...set, rules: await rulesIn(env, set.id), exclusions: await exclusionsIn(env, set.id) });
          }
          const { results: sources } = await env.DB.prepare(
            `SELECT * FROM product_sources WHERE product_id = ? AND active = 1 ORDER BY retrieved_at DESC`
          )
            .bind(product.id)
            .all<any>();
          return json({
            product: { ...product, stale: isStale(product, today(env)) },
            versions,
            sources: sources ?? [],
            // The invariant, checked rather than assumed: no day may be covered
            // by two published versions.
            overlaps: await overlaps(env, product.id),
          });
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
            /** Pick the card from the catalogue instead of describing it. */
            product_id?: number;
          };

          // Adding a card from the catalogue means naming what you hold, not
          // what it pays: the issuer, the product, the programme and every rate
          // are facts about the product and already recorded against it.
          const chosen = b.product_id ? await productById(env, Number(b.product_id)) : null;
          if (b.product_id && !chosen) return json({ error: 'no such product in the catalogue' }, 404);

          const issuer = chosen?.issuer ?? (b.issuer ?? '').trim();
          const product = chosen?.product_name ?? (b.product ?? '').trim();
          const nickname = (b.nickname ?? '').trim().toLowerCase();
          if (!issuer || !product || !nickname) return json({ error: 'issuer, product and nickname are required' }, 400);
          if (!/^[a-z0-9]{2,16}$/.test(nickname))
            return json({ error: 'nickname must be 2-16 letters or digits — it is what you type when logging spend' }, 400);

          const exists = await env.DB.prepare(`SELECT id FROM cards WHERE nickname = ? COLLATE NOCASE`)
            .bind(nickname)
            .first();
          if (exists) return json({ error: `the nickname ${nickname} is already taken` }, 400);

          // A day that was not given is the default standing in, and the card
          // records which of the two it is — otherwise a card billing on the
          // 1st because nobody said looks identical to one that really does.
          const dayGiven = b.statement_day !== undefined && b.statement_day !== null && String(b.statement_day) !== '';
          const day = Math.min(Math.max(parseInt(String(b.statement_day ?? 1), 10) || 1, 1), 28);
          const opened = b.opened_at ? parseDateToken(String(b.opened_at), env) : null;
          if (b.opened_at && !opened) return json({ error: 'bad opening date' }, 400);

          // A programme is guessed from the issuer so points have somewhere to
          // go; it is reported back rather than applied silently.
          const program =
            chosen?.program_key ?? (b.program_key === undefined ? await guessProgram(env, issuer) : b.program_key || null);
          const ins = await env.DB.prepare(
            `INSERT INTO cards (issuer, product, product_key, nickname, credit_limit_cents, statement_day,
               statement_day_known, opened_at, base_mpd, program_key, product_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              issuer,
              product,
              chosen?.product_key ?? productKeyOf(issuer, product),
              nickname,
              parseMoney(String(b.limit ?? '0')) ?? 0,
              day,
              dayGiven ? 1 : 0,
              opened,
              chosen?.base_mpd ?? (parseFloat(String(b.base_mpd ?? '0')) || 0),
              program,
              chosen?.id ?? null
            )
            .run();

          // A card not in the catalogue still becomes a product, so it earns
          // through the same engine rather than down a parallel path that has
          // to be fixed twice.
          let productId = chosen?.id ?? null;
          if (!productId) {
            const made = await ensureProduct(env, {
              product_key: productKeyOf(issuer, product),
              issuer,
              product_name: product,
              program_key: program,
              base_mpd: parseFloat(String(b.base_mpd ?? '0')) || null,
              source: 'user',
              verification_status: 'draft',
            });
            productId = made.id;
            await env.DB.prepare(`UPDATE cards SET product_id = ? WHERE id = ?`)
              .bind(productId, ins.meta.last_row_id)
              .run();
          }

          // What this card already pays, if the catalogue knew: the point of
          // picking from it is not being asked for rates you would have to go
          // and look up yourself.
          const liveSet = productId ? await ruleSetOn(env, productId, today(env)) : null;
          const liveRules = liveSet ? (await rulesIn(env, liveSet.id)).length : 0;

          return json({
            ok: true,
            id: ins.meta.last_row_id,
            nickname,
            program_key: program,
            product_id: productId,
            issuer,
            product,
            from_catalog: !!chosen,
            rules: liveRules,
          });
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
            min_tier?: string | number | null;
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

          // A rule added after the migration has to land in a version too, or
          // the product model quietly stops being the whole picture.
          const ruleSetId = await currentRuleSetFor(env, card.id, today(env));

          const ins = await env.DB.prepare(
            `INSERT INTO earn_rules (card_id, rule_set_id, category, mpd, reward_type, mcc_include, mcc_exclude, channel,
               min_txn_cents, min_tier_cents, program_key, cap_cents, cap_group, cap_window, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              card.id,
              ruleSetId,
              category,
              rate,
              rewardType,
              include,
              exclude,
              b.channel || null,
              b.min_txn ? parseMoney(String(b.min_txn)) : null,
              b.min_tier ? parseMoney(String(b.min_tier)) : null,
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
            /** Set to change an existing requirement rather than add another. */
            id?: number;
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

          // With a ladder, the lowest rung IS the minimum, so that is what gets
          // stored. Keeping a different number would have the app and the row
          // disagreeing about the same card.
          const lowestRung = tiers.length ? Math.min(...tiers.map((t) => t.min_spend!)) : null;

          const fields = [
            kind,
            lowestRung ?? amount,
            window,
            deadline,
            starts,
            b.min_txns ? Math.max(0, Math.round(Number(b.min_txns))) : null,
            b.bonus_cap ? parseMoney(String(b.bonus_cap)) : null,
            b.reward_note?.trim() || null,
            anchor,
            b.per_month ? 1 : 0,
            b.prorate_first ? 1 : 0,
          ];

          // Changing a requirement in place rather than deleting and adding
          // one: a minimum set up with the wrong window is the commonest thing
          // to get wrong, and making the only fix "delete it" is how a card
          // stays wrong.
          let id: number;
          if (b.id) {
            const owned = await env.DB.prepare(`SELECT id FROM requirements WHERE id = ? AND card_id = ?`)
              .bind(b.id, card.id)
              .first();
            if (!owned) return json({ error: 'no such requirement on that card' }, 404);
            await env.DB.prepare(
              `UPDATE requirements SET kind = ?, amount_cents = ?, window = ?, deadline = ?, starts_at = ?,
                 min_txns = ?, bonus_cap_cents = ?, reward_note = ?, anchor_at = ?, per_month = ?, prorate_first = ?
               WHERE id = ?`
            )
              .bind(...fields, b.id)
              .run();
            id = b.id;
            // The ladder is replaced wholesale, so removing a rung works.
            await env.DB.prepare(`DELETE FROM requirement_tiers WHERE requirement_id = ?`).bind(id).run();
          } else {
            const ins = await env.DB.prepare(
              `INSERT INTO requirements (card_id, kind, amount_cents, window, deadline, starts_at, min_txns,
                 bonus_cap_cents, reward_note, anchor_at, per_month, prorate_first, active)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
            )
              .bind(card.id, ...fields)
              .run();
            id = Number(ins.meta.last_row_id);
          }

          for (const t of tiers) {
            await env.DB.prepare(
              `INSERT INTO requirement_tiers (requirement_id, min_spend_cents, reward_cents, label) VALUES (?, ?, ?, ?)`
            )
              .bind(id, t.min_spend, t.reward, t.label)
              .run();
          }
          return json({ ok: true, id, tiers: tiers.length, amount_cents: lowestRung ?? amount });
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

          // Everything an entry needs is the same wherever it came from, so
          // the typed form goes through the one pipeline: deduplicated, merchant
          // resolved, coded, priced, and queued where it could not be decided.
          const note = body.note?.trim() || null;
          let category = body.category?.trim().toLowerCase() || null;
          // '?' means "I don't know yet" — an explicit unknown, not a guess.
          if (category === '?' || category === 'unknown') category = null;
          if (category) await rememberMerchant(env, note, category);

          const result = await ingestTransaction(env, {
            source: 'manual',
            card_id: card.id,
            amount_cents: cents,
            occurred_at: date,
            posted_at: posted,
            merchant: note,
            mcc: (body as any).mcc ?? null,
            category,
            channel: ((body as any).channel as Channel) ?? null,
          });
          if (result.status === 'rejected') return json({ error: result.warnings[0]?.detail ?? 'rejected' }, 400);

          const row = await env.DB.prepare(`SELECT * FROM transactions WHERE id = ?`)
            .bind(result.transaction_id)
            .first<any>();

          const alerts = await checkAlerts(env, card);
          for (const a of alerts) await send(env, env.OWNER_CHAT_ID, a);
          return json({
            ok: true,
            id: result.transaction_id,
            card: card.product,
            date,
            posted_at: posted,
            status: row?.status ?? 'pending',
            category: result.resolved.category,
            category_source: row?.category_source ?? null,
            needs_review: row?.needs_review ?? 0,
            mcc: result.resolved.mcc,
            channel: result.resolved.channel,
            expected_miles: result.reward?.miles ?? 0,
            expected_cashback_cents: result.reward?.cashback_cents ?? 0,
            expected_program: result.reward?.program ?? null,
            trace: result.reward?.trace ?? [],
            duplicate_of: result.duplicate_of ?? null,
            review: result.warnings,
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
                    t.actual_miles, t.actual_cashback_cents, t.status,
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

          // Promotion discovery, in bounded stages rather than one long run:
          // a Worker invocation is short, and each stage leaves its state in
          // the database so the next cron picks up where this one stopped.
          // Every one of these is allowed to fail without taking the rest of
          // the scan with it — a blocked source is an expected outcome here.
          // Wider at the month boundary, where offers actually turn over. The
          // search budget widens there too, in search.ts — this is about how
          // many sources and articles one invocation will handle, which is a
          // different limit from how much the searching costs.
          const deep = isDeepScanWindow(env);
          for (const stage of [
            () => discover(env, { limit: deep ? 10 : 6 }),
            () => extractPending(env, { limit: deep ? 10 : 6 }),
            () => corroboratePending(env, { limit: deep ? 20 : 12 }),
          ]) {
            try {
              await stage();
            } catch (e) {
              console.error('discovery stage failed', (e as Error).message);
            }
          }

          // What is left for a person. Silent when there is nothing, because a
          // daily message that usually says "nothing" is one you stop reading.
          try {
            const status = await discoveryStatus(env);
            if (status.today.awaiting_review > 0 || status.today.new > 0 || status.today.changed > 0) {
              await send(
                env,
                env.OWNER_CHAT_ID,
                `*Promotions* — ${status.today.new} new, ${status.today.changed} changed, ` +
                  `${status.today.awaiting_review} waiting for you.`
              );
            }
          } catch (e) {
            console.error('discovery status failed', (e as Error).message);
          }
        } else {
          await send(env, env.OWNER_CHAT_ID, await buildDigest(env));
          for (const alert of await checkAlerts(env)) await send(env, env.OWNER_CHAT_ID, alert);
        }
      })()
    );
  },
};
