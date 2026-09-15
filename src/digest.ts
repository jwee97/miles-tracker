import {
  activeCards,
  claimAlert,
  money,
  requirementProgress,
  requirementsFor,
  standings,
  today,
  utilization,
  type Progress,
} from './spend';
import type { Card, Env } from './types';

const bar = (pct: number, width = 10) => {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
};

/** The three statement months of a quarter, as ticks, crosses and the one in play. */
function quarterLine(p: Progress): string[] {
  if (!p.months.length) return [];
  const marks = p.months
    .map((m) => {
      const mark = m.qualified ? '✅' : m.state === 'past' ? '❌' : m.state === 'current' ? '▶️' : '·';
      return `${mark} M${m.index} $${money(m.spent_cents)}${p.txns_required > 0 ? `/${m.txn_count}tx` : ''}`;
    })
    .join('  ');
  const out = [`  _Q${p.quarter!.index} to ${p.quarter!.end}_`, `  ${marks}`];

  const dead = p.months_missed > 0 && !p.thirds;
  if (dead) {
    out.push(`  🛑 ${p.months_missed} month(s) short — this quarter pays nothing`);
  } else if (p.quarter_tier && p.thirds) {
    const share = p.thirds === 3 ? '' : ` (${p.thirds}/3 pro-rated)`;
    out.push(`  💰 on course for $${money(p.projected_reward_cents)}${share} at the $${money(p.quarter_tier.min_spend_cents)} tier`);
  }
  // The next rung up is the one piece of advice a tier table can give — but
  // only while there is still a quarter to earn. Urging more spend into a
  // quarter that already pays nothing is the opposite of useful.
  const next = dead ? undefined : p.tiers.find((t) => t.min_spend_cents > p.spent_cents);
  if (next) {
    out.push(`  ↗ $${money(next.min_spend_cents - p.spent_cents)} more this month reaches the $${money(next.min_spend_cents)} tier ($${money(next.reward_cents)}/quarter)`);
  }
  return out;
}

/**
 * Full status report, led by minimum spend.
 *
 * The limit is what a credit score reads; the minimum is what you can still do
 * something about today. Miss one and the month's bonus is gone, so that comes
 * first and the balance rides underneath it.
 */
export async function buildDigest(env: Env): Promise<string> {
  const rows = await standings(env);
  if (!rows.length) return 'No cards yet. Add one with /newcard — see /help for the format.';

  const warnDays = parseInt(env.MIN_SPEND_WARN_DAYS || '7', 10);
  const lines: string[] = [`*Cards* — ${today(env)}`, ''];

  let totalBal = 0;
  let totalLimit = 0;
  let open = 0;
  let met = 0;
  let stillNeeded = 0;

  for (const { card, utilization: u, requirements, headline, percent, lost } of rows) {
    totalBal += u.balance_cents;
    totalLimit += u.limit_cents;

    // The headline flag is about the minimum, not the limit: a warning means a
    // bonus is about to be lost, which is the thing worth interrupting you for.
    // A bonus ALREADY lost is not a warning — nothing you spend brings it back.
    const flag = lost ? ' 🛑' : headline && !headline.met && headline.days_left <= warnDays ? ' ⚠️' : '';
    lines.push(`*${card.product}* (${card.nickname})${flag}`);

    if (headline) {
      const req = headline.requirement;
      const txns = headline.txns_required > 0 ? ` · ${headline.txn_count}/${headline.txns_required} tx` : '';
      lines.push(
        `${bar(percent)} ${percent.toFixed(0)}% · $${money(headline.spent_cents)} / $${money(req.amount_cents)}${txns}`
      );
      lines.push(
        lost
          ? `_this quarter is already short — spend here earns only the base rate until ${headline.quarter!.end}_`
          : headline.met
          ? `_minimum met · window ends ${headline.window.end}, ${headline.days_left}d_`
          : `_$${money(headline.remaining_cents)} to go by ${headline.window.end}, ${headline.days_left}d` +
            (headline.remaining_cents > 0 && headline.days_left > 0 ? ` (~$${money(headline.per_day_cents)}/day)` : '') +
            '_'
      );
    } else {
      lines.push(`_no minimum to hit · $${money(u.balance_cents)} of $${money(u.limit_cents)}_`);
    }

    for (const p of requirements) {
      const req = p.requirement;
      const label =
        req.kind === 'signup_min'
          ? 'Sign-up'
          : p.quarter
            ? `Q${p.quarter.index} month ${p.months.find((m) => m.state === 'current')?.index ?? 3}`
            : 'Monthly min';
      const txns = p.txns_required > 0 ? ` · ${p.txn_count}/${p.txns_required} txns` : '';

      open += p.met ? 0 : 1;
      met += p.met ? 1 : 0;
      stillNeeded += p.remaining_cents;

      if (p.met && p.met_only_with_at_risk) {
        // The dangerous case: counting spend that may not post in time reads as
        // "met", and you stop spending on a minimum you have not actually hit.
        lines.push(
          `  ⏳ ${label} $${money(req.amount_cents)} met only if $${money(p.at_risk_cents)} posts in time` +
            `\n  ↳ confirmed $${money(p.confirmed_cents)} — spend $${money(req.amount_cents - p.confirmed_cents)} more to be safe`
        );
      } else if (p.met) {
        lines.push(`  ✅ ${label} $${money(req.amount_cents)} met ($${money(p.spent_cents)}${txns})`);
      } else {
        const urgent = p.days_left <= warnDays ? '⚠️ ' : '';
        const amountPart =
          p.remaining_cents > 0
            ? `$${money(p.spent_cents)} / $${money(req.amount_cents)} · $${money(p.remaining_cents)} to go`
            : `$${money(p.spent_cents)} ✓`;
        lines.push(`  ${urgent}${label}: ${amountPart}${txns}, ${p.days_left}d` +
          (p.remaining_cents > 0 && p.days_left > 0 ? ` (~$${money(p.per_day_cents)}/day)` : ''));
        if (p.at_risk_cents > 0) {
          lines.push(`  ↳ includes $${money(p.at_risk_cents)} that may post next window`);
        }
        if (p.remaining_cents === 0 && p.txns_remaining > 0) {
          lines.push(`  ↳ amount met — still needs ${p.txns_remaining} more transaction(s)`);
        }
      }

      lines.push(...quarterLine(p));

      // The mirror of a minimum: past the cap, this card earns its base rate and
      // further spend belongs somewhere else.
      if (p.cap_reached) {
        lines.push(`  🛑 Bonus cap $${money(req.bonus_cap_cents!)} reached — $${money(p.over_cap_cents)} over. Switch cards.`);
      }
      if (req.reward_note) lines.push(`  _${req.reward_note}_`);
    }

    // The limit still matters to a credit score, so it is reported — just not
    // as the thing you are being asked to look at.
    if (headline && u.limit_cents > 0) {
      lines.push(`  _balance $${money(u.balance_cents)} of $${money(u.limit_cents)} (${u.percent.toFixed(0)}%), statement closes ${u.cycle.end}_`);
    }
    if (u.at_risk_cents > 0) {
      lines.push(`  ⏳ $${money(u.at_risk_cents)} may post after the cycle closes`);
    }
    lines.push('');
  }

  if (open + met > 0) {
    lines.push(
      `*Minimums* ${met}/${met + open} met` + (stillNeeded > 0 ? ` · $${money(stillNeeded)} still to spend` : '')
    );
  }
  // Total utilization across all cards is what actually moves a credit score.
  if (totalLimit > 0) {
    const pct = (totalBal / totalLimit) * 100;
    lines.push(`_Overall balance $${money(totalBal)} / $${money(totalLimit)} · ${pct.toFixed(0)}%_`);
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
          const short: string[] = [];
          if (p.remaining_cents > 0) short.push(`$${money(p.remaining_cents)} of $${money(req.amount_cents)}`);
          if (p.txns_remaining > 0) short.push(`${p.txns_remaining} more transaction(s)`);
          out.push(
            `⚠️ *${card.product}* ${req.kind === 'signup_min' ? 'sign-up' : 'minimum'} not met\n` +
              `${short.join(' and ')} left · ${p.days_left}d to ${p.window.end}` +
              (p.remaining_cents > 0 && p.days_left > 0 ? `\nNeed ~$${money(p.per_day_cents)}/day` : '')
          );
        }
      }
      if (p.met_only_with_at_risk && (await claimAlert(env, `atrisk:${req.id}:${p.window.end}`))) {
        out.push(
          `⏳ *${card.product}* minimum looks met, but $${money(p.at_risk_cents)} of it may post after ${p.window.end}.\n` +
            `Confirmed: $${money(p.confirmed_cents)} of $${money(req.amount_cents)}. ` +
            `Spend $${money(req.amount_cents - p.confirmed_cents)} more to be certain.`
        );
      }
      // A quarter lost to one thin statement month is worth knowing about the
      // moment it happens, not when the cashback fails to arrive months later.
      for (const m of p.months) {
        if (m.state !== 'past' || m.qualified) continue;
        if (!(await claimAlert(env, `qmonth:${req.id}:${m.window.end}`))) continue;
        const short: string[] = [];
        if (m.spent_cents < req.amount_cents) short.push(`$${money(req.amount_cents - m.spent_cents)} short of $${money(req.amount_cents)}`);
        if (p.txns_required > 0 && m.txn_count < p.txns_required)
          short.push(`${p.txns_required - m.txn_count} transaction(s) short`);
        out.push(
          `❌ *${card.product}* month ${m.index} of Q${p.quarter!.index} closed ${short.join(' and ')}.\n` +
            (p.thirds
              ? `The quarter pro-rates to ${p.thirds}/3.`
              : `That quarter now pays nothing — the next one starts ${p.quarter!.end}.`)
        );
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
