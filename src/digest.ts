import {
  activeCards,
  claimAlert,
  money,
  requirementProgress,
  requirementsFor,
  today,
  utilization,
} from './spend';
import type { Card, Env } from './types';

const bar = (pct: number, width = 10) => {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
};

/** Full status report: utilization first, then every open minimum-spend commitment. */
export async function buildDigest(env: Env): Promise<string> {
  const cards = await activeCards(env);
  if (!cards.length) return 'No cards yet. Add one with /newcard — see /help for the format.';

  const warnDays = parseInt(env.MIN_SPEND_WARN_DAYS || '7', 10);
  const lines: string[] = [`*Cards* — ${today(env)}`, ''];

  let totalBal = 0;
  let totalLimit = 0;

  for (const card of cards) {
    const u = await utilization(env, card);
    totalBal += u.balance_cents;
    totalLimit += u.limit_cents;

    const flag = u.percent >= 90 ? ' 🔴' : u.percent >= 80 ? ' 🟠' : u.percent >= 50 ? ' 🟡' : '';
    lines.push(`*${card.product}* (${card.nickname})${flag}`);
    lines.push(
      `${bar(u.percent)} ${u.percent.toFixed(0)}% · $${money(u.balance_cents)} / $${money(u.limit_cents)}`
    );
    lines.push(`_statement closes ${u.cycle.end}, ${u.days_left}d_`);

    for (const req of await requirementsFor(env, card.id)) {
      const p = await requirementProgress(env, card, req);
      const label = req.kind === 'signup_min' ? 'Sign-up' : 'Monthly min';

      if (p.met) {
        lines.push(`  ✅ ${label} $${money(req.amount_cents)} met ($${money(p.spent_cents)})`);
      } else {
        const urgent = p.days_left <= warnDays ? '⚠️ ' : '';
        lines.push(
          `  ${urgent}${label}: $${money(p.spent_cents)} / $${money(req.amount_cents)} · ` +
            `$${money(p.remaining_cents)} to go, ${p.days_left}d` +
            (p.days_left > 0 ? ` (~$${money(p.per_day_cents)}/day)` : '')
        );
      }

      // The mirror of a minimum: past the cap, this card earns its base rate and
      // further spend belongs somewhere else.
      if (p.cap_reached) {
        lines.push(`  🛑 Bonus cap $${money(req.bonus_cap_cents!)} reached — $${money(p.over_cap_cents)} over. Switch cards.`);
      }
      if (req.reward_note) lines.push(`  _${req.reward_note}_`);
    }
    lines.push('');
  }

  // Total utilization across all cards is what actually moves a credit score.
  if (totalLimit > 0) {
    const pct = (totalBal / totalLimit) * 100;
    lines.push(`*Overall* ${bar(pct)} ${pct.toFixed(0)}% · $${money(totalBal)} / $${money(totalLimit)}`);
  }

  const offers = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM offers WHERE status = 'tracked'`
  ).first<{ n: number }>();
  if ((offers?.n ?? 0) > 0) lines.push(`\n${offers!.n} tracked offer(s) — /offers`);

  return lines.join('\n');
}

/**
 * Threshold checks, deduped so each condition notifies once per cycle rather than
 * once per run. Called after every transaction and again from the daily cron.
 */
export async function checkAlerts(env: Env, onlyCard?: Card): Promise<string[]> {
  const cards = onlyCard ? [onlyCard] : await activeCards(env);
  const thresholds = (env.UTIL_THRESHOLDS || '50,80,90')
    .split(',')
    .map((t) => parseInt(t.trim(), 10))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  const warnDays = parseInt(env.MIN_SPEND_WARN_DAYS || '7', 10);
  const out: string[] = [];

  for (const card of cards) {
    const u = await utilization(env, card);

    // Highest crossed threshold only — no cascade of three messages on one swipe.
    const crossed = thresholds.filter((t) => u.percent >= t).pop();
    if (crossed !== undefined) {
      if (await claimAlert(env, `util:${card.id}:${crossed}:${u.cycle.end}`)) {
        const icon = crossed >= 90 ? '🔴' : crossed >= 80 ? '🟠' : '🟡';
        out.push(
          `${icon} *${card.product}* at ${u.percent.toFixed(0)}% of limit\n` +
            `$${money(u.balance_cents)} / $${money(u.limit_cents)} · cycle ends ${u.cycle.end}`
        );
      }
    }

    for (const req of await requirementsFor(env, card.id)) {
      const p = await requirementProgress(env, card, req);
      if (!p.met && p.days_left <= warnDays) {
        if (await claimAlert(env, `minspend:${req.id}:${p.window.end}`)) {
          out.push(
            `⚠️ *${card.product}* ${req.kind === 'signup_min' ? 'sign-up' : 'monthly'} minimum\n` +
              `$${money(p.remaining_cents)} left of $${money(req.amount_cents)} · ${p.days_left}d to ${p.window.end}` +
              (p.days_left > 0 ? `\nNeed ~$${money(p.per_day_cents)}/day` : '')
          );
        }
      }
      if (p.cap_reached && (await claimAlert(env, `cap:${req.id}:${p.window.end}`))) {
        out.push(
          `🛑 *${card.product}* hit its bonus cap of $${money(req.bonus_cap_cents!)}\n` +
            `Further spend earns the base rate — switch cards.`
        );
      }
    }
  }
  return out;
}
