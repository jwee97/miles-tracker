import { mintToken } from './auth';
import { buildDigest, checkAlerts } from './digest';
import { cardRulesPrompt, extractionPrompt, HELP } from './extraction';
import { decideRule, evaluateOffer } from './eligibility';
import { daysUntil, OFFER_STATUSES, parseExtraction, saveExtraction, sweepExpiredOffers, type OfferStatus } from './offers';
import { feedStorage, ignoreFeedItem, purgeFeedItems, retentionDays, scanFeedsDetailed, scanUrl, trackFeedItem } from './rss';
import type { ScanResult } from './rss';
import { activeCards, daysBetween, money, parseDateToken, parseMoney, requirementProgress, requirementsFor, today, utilization } from './spend';
import { balances, categoryForMerchant, executeTransfer, formatRate, planRoutes, rankCards, ratesReview, rememberMerchant, tranchesByExpiry } from './points';
import { runMigrations, runSeed } from './migrate';
import { optimise } from './advice';
import { evaluate, lookupMerchant } from './rules';
import { acceptCredits, guessProgram, pendingCredits, programForCard, undoCredit, wallet } from './wallet';
import type { Card, Env, Offer } from './types';

const api = (env: Env, method: string) => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;

/**
 * Sends a message, chunking at Telegram's 4096-char limit. Markdown is attempted
 * first and retried as plain text if Telegram rejects the entities — card and
 * merchant names routinely contain characters that break the parser, and a
 * readable plain message beats a dropped one.
 */
export async function send(env: Env, chatId: string | number, text: string, extra: Record<string, unknown> = {}) {
  for (const chunk of chunkText(text, 4000)) {
    const body = { chat_id: chatId, text: chunk, parse_mode: 'Markdown', ...extra };
    const res = await fetch(api(env, 'sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const { parse_mode, ...plain } = body as Record<string, unknown>;
      await fetch(api(env, 'sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(plain),
      });
    }
  }
}

function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > size) {
      out.push(buf);
      buf = '';
    }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) out.push(buf);
  return out;
}

async function answerCallback(env: Env, id: string, text: string) {
  await fetch(api(env, 'answerCallbackQuery'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id, text }),
  });
}

const ruleIcon = (r: { verdict: string; decision: string | null }) =>
  (r.verdict === 'pass' ? '·' : r.verdict === 'fail' ? '✗' : '?') + (r.decision ? '✎' : '');

const decisionText = (r: { decision: string | null; note: string | null; reason: string }) =>
  `${r.decision === 'na' ? 'Does not apply' : r.decision === 'pass' ? 'You confirmed this' : 'You said you do not meet this'}` +
  `${r.note ? ` — ${r.note}` : ''}`;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const cardByNick = (env: Env, nick: string) =>
  env.DB.prepare(`SELECT * FROM cards WHERE nickname = ? COLLATE NOCASE`).bind(nick.trim()).first<Card>();

/** Notify about new feed matches, each with Track / Ignore buttons. */
export async function pushFeedMatches(env: Env, chatId: string, opts: { deep?: boolean } = {}) {
  const scan = await scanFeedsDetailed(env, opts);
  for (const item of scan.fresh) await pushFeedItem(env, chatId, item);
  return scan.fresh.length;
}

/** One match, with whatever the page reader managed to learn about it. */
export async function pushFeedItem(env: Env, chatId: string, item: ScanResult) {
  const lines = [`📰 *${item.feed}*`, item.title, item.link];
  if (item.excerpt) lines.push(`_${item.excerpt.slice(0, 220)}_`);
  if (item.apply_url && item.apply_url !== item.link) lines.push(`🔗 Offer page: ${item.apply_url}`);
  if (item.terms.length) lines.push(`matched: ${item.terms.join(', ')}`);

  await send(env, chatId, lines.join('\n'), {
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Track', callback_data: `track:${item.id}` },
          { text: '✖️ Ignore', callback_data: `ignore:${item.id}` },
        ],
      ],
    },
  });
}

export async function handleUpdate(env: Env, update: any, origin: string): Promise<void> {
  if (update.callback_query) return handleCallback(env, update.callback_query, origin);

  const msg = update.message ?? update.edited_message;
  if (!msg?.text) return;

  const chatId = String(msg.chat.id);
  const text: string = msg.text.trim();

  // Single-user bot: the owner's chat id is the entire access control model.
  if (env.OWNER_CHAT_ID && chatId !== env.OWNER_CHAT_ID) {
    if (text.startsWith('/start')) await send(env, chatId, `This bot is private.\nYour chat id is: ${chatId}`);
    return;
  }

  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.toLowerCase().split('@')[0];
  const args = rest.join(' ');

  try {
    switch (cmd) {
      case '/start':
        await send(env, chatId, `Connected. Your chat id is ${chatId}.\n\n${HELP}`);
        return;
      case '/help':
        await send(env, chatId, HELP);
        return;

      case '/app': {
        const token = await mintToken(env.APP_SECRET);
        await send(env, chatId, `Dashboard link (valid 30 days):\n${origin}/#t=${token}`, {
          disable_web_page_preview: true,
        });
        return;
      }

      case '/status':
        await send(env, chatId, await buildDigest(env));
        return;

      case '/cards': {
        const { results } = await env.DB.prepare(
          `SELECT * FROM cards ORDER BY closed_at IS NOT NULL, issuer`
        ).all<Card>();
        if (!results?.length) return send(env, chatId, 'No cards yet — /help for /newcard.');
        const lines = results.map(
          (c) =>
            `*${c.nickname}* — ${c.issuer} ${c.product}\n  limit $${money(c.credit_limit_cents)} · closes day ${c.statement_day}` +
            `\n  opened ${c.opened_at ?? '?'}${c.closed_at ? ` · closed ${c.closed_at}` : ''}` +
            `\n  earns into ${c.program_key ?? '— not set, /setprogram'}`
        );
        return send(env, chatId, lines.join('\n\n'));
      }

      case '/newcard': {
        // issuer|product|nickname|limit|statement_day|opened_at
        const p = args.split('|').map((s) => s.trim());
        if (p.length < 5)
          return send(env, chatId, 'Format:\n`/newcard DBS|Altitude Visa|alt|8000|18|2025-03-04`');
        const [issuer, product, nickname, limit, stmtDay, opened] = p;
        // A starting guess at where this card's points land, from the issuer.
        // A cashback card earns none, so nothing is credited either way.
        const guessed = await guessProgram(env, issuer);
        await env.DB.prepare(
          `INSERT INTO cards (issuer, product, product_key, nickname, credit_limit_cents, statement_day, opened_at, program_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            issuer,
            product,
            slug(`${issuer}_${product}`),
            nickname.toLowerCase(),
            parseMoney(limit) ?? 0,
            parseInt(stmtDay, 10) || 1,
            opened || null,
            guessed
          )
          .run();
        return send(
          env,
          chatId,
          `Added *${product}* as \`${nickname.toLowerCase()}\`.` +
            (guessed
              ? `\nPoints will go to \`${guessed}\` — \`/setprogram ${nickname.toLowerCase()} <programme>\` to change it.`
              : `\nNo programme guessed for ${issuer}. \`/setprogram ${nickname.toLowerCase()} <programme>\` if it earns points.`)
        );
      }

      case '/closecard': {
        const [nick, date] = args.split('|').map((s) => s.trim());
        const card = await cardByNick(env, nick ?? '');
        if (!card) return send(env, chatId, `No card with nickname \`${nick}\`.`);
        await env.DB.prepare(`UPDATE cards SET closed_at = ? WHERE id = ?`)
          .bind(date || today(env), card.id)
          .run();
        return send(env, chatId, `Closed ${card.product} on ${date || today(env)}. Eligibility cooldowns now run from that date.`);
      }

      case '/req': {
        // nickname|kind|amount|window|deadline|cap|txns|note
        const p = args.split('|').map((s) => s.trim());
        if (p.length < 4)
          return send(
            env,
            chatId,
            'Format: `nickname|kind|amount|window|deadline|cap|txns|note`\n\n' +
              '`/req citirw|monthly_min|0|statement_cycle||1000||4 mpd, capped`\n' +
              '`/req uobone|monthly_min|1000|calendar_quarter|||5|$100 quarterly rebate`\n' +
              '`/req alt|signup_min|1000|fixed_window|2026-11-14|||30k miles`'
          );
        const [nick, kind, amount, window, deadline, cap, txns, note] = p;
        const card = await cardByNick(env, nick);
        if (!card) return send(env, chatId, `No card with nickname \`${nick}\`.`);
        await env.DB.prepare(
          `INSERT INTO requirements (card_id, kind, amount_cents, window, deadline, starts_at, bonus_cap_cents, min_txns, reward_note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            card.id,
            kind,
            parseMoney(amount) ?? 0,
            window,
            deadline || null,
            kind === 'signup_min' ? card.opened_at : null,
            cap ? parseMoney(cap) : null,
            txns ? parseInt(txns, 10) : null,
            note || null
          )
          .run();
        return send(env, chatId, `Requirement added to ${card.product}. /status to see progress.`);
      }

      case '/reqs': {
        const { results } = await env.DB.prepare(
          `SELECT r.*, c.nickname, c.product FROM requirements r
           JOIN cards c ON c.id = r.card_id WHERE r.active = 1 ORDER BY c.nickname`
        ).all<any>();
        if (!results?.length) return send(env, chatId, 'No requirements set.');
        return send(
          env,
          chatId,
          results
            .map(
              (r) =>
                `#${r.id} *${r.nickname}* ${r.kind} $${money(r.amount_cents)} / ${r.window}` +
                (r.deadline ? ` by ${r.deadline}` : '') +
                (r.min_txns ? ` · ${r.min_txns} txns` : '') +
                (r.bonus_cap_cents ? ` · cap $${money(r.bonus_cap_cents)}` : '')
            )
            .join('\n')
        );
      }

      case '/delreq':
        await env.DB.prepare(`UPDATE requirements SET active = 0 WHERE id = ?`).bind(parseInt(args, 10)).run();
        return send(env, chatId, `Requirement #${parseInt(args, 10)} removed.`);

      case '/offers': {
        // `pending` is included: a tracked feed item sits there until it is
        // extracted, and leaving it out made it look like nothing happened.
        const wanted: OfferStatus[] =
          args.trim().toLowerCase() === 'all'
            ? [...OFFER_STATUSES]
            : ['pending', 'tracked', 'applied'];
        const { results } = await env.DB.prepare(
          `SELECT * FROM offers WHERE status IN (${wanted.map(() => '?').join(',')})
           ORDER BY created_at DESC LIMIT 20`
        )
          .bind(...wanted)
          .all<Offer>();
        if (!results?.length) return send(env, chatId, 'No offers yet. `/scan` looks for some.');
        const out: string[] = [];
        for (const o of results) {
          const e = await evaluateOffer(env, o.id);
          const icon = e.verdict === 'eligible' ? '✅' : e.verdict === 'not_eligible' ? '❌' : '🟡';
          const state = o.status === 'pending' ? ' _(not extracted)_' : o.status === 'dismissed' ? ' _(dismissed)_' : '';
          out.push(
            `${icon} *#${o.id} ${o.issuer ?? '?'} ${o.product ?? o.source_title ?? ''}*${state}` +
              (o.bonus_miles ? `\n  ${o.bonus_miles.toLocaleString()} miles` : '') +
              (o.min_spend_cents ? ` for $${money(o.min_spend_cents)} in ${o.spend_window_days ?? '?'}d` : '') +
              (o.valid_until
                ? `\n  ${(() => {
                    const d = daysUntil(o.valid_until, today(env));
                    return d === null
                      ? `ends ${o.valid_until}`
                      : d < 0
                        ? `ended ${o.valid_until} (${-d}d ago)`
                        : d === 0
                          ? `ends today (${o.valid_until})`
                          : `ends in ${d}d (${o.valid_until})`;
                  })()}`
                : '\n  _no end date extracted_') +
              (e.rules.length
                ? '\n' +
                  e.rules
                    .map((r) => `  ${ruleIcon(r)} #${r.id} ${r.decision ? decisionText(r) : r.reason}`)
                    .join('\n') +
                  (e.open_questions ? `\n  _${e.open_questions} need you: /rule <id> yes|no|na_` : '')
                : '\n  _no rules extracted yet — /extract ' + o.id + '_') +
              (o.source_url ? `\n  ${o.source_url}` : '')
          );
        }
        return send(env, chatId, out.join('\n\n'), { disable_web_page_preview: true });
      }

      case '/extract': {
        const id = parseInt(args, 10);
        const offer = await env.DB.prepare(`SELECT * FROM offers WHERE id = ?`).bind(id).first<Offer>();
        if (!offer) return send(env, chatId, `No offer #${id}.`);
        await send(env, chatId, `Open the T&C, then paste this into Claude with the terms:\n${offer.source_url ?? ''}`, {
          disable_web_page_preview: true,
        });
        // Sent without parse_mode so the prompt's braces and backticks survive verbatim.
        return send(env, chatId, extractionPrompt(id, offer.source_url), { parse_mode: undefined });
      }

      case '/save': {
        const m = args.match(/^(\d+)\s+([\s\S]+)$/);
        if (!m) return send(env, chatId, 'Format: `/save <offer id> {json}`');
        const id = parseInt(m[1], 10);
        let data: any;
        try {
          data = parseExtraction(m[2]);
        } catch (e) {
          return send(env, chatId, `Could not parse that JSON: ${(e as Error).message}`);
        }
        let saved;
        try {
          saved = await saveExtraction(env, id, data);
        } catch (e) {
          return send(env, chatId, (e as Error).message);
        }
        const e = saved.eligibility;
        const icon = e.verdict === 'eligible' ? '✅ Eligible' : e.verdict === 'not_eligible' ? '❌ Not eligible' : '🟡 Needs review';
        return send(
          env,
          chatId,
          `Saved offer #${id} with ${saved.rules_saved} rule(s)` +
            (saved.decisions_kept ? `, keeping ${saved.decisions_kept} of your answers` : '') +
            `.\n\n*${icon}*\n` +
            e.rules.map((r, i) => `${ruleIcon(r)} #${r.id} ${r.reason}`).join('\n') +
            (e.open_questions
              ? `\n\n${e.open_questions} clause(s) need you: \`/rule <id> yes|no|na [note]\`, or review them in the app.`
              : '')
        );
      }

      // Answer a clause the card history cannot settle — income, a card closed
      // before you started tracking, anything the extractor flagged for a human.
      case '/rule': {
        const m = args.match(/^(\d+)\s+(yes|no|na|clear)\s*([\s\S]*)$/i);
        if (!m)
          return send(
            env,
            chatId,
            'Format: `/rule <rule id> yes|no|na [note]`\n' +
              '`yes` you meet it · `no` you do not · `na` it does not apply · `clear` undo.\n' +
              'Rule ids are shown by `/offers`.'
          );
        const ruleId = parseInt(m[1], 10);
        const word = m[2].toLowerCase();
        const decision = word === 'yes' ? 'pass' : word === 'no' ? 'fail' : word === 'na' ? 'na' : null;
        const offerId = await decideRule(env, ruleId, decision, m[3].trim() || null);
        if (!offerId) return send(env, chatId, `No rule #${ruleId}.`);
        const e = await evaluateOffer(env, offerId);
        const icon = e.verdict === 'eligible' ? '✅ Eligible' : e.verdict === 'not_eligible' ? '❌ Not eligible' : '🟡 Needs review';
        return send(
          env,
          chatId,
          `Offer #${offerId} — *${icon}*\n` +
            e.rules.map((r) => `${ruleIcon(r)} #${r.id} ${r.decision ? decisionText(r) : r.reason}`).join('\n')
        );
      }

      case '/apply': {
        const id = parseInt(args, 10);
        await env.DB.prepare(`UPDATE offers SET status='applied' WHERE id = ?`).bind(id).run();
        return send(env, chatId, `Offer #${id} marked applied. Once approved, add the card with /newcard and its sign-up minimum with /req.`);
      }

      case '/dismiss': {
        const id = parseInt(args, 10);
        if (!id) return send(env, chatId, 'Format: `/dismiss <offer id>`');
        await env.DB.prepare(`UPDATE offers SET status='dismissed' WHERE id = ?`).bind(id).run();
        return send(env, chatId, `Offer #${id} dismissed. It stays on record; the app can bring it back.`);
      }

      case '/feeds': {
        const { results } = await env.DB.prepare(`SELECT url, label, active, kind FROM feeds`).all<any>();
        return send(
          env,
          chatId,
          (results ?? [])
            .map((f) => `${f.active ? '·' : '✖'} ${f.label} [${f.kind ?? 'auto'}] — ${f.url}`)
            .join('\n') || 'No feeds.'
        );
      }

      case '/addfeed': {
        // kind is optional: rss, page (an HTML listing), or blank to detect.
        const [url, label, kind] = args.split('|').map((s) => s.trim());
        if (!/^https?:\/\//i.test(url ?? ''))
          return send(env, chatId, 'Format:\n`/addfeed https://site/feed/|Label|rss`\nkind: `rss`, `page`, or blank to detect.');
        const k = kind && ['rss', 'page'].includes(kind.toLowerCase()) ? kind.toLowerCase() : null;
        await env.DB.prepare(`INSERT OR REPLACE INTO feeds (url, label, kind) VALUES (?, ?, ?)`)
          .bind(url, label || url, k)
          .run();
        return send(env, chatId, `Feed added: ${label || url} [${k ?? 'auto'}]`);
      }

      case '/scan': {
        // `/scan <url>` parses one page on demand; `/scan quick` skips opening
        // articles, which is faster but only sees what the feed summary says.
        if (/^https?:\/\//i.test(args.trim())) {
          const hit = await scanUrl(env, args.trim());
          if (!hit) return send(env, chatId, 'Could not read that page.');
          await pushFeedItem(env, chatId, hit);
          if (hit.topic !== 'promo')
            await send(env, chatId, 'Nothing in that page reads like a card offer — track it anyway if you disagree.');
          return;
        }
        const deep = args.trim().toLowerCase() !== 'quick';
        await send(env, chatId, deep ? 'Scanning feeds and opening articles…' : 'Scanning feed summaries…');
        const scan = await scanFeedsDetailed(env, { deep });
        for (const item of scan.fresh) await pushFeedItem(env, chatId, item);
        const stats =
          `${scan.feeds_read} source${scan.feeds_read === 1 ? '' : 's'} · ${scan.items_seen} new item(s) · ` +
          `${scan.pages_fetched} page(s) opened` +
          (scan.feeds_failed.length ? `\n⚠️ unreachable: ${scan.feeds_failed.join(', ')}` : '');
        await send(env, chatId, (scan.fresh.length ? `${scan.fresh.length} match(es).` : 'No new promo items.') + `\n${stats}`);
        return;
      }

      // Housekeeping for the scanner's history — the only table that grows
      // without you doing anything.
      // The wallet half of logging spend: what is earned but not yet banked.
      case '/credit': {
        const pending = await pendingCredits(env);
        const arg = args.trim().toLowerCase();

        if (!arg) {
          if (!pending.credits.length && !pending.unassigned.length)
            return send(env, chatId, 'Nothing waiting. Points are added when you accept them here.');
          const lines = pending.by_program.map(
            (g) => `*${g.program_name}* — ${g.points.toLocaleString()} ${g.unit} from ${g.count} purchase(s)`
          );
          const recent = pending.credits
            .slice(0, 8)
            .map((c) => `  #${c.id} ${c.date} ${c.merchant ?? '—'} · ${c.miles.toLocaleString()} ${c.unit}`);
          const orphan = pending.unassigned.map(
            (u) =>
              `⚠️ ${u.card} earned ${u.miles.toLocaleString()} with no programme set — \`/setprogram ${u.nickname} <programme>\``
          );
          return send(
            env,
            chatId,
            ['*Waiting to be banked*', ...lines, '', ...recent, ...orphan, '', '`/credit all` · `/credit <programme>`']
              .filter(Boolean)
              .join('\n')
          );
        }

        const ids =
          arg === 'all'
            ? pending.credits.map((c) => c.id)
            : pending.credits.filter((c) => c.program_key.toLowerCase() === arg).map((c) => c.id);
        if (!ids.length) return send(env, chatId, arg === 'all' ? 'Nothing waiting.' : `Nothing waiting for \`${arg}\`.`);

        const res = await acceptCredits(env, ids);
        const w = await wallet(env);
        return send(
          env,
          chatId,
          `Banked ${res.points.toLocaleString()} from ${res.accepted} purchase(s).\n` +
            w.programs
              .filter((p) => p.points > 0)
              .map((p) => `${p.name}: ${p.points.toLocaleString()} ${p.unit}`)
              .join('\n') +
            '\n\n`/undocredit <txn id>` if a bank credits something different.'
        );
      }

      case '/undocredit': {
        const id = parseInt(args, 10);
        if (!id) return send(env, chatId, 'Format: `/undocredit <transaction id>`');
        const ok = await undoCredit(env, id);
        return send(env, chatId, ok ? `Taken back out of the wallet (#${id}).` : `#${id} was not credited.`);
      }

      case '/setprogram': {
        const [nick, key] = args.split(/\s+/).map((x) => x?.trim());
        if (!nick) return send(env, chatId, 'Format: `/setprogram <card> <programme key>` · `/routes` lists programmes.');
        const card = await cardByNick(env, nick);
        if (!card) return send(env, chatId, `No card with nickname \`${nick}\`.`);
        if (key && key !== 'none') {
          const prog = await env.DB.prepare(`SELECT key, name FROM programs WHERE key = ?`).bind(key).first<any>();
          if (!prog) return send(env, chatId, `No programme \`${key}\`. \`/routes\` lists them.`);
        }
        await env.DB.prepare(`UPDATE cards SET program_key = ? WHERE id = ?`)
          .bind(key && key !== 'none' ? key : null, card.id)
          .run();
        return send(
          env,
          chatId,
          key && key !== 'none'
            ? `*${card.product}* now earns into \`${key}\`. Past purchases keep the programme they were logged with.`
            : `*${card.product}* no longer has a programme.`
        );
      }

      case '/wallet': {
        const w = await wallet(env);
        const lines = w.programs
          .filter((p) => p.points > 0 || p.pending > 0)
          .map(
            (p) =>
              `*${p.name}* ${p.points.toLocaleString()} ${p.unit}` +
              (p.miles_equivalent !== null && p.unit !== 'miles' ? ` ≈ ${p.miles_equivalent.toLocaleString()} miles` : '') +
              (p.pending ? ` · ${p.pending.toLocaleString()} waiting` : '') +
              (p.expiring_soon ? `\n  ⚠️ ${p.expiring_soon.toLocaleString()} expiring by ${p.next_expiry}` : '')
          );
        if (!lines.length) return send(env, chatId, 'Wallet is empty. `/addbal` records a balance; `/credit` banks what you earn.');
        return send(
          env,
          chatId,
          ['*Wallet*', ...lines, '', `Worth about $${money(w.totals.value_cents)} at your mile value.`].join('\n')
        );
      }

      case '/prune': {
        const store = await feedStorage(env);
        const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
        const arg = args.trim().toLowerCase();

        if (!arg) {
          return send(
            env,
            chatId,
            `*Scanned history*\n` +
              `${store.total} item(s) — ${store.undecided} waiting, ${store.tracked} tracked, ${store.ignored} ignored\n` +
              `Text stored: ${kb(store.text_bytes)}\n` +
              `Compactable now: ${store.compactable} item(s), about ${kb(store.reclaimable_bytes)}\n\n` +
              '`/prune compact` — drop the bulk of judged items older than ' +
              `${store.retention_days} days, keeping the ids so they are never shown again (this runs nightly anyway)\n` +
              '`/prune delete` — remove ignored items outright. They are then forgotten, so anything still in a feed comes back on the next scan.\n' +
              '`/prune offers` — mark ended offers expired and remove the old ones.'
          );
        }

        if (arg === 'compact') {
          const r = await purgeFeedItems(env, { mode: 'compact', scope: 'decided', older_than_days: retentionDays(env) });
          return send(env, chatId, `Compacted ${r.affected} item(s), freeing about ${kb(r.freed_bytes)}.`);
        }
        if (arg === 'offers') {
          const sweep = await sweepExpiredOffers(env, today(env));
          return send(
            env,
            chatId,
            `Marked ${sweep.expired} offer(s) expired` +
              (sweep.deleted ? ` and deleted ${sweep.deleted} that ended over ${sweep.retention_days} days ago.` : '.')
          );
        }
        if (arg === 'delete') {
          const r = await purgeFeedItems(env, { mode: 'delete', scope: 'ignored' });
          return send(
            env,
            chatId,
            `Deleted ${r.affected} ignored item(s), freeing about ${kb(r.freed_bytes)}.\n` +
              'Those are now forgotten — if a feed still carries one, the next scan will show it again.'
          );
        }
        return send(env, chatId, 'Use `/prune`, `/prune compact`, `/prune delete` or `/prune offers`.');
      }

      case '/recent': {
        const { results } = await env.DB.prepare(
          `SELECT t.id, t.amount_cents, t.occurred_at, t.posted_at, t.merchant, c.nickname
           FROM transactions t JOIN cards c ON c.id = t.card_id
           ORDER BY COALESCE(t.posted_at, t.occurred_at) DESC, t.id DESC LIMIT 15`
        ).all<any>();
        if (!results?.length) return send(env, chatId, 'No transactions yet.');
        return send(
          env,
          chatId,
          '*Recent*\n' +
            results
              .map(
                (r) =>
                  `#${r.id} ${r.occurred_at}${r.posted_at ? ` → ${r.posted_at}` : ' ⏳'} *${r.nickname}* ` +
                  `$${money(r.amount_cents)}${r.merchant ? ` — ${r.merchant}` : ''}`
              )
              .join('\n') +
            '\n\n⏳ = posting date not confirmed.' +
            '\n`/posted <id> <date>` to set it · `/del <id>` to remove.'
        );
      }

      case '/posted': {
        // 'today' and the other date words work here too.
        const m = args.trim().split(/\s+/);
        const id = parseInt(m[0], 10);
        const when = m[1] ? parseDateToken(m[1], env) : today(env);
        if (!id || !when) return send(env, chatId, 'Format: `/posted 12 2026-09-22` (or `today`, `yesterday`, `-2`).');
        const row = await env.DB.prepare(`SELECT * FROM transactions WHERE id = ?`).bind(id).first<any>();
        if (!row) return send(env, chatId, `No transaction #${id}.`);
        if (when < row.occurred_at)
          return send(env, chatId, `A transaction cannot post (${when}) before it happened (${row.occurred_at}).`);
        await env.DB.prepare(`UPDATE transactions SET posted_at = ? WHERE id = ?`).bind(when, id).run();
        return send(
          env,
          chatId,
          `#${id} posted ${when}` + (when === row.occurred_at ? '.' : ` (made ${row.occurred_at}).`) + '\nWindows now use the posting date.'
        );
      }

      case '/del':
      case '/undo': {
        const id = cmd === '/undo' ? null : parseInt(args, 10);
        const row = id
          ? await env.DB.prepare(`SELECT * FROM transactions WHERE id = ?`).bind(id).first<any>()
          : await env.DB.prepare(`SELECT * FROM transactions ORDER BY id DESC LIMIT 1`).first<any>();
        if (!row) return send(env, chatId, id ? `No transaction #${id}.` : 'Nothing to undo.');
        await env.DB.prepare(`DELETE FROM transactions WHERE id = ?`).bind(row.id).run();
        return send(env, chatId, `Deleted #${row.id} — $${money(row.amount_cents)} on ${row.occurred_at}.`);
      }

      case '/which': {
        const [rawCat, amt] = args.trim().split(/\s+/);
        const cents = amt ? parseMoney(amt) : null;
        const cards = await activeCards(env);
        if (!cards.length) return send(env, chatId, 'No cards yet.');

        // A minimum about to lapse can be worth more than a better rate.
        const nudges: { cardId: number; remaining: number; daysLeft: number }[] = [];
        for (const c of cards) {
          for (const r of await requirementsFor(env, c.id)) {
            const p = await requirementProgress(env, c, r);
            if (!p.met) nudges.push({ cardId: c.id, remaining: p.remaining_cents, daysLeft: p.days_left });
          }
        }

        // With no category, show the winner for each category you have rules for.
        if (!rawCat) {
          const { results: cats } = await env.DB.prepare(
            `SELECT DISTINCT category FROM earn_rules WHERE active = 1 AND category <> '*' ORDER BY category`
          ).all<{ category: string }>();
          if (!cats?.length)
            return send(env, chatId, 'No earn rules yet.\nStart with `/addearn <card> <category> <rate>` — see /help.');

          const lines: string[] = ['*Best card by category*', ''];
          for (const { category } of cats) {
            const top = (await rankCards(env, category, null, { cards, minSpendNudge: nudges }))[0];
            if (!top) continue;
            lines.push(
              `*${category}* — ${top.card.product}` +
                ` (${formatRate(top.effective_mpd, top.reward_type)})`
            );
          }
          lines.push('', '_`/which <category or merchant> <amount>` for detail._');
          return send(env, chatId, lines.join('\n'));
        }

        // The argument may be a merchant you have tagged before, not a category.
        const asMerchant = await categoryForMerchant(env, rawCat);
        const category = (asMerchant ?? rawCat).toLowerCase();

        const picks = await rankCards(env, category, cents, { cards, minSpendNudge: nudges });
        if (!picks.length)
          return send(env, chatId, 'No earn rules yet.\nStart with `/addearn <card> <category> <rate>` — see /help.');

        const header =
          `*${category}*${asMerchant ? ` _(${rawCat})_` : ''}${cents ? ` · $${money(cents)}` : ''}`;

        const lines = picks.map((p, i) => {
          const rate = formatRate(p.effective_mpd, p.reward_type);
          const earned =
            cents === null
              ? ''
              : p.reward_type === 'cashback'
                ? ` · $${money(p.cashback_cents ?? 0)} back`
                : ` · ${(p.miles ?? 0).toLocaleString()} miles`;
          // Both card types get a cash value, which is the only fair comparison.
          const worth = cents !== null ? ` _(≈$${money(Math.round(p.value_cents))})_` : '';
          const why = p.reasons.length ? '\n     _' + p.reasons.join('; ') + '_' : '';
          return `${i === 0 ? '👉' : '  '} *${p.card.product}* — ${rate}${earned}${worth}${why}`;
        });

        const mv = parseFloat(env.MILE_VALUE_CENTS || '1.5');
        return send(
          env,
          chatId,
          `${header}\n\n${lines.join('\n')}` +
            (picks.some((p) => p.reward_type === 'cashback') && picks.some((p) => p.reward_type === 'miles')
              ? `\n\n_Compared at ${mv}¢ per mile._`
              : '')
        );
      }

      case '/transfer': {
        // points from to  — actually moves them, unlike /convert which plans.
        const [ptsRaw, from, to] = args.trim().split(/\s+/);
        const pts = parseInt((ptsRaw ?? '').replace(/,/g, ''), 10);
        if (!pts || !from || !to)
          return send(env, chatId, 'Format: `/transfer 50000 citi_ty krisflyer`\nUse /convert first to compare routes.');
        const plans = await planRoutes(env, pts, from, to);
        const best = plans.find((p) => p.possible);
        if (!best) return send(env, chatId, plans[0]?.reason ?? `No route from ${from} to ${to}.`);

        const r = await executeTransfer(env, best.conversion.id, pts);
        if (!r.ok) return send(env, chatId, `Could not transfer: ${r.error}`);
        const used = (r.consumed ?? [])
          .map((c) => `${c.points.toLocaleString()} expiring ${c.expires_at ?? 'never'}`)
          .join(', ');
        return send(
          env,
          chatId,
          `Transferred ${r.plan!.transferable.toLocaleString()} ${from} → ` +
            `*${r.plan!.miles.toLocaleString()} ${to}*` +
            (r.plan!.fee_cents ? ` · fee $${money(r.plan!.fee_cents)}` : ' · free') +
            `\n\nTaken from: ${used}` +
            (r.plan!.stranded ? `\n${r.plan!.stranded.toLocaleString()} left behind (below a block)` : '') +
            '\n\n/bal to see the new balances.'
        );
      }

      case '/expiry': {
        const rows = await tranchesByExpiry(env);
        if (!rows.length) return send(env, chatId, 'No balances recorded. /addbal to start.');
        return send(
          env,
          chatId,
          '*By expiry, soonest first*\n' +
            rows
              .map(
                (r: any) =>
                  `${r.expires_at ?? 'no expiry'}${r.days_left !== null ? ` _(${r.days_left}d)_` : ''} — ` +
                  `*${r.points.toLocaleString()}* ${r.name}` +
                  (r.note ? `\n  _${r.note}_` : '')
              )
              .join('\n')
        );
      }

      case '/review': {
        const { results } = await env.DB.prepare(
          `SELECT t.id, t.amount_cents, t.occurred_at, t.posted_at, t.merchant, c.nickname
           FROM transactions t JOIN cards c ON c.id = t.card_id
           WHERE t.amount_cents > 0 AND t.category IS NULL
           ORDER BY t.posted_at IS NULL, t.occurred_at DESC LIMIT 20`
        ).all<any>();
        if (!results?.length) return send(env, chatId, 'Everything is categorised.');
        const ready = results.filter((r: any) => r.posted_at);
        const waiting = results.filter((r: any) => !r.posted_at);
        const line = (r: any) =>
          `#${r.id} ${r.occurred_at} *${r.nickname}* $${money(r.amount_cents)}${r.merchant ? ` — ${r.merchant}` : ''}`;
        const out: string[] = [];
        if (ready.length) {
          out.push('*Ready to categorise*', '_Posted, so the bank can tell you the MCC._', ...ready.map(line), '');
        }
        if (waiting.length) {
          out.push('*Waiting to post*', '_The MCC is not knowable until it posts._', ...waiting.map(line), '');
        }
        out.push('`/cat <id> <category>` to set one.');
        return send(env, chatId, out.join('\n'));
      }

      case '/cat': {
        const [idRaw, catRaw] = args.trim().split(/\s+/);
        const id = parseInt(idRaw, 10);
        if (!id || !catRaw) return send(env, chatId, 'Format: `/cat 42 groceries`');
        const cat = catRaw.toLowerCase();
        const row = await env.DB.prepare(`SELECT merchant FROM transactions WHERE id = ?`)
          .bind(id)
          .first<{ merchant: string | null }>();
        if (!row) return send(env, chatId, `No transaction #${id}.`);
        await rememberMerchant(env, row.merchant, cat);
        await env.DB.prepare(
          `UPDATE transactions SET category = ?, category_source = 'manual', needs_review = 0 WHERE id = ?`
        )
          .bind(cat, id)
          .run();
        return send(
          env,
          chatId,
          `#${id} is now *${cat}*.` + (row.merchant ? `\n${row.merchant} will categorise itself from now on.` : '')
        );
      }

      case '/bal': {
        const rows = await balances(env);
        if (!rows.length) return send(env, chatId, 'No programmes yet. /addbal to record a balance.');
        return send(
          env,
          chatId,
          '*Balances*\n' +
            rows
              .map(
                (r) =>
                  `*${r.name}* ${r.total.toLocaleString()} ${r.unit}` +
                  (r.expiring_soon > 0 ? `\n  ⏳ ${r.expiring_soon.toLocaleString()} expire by ${r.next_expiry}` : '')
              )
              .join('\n')
        );
      }

      case '/addbal': {
        // program|points|expires_at|note
        const [prog, pts, exp, note] = args.split('|').map((s) => s.trim());
        if (!prog || !pts) return send(env, chatId, 'Format: `/addbal citi_ty|50000|2027-03-31|statement balance`');
        await env.DB.prepare(
          `INSERT INTO balance_tranches (program_key, points, earned_at, expires_at, note) VALUES (?, ?, ?, ?, ?)`
        )
          .bind(prog, parseInt(pts.replace(/,/g, ''), 10), today(env), exp || null, note || null)
          .run();
        return send(env, chatId, `Recorded ${parseInt(pts.replace(/,/g, ''), 10).toLocaleString()} in ${prog}. /bal to check.`);
      }

      case '/convert': {
        const [ptsRaw, from, to] = args.trim().split(/\s+/);
        const pts = parseInt((ptsRaw ?? '').replace(/,/g, ''), 10);
        if (!pts || !from || !to) return send(env, chatId, 'Format: `/convert 50000 citi_ty krisflyer`');
        const plans = await planRoutes(env, pts, from, to);
        if (!plans.length) return send(env, chatId, `No route from ${from} to ${to}. Add one with /addconv.`);

        const out = plans.map((p) => {
          const c = p.conversion;
          if (!p.possible) return `✖ *${c.route ?? 'route'}* — ${p.reason}`;
          return (
            `*${c.route ?? 'route'}* → ${p.miles.toLocaleString()} miles` +
            (p.bonus_miles ? ` _(incl. ${p.bonus_miles.toLocaleString()} bonus)_` : '') +
            `\n  ${p.transferable.toLocaleString()} transferred in ${c.block_increment.toLocaleString()} blocks` +
            (p.stranded ? `, ${p.stranded.toLocaleString()} stranded` : '') +
            `\n  fee $${money(p.fee_cents)}` +
            (p.fee_cents ? ` · ${p.cents_per_mile.toFixed(3)}¢ per mile` : ' · free')
          );
        });
        return send(env, chatId, `*${pts.toLocaleString()} ${from} → ${to}*\n\n` + out.join('\n\n'));
      }

      case '/migrate': {
        const r = await runMigrations(env);
        const bits: string[] = [];
        if (r.created.length) bits.push(`Created: ${r.created.join(', ')}`);
        if (r.altered.length) bits.push(`Added columns: ${r.altered.join(', ')}`);
        if (r.alreadyCurrent) bits.push('Database already up to date.');
        if (r.errors.length) bits.push(`\nProblems:\n${r.errors.join('\n')}`);
        else if (!r.alreadyCurrent) bits.push('\nRun /seed to load the default feeds and transfer routes.');
        return send(env, chatId, bits.join('\n'));
      }

      case '/seed': {
        const r = await runSeed(env);
        return send(
          env,
          chatId,
          `Seed applied (${r.applied} statements).` +
            (r.errors.length ? `\n\nProblems:\n${r.errors.join('\n')}` : '\n/routes and /feeds to see what loaded.')
        );
      }

      case '/optimise':
      case '/optimize': {
        const o = await optimise(env, 3);
        const lines: string[] = [`*Portfolio check* — ${o.months_analysed} month(s) of history`, ''];
        if (o.reallocations.length) {
          lines.push(`*Worth moving* — about $${money(o.total_gain_cents_year)} a year`);
          for (const r of o.reallocations.slice(0, 5)) {
            lines.push(
              `• *${r.category}* — $${money(r.monthly_cents)}/mo on ${r.from_card} (${r.from_rate})\n` +
                `  → ${r.to_card} (${r.to_rate}) = +$${money(r.gain_cents_year)}/yr` +
                (r.gain_miles_year ? ` · ${r.gain_miles_year.toLocaleString()} miles` : '') +
                (r.capped_by ? `\n  _${r.capped_by}_` : '')
            );
          }
          lines.push('');
        }
        if (o.underused.length) {
          lines.push('*Allowances going unused*');
          for (const u of o.underused.slice(0, 4)) {
            lines.push(
              `• *${u.card}* ${u.category} — $${money(u.typical_used_cents)} of $${money(u.cap_cents)} (${u.utilisation_pct}%)` +
                (u.better_category
                  ? `\n  _You spend $${money(u.better_category.monthly_cents)}/mo on ${u.better_category.category}. ` +
                    `Switching this card's category there is worth about $${money(u.better_category.gain_cents_year)}/yr._`
                  : '')
            );
          }
          lines.push('');
        }
        for (const n of o.notes) lines.push(`_${n}_`);
        if (!o.reallocations.length && !o.underused.length && !o.notes.length) {
          lines.push('Nothing to suggest yet — log a few months of categorised spend first.');
        }
        return send(env, chatId, lines.join('\n'));
      }

      case '/rates':
        // On demand, always the full report rather than the quiet daily one.
        return send(env, chatId, (await ratesReview(env, { quiet: false })) ?? 'Nothing to flag.');

      case '/routes': {
        const { results } = await env.DB.prepare(
          `SELECT c.*, pf.name AS from_name, pt.name AS to_name FROM conversions c
           JOIN programs pf ON pf.key = c.from_program JOIN programs pt ON pt.key = c.to_program
           WHERE c.active = 1 ORDER BY pf.name, c.id`
        ).all<any>();
        if (!results?.length) return send(env, chatId, 'No routes configured.');
        return send(
          env,
          chatId,
          '*Transfer routes*\n' +
            results
              .map(
                (c) =>
                  `#${c.id} ${c.from_name} → ${c.to_name}${c.route ? ` (${c.route})` : ''}\n` +
                  `  ${c.from_units.toLocaleString()} → ${c.to_units.toLocaleString()} · fee $${money(c.fee_cents)} · min ${c.min_block.toLocaleString()}\n` +
                  `  ${c.verified_at ? `verified ${c.verified_at}` : '❓ never verified'}${c.note ? ` · _${c.note}_` : ''}`
              )
              .join('\n')
        );
      }

      case '/verified': {
        const [idRaw, dateRaw] = args.trim().split(/\s+/);
        const id = parseInt(idRaw, 10);
        const when = dateRaw ? parseDateToken(dateRaw, env) : today(env);
        if (!id || !when) return send(env, chatId, 'Format: `/verified 4` (or `/verified 4 2026-09-01`).');
        const r = await env.DB.prepare(`UPDATE conversions SET verified_at = ?, note = NULL WHERE id = ?`)
          .bind(when, id)
          .run();
        if (!(r.meta.changes ?? 0)) return send(env, chatId, `No route #${id}. /routes to list them.`);
        return send(env, chatId, `Route #${id} marked verified ${when}.`);
      }

      case '/setrate': {
        // id|from_units|to_units|fee|min_block|increment
        const p = args.split('|').map((s) => s.trim());
        if (p.length < 6) return send(env, chatId, 'Format: `/setrate 4|5000|10000|27.25|5000|5000`');
        const [idRaw, fu, tu, fee, minB, inc] = p;
        const r = await env.DB.prepare(
          `UPDATE conversions SET from_units=?, to_units=?, fee_cents=?, min_block=?, block_increment=?,
             verified_at=?, note=NULL WHERE id=?`
        )
          .bind(parseInt(fu, 10), parseInt(tu, 10), parseMoney(fee) ?? 0, parseInt(minB, 10), parseInt(inc, 10), today(env), parseInt(idRaw, 10))
          .run();
        if (!(r.meta.changes ?? 0)) return send(env, chatId, `No route #${parseInt(idRaw, 10)}.`);
        return send(env, chatId, `Route #${parseInt(idRaw, 10)} updated and marked verified.`);
      }

      case '/setbonus': {
        // id|pct|until
        const [idRaw, pct, until] = args.split('|').map((s) => s.trim());
        if (!idRaw || !pct) return send(env, chatId, 'Format: `/setbonus 2|8|2026-12-31` — use 0 to clear.');
        await env.DB.prepare(`UPDATE conversions SET bonus_pct = ?, bonus_until = ? WHERE id = ?`)
          .bind(parseFloat(pct), until || null, parseInt(idRaw, 10))
          .run();
        return send(env, chatId, `Route #${parseInt(idRaw, 10)}: ${pct}% bonus${until ? ` until ${until}` : ''}.`);
      }

      case '/earn': {
        const { results } = await env.DB.prepare(
          `SELECT e.*, c.nickname FROM earn_rules e JOIN cards c ON c.id = e.card_id
           WHERE e.active = 1 ORDER BY c.nickname, e.mpd DESC`
        ).all<any>();
        if (!results?.length) return send(env, chatId, 'No earn rules yet. /addearn to add one.');
        return send(
          env,
          chatId,
          '*Earn rules*\n' +
            results
              .map(
                (r) =>
                  `#${r.id} *${r.nickname}* ${r.category} → ${formatRate(r.mpd, r.reward_type)}` +
                  (r.cap_cents ? ` (cap $${money(r.cap_cents)}/${r.cap_window ?? 'cycle'}${r.cap_group ? `, shared: ${r.cap_group}` : ''})` : '') +
                  (r.note ? `\n     _${r.note}_` : '')
              )
              .join('\n')
        );
      }

      case '/addearn': {
        // Readable form:  citirw shopping 4 cap 1000 group tenx window statement_cycle
        // A rate ending in % means cashback; anything else means miles.
        // The older pipe form still works.
        let nick: string, cat: string, rateRaw: string;
        let cap: string | undefined;
        let capWindow: string | undefined;
        let capGroup: string | undefined;
        let note: string | undefined;

        if (args.includes('|')) {
          const p = args.split('|').map((s) => s.trim());
          [nick, cat, rateRaw, cap, capWindow, capGroup, note] = p;
        } else {
          const tok = args.trim().split(/\s+/);
          if (tok.length < 3)
            return send(
              env,
              chatId,
              '*Add an earn rule*\n`/addearn <card> <category> <rate>`\n\n' +
                'Examples:\n' +
                '`/addearn citirw shopping 4` — 4 miles per dollar\n' +
                '`/addearn uobone groceries 5%` — 5% cashback\n' +
                '`/addearn citirw shopping 4 cap 1000` — bonus rate stops after $1,000\n' +
                '`/addearn citirw online 4 cap 1000 group tenx` — shares that cap with other `tenx` rules\n' +
                '`/addearn citirw * 0.4` — the fallback rate for everything else\n\n' +
                'Extras, in any order: `cap <amount>`, `window <statement_cycle|calendar_month|calendar_quarter>`, `group <name>`, `note <text>`'
            );
          [nick, cat, rateRaw] = tok;
          for (let i = 3; i < tok.length; i += 2) {
            const k = tok[i].toLowerCase();
            const v = tok[i + 1];
            if (k === 'cap') cap = v;
            else if (k === 'window') capWindow = v;
            else if (k === 'group') capGroup = v;
            else if (k === 'note') {
              note = tok.slice(i + 1).join(' ');
              break;
            }
          }
        }

        const card = await cardByNick(env, nick);
        if (!card) return send(env, chatId, `No card with nickname \`${nick}\`. /cards to list them.`);

        const isCashback = /%$/.test(rateRaw ?? '');
        const rate = parseFloat((rateRaw ?? '').replace('%', ''));
        if (!Number.isFinite(rate)) return send(env, chatId, `Could not read a rate from "${rateRaw}".`);

        await env.DB.prepare(
          `INSERT INTO earn_rules (card_id, category, mpd, reward_type, cap_cents, cap_window, cap_group, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            card.id,
            cat.toLowerCase(),
            rate,
            isCashback ? 'cashback' : 'miles',
            cap ? parseMoney(cap) : null,
            capWindow || (cap ? 'statement_cycle' : null),
            capGroup || null,
            note || null
          )
          .run();

        return send(
          env,
          chatId,
          `*${card.product}* earns ${formatRate(rate, isCashback ? 'cashback' : 'miles')} on *${cat}*` +
            (cap ? `, up to $${money(parseMoney(cap) ?? 0)} per ${capWindow || 'statement_cycle'}` : '') +
            (capGroup ? `\n_Shares that cap with other \`${capGroup}\` rules._` : '') +
            '\n\nTry `/which ' + cat.toLowerCase() + ' 100`.'
        );
      }

      case '/cardrules': {
        const card = await cardByNick(env, args.trim());
        if (!card) return send(env, chatId, 'Format: `/cardrules citirw` — use /cards for nicknames.');
        await send(env, chatId, `Open ${card.product}'s rewards page, then paste this into Claude with it:`);
        return send(env, chatId, cardRulesPrompt(card.nickname, card.product), { parse_mode: undefined });
      }

      case '/merchants': {
        const { results } = await env.DB.prepare(
          `SELECT merchant, category, hits FROM merchant_categories ORDER BY hits DESC, merchant LIMIT 30`
        ).all<any>();
        if (!results?.length)
          return send(env, chatId, 'Nothing learned yet. Tag a merchant once: `25.40 citirw #groceries NTUC`');
        return send(
          env,
          chatId,
          '*Learned merchants*\n' + results.map((r) => `${r.merchant} → ${r.category} _(${r.hits}×)_`).join('\n')
        );
      }

      case '/delearn':
        await env.DB.prepare(`UPDATE earn_rules SET active = 0 WHERE id = ?`).bind(parseInt(args, 10)).run();
        return send(env, chatId, `Earn rule #${parseInt(args, 10)} removed.`);

      case '/addconv': {
        // from|to|from_units|to_units|fee|min_block|increment|route
        const p = args.split('|').map((s) => s.trim());
        if (p.length < 7)
          return send(env, chatId, 'Format: `/addconv citi_ty|krisflyer|25000|10000|27.25|25000|25000|direct`');
        const [from, to, fu, tu, fee, minB, inc, route] = p;
        await env.DB.prepare(
          `INSERT INTO conversions (from_program, to_program, from_units, to_units, fee_cents, min_block, block_increment, route)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(from, to, parseInt(fu, 10), parseInt(tu, 10), parseMoney(fee) ?? 0, parseInt(minB, 10), parseInt(inc, 10), route || null)
          .run();
        return send(env, chatId, `Route added: ${from} → ${to} via ${route || 'direct'}.`);
      }

      case '/add':
        return logSpend(env, chatId, args);

      default:
        // Anything that isn't a command is treated as a spend entry.
        if (!text.startsWith('/')) return logSpend(env, chatId, text);
        return send(env, chatId, `Unknown command. /help`);
    }
  } catch (err) {
    await send(env, chatId, `Error: ${(err as Error).message}`);
  }
}

/**
 * Accepts the amount, card and date in any order, with the date optional:
 *   25.40 uobone lunch              -> today
 *   25.40 uobone yesterday lunch
 *   25.40 uobone 2026-09-05 lunch
 *   25.40 uobone 5/9 lunch          -> day/month
 *   25.40 uobone -3 lunch           -> three days ago
 * Whatever is left over becomes the note.
 */
async function logSpend(env: Env, chatId: string, input: string) {
  const tokens = input.trim().split(/\s+/);
  if (tokens.length < 2) return send(env, chatId, 'Format: `25.40 uobone lunch` — add a date like `yesterday` or `5/9` to backdate.');

  let amount: number | null = null;
  let occurred: string | null = null;
  let category: string | null = null;
  const rest: string[] = [];

  for (const tok of tokens) {
    if (tok.startsWith('#') && tok.length > 1) {
      category = tok.slice(1).toLowerCase();
      continue;
    }
    if (amount === null) {
      const m = parseMoney(tok);
      if (m !== null) {
        amount = m;
        continue;
      }
    }
    if (occurred === null) {
      const d = parseDateToken(tok, env);
      if (d !== null) {
        occurred = d;
        continue;
      }
    }
    rest.push(tok);
  }

  if (amount === null) return send(env, chatId, `Could not read an amount from "${input}".`);
  if (!rest.length) return send(env, chatId, 'Which card? e.g. `25.40 uobone lunch`');

  const nick = rest[0];
  const note = rest.slice(1).join(' ');
  const date = occurred ?? today(env);

  if (date > today(env)) {
    return send(env, chatId, `${date} is in the future — check the date and try again.`);
  }

  const card = await cardByNick(env, nick);
  if (!card) return send(env, chatId, `No card with nickname \`${nick}\`. /cards to list them.`);

  // Tagging a merchant once is enough: later spend there categorises itself.
  // '#?' is an explicit "I don't know yet" — better than a guess, because a
  // wrong category quietly corrupts the cap tracking and the wrong-card advice.
  let resolved = category === '?' || category === 'unknown' ? null : category;
  let learned = false;
  let source: string | null = null;
  if (resolved) {
    source = 'manual';
    await rememberMerchant(env, note, resolved);
  } else if (note && category === null) {
    resolved = await categoryForMerchant(env, note);
    learned = resolved !== null;
    if (resolved) source = 'learned';
  }

  // The same evaluation the dashboard does. Logging through the bot used to
  // store no prediction at all, which left the reward audit with nothing to
  // reconcile and the wallet with nothing to credit.
  const guess = note ? await lookupMerchant(env, note) : null;
  const mcc = guess?.mcc ?? null;
  const channel = guess?.channel ?? null;
  if (!resolved && guess?.category) {
    resolved = guess.category;
    source = 'learned';
    learned = true;
  }
  const expected = await evaluate(env, card, { amount_cents: amount, mcc, category: resolved, channel });
  const program = expected.miles > 0 ? await programForCard(env, card.id, expected.rule?.id) : null;

  const ins = await env.DB.prepare(
    `INSERT INTO transactions (card_id, amount_cents, occurred_at, merchant, category, category_source,
       needs_review, mcc, channel, expected_miles, expected_cashback_cents, expected_program, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`
  )
    .bind(
      card.id, amount, date, note || null, resolved, source, resolved ? 0 : 1,
      mcc, channel, expected.miles, expected.cashback_cents, program
    )
    .run();

  // Immediate feedback: what this swipe did to the limit and to any minimum.
  const reqs = await requirementsFor(env, card.id);
  const when = date === today(env) ? '' : ` on ${date}`;
  const bits: string[] = [
    `Logged $${money(amount)} to *${card.product}*${when}.` +
      (resolved ? ` #${resolved}${learned ? ' _(remembered)_' : ''}` : ' _(no category — /review)_') +
      ` (#${ins.meta.last_row_id})`,
  ];
  // What it earned, and whether that is waiting to go into the wallet.
  if (expected.miles > 0) {
    bits.push(
      `Earns ~${expected.miles.toLocaleString()} ${expected.reward_type === 'miles' ? 'miles' : 'points'}` +
        (program
          ? ` → ${program}. \`/credit\` to add it to your balance.`
          : ` — no programme set for this card, so it cannot be banked. \`/setprogram ${card.nickname} <programme>\``)
    );
  } else if (expected.cashback_cents > 0) {
    bits.push(`Earns ~$${money(expected.cashback_cents)} cashback.`);
  }
  for (const req of reqs) {
    const p = await requirementProgress(env, card, req);
    if (p.met) {
      bits.push(`✅ ${req.kind === 'signup_min' ? 'Sign-up' : 'Minimum'} met.`);
    } else {
      const left: string[] = [];
      if (p.remaining_cents > 0) left.push(`$${money(p.remaining_cents)}`);
      if (p.txns_remaining > 0) left.push(`${p.txns_remaining} txn(s)`);
      bits.push(`${left.join(' and ')} to go on the ${req.kind === 'signup_min' ? 'sign-up' : 'minimum'} (${p.days_left}d).`);
    }
  }
  // A backdated entry can land outside the window a requirement measures, so
  // say so rather than leave the unchanged totals looking like a failed write.
  if (date !== today(env)) bits.push('_Backdated — totals only move if it falls inside the current window._');
  // Banks count the posting date, so near a boundary this entry may not land
  // in the window it appears to.
  const near = await requirementsFor(env, card.id);
  const lag = parseInt(env.POSTING_LAG_DAYS || '0', 10);
  const boundary = near.length
    ? (await requirementProgress(env, card, near[0])).window.end
    : (await utilization(env, card)).cycle.end;
  if (lag > 0 && daysBetween(date, boundary) <= lag && date <= boundary) {
    bits.push(`⏳ Close to ${boundary} — may post after it. \`/posted ${ins.meta.last_row_id} <date>\` once you see it.`);
  }
  await send(env, chatId, bits.join('\n'));

  for (const alert of await checkAlerts(env, card)) await send(env, chatId, alert);
}

async function handleCallback(env: Env, cq: any, _origin: string) {
  const chatId = String(cq.message.chat.id);
  if (env.OWNER_CHAT_ID && chatId !== env.OWNER_CHAT_ID) return;

  const [action, idStr] = String(cq.data).split(':');
  const id = parseInt(idStr, 10);

  if (action === 'ignore') {
    await ignoreFeedItem(env, id);
    return answerCallback(env, cq.id, 'Ignored');
  }

  if (action === 'track') {
    const offerId = await trackFeedItem(env, id);
    if (!offerId) return answerCallback(env, cq.id, 'Gone');
    await answerCallback(env, cq.id, `Tracked as offer #${offerId}`);
    await send(env, chatId, `Tracked as offer #${offerId}. Run \`/extract ${offerId}\` to get the prompt for Claude.`);
  }
}
