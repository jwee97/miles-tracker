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

const CATALOG_ONE = {
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
        { id: 1, category: 'online', mpd: 4, reward_type: 'miles', cap_cents: 100000, mcc_list: '5311,5399', channel: 'online' },
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
    const u = new URL(route.request().url());
    const send = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (u.pathname === '/api/recommend') return send(RECOMMENDATION);
    if (u.pathname === '/api/actions') return send(ACTIONS);
    if (u.pathname === '/api/transactions') return send(TRANSACTIONS);
    if (u.pathname === '/api/tx/used') {
      usedCalls++;
      return send(USED);
    }
    if (u.pathname === '/api/catalog/cards') return send(CATALOG);
    if (u.pathname.startsWith('/api/catalog/cards/')) return send(CATALOG_ONE);
    return send({});
  });
}

async function main() {
  const server = await serve();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
    const page = await browser.newPage();
    await stub(page);
    await page.goto(`${server.url}/#t=test-token`);

    // --- home: the advisor is the first thing on the screen --------------
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

    // --- the catalogue --------------------------------------------------
    await page.getByRole('button', { name: /^More/ }).click();
    await page.getByRole('button', { name: 'Catalogue' }).click();
    await page.locator('.catalog-list').waitFor();
    check('every product is listed', (await page.locator('.catalog-list > li').count()) === 2);
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
