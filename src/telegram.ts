import { mintToken } from './auth';
import { buildDigest, checkAlerts } from './digest';
import { cardRulesPrompt, COMMANDS, extractionPrompt, HELP } from './extraction';
import { decideRule, evaluateOffer } from './eligibility';
import { daysUntil, OFFER_STATUSES, parseExtraction, saveExtraction, sweepExpiredOffers, type OfferStatus } from './offers';
import { feedStorage, ignoreFeedItem, purgeFeedItems, retentionDays, scanFeedsDetailed, scanUrl, trackFeedItem } from './rss';
import type { ScanResult } from './rss';
import { currentRuleSetFor } from './catalog/migrate-products';
import { choicesOf, chooseMode, defineMode, ModeError, modeOn, modesOf } from './cards/modes';
import { modeComparison, NoModesError } from './intelligence/planning/modes';
import { ingestTransaction } from './transactions/ingest';
import { activeCards, daysBetween, money, parseDateToken, parseMoney, requirementProgress, requirementsFor, today, utilization } from './spend';
import { balances, categoryForMerchant, executeTransfer, formatRate, planRoutes, rankCards, ratesReview, rememberMerchant, tranchesByExpiry } from './points';
import { runMigrations, runSeed } from './migrate';
import { optimise } from './advice';
import { mccMatrix } from './mcc';
import { defaultCardPossible, describeMissed, METHODS, monthOfOther } from './other';
import {
  assignMerchantCode,
  ignoredMerchants,
  ignoreMerchant,
  importMerchantCodes,
  lookupMerchantOnline,
  unknownMerchants,
} from './mccscan';
import { evaluate, isCodeEntry, lookupMerchant } from './rules';
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

/**
 * Tell Telegram which commands exist, so typing "/" offers them.
 *
 * The client caches the menu, so this has to run again after a command is added
 * — /commands does it on demand, and /start does it on the way past. The reply
 * says whether Telegram accepted it rather than assuming: a rejected list fails
 * quietly, and the symptom is a menu that is silently a version behind.
 */
export async function registerCommands(env: Env): Promise<{ ok: boolean; count: number; error?: string }> {
  const res = await fetch(api(env, 'setMyCommands'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: COMMANDS }),
  });
  if (!res.ok) return { ok: false, count: COMMANDS.length, error: `Telegram said ${res.status}` };
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  return { ok: body.ok !== false, count: COMMANDS.length, error: body.ok === false ? body.description : undefined };
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

/**
 * Where a command's answer goes.
 *
 * One command per message sends straight back. A pasted block of commands
 * collects each answer instead, so eight lines cost one message rather than
 * eight — which matters because a Worker invocation may make only 50
 * subrequests, and every send and every database call is one of them.
 */
type Reply = (text: string, extra?: Record<string, unknown>) => Promise<unknown>;

/** A line the prompt writes for its own reader, not for the bot. */
const isComment = (line: string) => /^#(\s|$)/.test(line);
const isCommand = (line: string) => /^\/[a-z]/i.test(line);

/**
 * How many commands one message may run.
 *
 * Bounded by the subrequest budget, not by taste: /addearn alone costs three or
 * four database calls, so eight lines plus the reply sits around thirty-five of
 * the fifty a Worker invocation gets. Going over does not fail politely — the
 * platform cuts the invocation off partway through, which would leave a card
 * holding half its rates.
 */
const MAX_BLOCK = 8;

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

  // A pasted block of commands — what /cardrules asks Claude to produce — used
  // to be read as a single command, so every line but the first was silently
  // lost. Two or more command lines means the whole block was meant.
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !isComment(l));
  if (lines.filter(isCommand).length > 1) return runBlock(env, chatId, lines, origin);

  return void (await runCommand(env, chatId, text, origin, (t, extra) => send(env, chatId, t, extra)));
}

/**
 * Run each command line and answer once.
 *
 * Every line reports what it did, including the ones that failed: a block where
 * line four was rejected and nothing said so is a card that looks complete and
 * is not. Lines that are not commands are listed as skipped rather than guessed
 * at — a stray sentence in a pasted block must not become a spend entry.
 */
async function runBlock(env: Env, chatId: string, lines: string[], origin: string): Promise<void> {
  const out: string[] = [];
  let ran = 0;

  for (const line of lines) {
    if (!isCommand(line)) {
      out.push(`· skipped, not a command: ${line.slice(0, 60)}`);
      continue;
    }
    if (ran >= MAX_BLOCK) {
      const left = lines.filter(isCommand).length - ran;
      out.push(`\nStopped after ${MAX_BLOCK}. Send the remaining ${left} line${left === 1 ? '' : 's'} as a second message.`);
      break;
    }
    ran++;

    const said: string[] = [];
    try {
      await runCommand(env, chatId, line, origin, async (t) => void said.push(t));
    } catch (err) {
      said.push(`Error: ${(err as Error).message}`);
    }
    // The first line of the answer is the verdict; the rest is the usage help
    // or the follow-up suggestion, which is noise eight times over.
    const first = (said.join('\n').split('\n').find((l) => l.trim()) ?? 'done').trim();
    out.push(`${line.split(/\s+/)[0]} — ${first}`);
  }

  await send(env, chatId, out.join('\n') || 'Nothing to run.');
}

async function runCommand(
  env: Env,
  chatId: string,
  text: string,
  origin: string,
  reply: Reply
): Promise<unknown> {
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.toLowerCase().split('@')[0];
  const args = rest.join(' ');

  try {
    switch (cmd) {
      case '/start': {
        // Registering here means a fresh chat gets the menu without being told
        // to ask for it.
        const menu = await registerCommands(env);
        await reply(
          `Connected. Your chat id is ${chatId}.` +
            (menu.ok ? ` ${menu.count} commands are in the menu — type / to see them.` : '') +
            `\n\n${HELP}`
        );
        return;
      }

      case '/commands': {
        const menu = await registerCommands(env);
        return reply(
          menu.ok
            ? `${menu.count} commands registered. Type / to see them — Telegram caches the menu, so it may take a moment to refresh.`
            : `Telegram would not take the command list: ${menu.error ?? 'no reason given'}`
        );
      }
      case '/help':
        await reply(HELP);
        return;

      case '/app': {
        const token = await mintToken(env.APP_SECRET);
        await reply(`Dashboard link (valid 30 days):\n${origin}/#t=${token}`, {
          disable_web_page_preview: true,
        });
        return;
      }

      case '/status':
        await reply(await buildDigest(env));
        return;

      case '/cards': {
        const { results } = await env.DB.prepare(
          `SELECT * FROM cards ORDER BY closed_at IS NOT NULL, issuer`
        ).all<Card>();
        if (!results?.length) return reply('No cards yet — /help for /newcard.');
        const lines = results.map(
          (c) =>
            `*${c.nickname}* — ${c.issuer} ${c.product}\n  limit $${money(c.credit_limit_cents)} · closes day ${c.statement_day}` +
            `\n  opened ${c.opened_at ?? '?'}${c.closed_at ? ` · closed ${c.closed_at}` : ''}` +
            `\n  earns into ${c.program_key ?? '— not set, /setprogram'}`
        );
        return reply(lines.join('\n\n'));
      }

      case '/newcard': {
        // issuer|product|nickname|limit|statement_day|opened_at
        const p = args.split('|').map((s) => s.trim());
        if (p.length < 5)
          return reply('Format:\n`/newcard DBS|Altitude Visa|alt|8000|18|2025-03-04`');
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
        return reply(`Added *${product}* as \`${nickname.toLowerCase()}\`.` +
            (guessed
              ? `\nPoints will go to \`${guessed}\` — \`/setprogram ${nickname.toLowerCase()} <programme>\` to change it.`
              : `\nNo programme guessed for ${issuer}. \`/setprogram ${nickname.toLowerCase()} <programme>\` if it earns points.`)
        );
      }

      case '/closecard': {
        const [nick, date] = args.split('|').map((s) => s.trim());
        const card = await cardByNick(env, nick ?? '');
        if (!card) return reply(`No card with nickname \`${nick}\`.`);
        await env.DB.prepare(`UPDATE cards SET closed_at = ? WHERE id = ?`)
          .bind(date || today(env), card.id)
          .run();
        return reply(`Closed ${card.product} on ${date || today(env)}. Eligibility cooldowns now run from that date.`);
      }

      case '/req': {
        // nickname|kind|amount|window|deadline|cap|txns|note
        const p = args.split('|').map((s) => s.trim());
        if (p.length < 4)
          return reply('Format: `nickname|kind|amount|window|deadline|cap|txns|note`\n\n' +
              '`/req citirw|monthly_min|0|statement_cycle||1000||4 mpd, capped`\n' +
              '`/req uobone|monthly_min|600|statement_quarter||||10|quarterly cashback`\n' +
              '`/req alt|signup_min|1000|fixed_window|2026-11-14|||30k miles`\n\n' +
              '`statement_quarter` is three statement months counted from the month the card was issued — ' +
              'the amount must be hit in every one of them. Add its tiers with /tiers.\n' +
              '`membership_quarter` is the same in calendar months, which is how Trust counts.'
          );
        const [nick, kind, amount, window, deadline, cap, txns, note, reqMode] = p;
        const card = await cardByNick(env, nick);
        if (!card) return reply(`No card with nickname \`${nick}\`.`);

        // A rolling quarter is counted from a date. Without one every month
        // would look like quarter one, so refuse rather than guess.
        // Both kinds of rolling quarter are counted from a date — statement
        // cycles for UOB One, calendar months for Trust — and both need it.
        const quarterly = window === 'statement_quarter' || window === 'membership_quarter';
        if (quarterly && !card.opened_at)
          return reply(`A statement quarter is counted from the month *${card.product}* was issued, and that card has no opening date.\n` +
              'Set one in the Cards tab first.'
          );

        await env.DB.prepare(
          `INSERT INTO requirements (card_id, kind, amount_cents, window, deadline, starts_at, bonus_cap_cents,
             min_txns, reward_note, anchor_at, per_month, prorate_first, mode_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
            note || null,
            quarterly ? card.opened_at : null,
            quarterly ? 1 : 0,
            quarterly ? 1 : 0,
            reqMode ? reqMode.trim().toLowerCase() : null
          )
          .run();
        return reply(`Requirement added to ${card.product}.` +
            (reqMode ? ` It applies only while the card is set to \`${reqMode.trim().toLowerCase()}\`.` : '') +
            (quarterly
              ? ` Its quarters run from ${card.opened_at}, three statement months at a time. Add tiers with \`/tiers ${card.nickname} 600=50 1000=110\`.`
              : '') +
            ' /status to see progress.'
        );
      }

      // Tiered cashback: one minimum is not one number. A card like UOB One
      // pays a different amount at each rung, and the rung is decided by the
      // LEANEST month of the quarter, so the whole ladder has to be recorded.
      case '/tiers': {
        const tok = args.trim().split(/\s+/).filter(Boolean);
        const card = tok.length ? await cardByNick(env, tok[0]) : null;
        if (!card)
          return reply('Format: `/tiers <card> <spend>=<pays> ...`\n\n' +
              '`/tiers uobone 600=50 1000=110 2000=300`\n' +
              '_spend is per statement month, pays is per quarter._\n\n' +
              'With no rungs it lists what is recorded. Send `/tiers <card> none` to clear them.'
          );

        const req = await env.DB.prepare(
          `SELECT * FROM requirements WHERE card_id = ? AND active = 1 AND window IN ('statement_quarter', 'membership_quarter')
           ORDER BY id DESC LIMIT 1`
        )
          .bind(card.id)
          .first<{ id: number; amount_cents: number }>();
        if (!req)
          return reply(`*${card.product}* has no rolling-quarter minimum to attach tiers to.\n` +
              `Add one first: \`/req ${card.nickname}|monthly_min|600|statement_quarter||||10|quarterly cashback\``
          );

        const rungs = tok.slice(1);
        if (!rungs.length) {
          const { results } = await env.DB.prepare(
            `SELECT * FROM requirement_tiers WHERE requirement_id = ? ORDER BY min_spend_cents`
          )
            .bind(req.id)
            .all<any>();
          if (!results?.length) return reply(`No tiers on *${card.product}* yet.`);
          return reply(`*${card.product}* tiers\n` +
              results
                .map((t) => `$${money(t.min_spend_cents)} a month → $${money(t.reward_cents)} a quarter`)
                .join('\n')
          );
        }

        if (rungs.length === 1 && rungs[0].toLowerCase() === 'none') {
          await env.DB.prepare(`DELETE FROM requirement_tiers WHERE requirement_id = ?`).bind(req.id).run();
          return reply(`Tiers cleared on *${card.product}*.`);
        }

        const parsed: { spend: number; pays: number }[] = [];
        for (const rung of rungs) {
          const [a, b] = rung.split('=');
          const spend = parseMoney(a ?? '');
          const pays = parseMoney(b ?? '');
          if (!spend || spend <= 0 || pays === null || pays < 0)
            return reply(`Could not read \`${rung}\`. Each rung is \`<spend>=<pays>\`, e.g. \`600=50\`.`);
          parsed.push({ spend, pays });
        }
        parsed.sort((a, b) => a.spend - b.spend);

        // Replacing rather than appending: sending the ladder twice should not
        // leave two of every rung.
        await env.DB.prepare(`DELETE FROM requirement_tiers WHERE requirement_id = ?`).bind(req.id).run();
        for (const t of parsed) {
          await env.DB.prepare(
            `INSERT INTO requirement_tiers (requirement_id, min_spend_cents, reward_cents) VALUES (?, ?, ?)`
          )
            .bind(req.id, t.spend, t.pays)
            .run();
        }

        // The ladder IS the minimum, so the requirement is brought into line
        // rather than left disagreeing with it.
        const lowest = parsed[0].spend;
        const moved = lowest !== req.amount_cents;
        if (moved) {
          await env.DB.prepare(`UPDATE requirements SET amount_cents = ? WHERE id = ?`).bind(lowest, req.id).run();
        }

        return reply(`*${card.product}* — ${parsed.length} tier(s)\n` +
            parsed.map((t) => `$${money(t.spend)} a month → $${money(t.pays)} a quarter`).join('\n') +
            (moved
              ? `\n\nThe monthly minimum is now $${money(lowest)}, the lowest rung — it was $${money(req.amount_cents)}.`
              : '') +
            '\n\n_The quarter pays at the lowest tier held across its three statement months, so once a month closes ' +
            'a rung down, spending higher in the months after it buys nothing more that quarter._'
        );
      }

      case '/reqs': {
        const { results } = await env.DB.prepare(
          `SELECT r.*, c.nickname, c.product FROM requirements r
           JOIN cards c ON c.id = r.card_id WHERE r.active = 1 ORDER BY c.nickname`
        ).all<any>();
        if (!results?.length) return reply('No requirements set.');
        return reply(results
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
        return reply(`Requirement #${parseInt(args, 10)} removed.`);

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
        if (!results?.length) return reply('No offers yet. `/scan` looks for some.');
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
        return reply(out.join('\n\n'), { disable_web_page_preview: true });
      }

      case '/extract': {
        const id = parseInt(args, 10);
        const offer = await env.DB.prepare(`SELECT * FROM offers WHERE id = ?`).bind(id).first<Offer>();
        if (!offer) return reply(`No offer #${id}.`);
        await reply(`Open the T&C, then paste this into Claude with the terms:\n${offer.source_url ?? ''}`, {
          disable_web_page_preview: true,
        });
        // Sent without parse_mode so the prompt's braces and backticks survive verbatim.
        return reply(extractionPrompt(id, offer.source_url), { parse_mode: undefined });
      }

      case '/save': {
        const m = args.match(/^(\d+)\s+([\s\S]+)$/);
        if (!m) return reply('Format: `/save <offer id> {json}`');
        const id = parseInt(m[1], 10);
        let data: any;
        try {
          data = parseExtraction(m[2]);
        } catch (e) {
          return reply(`Could not parse that JSON: ${(e as Error).message}`);
        }
        let saved;
        try {
          saved = await saveExtraction(env, id, data);
        } catch (e) {
          return reply((e as Error).message);
        }
        const e = saved.eligibility;
        const icon = e.verdict === 'eligible' ? '✅ Eligible' : e.verdict === 'not_eligible' ? '❌ Not eligible' : '🟡 Needs review';
        return reply(`Saved offer #${id} with ${saved.rules_saved} rule(s)` +
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
          return reply('Format: `/rule <rule id> yes|no|na [note]`\n' +
              '`yes` you meet it · `no` you do not · `na` it does not apply · `clear` undo.\n' +
              'Rule ids are shown by `/offers`.'
          );
        const ruleId = parseInt(m[1], 10);
        const word = m[2].toLowerCase();
        const decision = word === 'yes' ? 'pass' : word === 'no' ? 'fail' : word === 'na' ? 'na' : null;
        const offerId = await decideRule(env, ruleId, decision, m[3].trim() || null);
        if (!offerId) return reply(`No rule #${ruleId}.`);
        const e = await evaluateOffer(env, offerId);
        const icon = e.verdict === 'eligible' ? '✅ Eligible' : e.verdict === 'not_eligible' ? '❌ Not eligible' : '🟡 Needs review';
        return reply(`Offer #${offerId} — *${icon}*\n` +
            e.rules.map((r) => `${ruleIcon(r)} #${r.id} ${r.decision ? decisionText(r) : r.reason}`).join('\n')
        );
      }

      case '/apply': {
        const id = parseInt(args, 10);
        await env.DB.prepare(`UPDATE offers SET status='applied' WHERE id = ?`).bind(id).run();
        return reply(`Offer #${id} marked applied. Once approved, add the card with /newcard and its sign-up minimum with /req.`);
      }

      case '/dismiss': {
        const id = parseInt(args, 10);
        if (!id) return reply('Format: `/dismiss <offer id>`');
        await env.DB.prepare(`UPDATE offers SET status='dismissed' WHERE id = ?`).bind(id).run();
        return reply(`Offer #${id} dismissed. It stays on record; the app can bring it back.`);
      }

      case '/feeds': {
        const { results } = await env.DB.prepare(`SELECT url, label, active, kind FROM feeds`).all<any>();
        return reply((results ?? [])
            .map((f) => `${f.active ? '·' : '✖'} ${f.label} [${f.kind ?? 'auto'}] — ${f.url}`)
            .join('\n') || 'No feeds.'
        );
      }

      case '/addfeed': {
        // kind is optional: rss, page (an HTML listing), or blank to detect.
        const [url, label, kind] = args.split('|').map((s) => s.trim());
        if (!/^https?:\/\//i.test(url ?? ''))
          return reply('Format:\n`/addfeed https://site/feed/|Label|rss`\nkind: `rss`, `page`, or blank to detect.');
        const k = kind && ['rss', 'page'].includes(kind.toLowerCase()) ? kind.toLowerCase() : null;
        await env.DB.prepare(`INSERT OR REPLACE INTO feeds (url, label, kind) VALUES (?, ?, ?)`)
          .bind(url, label || url, k)
          .run();
        return reply(`Feed added: ${label || url} [${k ?? 'auto'}]`);
      }

      case '/scan': {
        // `/scan <url>` parses one page on demand; `/scan quick` skips opening
        // articles, which is faster but only sees what the feed summary says.
        if (/^https?:\/\//i.test(args.trim())) {
          const hit = await scanUrl(env, args.trim());
          if (!hit) return reply('Could not read that page.');
          await pushFeedItem(env, chatId, hit);
          if (hit.topic !== 'promo')
            await reply('Nothing in that page reads like a card offer — track it anyway if you disagree.');
          return;
        }
        const deep = args.trim().toLowerCase() !== 'quick';
        await reply(deep ? 'Scanning feeds and opening articles…' : 'Scanning feed summaries…');
        const scan = await scanFeedsDetailed(env, { deep });
        for (const item of scan.fresh) await pushFeedItem(env, chatId, item);
        const stats =
          `${scan.feeds_read} source${scan.feeds_read === 1 ? '' : 's'} · ${scan.items_seen} new item(s) · ` +
          `${scan.pages_fetched} page(s) opened` +
          (scan.feeds_failed.length ? `\n⚠️ unreachable: ${scan.feeds_failed.join(', ')}` : '');
        await reply((scan.fresh.length ? `${scan.fresh.length} match(es).` : 'No new promo items.') + `\n${stats}`);
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
            return reply('Nothing waiting. Points are added when you accept them here.');
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
          return reply(['*Waiting to be banked*', ...lines, '', ...recent, ...orphan, '', '`/credit all` · `/credit <programme>`']
              .filter(Boolean)
              .join('\n')
          );
        }

        const ids =
          arg === 'all'
            ? pending.credits.map((c) => c.id)
            : pending.credits.filter((c) => c.program_key.toLowerCase() === arg).map((c) => c.id);
        if (!ids.length) return reply(arg === 'all' ? 'Nothing waiting.' : `Nothing waiting for \`${arg}\`.`);

        const res = await acceptCredits(env, ids);
        const w = await wallet(env);
        return reply(`Banked ${res.points.toLocaleString()} from ${res.accepted} purchase(s).\n` +
            w.programs
              .filter((p) => p.points > 0)
              .map((p) => `${p.name}: ${p.points.toLocaleString()} ${p.unit}`)
              .join('\n') +
            '\n\n`/undocredit <txn id>` if a bank credits something different.'
        );
      }

      case '/undocredit': {
        const id = parseInt(args, 10);
        if (!id) return reply('Format: `/undocredit <transaction id>`');
        const ok = await undoCredit(env, id);
        return reply(ok ? `Taken back out of the wallet (#${id}).` : `#${id} was not credited.`);
      }

      /**
       * Cards you choose the reward of.
       *
       *   /mode                       what every such card is set to
       *   /mode freedom               this card's options and its history
       *   /mode freedom stockback     switch, from today
       *   /mode freedom stockback 2026-10-01 [category]
       *   /mode freedom add miles|Miles|miles
       *
       * The date matters more than it looks: the choice is locked for a
       * membership quarter, so a switch recorded with today's date says last
       * quarter's purchases were earned under the old mode, which they were.
       */
      case '/mode': {
        const tok = args.trim().split(/\s+/).filter(Boolean);

        if (!tok.length) {
          const { results: cards } = await env.DB.prepare(
            `SELECT c.id, c.nickname, c.product, c.product_id FROM cards c
              WHERE c.closed_at IS NULL AND c.product_id IN (SELECT product_id FROM card_modes)
              ORDER BY c.nickname`
          ).all<any>();
          if (!cards?.length)
            return reply(
              'No card here has selectable rewards.\n' +
                'A card that makes you choose — miles, cashback or stock, one at a time — is set up with\n' +
                '`/mode <card> add <key>|<label>|<payout>` and then `/mode <card> <key> <from>`.'
            );
          const lines = await Promise.all(
            (cards ?? []).map(async (c: any) => {
              const now = await modeOn(env, c.id, today(env), c.product_id);
              return `*${c.nickname}* — ${now ? `${now.mode_key}${now.category ? ` (${now.category})` : ''} since ${now.effective_from}` : 'nothing chosen, so it earns only its unconditional rates'}`;
            })
          );
          return reply(`*Reward modes*\n\n${lines.join('\n')}`);
        }

        const card = await cardByNick(env, tok[0]);
        if (!card) return reply(`No card with nickname \`${tok[0]}\`. /cards to list them.`);
        const productId = (card as any).product_id ?? null;

        // /mode <card> add key|label|payout|categories
        if (tok[1]?.toLowerCase() === 'add') {
          if (!productId) return reply(`*${card.product}* is not linked to a product yet — run /migrate first.`);
          const [key, label, payout, cats, flag] = args.slice(args.indexOf('add') + 3).split('|').map((x) => x.trim());
          if (!key || !label)
            return reply(
              'Format: `/mode <card> add <key>|<label>|<payout>|<categories>|default`\n' +
                '`payout` is what it actually pays: `miles`, `cash`, `stock` or `points`.\n' +
                'Add categories only when the mode also makes you pick one:\n' +
                '`/mode freedom add bonus_cashback|Bonus Cashback|cash|dining,shopping,travel`\n' +
                'End with `default` for the mode the bank applies until you choose one:\n' +
                '`/mode freedom add unlimited_cashback|Unlimited Cashback|cash||default`'
            );
          const m = await defineMode(env, productId, {
            mode_key: key.toLowerCase(),
            label,
            payout: (payout || 'cash').toLowerCase(),
            picks_category: !!cats,
            category_choices: cats || null,
            is_default: (flag ?? '').toLowerCase() === 'default',
          });
          return reply(
            `*${card.product}* can now be set to *${m.label}* (\`${m.mode_key}\`), paid as ${m.payout}` +
              (m.picks_category ? `, picking one of ${m.category_choices}` : '') +
              (m.is_default ? ' — and it is what applies until you choose' : '') +
              `.\n\nRules for it carry \`mode ${m.mode_key}\`: \`/addearn ${card.nickname} * 1.3 mode ${m.mode_key}\``
          );
        }

        // /mode <card> compare [range] — the quarterly decision, on your own
        // spending rather than on the headline rates.
        if (tok[1]?.toLowerCase() === 'compare') {
          try {
            const cmp = await modeComparison(env, card.nickname, { range: tok[2] ?? null });
            return reply(
              `*${cmp.product}* · ${cmp.label}\n${cmp.headline}\n\n` +
                cmp.modes
                  .map((m, i) => `${i === 0 ? '🥇' : m.selected ? '👉' : '  '} ${m.summary}`)
                  .join('\n') +
                `\n\n_${cmp.caveats[0]}_`
            );
          } catch (e) {
            if (e instanceof NoModesError) return reply(`Cannot compare: ${(e as Error).message}`);
            throw e;
          }
        }

        const offered = await modesOf(env, productId);

        // /mode <card> — what it offers and what it has been set to.
        if (tok.length === 1) {
          if (!offered.length)
            return reply(
              `*${card.product}* has no selectable rewards recorded.\n` +
                `Add one with \`/mode ${card.nickname} add <key>|<label>|<payout>\`.`
            );
          const history = await choicesOf(env, card.id);
          const now = await modeOn(env, card.id, today(env), productId);
          return reply(
            `*${card.product}*\n\n` +
              offered
                .map(
                  (m) =>
                    `${now?.mode_key === m.mode_key ? '👉' : '  '} *${m.label}* \`${m.mode_key}\` — paid as ${m.payout}` +
                    (m.picks_category ? `, picks one of ${m.category_choices}` : '')
                )
                .join('\n') +
              '\n\n' +
              (history.length
                ? '*History*\n' +
                  history
                    .map(
                      (h) =>
                        `${h.effective_from} → ${h.effective_until ?? 'now'} · ${h.mode_key}${h.category ? ` (${h.category})` : ''}`
                    )
                    .join('\n')
                : 'Nothing chosen yet, so only rules with no mode apply.') +
              `\n\nSwitch with \`/mode ${card.nickname} <key> <YYYY-MM-DD>\` — the date it started, not today, if they differ.\n\`/mode ${card.nickname} compare\` prices each one against what you actually spent.`
          );
        }

        // /mode <card> <key> [from] [category]
        const key = tok[1].toLowerCase();
        const rest = tok.slice(2);
        const from = rest.find((t) => /^\d{4}-\d{2}-\d{2}$/.test(t)) ?? today(env);
        const category = rest.find((t) => !/^\d{4}-\d{2}-\d{2}$/.test(t)) ?? null;
        try {
          const made = await chooseMode(env, { id: card.id, product_id: productId, nickname: card.nickname }, key, {
            from,
            category,
          });
          const mode = offered.find((m) => m.mode_key === made.mode_key);
          return reply(
            `*${card.product}* is on *${mode?.label ?? made.mode_key}*${made.category ? ` (${made.category})` : ''} from ${made.effective_from}.\n\n` +
              'Everything bought before that keeps the mode it was bought under, so what the card has already earned does not change.'
          );
        } catch (e) {
          if (e instanceof ModeError) return reply(`Cannot switch: ${e.message}`);
          throw e;
        }
      }

      case '/setprogram': {
        const [nick, key] = args.split(/\s+/).map((x) => x?.trim());
        if (!nick) return reply('Format: `/setprogram <card> <programme key>` · `/routes` lists programmes.');
        const card = await cardByNick(env, nick);
        if (!card) return reply(`No card with nickname \`${nick}\`.`);
        if (key && key !== 'none') {
          const prog = await env.DB.prepare(`SELECT key, name FROM programs WHERE key = ?`).bind(key).first<any>();
          if (!prog) return reply(`No programme \`${key}\`. \`/routes\` lists them.`);
        }
        await env.DB.prepare(`UPDATE cards SET program_key = ? WHERE id = ?`)
          .bind(key && key !== 'none' ? key : null, card.id)
          .run();
        return reply(key && key !== 'none'
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
        if (!lines.length) return reply('Wallet is empty. `/addbal` records a balance; `/credit` banks what you earn.');
        return reply(['*Wallet*', ...lines, '', `Worth about $${money(w.totals.value_cents)} at your mile value.`].join('\n')
        );
      }

      // The code table, from the phone. Same numbers as the Codes tab.
      case '/codes': {
        const q = args.trim();
        const m = await mccMatrix(env, q ? { q } : { filter: 'used' });
        if (!m.rows.length)
          return reply(q ? `No code matches \`${q}\`.` : 'No spend with a known code yet.');

        const lines = m.rows.slice(0, 12).map((r) => {
          const cells = r.cells
            .map((c) =>
              c.state === 'excluded'
                ? `${c.nickname}: ✕`
                : c.state === 'none'
                  ? `${c.nickname}: —`
                  : `${c.nickname}: ${c.rate}${c.reward_type === 'cashback' ? '%' : ' mpd'}${c.cap_cents ? '*' : ''}`
            )
            .join(' · ');
          return `*${r.code}* ${r.description}\n  ${cells}`;
        });
        const more = m.rows.length > 12 ? `\n\n…and ${m.rows.length - 12} more. Open the Codes tab with /app.` : '';
        return reply((q ? `*Codes matching "${q}"*\n` : '*Codes you have spent on*\n') +
            lines.join('\n') +
            '\n\n✕ earns nothing and does not count toward a minimum · * capped' +
            more
        );
      }

      // Refresh merchant codes from the public directory, then show what is
      // still missing from your own spend.
      case '/mccscan': {
        await reply('Reading the merchant directory…');
        const r = await importMerchantCodes(env);
        const lines = [...r.added, ...r.updated]
          .slice(0, 12)
          .map((a) => `${a.merchant} → ${a.mcc}${a.verified ? ' ✓' : ''}`);
        const unknown = await unknownMerchants(env, { per: 8 });
        return reply(`*${r.source}*\n${r.fetched} page(s) · ${r.added.length} new · ${r.updated.length} corrected · ${r.unchanged} unchanged` +
            (r.failed.length ? ` · ${r.failed.length} unreadable` : '') +
            (lines.length ? `\n\n${lines.join('\n')}` : '') +
            (r.conflicts.length
              ? `\n\n⚠️ Disagrees with codes you confirmed (yours kept):\n` +
                r.conflicts.map((c) => `${c.merchant}: you ${c.yours}, they ${c.theirs}`).join('\n')
              : '') +
            (unknown.merchants.length
              ? `\n\n*Still no code, by spend* — ${unknown.total} left\n` +
                unknown.merchants
                  .map((u) => `${u.merchant} — ${u.txn_count}× $${money(u.spend_cents)}${u.suggested_mcc ? ` (try ${u.suggested_mcc})` : ''}`)
                  .join('\n') +
                '\n`/mcc <merchant> <code>` to set one, `/mccskip <merchant>` to stop asking.' +
                (unknown.ignored ? `\n_${unknown.ignored} ignored._` : '')
              : '\n\nEvery merchant you have spent at has a code.')
        );
      }

      // Some spend has no code to find — a hawker stall, a transfer to a
      // friend. The honest answer is not a guess, it is to take it off the list.
      case '/mccskip': {
        const name = args.trim().replace(/\s+--undo$/i, '').trim();
        const undo = /\s--undo$/i.test(args.trim());
        if (!name) {
          const rows = await ignoredMerchants(env);
          if (!rows.length) return reply('Nothing ignored. `/mccskip <merchant>` stops asking about one.');
          return reply(`*Ignored merchants* (${rows.length})\n` +
              rows.map((r) => `${r.merchant}${r.reason ? ` — ${r.reason}` : ''}`).join('\n') +
              '\n\n`/mccskip <merchant> --undo` puts one back.'
          );
        }
        const r = await ignoreMerchant(env, name, { undo });
        return reply(r.ignored
            ? `*${r.merchant}* will no longer be listed as missing a code. \`/mccskip ${r.merchant} --undo\` to undo.`
            : `*${r.merchant}* is back on the list of merchants with no code.`
        );
      }

      case '/mcc': {
        const [merchant, code] = (() => {
          const parts = args.trim().split(/\s+/);
          const last = parts[parts.length - 1];
          return /^\d{4}$/.test(last ?? '') ? [parts.slice(0, -1).join(' '), last] : [args.trim(), ''];
        })();
        if (!merchant) return reply('Format: `/mcc <merchant> [code]` — with a code it records one.');
        if (!code) {
          const guess = await lookupMerchant(env, merchant);
          if (guess.confidence !== 'unknown')
            return reply(`*${merchant}* → ${guess.mcc} (${guess.description ?? '?'}) · ${guess.confidence}` +
                (guess.category ? `\ncategory: ${guess.category}` : '')
            );

          // Nothing here; ask the public directory before giving up.
          const online = await lookupMerchantOnline(env, merchant);
          if (online.error) return reply(`No code for *${merchant}* here, and ${online.source} ${online.error}.`);
          if (!online.results.length)
            return reply(`No code for *${merchant}*, here or at ${online.source}.\n` +
                `\`/mcc ${merchant} 5812\` records one once your statement shows what it earned.`
            );

          const lines = online.results
            .slice(0, 6)
            .map(
              (r) =>
                `*${r.store}* → ${r.mcc}` +
                `${r.channel ? ` (${r.channel})` : ''}` +
                `${r.category ? ` · ${r.category}` : ''}\n  \`/mcc ${r.store} ${r.mcc}\``
            );
          return reply(`*${online.results.length} match(es) at ${online.source}*\n` +
              lines.join('\n') +
              (online.results.length > 6 ? `\n…and ${online.results.length - 6} more.` : '')
          );
        }
        const r = await assignMerchantCode(env, merchant, code);
        return reply(`*${r.merchant}* is now ${code}.` +
            (r.updated ? ` ${r.updated} past purchase(s) updated.` : '') +
            (r.categorised
              ? `\n${r.categorised} of them also took the code's category, *${r.category}* — anything you had categorised by hand was left alone.`
              : '')
        );
      }

      case '/exclude': {
        // /exclude 6540[,6051,...] [card] [reason]
        //
        // A list, because terms name exclusions in lists: "MCC 4829, 6010,
        // 6011, 6012" is one clause and one line to write. One code at a time
        // meant a card's exclusions arrived as eight commands, and the eight
        // were the ones most likely to be abandoned half done.
        const parts = args.trim().split(/\s+/);
        const codes = (parts[0] ?? '')
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
        if (!codes.length || codes.some((c) => !/^\d{4}$/.test(c)))
          return reply(
            'Format: `/exclude <mcc> [card] [reason]`\n' +
              'Several at once: `/exclude 4829,6010,6011 freedom financial institutions`\n' +
              'Leave the card out to exclude it everywhere.'
          );
        const maybeCard = parts[1] ? await cardByNick(env, parts[1]) : null;
        const reason = parts.slice(maybeCard ? 2 : 1).join(' ') || 'excluded';
        await env.DB.batch(
          codes.map((code) =>
            env.DB.prepare(
              `INSERT INTO exclusions (card_id, mcc, reason, source, active) VALUES (?, ?, ?, 'user', 1)`
            ).bind(maybeCard?.id ?? null, code, reason)
          )
        );
        return reply(
          `MCC ${codes.join(', ')} now earn${codes.length > 1 ? '' : 's'} nothing on ` +
            `${maybeCard ? `*${maybeCard.product}*` : 'every card'}` +
            ' and will not count toward a minimum. It applies from the next purchase you log.'
        );
      }

      // Spending that never touched a card. It earns nothing, which is the
      // reason to record it: the month's total is only half the picture.
      case '/spend': {
        // /spend 12.80 paylah [date] [note]
        const parts = args.trim().split(/\s+/).filter(Boolean);
        if (parts.length < 2)
          return reply('Format: `/spend <amount> <method> [date] [note]`\n' +
              `Methods: ${METHODS.map((m) => `\`${m.key}\``).join(' ')}`
          );
        const cents = parseMoney(parts[0]);
        if (!cents || cents <= 0) return reply(`Could not read an amount from "${parts[0]}".`);
        const method = parts[1].toLowerCase();

        let date = today(env);
        const rest: string[] = [];
        for (const tok of parts.slice(2)) {
          const d = parseDateToken(tok, env);
          if (d && date === today(env)) date = d;
          else rest.push(tok);
        }
        const note = rest.join(' ') || null;
        const category = (await categoryForMerchant(env, note)) ?? null;

        const ins = await env.DB.prepare(
          `INSERT INTO other_spend (occurred_at, amount_cents, method, merchant, category, card_possible)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
          .bind(date, cents, method, note, category, defaultCardPossible(method))
          .run();
        return reply(`Logged $${money(cents)} by ${method}${note ? ` — ${note}` : ''} (#${ins.meta.last_row_id}).` +
            (category ? ` #${category}` : ' _no category, so it cannot be costed — /spends to see the month_')
        );
      }

      case '/spends': {
        const m = await monthOfOther(env, /^\d{4}-\d{2}$/.test(args.trim()) ? args.trim() : undefined);
        if (!m.rows.length) return reply(`Nothing off-card in ${m.month}.`);
        return reply(`*Off-card, ${m.month}*\n$${money(m.total_cents)} — ${m.share_percent.toFixed(0)}% of everything you spent\n` +
            m.by_method.map((x) => `  ${x.label}: $${money(x.spend_cents)} (${x.count})`).join('\n') +
            (m.missed_value_cents > 0
              ? `\n\n*Left on the table*: about $${money(m.missed_value_cents)}` +
                (m.missed_miles ? ` (${m.missed_miles.toLocaleString()} miles)` : '') +
                '\n' +
                m.missed.slice(0, 5).map((x) => `  ${describeMissed(x)}`).join('\n')
              : '') +
            (m.uncategorised_cents > 0
              ? `\n\n$${money(m.uncategorised_cents)} has no category and is not in that figure.`
              : '') +
            '\n\n`/delspend <id>` removes one.'
        );
      }

      case '/delspend': {
        const id = parseInt(args, 10);
        if (!id) return reply('Format: `/delspend <id>`');
        const r = await env.DB.prepare(`DELETE FROM other_spend WHERE id = ?`).bind(id).run();
        return reply((r.meta.changes ?? 0) ? `Removed #${id}.` : `No off-card row #${id}.`);
      }

      case '/prune': {
        const store = await feedStorage(env);
        const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
        const arg = args.trim().toLowerCase();

        if (!arg) {
          return reply(`*Scanned history*\n` +
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
          return reply(`Compacted ${r.affected} item(s), freeing about ${kb(r.freed_bytes)}.`);
        }
        if (arg === 'offers') {
          const sweep = await sweepExpiredOffers(env, today(env));
          return reply(`Marked ${sweep.expired} offer(s) expired` +
              (sweep.deleted ? ` and deleted ${sweep.deleted} that ended over ${sweep.retention_days} days ago.` : '.')
          );
        }
        if (arg === 'delete') {
          const r = await purgeFeedItems(env, { mode: 'delete', scope: 'ignored' });
          return reply(`Deleted ${r.affected} ignored item(s), freeing about ${kb(r.freed_bytes)}.\n` +
              'Those are now forgotten — if a feed still carries one, the next scan will show it again.'
          );
        }
        return reply('Use `/prune`, `/prune compact`, `/prune delete` or `/prune offers`.');
      }

      case '/recent': {
        const { results } = await env.DB.prepare(
          `SELECT t.id, t.amount_cents, t.occurred_at, t.posted_at, t.merchant, c.nickname
           FROM transactions t JOIN cards c ON c.id = t.card_id
           ORDER BY COALESCE(t.posted_at, t.occurred_at) DESC, t.id DESC LIMIT 15`
        ).all<any>();
        if (!results?.length) return reply('No transactions yet.');
        return reply('*Recent*\n' +
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
        if (!id || !when) return reply('Format: `/posted 12 2026-09-22` (or `today`, `yesterday`, `-2`).');
        const row = await env.DB.prepare(`SELECT * FROM transactions WHERE id = ?`).bind(id).first<any>();
        if (!row) return reply(`No transaction #${id}.`);
        if (when < row.occurred_at)
          return reply(`A transaction cannot post (${when}) before it happened (${row.occurred_at}).`);
        await env.DB.prepare(`UPDATE transactions SET posted_at = ? WHERE id = ?`).bind(when, id).run();
        return reply(`#${id} posted ${when}` + (when === row.occurred_at ? '.' : ` (made ${row.occurred_at}).`) + '\nWindows now use the posting date.'
        );
      }

      case '/del':
      case '/undo': {
        const id = cmd === '/undo' ? null : parseInt(args, 10);
        const row = id
          ? await env.DB.prepare(`SELECT * FROM transactions WHERE id = ?`).bind(id).first<any>()
          : await env.DB.prepare(`SELECT * FROM transactions ORDER BY id DESC LIMIT 1`).first<any>();
        if (!row) return reply(id ? `No transaction #${id}.` : 'Nothing to undo.');
        await env.DB.prepare(`DELETE FROM transactions WHERE id = ?`).bind(row.id).run();
        return reply(`Deleted #${row.id} — $${money(row.amount_cents)} on ${row.occurred_at}.`);
      }

      case '/which': {
        const [rawCat, amt] = args.trim().split(/\s+/);
        const cents = amt ? parseMoney(amt) : null;
        const cards = await activeCards(env);
        if (!cards.length) return reply('No cards yet.');

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
            return reply('No earn rules yet.\nStart with `/addearn <card> <category> <rate>` — see /help.');

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
          return reply(lines.join('\n'));
        }

        // The argument may be a merchant you have tagged before, not a category.
        const asMerchant = await categoryForMerchant(env, rawCat);
        const category = (asMerchant ?? rawCat).toLowerCase();

        const picks = await rankCards(env, category, cents, { cards, minSpendNudge: nudges });
        if (!picks.length)
          return reply('No earn rules yet.\nStart with `/addearn <card> <category> <rate>` — see /help.');

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
        return reply(`${header}\n\n${lines.join('\n')}` +
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
          return reply('Format: `/transfer 50000 citi_ty krisflyer`\nUse /convert first to compare routes.');
        const plans = await planRoutes(env, pts, from, to);
        const best = plans.find((p) => p.possible);
        if (!best) return reply(plans[0]?.reason ?? `No route from ${from} to ${to}.`);

        const r = await executeTransfer(env, best.conversion.id, pts);
        if (!r.ok) return reply(`Could not transfer: ${r.error}`);
        const used = (r.consumed ?? [])
          .map((c) => `${c.points.toLocaleString()} expiring ${c.expires_at ?? 'never'}`)
          .join(', ');
        return reply(`Transferred ${r.plan!.transferable.toLocaleString()} ${from} → ` +
            `*${r.plan!.miles.toLocaleString()} ${to}*` +
            (r.plan!.fee_cents ? ` · fee $${money(r.plan!.fee_cents)}` : ' · free') +
            `\n\nTaken from: ${used}` +
            (r.plan!.stranded ? `\n${r.plan!.stranded.toLocaleString()} left behind (below a block)` : '') +
            '\n\n/bal to see the new balances.'
        );
      }

      case '/expiry': {
        const rows = await tranchesByExpiry(env);
        if (!rows.length) return reply('No balances recorded. /addbal to start.');
        return reply('*By expiry, soonest first*\n' +
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
        if (!results?.length) return reply('Everything is categorised.');
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
        return reply(out.join('\n'));
      }

      case '/cat': {
        const [idRaw, catRaw] = args.trim().split(/\s+/);
        const id = parseInt(idRaw, 10);
        if (!id || !catRaw) return reply('Format: `/cat 42 groceries`');
        const cat = catRaw.toLowerCase();
        const row = await env.DB.prepare(`SELECT merchant FROM transactions WHERE id = ?`)
          .bind(id)
          .first<{ merchant: string | null }>();
        if (!row) return reply(`No transaction #${id}.`);
        await rememberMerchant(env, row.merchant, cat);
        await env.DB.prepare(
          `UPDATE transactions SET category = ?, category_source = 'manual', needs_review = 0 WHERE id = ?`
        )
          .bind(cat, id)
          .run();
        return reply(`#${id} is now *${cat}*.` + (row.merchant ? `\n${row.merchant} will categorise itself from now on.` : '')
        );
      }

      case '/bal': {
        const rows = await balances(env);
        if (!rows.length) return reply('No programmes yet. /addbal to record a balance.');
        return reply('*Balances*\n' +
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
        if (!prog || !pts) return reply('Format: `/addbal citi_ty|50000|2027-03-31|statement balance`');
        await env.DB.prepare(
          `INSERT INTO balance_tranches (program_key, points, earned_at, expires_at, note) VALUES (?, ?, ?, ?, ?)`
        )
          .bind(prog, parseInt(pts.replace(/,/g, ''), 10), today(env), exp || null, note || null)
          .run();
        return reply(`Recorded ${parseInt(pts.replace(/,/g, ''), 10).toLocaleString()} in ${prog}. /bal to check.`);
      }

      case '/convert': {
        const [ptsRaw, from, to] = args.trim().split(/\s+/);
        const pts = parseInt((ptsRaw ?? '').replace(/,/g, ''), 10);
        if (!pts || !from || !to) return reply('Format: `/convert 50000 citi_ty krisflyer`');
        const plans = await planRoutes(env, pts, from, to);
        if (!plans.length) return reply(`No route from ${from} to ${to}. Add one with /addconv.`);

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
        return reply(`*${pts.toLocaleString()} ${from} → ${to}*\n\n` + out.join('\n\n'));
      }

      case '/migrate': {
        const r = await runMigrations(env);
        const bits: string[] = [];
        if (r.created.length) bits.push(`Created: ${r.created.join(', ')}`);
        if (r.altered.length) bits.push(`Added columns: ${r.altered.join(', ')}`);
        if (r.alreadyCurrent) bits.push('Database already up to date.');
        if (r.errors.length) bits.push(`\nProblems:\n${r.errors.join('\n')}`);
        else if (!r.alreadyCurrent) bits.push('\nRun /seed to load the default feeds and transfer routes.');
        return reply(bits.join('\n'));
      }

      case '/seed': {
        const r = await runSeed(env);
        return reply(`Seed applied (${r.applied} statements).` +
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
        return reply(lines.join('\n'));
      }

      case '/rates':
        // On demand, always the full report rather than the quiet daily one.
        return reply((await ratesReview(env, { quiet: false })) ?? 'Nothing to flag.');

      case '/routes': {
        const { results } = await env.DB.prepare(
          `SELECT c.*, pf.name AS from_name, pt.name AS to_name FROM conversions c
           JOIN programs pf ON pf.key = c.from_program JOIN programs pt ON pt.key = c.to_program
           WHERE c.active = 1 ORDER BY pf.name, c.id`
        ).all<any>();
        if (!results?.length) return reply('No routes configured.');
        return reply('*Transfer routes*\n' +
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
        if (!id || !when) return reply('Format: `/verified 4` (or `/verified 4 2026-09-01`).');
        const r = await env.DB.prepare(`UPDATE conversions SET verified_at = ?, note = NULL WHERE id = ?`)
          .bind(when, id)
          .run();
        if (!(r.meta.changes ?? 0)) return reply(`No route #${id}. /routes to list them.`);
        return reply(`Route #${id} marked verified ${when}.`);
      }

      case '/setrate': {
        // id|from_units|to_units|fee|min_block|increment
        const p = args.split('|').map((s) => s.trim());
        if (p.length < 6) return reply('Format: `/setrate 4|5000|10000|27.25|5000|5000`');
        const [idRaw, fu, tu, fee, minB, inc] = p;
        const r = await env.DB.prepare(
          `UPDATE conversions SET from_units=?, to_units=?, fee_cents=?, min_block=?, block_increment=?,
             verified_at=?, note=NULL WHERE id=?`
        )
          .bind(parseInt(fu, 10), parseInt(tu, 10), parseMoney(fee) ?? 0, parseInt(minB, 10), parseInt(inc, 10), today(env), parseInt(idRaw, 10))
          .run();
        if (!(r.meta.changes ?? 0)) return reply(`No route #${parseInt(idRaw, 10)}.`);
        return reply(`Route #${parseInt(idRaw, 10)} updated and marked verified.`);
      }

      case '/setbonus': {
        // id|pct|until
        const [idRaw, pct, until] = args.split('|').map((s) => s.trim());
        if (!idRaw || !pct) return reply('Format: `/setbonus 2|8|2026-12-31` — use 0 to clear.');
        await env.DB.prepare(`UPDATE conversions SET bonus_pct = ?, bonus_until = ? WHERE id = ?`)
          .bind(parseFloat(pct), until || null, parseInt(idRaw, 10))
          .run();
        return reply(`Route #${parseInt(idRaw, 10)}: ${pct}% bonus${until ? ` until ${until}` : ''}.`);
      }

      case '/earn': {
        const { results } = await env.DB.prepare(
          `SELECT e.*, c.nickname FROM earn_rules e JOIN cards c ON c.id = e.card_id
           WHERE e.active = 1 ORDER BY c.nickname, e.mpd DESC`
        ).all<any>();
        if (!results?.length) return reply('No earn rules yet. /addearn to add one.');
        return reply('*Earn rules*\n' +
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
        let mccList: string | undefined;
        let minTier: string | undefined;
        let modeKey: string | undefined;
        let region: string | undefined;
        let minTxn: string | undefined;
        let earnStep: string | undefined;
        let note: string | undefined;

        if (args.includes('|')) {
          const p = args.split('|').map((s) => s.trim());
          [nick, cat, rateRaw, cap, capWindow, capGroup, note] = p;
        } else {
          const tok = args.trim().split(/\s+/);
          if (tok.length < 3)
            return reply('*Add an earn rule*\n`/addearn <card> <category> <rate>`\n\n' +
                'Examples:\n' +
                '`/addearn citirw shopping 4` — 4 miles per dollar\n' +
                '`/addearn uobone groceries 5%` — 5% cashback\n' +
                '`/addearn citirw shopping 4 cap 1000` — bonus rate stops after $1,000\n' +
                '`/addearn citirw online 4 cap 1000 group tenx` — shares that cap with other `tenx` rules\n' +
                '`/addearn citirw * 0.4` — the fallback rate for everything else\n' +
                '`/addearn citirw online 4 mcc 5262,5964,5969` — only those merchant codes\n\n' +
                'Extras, in any order: `cap <amount>`, `window <statement_cycle|calendar_month|calendar_quarter|membership_quarter>`, `group <name>`, `mcc <codes>`, `tier <amount>`, `mode <key>`, `region <local|foreign>`, `step <amount>`, `min <amount>`, `note <text>`\n\n' +
                '`tier` is for cards whose rate moves with the spend rung: `/addearn uobone groceries 6% tier 1000` earns 6% only while the card holds the $1,000 tier.\n' +
                '`mode` is for cards you choose the reward of: the rule applies only while that mode is selected — /mode.\n' +
                '`step` is for cards that round a transaction down before paying on it: `step 5` is Trust\'s nearest S$5.'
            );
          [nick, cat, rateRaw] = tok;
          for (let i = 3; i < tok.length; i += 2) {
            const k = tok[i].toLowerCase();
            const v = tok[i + 1];
            if (k === 'cap') cap = v;
            else if (k === 'window') capWindow = v;
            else if (k === 'group') capGroup = v;
            else if (k === 'mcc') mccList = v;
            else if (k === 'tier') minTier = v;
            else if (k === 'mode') modeKey = v;
            else if (k === 'region') region = v?.toLowerCase();
            else if (k === 'min') minTxn = v;
            else if (k === 'step') earnStep = v;
            else if (k === 'note') {
              note = tok.slice(i + 1).join(' ');
              break;
            }
          }
        }

        const card = await cardByNick(env, nick);
        if (!card) return reply(`No card with nickname \`${nick}\`. /cards to list them.`);

        const isCashback = /%$/.test(rateRaw ?? '');
        const rate = parseFloat((rateRaw ?? '').replace('%', ''));
        if (!Number.isFinite(rate)) return reply(`Could not read a rate from "${rateRaw}".`);

        // A list of codes is what makes a rule precise: "4 mpd online" is not
        // the same thing as "4 mpd on 5262, 5964 and 5969", and the terms
        // almost always say the second.
        const include = (mccList ?? '')
          .split(/[,\s]+/)
          .map((x) => x.trim())
          .filter(Boolean);
        if (include.some((x) => !isCodeEntry(x)))
          return reply(
            `\`mcc\` takes four-digit codes, comma separated, and ranges like \`3000-3308\` — got "${mccList}".`
          );

        // Same as the app: a rule added now belongs to the card's current
        // version, not loose beside it.
        const botRuleSet = await currentRuleSetFor(env, card.id, today(env));
        if (region && region !== 'local' && region !== 'foreign')
          return reply('`region` is `local` or `foreign` — leave it out for a rate that applies everywhere.');

        // A mode has to be one the card actually offers, or the rule would sit
        // in the table applying to nothing and looking like it applied.
        if (modeKey) {
          const offered = await modesOf(env, (card as any).product_id ?? null);
          // `bonus_cashback:dining` is a mode and one of the categories it lets
          // you pick; both halves have to be real, or the rule would apply to
          // nothing while looking as if it applied.
          const [modePart, pick] = modeKey.split(':');
          const mode = offered.find((m) => m.mode_key === modePart);
          if (!mode)
            return reply(
              offered.length
                ? `*${card.product}* has no mode called \`${modePart}\` — it offers ${offered.map((m) => `\`${m.mode_key}\``).join(', ')}.`
                : `*${card.product}* has no selectable modes yet. Add them with \`/mode ${card.nickname} add <key>|<label>|<payout>\`.`
            );
          if (pick) {
            const allowed = (mode.category_choices ?? '').split(',').map((c) => c.trim().toLowerCase());
            if (!mode.picks_category || !allowed.includes(pick.toLowerCase()))
              return reply(
                mode.picks_category
                  ? `${mode.label} does not offer \`${pick}\` — it offers ${allowed.join(', ')}.`
                  : `${mode.label} does not make you pick a category, so \`:${pick}\` means nothing on it.`
              );
          }
        }

        await env.DB.prepare(
          `INSERT INTO earn_rules (card_id, rule_set_id, category, mpd, reward_type, mcc_include, min_tier_cents,
             cap_cents, cap_window, cap_group, mode_key, earn_step_cents, region, min_txn_cents, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            card.id,
            botRuleSet,
            cat.toLowerCase(),
            rate,
            isCashback ? 'cashback' : 'miles',
            include.length ? include.join(',') : null,
            minTier ? parseMoney(minTier) : null,
            cap ? parseMoney(cap) : null,
            capWindow || (cap ? 'statement_cycle' : null),
            capGroup || null,
            modeKey || null,
            earnStep ? parseMoney(earnStep) : null,
            region || null,
            minTxn ? parseMoney(minTxn) : null,
            note || null
          )
          .run();

        return reply(`*${card.product}* earns ${formatRate(rate, isCashback ? 'cashback' : 'miles')} on *${cat}*` +
            (include.length ? `, but only on MCC ${include.join(', ')}` : '') +
            (minTier ? `, and only while the card holds the $${money(parseMoney(minTier) ?? 0)} tier` : '') +
            (modeKey ? `, while the card is set to \`${modeKey}\`` : '') +
            (region ? `, on ${region} spend only` : '') +
            (minTxn ? `, on purchases of $${money(parseMoney(minTxn) ?? 0)} or more` : '') +
            (earnStep ? `, rounding each purchase down to $${money(parseMoney(earnStep) ?? 0)}` : '') +
            (cap ? `, up to $${money(parseMoney(cap) ?? 0)} per ${capWindow || 'statement_cycle'}` : '') +
            (capGroup ? `\n_Shares that cap with other \`${capGroup}\` rules._` : '') +
            '\n\nTry `/which ' + cat.toLowerCase() + ' 100`.'
        );
      }

      case '/cardrules': {
        const card = await cardByNick(env, args.trim());
        if (!card) return reply('Format: `/cardrules citirw` — use /cards for nicknames.');
        await reply(`Open ${card.product}'s rewards page, then paste this into Claude with it:`);
        return reply(cardRulesPrompt(card.nickname, card.product), { parse_mode: undefined });
      }

      case '/merchants': {
        const { results } = await env.DB.prepare(
          `SELECT merchant, category, hits FROM merchant_categories ORDER BY hits DESC, merchant LIMIT 30`
        ).all<any>();
        if (!results?.length)
          return reply('Nothing learned yet. Tag a merchant once: `25.40 citirw #groceries NTUC`');
        return reply('*Learned merchants*\n' + results.map((r) => `${r.merchant} → ${r.category} _(${r.hits}×)_`).join('\n')
        );
      }

      /**
       * Correct a rate that was entered wrong.
       *
       * An in-place edit, deliberately: this is for a rate that was always
       * meant to be 5% and got typed as 4. A rate the BANK changed is a
       * different thing and belongs in a new version, or the months already
       * earned get restated — Catalogue → Edit its rules is where that goes.
       */
      case '/setearn': {
        const [idRaw, rateRaw] = args.trim().split(/\s+/);
        const id = parseInt(idRaw, 10);
        const isCashback = /%$/.test(rateRaw ?? '');
        const rate = parseFloat((rateRaw ?? '').replace('%', ''));
        if (!id || !Number.isFinite(rate))
          return reply('Format: `/setearn <id> <rate>` — e.g. `/setearn 3 5%`.\n/earn lists the ids.');

        const rule = await env.DB.prepare(`SELECT * FROM earn_rules WHERE id = ?`).bind(id).first<any>();
        if (!rule) return reply(`No earn rule #${id}. /earn lists them.`);

        await env.DB.prepare(`UPDATE earn_rules SET mpd = ?, reward_type = ? WHERE id = ?`)
          .bind(rate, isCashback ? 'cashback' : 'miles', id)
          .run();
        return reply(
          `Earn rule #${id} (${rule.category}) now pays ${formatRate(rate, isCashback ? 'cashback' : 'miles')}` +
            `, was ${formatRate(rule.mpd, rule.reward_type)}.`
        );
      }

      case '/delearn':
        await env.DB.prepare(`UPDATE earn_rules SET active = 0 WHERE id = ?`).bind(parseInt(args, 10)).run();
        return reply(`Earn rule #${parseInt(args, 10)} removed.`);

      case '/addconv': {
        // from|to|from_units|to_units|fee|min_block|increment|route
        const p = args.split('|').map((s) => s.trim());
        if (p.length < 7)
          return reply('Format: `/addconv citi_ty|krisflyer|25000|10000|27.25|25000|25000|direct`');
        const [from, to, fu, tu, fee, minB, inc, route] = p;
        await env.DB.prepare(
          `INSERT INTO conversions (from_program, to_program, from_units, to_units, fee_cents, min_block, block_increment, route)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(from, to, parseInt(fu, 10), parseInt(tu, 10), parseMoney(fee) ?? 0, parseInt(minB, 10), parseInt(inc, 10), route || null)
          .run();
        return reply(`Route added: ${from} → ${to} via ${route || 'direct'}.`);
      }

      case '/add':
        return logSpend(env, chatId, args, reply);

      default:
        // Anything that isn't a command is treated as a spend entry.
        if (!text.startsWith('/')) return logSpend(env, chatId, text, reply);
        return reply(`Unknown command. /help`);
    }
  } catch (err) {
    await reply(`Error: ${(err as Error).message}`);
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
async function logSpend(env: Env, chatId: string, input: string, reply: Reply) {
  const tokens = input.trim().split(/\s+/);
  if (tokens.length < 2) return reply('Format: `25.40 uobone lunch` — add a date like `yesterday` or `5/9` to backdate.');

  let amount: number | null = null;
  let occurred: string | null = null;
  let category: string | null = null;
  let foreign: boolean | null = null;
  const rest: string[] = [];

  for (const tok of tokens) {
    // `#fx` marks foreign spend — overseas, or charged in another currency —
    // which some cards pay less on. Checked before the category tag, because
    // it is not one: `25 freedom #fx #dining` is a foreign dinner.
    if (/^#(fx|foreign|overseas)$/i.test(tok)) {
      foreign = true;
      continue;
    }
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

  if (amount === null) return reply(`Could not read an amount from "${input}".`);
  if (!rest.length) return reply('Which card? e.g. `25.40 uobone lunch`');

  const nick = rest[0];
  const note = rest.slice(1).join(' ');
  const date = occurred ?? today(env);

  if (date > today(env)) {
    return reply(`${date} is in the future — check the date and try again.`);
  }

  const card = await cardByNick(env, nick);
  if (!card) return reply(`No card with nickname \`${nick}\`. /cards to list them.`);

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

  // The bot goes through the same pipeline as everything else, so a swipe
  // logged here is deduplicated against the statement that will arrive days
  // later, and priced by the rules that applied on its date.
  const result = await ingestTransaction(env, {
    source: 'telegram',
    card_id: card.id,
    amount_cents: amount,
    occurred_at: date,
    merchant: note || null,
    category: resolved,
    foreign,
  });
  if (result.status === 'rejected') return reply(result.warnings[0]?.detail ?? 'Could not log that.');

  const row = await env.DB.prepare(`SELECT category, category_source, mcc FROM transactions WHERE id = ?`)
    .bind(result.transaction_id)
    .first<{ category: string | null; category_source: string | null; mcc: string | null }>();
  if (!resolved && row?.category) {
    resolved = row.category;
    source = row.category_source;
    learned = true;
  }
  const expected = {
    miles: result.reward?.miles ?? 0,
    cashback_cents: result.reward?.cashback_cents ?? 0,
    reward_type: (result.reward?.miles ?? 0) > 0 ? 'miles' : 'cashback',
  };
  const program = result.reward?.program ?? null;
  const ins = { meta: { last_row_id: result.transaction_id! } };

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
  await reply(bits.join('\n'));

  for (const alert of await checkAlerts(env, card)) await reply(alert);
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
