import { mintToken } from './auth';
import { buildDigest, checkAlerts } from './digest';
import { extractionPrompt, HELP } from './extraction';
import { evaluateOffer } from './eligibility';
import { scanFeeds } from './rss';
import { money, parseMoney, requirementProgress, requirementsFor, today } from './spend';
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

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const cardByNick = (env: Env, nick: string) =>
  env.DB.prepare(`SELECT * FROM cards WHERE nickname = ? COLLATE NOCASE`).bind(nick.trim()).first<Card>();

/** Notify about new feed matches, each with Track / Ignore buttons. */
export async function pushFeedMatches(env: Env, chatId: string) {
  const fresh = await scanFeeds(env);
  for (const item of fresh) {
    await send(env, chatId, `📰 *${item.feed}*\n${item.title}\n${item.link}`, {
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
  return fresh.length;
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
            `\n  opened ${c.opened_at ?? '?'}${c.closed_at ? ` · closed ${c.closed_at}` : ''}`
        );
        return send(env, chatId, lines.join('\n\n'));
      }

      case '/newcard': {
        // issuer|product|nickname|limit|statement_day|opened_at
        const p = args.split('|').map((s) => s.trim());
        if (p.length < 5)
          return send(env, chatId, 'Format:\n`/newcard DBS|Altitude Visa|alt|8000|18|2025-03-04`');
        const [issuer, product, nickname, limit, stmtDay, opened] = p;
        await env.DB.prepare(
          `INSERT INTO cards (issuer, product, product_key, nickname, credit_limit_cents, statement_day, opened_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            issuer,
            product,
            slug(`${issuer}_${product}`),
            nickname.toLowerCase(),
            parseMoney(limit) ?? 0,
            parseInt(stmtDay, 10) || 1,
            opened || null
          )
          .run();
        return send(env, chatId, `Added *${product}* as \`${nickname.toLowerCase()}\`.`);
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
        // nickname|kind|amount|window|deadline|cap|note
        const p = args.split('|').map((s) => s.trim());
        if (p.length < 4)
          return send(
            env,
            chatId,
            'Format:\n`/req wwmc|monthly_min|800|calendar_month||1000|4 mpd on first $1k`\n`/req alt|signup_min|1000|fixed_window|2026-11-14||30k miles`'
          );
        const [nick, kind, amount, window, deadline, cap, note] = p;
        const card = await cardByNick(env, nick);
        if (!card) return send(env, chatId, `No card with nickname \`${nick}\`.`);
        await env.DB.prepare(
          `INSERT INTO requirements (card_id, kind, amount_cents, window, deadline, starts_at, bonus_cap_cents, reward_note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            card.id,
            kind,
            parseMoney(amount) ?? 0,
            window,
            deadline || null,
            kind === 'signup_min' ? card.opened_at : null,
            cap ? parseMoney(cap) : null,
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
                (r.bonus_cap_cents ? ` · cap $${money(r.bonus_cap_cents)}` : '')
            )
            .join('\n')
        );
      }

      case '/delreq':
        await env.DB.prepare(`UPDATE requirements SET active = 0 WHERE id = ?`).bind(parseInt(args, 10)).run();
        return send(env, chatId, `Requirement #${parseInt(args, 10)} removed.`);

      case '/offers': {
        const { results } = await env.DB.prepare(
          `SELECT * FROM offers WHERE status IN ('tracked','applied') ORDER BY created_at DESC LIMIT 20`
        ).all<Offer>();
        if (!results?.length) return send(env, chatId, 'No tracked offers yet.');
        const out: string[] = [];
        for (const o of results) {
          const e = await evaluateOffer(env, o.id);
          const icon = e.verdict === 'eligible' ? '✅' : e.verdict === 'not_eligible' ? '❌' : '🟡';
          out.push(
            `${icon} *#${o.id} ${o.issuer ?? '?'} ${o.product ?? o.source_title ?? ''}*` +
              (o.bonus_miles ? `\n  ${o.bonus_miles.toLocaleString()} miles` : '') +
              (o.min_spend_cents ? ` for $${money(o.min_spend_cents)} in ${o.spend_window_days ?? '?'}d` : '') +
              (o.valid_until ? `\n  expires ${o.valid_until}` : '') +
              (e.rules.length
                ? '\n' + e.rules.map((r) => `  ${r.verdict === 'pass' ? '·' : r.verdict === 'fail' ? '✗' : '?'} ${r.reason}`).join('\n')
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
        const json = m[2].replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        let data: any;
        try {
          data = JSON.parse(json);
        } catch (e) {
          return send(env, chatId, `Could not parse that JSON: ${(e as Error).message}`);
        }
        await env.DB.prepare(
          `UPDATE offers SET issuer=?, product=?, product_key=?, bonus_miles=?, bonus_note=?,
             min_spend_cents=?, spend_window_days=?, valid_from=?, valid_until=?,
             status='tracked', extracted_at=datetime('now') WHERE id = ?`
        )
          .bind(
            data.issuer ?? null,
            data.product ?? null,
            data.product_key ?? (data.issuer && data.product ? slug(`${data.issuer}_${data.product}`) : null),
            data.bonus_miles ?? null,
            data.bonus_note ?? null,
            data.min_spend != null ? Math.round(data.min_spend * 100) : null,
            data.spend_window_days ?? null,
            data.valid_from ?? null,
            data.valid_until ?? null,
            id
          )
          .run();
        await env.DB.prepare(`DELETE FROM offer_rules WHERE offer_id = ?`).bind(id).run();
        for (const r of data.rules ?? []) {
          await env.DB.prepare(`INSERT INTO offer_rules (offer_id, predicate, quote) VALUES (?, ?, ?)`)
            .bind(id, JSON.stringify(r.predicate ?? r), r.quote ?? null)
            .run();
        }
        const e = await evaluateOffer(env, id);
        const icon = e.verdict === 'eligible' ? '✅ Eligible' : e.verdict === 'not_eligible' ? '❌ Not eligible' : '🟡 Needs review';
        return send(
          env,
          chatId,
          `Saved offer #${id} with ${(data.rules ?? []).length} rule(s).\n\n*${icon}*\n` +
            e.rules.map((r) => `${r.verdict === 'pass' ? '·' : r.verdict === 'fail' ? '✗' : '?'} ${r.reason}`).join('\n')
        );
      }

      case '/apply': {
        const id = parseInt(args, 10);
        await env.DB.prepare(`UPDATE offers SET status='applied' WHERE id = ?`).bind(id).run();
        return send(env, chatId, `Offer #${id} marked applied. Once approved, add the card with /newcard and its sign-up minimum with /req.`);
      }

      case '/feeds': {
        const { results } = await env.DB.prepare(`SELECT url, label, active FROM feeds`).all<any>();
        return send(env, chatId, (results ?? []).map((f) => `${f.active ? '·' : '✖'} ${f.label} — ${f.url}`).join('\n') || 'No feeds.');
      }

      case '/addfeed': {
        const [url, label] = args.split('|').map((s) => s.trim());
        await env.DB.prepare(`INSERT OR REPLACE INTO feeds (url, label) VALUES (?, ?)`).bind(url, label || url).run();
        return send(env, chatId, `Feed added: ${label || url}`);
      }

      case '/scan': {
        const n = await pushFeedMatches(env, chatId);
        if (n === 0) await send(env, chatId, 'No new promo items.');
        return;
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

/** Accepts "25.40 wwmc lunch" or "wwmc 25.40 lunch". */
async function logSpend(env: Env, chatId: string, input: string) {
  const parts = input.trim().split(/\s+/);
  if (parts.length < 2) return send(env, chatId, 'Format: `25.40 wwmc lunch`');

  let amount = parseMoney(parts[0]);
  let nick = parts[1];
  let note = parts.slice(2).join(' ');
  if (amount === null) {
    amount = parseMoney(parts[1]);
    nick = parts[0];
    note = parts.slice(2).join(' ');
  }
  if (amount === null) return send(env, chatId, `Could not read an amount from "${input}".`);

  const card = await cardByNick(env, nick);
  if (!card) return send(env, chatId, `No card with nickname \`${nick}\`. /cards to list them.`);

  await env.DB.prepare(
    `INSERT INTO transactions (card_id, amount_cents, occurred_at, merchant, source) VALUES (?, ?, ?, ?, 'manual')`
  )
    .bind(card.id, amount, today(env), note || null)
    .run();

  // Immediate feedback: what this swipe did to the limit and to any minimum.
  const reqs = await requirementsFor(env, card.id);
  const bits: string[] = [`Logged $${money(amount)} on *${card.product}*.`];
  for (const req of reqs) {
    const p = await requirementProgress(env, card, req);
    bits.push(
      p.met
        ? `✅ ${req.kind === 'signup_min' ? 'Sign-up' : 'Monthly'} minimum met.`
        : `$${money(p.remaining_cents)} to go on the ${req.kind === 'signup_min' ? 'sign-up' : 'monthly'} minimum (${p.days_left}d).`
    );
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
    await env.DB.prepare(`UPDATE feed_items SET action = 'ignored' WHERE id = ?`).bind(id).run();
    return answerCallback(env, cq.id, 'Ignored');
  }

  if (action === 'track') {
    const item = await env.DB.prepare(`SELECT * FROM feed_items WHERE id = ?`).bind(id).first<any>();
    if (!item) return answerCallback(env, cq.id, 'Gone');
    const ins = await env.DB.prepare(
      `INSERT INTO offers (status, source_url, source_title) VALUES ('pending', ?, ?)`
    )
      .bind(item.link, item.title)
      .run();
    const offerId = ins.meta.last_row_id as number;
    await env.DB.prepare(`UPDATE feed_items SET action = 'tracked', offer_id = ? WHERE id = ?`)
      .bind(offerId, id)
      .run();
    await answerCallback(env, cq.id, `Tracked as offer #${offerId}`);
    await send(env, chatId, `Tracked as offer #${offerId}. Run \`/extract ${offerId}\` to get the prompt for Claude.`);
  }
}
