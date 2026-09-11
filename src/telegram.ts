import { mintToken } from './auth';
import { buildDigest, checkAlerts } from './digest';
import { extractionPrompt, HELP } from './extraction';
import { evaluateOffer } from './eligibility';
import { scanFeeds } from './rss';
import { activeCards, daysBetween, money, parseDateToken, parseMoney, requirementProgress, requirementsFor, today, utilization } from './spend';
import { balances, planRoutes, rankCards, ratesReview } from './points';
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
        const [cat, amt] = args.trim().split(/\s+/);
        if (!cat) return send(env, chatId, 'Format: `/which groceries 120` — the amount is optional.');
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

        const picks = await rankCards(env, cat.toLowerCase(), cents, { cards, minSpendNudge: nudges });
        if (!picks.length) return send(env, chatId, 'No earn rules yet — add one with /addearn (see /help).');

        const lines = picks.map((p, i) => {
          const head =
            `${i === 0 ? '👉' : '  '} *${p.card.product}* — ${p.effective_mpd} mpd` +
            (p.miles !== null ? ` · ${p.miles.toLocaleString()} miles` : '');
          const why = p.reasons.length ? '\n     _' + p.reasons.join('; ') + '_' : '';
          return head + why;
        });
        return send(env, chatId, `*${cat}*${cents ? ` · $${money(cents)}` : ''}\n\n` + lines.join('\n'));
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

      case '/rates':
        return send(env, chatId, await ratesReview(env));

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
                  `#${r.id} *${r.nickname}* ${r.category} → ${r.mpd} mpd` +
                  (r.cap_cents ? ` (cap $${money(r.cap_cents)}/${r.cap_window ?? 'cycle'}${r.cap_group ? `, shared: ${r.cap_group}` : ''})` : '') +
                  (r.note ? `\n     _${r.note}_` : '')
              )
              .join('\n')
        );
      }

      case '/addearn': {
        // nickname|category|mpd|cap|cap_window|cap_group|note
        const p = args.split('|').map((s) => s.trim());
        if (p.length < 3)
          return send(
            env,
            chatId,
            'Format: `nickname|category|mpd|cap|cap_window|cap_group|note`\n\n' +
              '`/addearn citirw|shopping|4|1000|statement_cycle|tenx|10X online`\n' +
              '`/addearn citirw|*|0.4`  ← base rate for everything else\n' +
              "Use `*` for the fallback category. Rules sharing a cap_group share one cap."
          );
        const [nick, cat, mpd, cap, capWindow, capGroup, note] = p;
        const card = await cardByNick(env, nick);
        if (!card) return send(env, chatId, `No card with nickname \`${nick}\`.`);
        await env.DB.prepare(
          `INSERT INTO earn_rules (card_id, category, mpd, cap_cents, cap_window, cap_group, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(card.id, cat.toLowerCase(), parseFloat(mpd), cap ? parseMoney(cap) : null, capWindow || null, capGroup || null, note || null)
          .run();
        return send(env, chatId, `Rule added: ${card.product} earns ${mpd} mpd on ${cat}.`);
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

  const ins = await env.DB.prepare(
    `INSERT INTO transactions (card_id, amount_cents, occurred_at, merchant, category, source) VALUES (?, ?, ?, ?, ?, 'manual')`
  )
    .bind(card.id, amount, date, note || null, category)
    .run();

  // Immediate feedback: what this swipe did to the limit and to any minimum.
  const reqs = await requirementsFor(env, card.id);
  const when = date === today(env) ? '' : ` on ${date}`;
  const bits: string[] = [`Logged $${money(amount)} to *${card.product}*${when}. (#${ins.meta.last_row_id})`];
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
