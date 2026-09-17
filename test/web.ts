/**
 * The web app, driven in a real browser against stubbed responses.
 *
 * The unit suites prove the engine; this proves the screen. They fail for
 * different reasons: a correct recommendation rendered into a field that does
 * not exist is a green test suite and a blank page, and that gap is exactly
 * what a contract change between the Worker and the app produces.
 *
 * Everything the browser would fetch is intercepted, so the test needs no
 * database, no Worker and no network.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

let fails = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  -- ${detail}`}`);
};

const DIST = new URL('../web/dist/', import.meta.url).pathname;
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

const pick = (nickname: string, product: string, over: Record<string, unknown> = {}) => ({
  card: { id: 1, nickname, issuer: 'DBS', product, product_id: 7 },
  reward: { type: 'miles', amount: 480, effective_rate: 4, value_cents: 720 },
  cap: { applies: true, cap_cents: 100000, used_cents: 66300, remaining_cents: 33700 },
  minimum_spend: null,
  rule_set_id: 3,
  reasons: [
    { pass: true, text: 'Online purchase qualifies' },
    { pass: true, text: 'MCC 5311 qualifies' },
  ],
  score_components: {
    reward_value: 720,
    objective_bonus: 0,
    minimum_spend_bonus: 0,
    urgency_bonus: 0,
    uncertainty_penalty: -250,
    exhausted_cap_penalty: 0,
  },
  score: 470,
  disqualified: null,
  ...over,
});

const RECOMMENDATION = {
  purchase: { amount_cents: 12000, mcc: '5311', category: 'online', channel: 'online', resolved_from: 'merchant' },
  merchant: {
    query: 'Shopee',
    merchant: 'Shopee',
    mcc: '5311',
    description: 'Department stores',
    category: 'online',
    channel: 'online',
    confidence: 'guess',
    source: 'learned',
    alternatives: [],
  },
  objective: 'balanced',
  confidence: { level: 'low', reasons: ['the merchant code is unknown, and a card’s bonus turns on it'] },
  recommendation: pick('wwmc', "Woman's World Card"),
  alternatives: [
    pick('citirw', 'Rewards Card', {
      card: { id: 2, nickname: 'citirw', issuer: 'Citi', product: 'Rewards Card', product_id: 9 },
      reward: { type: 'miles', amount: 480, effective_rate: 4, value_cents: 720 },
      cap: { applies: true, cap_cents: 100000, used_cents: 92900, remaining_cents: 7100 },
      score: 400,
    }),
  ],
  ineligible: [
    pick('alt', 'Altitude Visa', {
      card: { id: 3, nickname: 'alt', issuer: 'DBS', product: 'Altitude Visa', product_id: 11 },
      disqualified: { reason: 'excluded code', detail: '5311 is excluded on this card' },
    }),
  ],
  split_advice: {
    bonus_cents: 33700,
    remainder_cents: 8300,
    use: 'Rewards Card',
    earns: '170 miles',
    gain_cents: 310,
  },
  assumptions: [
    { what: 'the merchant code', because: 'no code recorded for this merchant', weight: 'material' },
    { what: 'the channel', because: 'not given, and the merchant is usually online', weight: 'minor' },
  ],
  evaluated_at: '2026-09-17',
  data_version: 'never verified',
};

const CATALOG = {
  products: [
    {
      id: 7,
      product_key: 'dbs_womans_world',
      issuer: 'DBS',
      product_name: "Woman's World Card",
      network: 'mastercard',
      reward_type: 'miles',
      program_key: 'dbs_points',
      base_mpd: 0.4,
      base_cashback_pct: null,
      annual_fee_cents: null,
      official_url: 'https://example.invalid/wwmc',
      source: 'catalog',
      verification_status: 'draft',
      last_verified_at: null,
      stale: true,
      current_rule_set: { id: 3, version: 1, effective_from: '2024-05-10' },
      rules: 2,
      held_by: ['wwmc'],
    },
    {
      id: 9,
      product_key: 'uob_one',
      issuer: 'UOB',
      product_name: 'One Card',
      network: 'visa',
      reward_type: 'cashback',
      program_key: null,
      base_mpd: null,
      base_cashback_pct: null,
      annual_fee_cents: null,
      official_url: 'https://example.invalid/one',
      source: 'catalog',
      verification_status: 'draft',
      last_verified_at: null,
      stale: true,
      current_rule_set: null,
      rules: 0,
      held_by: [],
    },
  ],
};

const CATALOG_WITH_DRAFT: any = {
  product: { ...CATALOG.products[0] },
  versions: [
    {
      id: 3,
      version: 1,
      status: 'published',
      effective_from: '2024-05-10',
      effective_until: null,
      notes: 'migrated from per-card rules',
      rules: [
        {
          id: 1,
          category: 'online',
          mpd: 4,
          reward_type: 'miles',
          cap_cents: 100000,
          mcc_include: '5311,5399',
          mcc_exclude: null,
          channel: 'online',
          min_tier_cents: null,
        },
      ],
      exclusions: [{ id: 1, mcc: '4900', reason: 'utilities excluded' }],
    },
  ],
  sources: [],
  overlaps: [],
};

const ACTIONS = {
  as_of: '2026-09-18',
  actions: [
    {
      kind: 'minimum_spend',
      subject: 'one',
      title: 'Spend another $164.00 on one',
      detail: 'By 2026-09-30. $20.50 a day from here.',
      amount_cents: 16400,
      deadline: '2026-09-30',
      days_left: 8,
      urgency: 'soon',
      target: 'cards',
      priority: 10,
      count: 1,
    },
    {
      kind: 'cap_nearly_gone',
      subject: 'wwmc',
      title: "Only $83.00 of wwmc's bonus allowance remains",
      detail: '4 mpd on the first $1,000. Spend past it earns the base rate.',
      amount_cents: 8300,
      deadline: '2026-09-30',
      days_left: 12,
      urgency: 'watch',
      target: 'cards',
      priority: 40,
      count: 1,
    },
    {
      kind: 'unknown_code',
      subject: 'Codes',
      title: '3 merchants have no code yet',
      detail: 'A card whose bonus turns on the code cannot be judged without it.',
      amount_cents: null,
      deadline: null,
      days_left: null,
      urgency: 'watch',
      target: 'codes',
      priority: 70,
      count: 3,
    },
  ],
};

const TRANSACTIONS = {
  transactions: [
    {
      id: 1,
      amount_cents: 8320,
      occurred_at: '2026-09-18',
      posted_at: null,
      merchant: 'FairPrice',
      category: 'groceries',
      needs_review: 0,
      source: 'advisor',
      nickname: 'wwmc',
      product: "Woman's World Card",
      mcc: '5411',
      expected_miles: 333,
      expected_cashback_cents: 0,
      actual_miles: null,
      actual_cashback_cents: null,
      status: 'pending',
    },
    {
      id: 2,
      amount_cents: 2470,
      occurred_at: '2026-09-17',
      posted_at: '2026-09-17',
      merchant: 'Grab',
      category: 'transport',
      needs_review: 1,
      source: 'sms',
      nickname: 'crw',
      product: 'Rewards Card',
      mcc: null,
      expected_miles: 99,
      expected_cashback_cents: 0,
      actual_miles: null,
      actual_cashback_cents: null,
      status: 'posted',
    },
  ],
  range: { from: null, to: null, label: 'recent' },
  total_count: 2,
  total_cents: 10790,
  page: 1,
  pages: 1,
  per_page: 8,
};

const USED = {
  ok: true,
  id: 99,
  status: 'pending',
  card: { id: 1, nickname: 'wwmc', product: "Woman's World Card" },
  occurred_at: '2026-09-18',
  amount_cents: 12000,
  expected: { miles: 480, cashback_cents: 0 },
};

let usedCalls = 0;

const REVIEW = {
  items: [
    {
      id: 1,
      transaction_id: 11,
      reason: 'possible_duplicate',
      detail: 'same card and amount, 1 day apart, and a similar merchant',
      suggestion: null,
      other_id: 10,
      merchant: 'Grab',
      merchant_raw: 'GRAB*RIDE 8829',
      merchant_id: 3,
      amount_cents: 2470,
      occurred_at: '2026-09-16',
      mcc: null,
      channel: null,
      category: 'transport',
      nickname: 'crw',
      product: 'Rewards Card',
      options: [],
    },
    {
      id: 2,
      transaction_id: 12,
      reason: 'unknown_mcc',
      detail: 'no code on file for Kopitiam 88 Outlet 3 — it may be Kopitiam 88',
      suggestion: '5814',
      other_id: null,
      merchant: 'Kopitiam 88 Outlet 3',
      merchant_raw: 'KOPITIAM 88 OUTLET 3',
      merchant_id: 4,
      amount_cents: 1150,
      occurred_at: '2026-09-16',
      mcc: null,
      channel: null,
      category: 'dining',
      nickname: 'wwmc',
      product: "Woman's World Card",
      options: [
        { mcc: '5814', description: 'Fast food restaurants', observations: 3 },
        { mcc: '5812', description: 'Eating places', observations: 1 },
      ],
    },
  ],
};

let resolved: { id: number; body: any } | null = null;
let published = 0;
let slowActions = false;
let breakTransactions = false;
let repriced: any = null;
let onboardingStatus = 'completed';
let appliedMcc: any = null;
let optimised: any = null;
let trackedOffer: number | null = null;
let simulated: any = null;
let added: any[] = [];

/** innerText reflects CSS casing, so every text assertion compares lowercased. */
const says = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle.toLowerCase());

const DRAFT = {
  id: 5,
  version: 2,
  status: 'draft',
  effective_from: '2026-10-01',
  effective_until: null,
  notes: 'based on version 1',
  rules: [
    {
      id: 9,
      category: 'online',
      mpd: 1.2,
      reward_type: 'miles',
      cap_cents: 50000,
      mcc_include: null,
      mcc_exclude: null,
      channel: null,
      min_tier_cents: null,
    },
  ],
  exclusions: [],
};

CATALOG_WITH_DRAFT.versions.push(DRAFT);

const DIFF = {
  from: { id: 3, version: 1 },
  to: { id: 5, version: 2 },
  rules: [
    {
      kind: 'changed',
      category: 'online',
      summary: 'online goes from 4 mpd, capped at $1000.00 to 1.2 mpd, capped at $500.00',
      before: '4 mpd, capped at $1000.00',
      after: '1.2 mpd, capped at $500.00',
    },
  ],
  exclusions: [],
  identical: false,
};

async function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const file = path === '/' ? 'index.html' : path.slice(1);
    try {
      const body = await readFile(join(DIST, file));
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Every API call the app can make, answered from fixtures rather than a Worker. */
async function stub(page: Page) {
  await page.route('**/api/**', async (route) => {
    try {
    const u = new URL(route.request().url());
    // no-store, so a reload re-asks the stub instead of the browser answering
    // from its own cache with whatever the last scenario returned.
    const send = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: JSON.stringify(body),
      });

    if (u.pathname === '/api/recommend') return send(RECOMMENDATION);
    if (u.pathname === '/api/actions') {
      // The real endpoint walks every card's standings, the expiry tranches and
      // the stale catalogue; the ledger is one indexed query. So in production
      // the transactions almost always land first, and a home screen that only
      // renders in the other order is a home screen that only renders in tests.
      if (slowActions) await new Promise((r) => setTimeout(r, 300));
      return send(ACTIONS);
    }
    if (u.pathname === '/api/review/queue') return send(REVIEW);
    if (u.pathname.startsWith('/api/review/') && u.pathname.endsWith('/resolve')) {
      resolved = {
        id: Number(u.pathname.split('/')[3]),
        body: JSON.parse(route.request().postData() ?? '{}'),
      };
      return send({ ok: true, applied: 'Kopitiam 88 Outlet 3 is 5814 from now on' });
    }
    if (u.pathname === '/api/cards/acquisition/simulate') {
      simulated = JSON.parse(route.request().postData() ?? '{}');
      return send({
        as_of: '2026-09-18',
        objective: simulated.objective,
        confidence: 'medium',
        history: { months: 6, months_with_data: 4, from: '2026-03-18', to: '2026-09-18' },
        gaps: [
          {
            category: 'dining',
            monthly_cents: 54000,
            return_pct: 1.8,
            detail: '$540.00 a month on dining with no card of yours paying a bonus on it — it earns about 1.80% in value.',
            severity: 'high',
          },
        ],
        suggestions: [
          {
            product: { id: 3, product_key: 'uob_ladys', issuer: 'UOB', product_name: "Lady's Card", annual_fee_cents: 19600 },
            eligibility: 'unknown',
            eligibility_note: 'Income and existing-relationship requirements are not known to the app.',
            projected_annual_incremental_value_cents: 27600,
            projected_extra_miles: 18400,
            annual_fee_cents: 19600,
            net_value_cents: 8000,
            affected_spend_cents: 610000,
            categories_improved: [{ category: 'dining', spend_cents: 610000, extra_value_cents: 24800, transactions: 36 }],
            overlap_score: 0.2,
            no_improvement: ['online: $120.00 a month, already as well covered as this card would manage'],
            welcome_offer: { title: '25,000 welcome miles', reward: '25,000 miles', requires: '$800.00 of spend' },
            assumptions: ['Based on 4 month(s) of transactions, which is not much to go on.', 'Assumes you would have used this card wherever it beat what you actually used.'],
            reasons: ['dining: about $248.00 a year more'],
            confidence: 'medium',
            score_cents: 6000,
            complexity_cost_cents: 2000,
            closes_gaps: ['dining'],
          },
        ],
        not_worth_it: [{ product_name: 'Another Plain Card', why: 'it mostly repeats a card you already hold' }],
      });
    }
    if (u.pathname === '/api/promotions' && route.request().method() === 'GET') {
      const offer = {
        promotion: {
          id: 7,
          promotion_type: 'spend_bonus',
          issuer: 'DBS',
          title: "Spend $300 on eligible online purchases",
          description: null,
          start_at: '2026-09-01',
          end_at: '2026-09-30',
          registration_required: 1,
          source_url: 'https://example.invalid/offer',
          source_quote: 'Spend $300 · within 30 days · 2,000 bonus points',
          confidence: 'high',
          status: 'published',
        },
        terms: { minimum_spend_cents: 30000, reward_points: 2000, window_days: 30 },
        relevance: 'high',
        why: ["You hold DBS Woman's World Card.", 'You normally spend about $430.00 a month where this applies.', 'Registration required.'],
        blockers: [],
        days_left: 12,
        card: { id: 1, nickname: 'wwmc', product: "Woman's World Card" },
        reachable: true,
        monthly_spend_cents: 43000,
        tracked: false,
      };
      const irrelevant = {
        ...offer,
        promotion: { ...offer.promotion, id: 8, title: 'Offer for a card you do not hold' },
        relevance: 'not_applicable',
        why: [],
        blockers: ['You do not hold the card this applies to.'],
        card: null,
      };
      return send({
        as_of: '2026-09-18',
        worth_checking: [offer],
        ending_soon: [offer],
        your_cards: [offer],
        transfers: [],
        everything: [offer, irrelevant],
      });
    }
    if (u.pathname === '/api/promotions/tracked')
      return send({
        as_of: '2026-09-18',
        offers: [
          {
            tracking_id: 1,
            promotion: { id: 7, title: 'Spend $300 on eligible online purchases', promotion_type: 'spend_bonus', issuer: 'DBS', description: null, start_at: null, end_at: '2026-09-30', registration_required: 1, source_url: null, source_quote: null, confidence: 'high', status: 'published' },
            card: { id: 1, nickname: 'wwmc', product: "Woman's World Card" },
            progress: { spent_cents: 18600, required_cents: 30000, remaining_cents: 11400, days_left: 12, met: false },
            status: 'tracked',
          },
        ],
      });
    if (u.pathname.match(/^\/api\/promotions\/\d+\/track$/)) {
      trackedOffer = Number(u.pathname.split('/')[3]);
      return send({ ok: true, summary: '$300.00 on wwmc by 2026-09-30 — 12 days left.' });
    }
    if (u.pathname.startsWith('/api/promotions/')) return send({ ok: true, completed: [] });
    if (u.pathname === '/api/rewards/programmes')
      return send({
        programmes: [
          { key: 'kf', name: 'KrisFlyer', kind: 'airline', unit: 'miles', expiry_months: 36 },
          { key: 'dbs', name: 'DBS Points', kind: 'bank', unit: 'points', expiry_months: null },
        ],
      });
    if (u.pathname === '/api/rewards/goals' && route.request().method() === 'GET')
      return send({
        as_of: '2026-09-18',
        goals: [
          {
            goal: { id: 1, program_key: 'kf', target_units: 85000, target_date: '2026-12-15', description: 'Japan business class', status: 'active' },
            program_name: 'KrisFlyer',
            unit: 'miles',
            held_units: 54200,
            convertible_units: 40000,
            total_units: 94200,
            shortfall_units: 0,
            percent: 100,
            days_left: 88,
            at_risk: false,
          },
        ],
      });
    if (u.pathname === '/api/rewards/goals') return send({ ok: true, goal: {} });
    if (u.pathname === '/api/rewards/transfers/optimise') {
      optimised = JSON.parse(route.request().postData() ?? '{}');
      return send({
        destination: { key: 'kf', name: 'KrisFlyer', unit: 'miles' },
        objective: optimised.objective,
        target_units: optimised.target_units ?? null,
        resulting_units: 62500,
        shortfall_units: 0,
        total_fees_cents: 2725,
        expiring_points_saved: 12000,
        routes: [
          {
            from_program: 'dbs',
            from_name: 'DBS Points',
            route: 'direct',
            source_units: 25000,
            destination_units: 62500,
            bonus_units: 12500,
            fee_cents: 2725,
            stranded_units: 1000,
            expiring_units_saved: 12000,
            promotion: { title: '25% transfer bonus', bonus_pct: 25, ends: '2026-09-30', registration_required: false },
            processing_days: { min: null, max: 7 },
            reason: '12,000 of these expire from 2026-11-01; a bonus adds 12,500 miles; $27.25 fee over 62,500 miles; 1,000 left behind — they do not fill a block',
          },
        ],
        assumptions: ['A transfer bonus is counted; it has to be used before the date shown.', 'Nothing is transferred by this app — the plan is for you to carry out.'],
        warnings: [],
        as_of: '2026-09-18',
      });
    }
    if (u.pathname === '/api/rewards/reconciliation')
      return send({
        as_of: '2026-09-18',
        results: [
          {
            scope: { type: 'statement', start: '2026-08-01', end: '2026-08-31', card_id: 1 },
            card: { id: 1, nickname: 'wwmc', product: "Woman's World Card" },
            expected: [],
            actual: [],
            differences: [
              { component: 'base', unit: 'points', expected: 900, actual: 900, difference: 0, within_tolerance: true },
              { component: 'category_bonus', unit: 'points', expected: 7500, actual: 6000, difference: -1500, within_tolerance: false },
            ],
            status: 'undercredited',
            explanations: [
              {
                cause: 'different_mcc',
                text: 'ABC Electronics of $375.00 has no confirmed merchant code, so its bonus was expected on a guess.',
                transaction_ids: [42],
                amount: 1500,
              },
            ],
            confidence: 'medium',
            pending: [{ component: 'minimum_spend_bonus', amount: 20000, unit: 'miles', expected_by: '2026-11-30' }],
            as_of: '2026-09-18',
          },
          {
            scope: { type: 'statement', start: '2026-08-01', end: '2026-08-31', card_id: 2 },
            card: { id: 2, nickname: 'crw', product: 'Rewards Card' },
            expected: [],
            actual: [],
            differences: [{ component: 'base', unit: 'points', expected: 400, actual: 400, difference: 0, within_tolerance: true }],
            status: 'matched',
            explanations: [],
            confidence: 'high',
            pending: [],
            as_of: '2026-09-18',
          },
        ],
      });
    if (u.pathname === '/api/rewards/candidates')
      return send({
        candidates: [
          { id: 1, card_id: 1, entry_type: 'bonus_reward', amount: 1500, unit: 'points', description: 'Bonus points earned 1,500', confidence: 'high', raw_line: 'Bonus points earned 1,500' },
        ],
      });
    if (u.pathname.startsWith('/api/rewards/mcc/')) {
      appliedMcc = { id: Number(u.pathname.split('/')[4]), body: JSON.parse(route.request().postData() ?? '{}') };
      return send({ ok: true, correction: { previous_mcc: null, reward_before: 1500, reward_after: 150 } });
    }
    if (u.pathname.startsWith('/api/rewards/candidates/')) return send({ ok: true, applied: 'accepted' });
    if (u.pathname === '/api/onboarding')
      return send({
        state: { status: onboardingStatus, cards_completed: 2, statements_offered: 0, wallet_offered: 0, completed_at: null },
        cards: [],
        repairs:
          onboardingStatus === 'completed'
            ? [
                {
                  card_id: 2,
                  nickname: 'one',
                  product: 'One Card',
                  status: 'usable_with_limits',
                  missing: [{ field_key: 'opened_at', label: 'When did you get this card?', affects: 'minimum_spend', required: true }],
                  consequence: 'Progress toward its minimum cannot be tracked.',
                },
              ]
            : [],
        ready: false,
      });
    if (u.pathname === '/api/onboarding/search')
      return send({
        matches: [
          { product: { ...CATALOG.products[0], rules: 2 }, matched_on: 'alias', score: 100, held_as: null },
          { product: { ...CATALOG.products[1], rules: 0 }, matched_on: 'name', score: 40, held_as: null },
        ],
      });
    if (u.pathname === '/api/onboarding/fields')
      return send({
        fields: [
          { key: 'opened_at', type: 'date', label: 'When did you get this card?', help_text: 'This card pays by the quarter.', required: true, affects: 'minimum_spend', sort: 10 },
          { key: 'statement_day', type: 'day_of_month', label: 'When does your statement close?', help_text: null, required: true, affects: 'statement_window', sort: 20 },
        ],
      });
    if (u.pathname === '/api/onboarding/state' || u.pathname === '/api/onboarding/complete')
      return send({ ok: true, state: { status: 'completed' }, repairs: [] });
    if (u.pathname === '/api/card') {
      added.push(JSON.parse(route.request().postData() ?? '{}'));
      return send({ ok: true, id: 7, nickname: 'dwwc', program_key: 'dbs_points', product_id: 7, issuer: 'DBS', product: "Woman's World Card", from_catalog: true, rules: 2 });
    }
    if (u.pathname === '/api/summary')
      return send({ cards: [{ nickname: 'wwmc' }, { nickname: 'crw' }], overall: {} });
    if (u.pathname === '/api/categories') return send({ categories: ['dining', 'online'] });
    if (u.pathname === '/api/review') return send({ ready: [], waiting: [] });
    if (u.pathname === '/api/transactions/recalculate') {
      repriced = JSON.parse(route.request().postData() ?? '{}');
      return send({
        considered: 42,
        changed: 2,
        unchanged: 40,
        failed: [],
        miles_before: 12000,
        miles_after: 9600,
        cashback_before_cents: 0,
        cashback_after_cents: 0,
        changes: [
          {
            id: 1,
            occurred_at: '2026-08-05',
            merchant: 'Shopee',
            card: 'wwmc',
            before: { miles: 2400, cashback_cents: 0, rule_set_id: 1 },
            after: { miles: 1200, cashback_cents: 0, rule_set_id: 1 },
            summary: '2,400 miles → 1,200 miles',
            changed: true,
          },
        ],
      });
    }
    if (u.pathname === '/api/transactions') {
      // A shape the component cannot render: React refuses an object as a
      // child, which is exactly the kind of contract drift a boundary is for.
      if (breakTransactions) {
        return send({
          ...TRANSACTIONS,
          transactions: [{ ...TRANSACTIONS.transactions[0], merchant: { boom: true } }],
        });
      }
      return send(TRANSACTIONS);
    }
    if (u.pathname === '/api/tx/used') {
      usedCalls++;
      return send(USED);
    }
    if (u.pathname === '/api/catalog/cards') return send(CATALOG);
    if (u.pathname === '/api/catalog/stale')
      return send({
        as_of: '2026-09-18',
        products: [
          {
            product: CATALOG.products[0],
            reason: 'it has never been checked against a bank document',
            days_since: null,
            held_by: ['wwmc'],
          },
        ],
      });
    if (u.pathname.endsWith('/publish')) {
      published++;
      return send({ ok: true, rule_set: { ...DRAFT, status: 'published' }, diff: DIFF, product: CATALOG.products[0] });
    }
    if (u.pathname.endsWith('/diff')) return send(DIFF);
    if (u.pathname.startsWith('/api/catalog/cards/')) return send(CATALOG_WITH_DRAFT);
    return send({});
    } catch (e) {
      console.log('ROUTE ERROR', route.request().url(), (e as Error).message);
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    }
  });
}

async function main() {
  const server = await serve();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
    const page = await browser.newPage();
    await stub(page);

    // The app moves the token out of the hash on boot, so revisiting the same
    // path with a hash is a same-document fragment jump and nothing reloads.
    // Each scenario therefore gets a URL of its own.
    let visit = 0;
    const open = () => page.goto(`${server.url}/?v=${++visit}#t=test-token`);
    await open();

    // --- home, with the ledger back before the action centre -------------
    // Regression: the activity list dated its rows against a day the action
    // centre had not answered with yet, and formatting that empty date threw —
    // which unmounts React and leaves a blank screen, not a missing section.
    slowActions = true;
    await open();
    await page.locator('.activity-list li').first().waitFor();
    check('the ledger renders before the action centre has answered', true);
    check(
      'and the rows are dated, without a day to compare against',
      (await page.locator('.activity-date').first().innerText()).length > 0
    );
    await page.locator('.actions .action').first().waitFor();
    check('the action centre still arrives', (await page.locator('.actions .action').count()) === 3);
    slowActions = false;

    // A crash must read as a crash. React unmounts the whole tree when a render
    // throws, so without a boundary one bad row anywhere is a blank page — the
    // least diagnosable failure there is.
    breakTransactions = true;
    await open();
    await page.locator('.card').first().waitFor();
    const boundary = await page.locator('main').innerText();
    check('a screen that throws says so', boundary.includes('could not be drawn'), boundary.slice(0, 200));
    // The production build ships React's minified messages, so what matters is
    // that the error is carried through at all rather than swallowed.
    const said = await page.locator('.card .err-text').innerText();
    check('and carries the error through instead of swallowing it', said.trim().length > 0, said);
    check('while the tabs stay usable', (await page.locator('nav.tabs.primary button').count()) === 5);
    breakTransactions = false;

    // --- home: the advisor is the first thing on the screen --------------
    await open();
    await page.locator('.advisor').waitFor();
    check('the app opens on the advisor', await page.locator('.advisor h2').isVisible());
    check(
      'the navigation is five everyday things, not eleven',
      (await page.locator('nav.tabs.primary button').count()) === 5,
      String(await page.locator('nav.tabs.primary button').count())
    );

    const actions = page.locator('.actions .action');
    await actions.first().waitFor();
    check('the action centre leads with the deadline', (await actions.first().innerText()).includes('Spend another $164.00'));
    check('and how long is left', (await actions.first().innerText()).includes('8d'));
    check(
      'the allowance sits below it',
      (await actions.nth(1).innerText()).includes('bonus allowance remains'),
      await actions.nth(1).innerText()
    );
    check('and the housekeeping below that', (await actions.nth(2).innerText()).includes('no code yet'));

    const activity = page.locator('.activity-list li').first();
    check('recent activity shows what a purchase earned', (await activity.innerText()).includes('333 miles'));
    check('and how sure that is', (await activity.innerText()).includes('probable'));
    check('a purchase the bank has not confirmed says pending', (await activity.innerText()).includes('pending'));
    check(
      'a transaction with no code is not called probable',
      (await page.locator('.activity-list li').nth(1).innerText()).includes('uncertain')
    );

    // --- the advisor ----------------------------------------------------
    await page.locator('#adv-merchant').fill('Shopee');
    await page.locator('#adv-amount').fill('120');
    await page.getByRole('button', { name: 'Check cards' }).click();
    await page.locator('.rec-top').waitFor();

    const top = page.locator('.rec-top');
    check('the winning card gets the page', (await top.locator('.rec-name').innerText()) === "Woman's World Card");
    check('with what it earns', (await top.locator('.rec-amount').innerText()).includes('480 miles'));
    check('and the rate behind it', (await top.locator('.rec-rate').innerText()) === '4 mpd');
    check('and what is left of the cap', (await top.locator('.rec-cap').innerText()).includes('337.00'));

    check(
      'an uncertain answer says so',
      (await page.locator('.conf-chip').innerText()).includes('Uncertain'),
      await page.locator('.conf-chip').innerText()
    );
    await page.locator('.conf-chip').click();
    const assumptions = page.locator('.assumptions li');
    check('the assumptions are listed', (await assumptions.count()) === 2);
    check(
      'and the one that could change the answer is marked',
      (await page.locator('.assumptions li.material').count()) === 1
    );

    await top.getByRole('button', { name: 'Why this card?' }).click();
    check('the reasons are the engine’s own', (await top.locator('.trace li').count()) === 2);

    await top.getByRole('button', { name: 'Show the score' }).click();
    const score = await top.locator('.score-table').innerText();
    check('the score shows its components', score.includes('Reward value') && score.includes('720'));
    check('including what uncertainty cost', score.includes('-250'));
    check('and the total', score.includes('470'));

    check('a runner-up is offered', (await page.locator('.picks-list .pick').count()) >= 1);

    const split = await page.locator('.missed').innerText();
    check('a split is explained', split.includes('337.00') && split.includes('Rewards Card'));
    check('with what it gains', split.includes('3.10'));

    await page.getByRole('button', { name: 'Show' }).first().click();
    const dq = await page.locator('.pick.excluded').first().innerText();
    check('a card that cannot be used is kept, with its reason', dq.includes('excluded code'));
    check('and never shown as earning', dq.includes('cannot be used'));

    check(
      'the answer is dated, and honest about the data behind it',
      (await page.locator('.rec-foot').innerText()).includes('never verified')
    );

    // --- taking the recommendation --------------------------------------
    await page.getByRole('button', { name: 'I used this card' }).click();
    await page.locator('.ok-text').waitFor();
    check('the recommendation can be logged in one tap', usedCalls === 1, String(usedCalls));
    check(
      'and it says the bank has not confirmed it yet',
      (await page.locator('.ok-text').innerText()).includes('pending'),
      await page.locator('.ok-text').innerText()
    );

    // --- the review inbox -----------------------------------------------
    await page.getByRole('button', { name: /^More/ }).click();
    await page.getByRole('button', { name: 'Review' }).click();
    await page.locator('.review-list').waitFor();

    const items = page.locator('.review-item');
    check('the questions are listed', (await items.count()) === 2, String(await items.count()));
    check(
      'a possible duplicate is asked as a question, not reported as a fact',
      (await items.first().innerText()).includes('Is this the same purchase twice?')
    );
    check('with both answers offered', (await items.first().getByRole('button', { name: /Merge|Keep both/ }).count()) === 2);

    const code = items.nth(1);
    check('an unknown code offers the likely answer first', (await code.innerText()).includes('Confirm 5814'));
    check('with what that code means', (await code.innerText()).includes('Fast food restaurants'));
    check('the other possibilities are there too', (await code.innerText()).includes('5812'));
    check('and the resemblance that suggested it is named', (await code.innerText()).includes('it may be Kopitiam 88'));

    await code.getByRole('button', { name: /^Confirm 5814/ }).click();
    await page.locator('.ok-text').waitFor();
    check('answering sends the code', resolved?.body.mcc === '5814', JSON.stringify(resolved));
    check('against the right question', resolved?.id === 2, JSON.stringify(resolved));
    check(
      'and says what it taught the app, not just that it worked',
      (await page.locator('.ok-text').innerText()).includes('from now on')
    );

    // --- is a card missing from my setup? --------------------------------
    await page.getByRole('button', { name: /^More/ }).click();
    await page.getByRole('button', { name: 'Improve my setup' }).click();
    await page.locator('.gaps').waitFor();

    const gapsText = await page.locator('main').innerText();
    check('gaps come before any card', says(gapsText, 'Your biggest reward gaps'), gapsText.slice(0, 200));
    check('naming the spend and what it earns', says(gapsText, '$540.00 a month on dining'), gapsText.slice(0, 500));
    check('and that nothing held pays a bonus on it', says(gapsText, 'no card of yours'), gapsText.slice(0, 600));
    check('with the history it is based on', says(gapsText, '4 months with transactions'), gapsText.slice(0, 600));
    check('and the confidence that follows from it', says(gapsText, 'medium confidence'), gapsText.slice(0, 600));

    check('the simulation was asked for', simulated !== null, JSON.stringify(simulated));

    const acq = await page.locator('.acq').first().innerText();
    check('a candidate says what it would add', says(acq, '$276.00 a year'), acq.slice(0, 300));
    check('with its annual fee shown separately', says(acq, '$196.00 annual fee'), acq.slice(0, 300));
    check(
      'and the welcome offer kept apart from the ongoing value',
      says(acq, 'Separately, a welcome offer') && says(acq, '25,000 miles'),
      acq.slice(0, 500)
    );
    check('eligibility is not claimed', says(acq, 'needs a check'), acq.slice(0, 500));

    await page.locator('.acq').first().getByRole('button', { name: 'See the analysis' }).click();
    const analysis = await page.locator('.acq-detail').innerText();
    check('the analysis says where the value comes from', says(analysis, 'Where the improvement comes from'), analysis.slice(0, 200));
    check('and where it does not help', says(analysis, 'Where it does not help') && says(analysis, 'already as well covered'), analysis.slice(0, 400));
    check('another card is charged for', says(analysis, 'Another card to manage'), analysis.slice(0, 500));
    check('and what it assumed is stated', says(analysis, 'not much to go on'), analysis.slice(0, 600));

    const rejected = await page.locator('.card', { hasText: 'not worth it' }).innerText();
    check('cards considered and rejected are shown', says(rejected, 'Another Plain Card'), rejected.slice(0, 300));
    check('with the reason', says(rejected, 'repeats a card you already hold'), rejected.slice(0, 300));

    // --- offers worth your attention -------------------------------------
    await page.getByRole('button', { name: /^More/ }).click();
    await page.getByRole('button', { name: 'Offers for you' }).click();
    await page.locator('.offers2').first().waitFor();

    const offersText = await page.locator('main').innerText();
    check('relevant offers lead', says(offersText, 'Worth checking'), offersText.slice(0, 300));
    check('and every one says why it is shown', says(offersText, "Why you're seeing this"), offersText.slice(0, 500));
    check('in terms of this wallet', says(offersText, 'You normally spend about $430.00'), offersText.slice(0, 600));
    check('registration is not assumed away', says(offersText, 'Registration required'), offersText.slice(0, 600));

    const tracking = await page.locator('.card', { hasText: 'chasing' }).innerText();
    check('a tracked offer shows real progress', tracking.includes('186.00') && tracking.includes('300.00'), tracking.slice(0, 300));
    check(
      'from the same engine the cards use',
      says(tracking, 'not a second one'),
      tracking.slice(0, 400)
    );

    // The tracked section renders first and its rows share the class, so target
    // the offer inside "Worth checking" rather than the first one on the page.
    const worth = page.locator('.card', { hasText: 'Worth checking' });
    await worth.locator('.offer2').first().getByRole('button', { name: 'Track this offer' }).click();
    await worth.locator('.ok-text').first().waitFor();
    check('an offer can be tracked in one tap', trackedOffer === 7, String(trackedOffer));
    check(
      'and it says what will be watched',
      says(await worth.locator('.ok-text').first().innerText(), '300.00'),
      await worth.locator('.ok-text').first().innerText()
    );

    await page.locator('.card', { hasText: 'Everything' }).getByRole('button', { name: 'Show' }).click();
    const everything = await page.locator('.card', { hasText: 'Everything' }).innerText();
    check('offers that do not apply are still listed', says(everything, 'do not hold'), everything.slice(0, 400));
    check('with the reason they do not', says(everything, 'not_applicable'), everything.slice(0, 400));

    // --- what to do with the points --------------------------------------
    await page.getByRole('button', { name: /^More/ }).click();
    await page.getByRole('button', { name: 'Transfers' }).click();
    await page.locator('.card', { hasText: 'Plan a transfer' }).first().waitFor();
    check(
      'the screen says a transfer is discrete, not a ratio',
      says(await page.locator('main').innerText(), 'whole blocks'),
      (await page.locator('main').innerText()).slice(0, 300)
    );

    await page.getByRole('button', { name: 'Plan a transfer' }).last().click();
    await page.locator('.plan').waitFor();
    const planText = await page.locator('.plan').innerText();
    check('the plan is requested', optimised !== null, JSON.stringify(optimised));
    check('with the total up front', planText.includes('62,500'), planText.slice(0, 200));
    check('and what it costs', says(planText, '27.25'), planText.slice(0, 300));
    check('the transfer is spelled out', says(planText, 'Transfer') && planText.includes('25,000'), planText.slice(0, 400));
    check('points left behind are admitted', says(planText, 'left behind'), planText);
    check('the bonus is named with its deadline', says(planText, '25% transfer bonus') && says(planText, '2026-09-30'), planText);
    check('expiring points are called out', says(planText, 'would have expired'), planText);
    check(
      'and the app never claims it will transfer anything',
      says(planText, 'for you to carry out'),
      planText
    );

    const goalsText = await page.locator('.card', { hasText: 'What the points are for' }).innerText();
    check('goals show what is held against what could be moved', says(goalsText, '54,200 held'), goalsText.slice(0, 300));
    check('and whether the target is reachable', says(goalsText, 'reachable today'), goalsText.slice(0, 300));

    // --- did the bank credit what it owed? -------------------------------
    await page.getByRole('button', { name: /^More/ }).click();
    await page.getByRole('button', { name: 'Rewards check' }).click();
    await page.locator('.recon-list').waitFor();

    const check1 = await page.locator('main').innerText();
    check('a card that matches says so', says(check1, 'Matches'), check1.slice(0, 300));
    check('and one that does not is a possible shortfall', says(check1, 'Possible shortfall'), check1.slice(0, 300));
    check(
      'never an accusation',
      !/bank (made|got) (a mistake|it wrong)/i.test(check1) && !says(check1, 'the bank owes'),
      check1.slice(0, 300)
    );
    check('with confidence shown when it is not high', says(check1, 'medium confidence'), check1.slice(0, 400));

    await page.locator('.recon').first().getByRole('button', { name: 'Detail' }).click();
    const reconDetail = await page.locator('.recon-detail').innerText();
    check('the base is shown matching', says(reconDetail, 'base') && reconDetail.includes('900'), reconDetail);
    check('and the bonus short by its amount', reconDetail.includes('-1,500'), reconDetail);
    check('with a reason that names the purchase', says(reconDetail, 'ABC Electronics'), reconDetail);
    check('and a reward that is merely not due yet is separated out', says(reconDetail, 'Not due yet'), reconDetail);

    await page.locator('.recon-detail input').fill('5732');
    await page.getByRole('button', { name: /statement/ }).click();
    await page.locator('.recon-detail .ok-text').waitFor();
    check('the statement code can be applied', appliedMcc?.body.mcc === '5732', JSON.stringify(appliedMcc));
    check(
      'and it says the expectation was what changed',
      says(await page.locator('.recon-detail .ok-text').innerText(), 'Re-priced'),
      await page.locator('.recon-detail .ok-text').innerText()
    );

    const cand = await page.locator('.card', { hasText: 'read off a statement' }).first().innerText();
    check('reward lines wait to be accepted', says(cand, 'until you accept it'), cand.slice(0, 300));
    check('with what they say and how sure', says(cand, 'bonus reward') && says(cand, 'high'), cand.slice(0, 300));

    // --- setting up ------------------------------------------------------
    // A gap in an existing setup is a repair, not an onboarding: someone with
    // cards and history must never be shown a welcome screen.
    await page.getByRole('button', { name: 'Home' }).click();
    await page.locator('.advisor').waitFor();
    // Wait for the banner itself rather than for a fixed time: the onboarding
    // fetch races the advisor, and a sleep long enough today is a flaky test
    // tomorrow.
    await page.locator('.card', { hasText: 'would improve recommendations' }).first().waitFor();
    const repair = await page.locator('main').innerText();
    check('an existing user is offered a repair', says(repair, 'would improve recommendations'), repair.slice(0, 200));
    check('naming the card and the detail', says(repair, 'One Card') && says(repair, 'When did you get this card?'), repair.slice(0, 300));
    check('and never a welcome screen', !says(repair, 'Welcome to Miles Tracker'));

    onboardingStatus = 'not_started';
    await open();
    await page.getByRole('button', { name: /^More/ }).click();
    await page.getByRole('button', { name: 'Setup' }).click();
    await page.locator('.onb').first().waitFor();
    check('a new user gets a welcome', says(await page.locator('.onb').first().innerText(), 'Welcome to Miles Tracker'));
    check(
      'that promises not to ask for rates',
      says(await page.locator('.onb').first().innerText(), 'not be asked for reward rates')
    );

    await page.getByRole('button', { name: 'Get started' }).last().click();
    await page.locator('.big-search').waitFor();
    check('cards are searched, not described', says(await page.locator('.onb').innerText(), 'whatever you call it'));
    check('and the catalogue says which have rates', says(await page.locator('.picker').innerText(), 'rates known'));
    check('and which do not', says(await page.locator('.picker').innerText(), 'no rates yet'));

    await page.locator('.picker button', { hasText: 'Add' }).first().click();
    check('a chosen card is listed back', says(await page.locator('.onb-chosen').innerText(), "Woman's World Card"));
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.locator('.onb-card').waitFor();
    await page.locator('.onb-card .sub').first().waitFor();
    const details = await page.locator('.onb-card').first().innerText();
    check('only personal details are asked for', says(details, 'Statement closes on') && says(details, 'Nickname'), details);
    check('the credit limit is marked optional', says(details, 'Credit limit (optional)'), details);
    check('a card that runs in quarters says why it needs a date', says(details, 'pays by the quarter'), details);
    check('and nothing asks about rates or codes', !/mpd|merchant code|mcc/i.test(details), details.slice(0, 300));

    await page.getByRole('button', { name: 'Save cards' }).click();
    await page.locator('.onb').filter({ hasText: 'Two optional things' }).waitFor();
    check('the card was created from the catalogue', added[0]?.product_id === 7, JSON.stringify(added));
    check('statements and points are offered, not required', says(await page.locator('.onb').innerText(), 'neither is required'));

    await page.getByRole('button', { name: 'Do these later' }).click();
    await page.locator('.onb').filter({ hasText: "You're ready" }).waitFor();
    check('setup ends by demonstrating value', (await page.getByRole('button', { name: 'Find the best card' }).count()) === 1);
    onboardingStatus = 'completed';
    await open();

    // --- re-pricing what the app believed --------------------------------
    await page.getByRole('button', { name: 'Activity' }).click();
    await page.locator('.repricer').first().waitFor();
    await page.locator('.repricer summary').first().click();
    check(
      'it says which day the rules are read for',
      (await page.locator('.repricer').first().innerText()).includes('for the day each purchase happened')
    );
    check(
      'and promises not to touch what the bank paid',
      (await page.locator('.repricer').first().innerText()).includes('never changed')
    );

    await page.locator('.repricer').first().getByRole('button', { name: 'Re-price' }).click();
    await page.locator('.recalc-report').waitFor();
    const rep = await page.locator('.recalc-report').innerText();
    check('the request goes out', repriced !== null, JSON.stringify(repriced));
    check('the report says how much was looked at', rep.includes('42 looked at'), rep);
    check('and how much moved', rep.includes('2') && rep.includes('40 already right'), rep);
    check('a reward that went down is not dressed up as good news', rep.includes('-2,400 miles'), rep);
    check('with the rows that changed', rep.includes('2,400 miles → 1,200 miles'), rep);

    // --- the catalogue --------------------------------------------------
    await page.getByRole('button', { name: /^More/ }).click();
    await page.getByRole('button', { name: 'Catalogue' }).click();
    await page.locator('.catalog-list').waitFor();
    check('every product is listed', (await page.locator('.catalog-list > li').count()) === 2);
    const staleNote = await page.locator('.stale-note').innerText();
    check('cards whose rates are unchecked are called out', staleNote.includes('never been checked'), staleNote);
    check('and it says they are still used', staleNote.includes('stale rate beats no rate'));
    const one = await page.locator('.catalog-list > li').nth(1).innerText();
    check('a product with no rules says so', one.includes('no rules yet'));
    check('rather than looking complete', !one.includes('version'));

    await page
      .locator('.catalog-list > li')
      .first()
      .getByRole('button', { name: 'Versions' })
      .click();
    const detail = await page.locator('.catalog-detail').innerText();
    check('a version can be opened', detail.includes('Version 1') && detail.includes('published'));
    check('with the rules it holds', detail.includes('4 mpd'));
    check('and what it excludes', detail.includes('4900'));
    check('and the codes a bonus is restricted to', detail.includes('only codes 5311,5399'), detail);

    // --- changing what a card pays ---------------------------------------
    await page.getByRole('button', { name: 'Edit its rules' }).click();
    const admin = page.locator('.admin');
    check('a draft can be edited', (await admin.innerText()).includes('Version 2 is a draft'));
    check(
      'and it says nothing can reach it yet',
      (await admin.innerText()).includes('Nothing can reach it until it is published')
    );
    check('there is no publish button before the comparison', (await admin.getByRole('button', { name: /^Publish/ }).count()) === 0);

    await admin.getByRole('button', { name: 'Compare with what is live' }).click();
    await page.locator('.diff').waitFor();
    const diffText = await page.locator('.diff').innerText();
    check('the comparison names the versions', diffText.includes('Version 1 → 2'), diffText);
    check('and reads as a sentence', diffText.includes('online goes from 4 mpd'), diffText);
    check('only now is publishing offered', (await admin.getByRole('button', { name: /^Publish version 2/ }).count()) === 1);

    await admin.getByRole('button', { name: /^Publish version 2/ }).click();
    check('publishing goes through', published === 1, String(published));

    await page.close();
  } finally {
    await browser?.close();
    await server.close();
  }

  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
