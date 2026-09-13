import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index';
import { runMigrations } from '../src/migrate';
import { mintToken } from '../src/auth';
import type { Env } from '../src/types';

// Telegram is the only outbound call the handler makes; swallow it so the
// tests exercise the endpoint without touching the network.
const sent: string[] = [];
globalThis.fetch = (async (input: any) => {
  sent.push(String(input));
  return new Response('{"ok":true}', { status: 200 });
}) as typeof fetch;

const db = new DatabaseSync(':memory:');
const wrap = (sql: string, args: unknown[] = []): any => ({
  bind: (...a: unknown[]) => wrap(sql, a),
  first: async <T>() => (db.prepare(sql).get(...(args as any)) ?? null) as T,
  all: async <T>() => ({ results: db.prepare(sql).all(...(args as any)) as T[] }),
  run: async () => {
    const r = db.prepare(sql).run(...(args as any));
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  },
});
const env = {
  DB: { prepare: (sql: string) => wrap(sql) },
  APP_SECRET: 'test-secret',
  TELEGRAM_BOT_TOKEN: 'x',
  TELEGRAM_SECRET: 'y',
  OWNER_CHAT_ID: '1',
  TZ_OFFSET_MINUTES: '480',
  UTIL_THRESHOLDS: '50,80,90',
  MIN_SPEND_WARN_DAYS: '7',
  POSTING_LAG_DAYS: '3',
  RATE_RECHECK_DAYS: '90',
  MILE_VALUE_CENTS: '1.5',
} as unknown as Env;

Date.now = () => Date.parse('2026-09-11T04:00:00Z'); // 12:00 SGT, 11 Sep

let fails = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  -- ${detail}`}`);
};

await runMigrations(env);
db.prepare(
  `INSERT INTO cards (issuer, product, product_key, nickname, credit_limit_cents, statement_day, opened_at)
   VALUES ('Citi','Rewards','citi_rw','crw',500000,15,'2026-01-01')`
).run();

const token = await mintToken('test-secret');
const post = (body: unknown) =>
  worker.fetch(
    new Request('https://x.test/api/tx', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env
  );
const rowFor = (id: number) => db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id) as any;

// --- the feature: an old purchase whose posting date is already known -------
{
  const res = await post({ nickname: 'crw', amount: '42.50', date: '2026-08-28', posted: '2026-09-01', note: 'Lazada' });
  const body = (await res.json()) as any;
  check('accepts a purchase with a known posting date', res.status === 200, JSON.stringify(body));
  check('echoes the posting date back', body.posted_at === '2026-09-01', JSON.stringify(body));
  const row = rowFor(body.id);
  check('stores both dates', row.occurred_at === '2026-08-28' && row.posted_at === '2026-09-01', JSON.stringify(row));
}

// --- still pending: posting date omitted ------------------------------------
{
  const res = await post({ nickname: 'crw', amount: '10.00', date: '2026-09-10', note: 'Kopi' });
  const body = (await res.json()) as any;
  check('posting date is optional', res.status === 200 && body.posted_at === null, JSON.stringify(body));
  check('and is left null, not guessed', rowFor(body.id).posted_at === null, JSON.stringify(rowFor(body.id)));
}

// --- validation -------------------------------------------------------------
{
  const res = await post({ nickname: 'crw', amount: '5.00', date: '2026-09-05', posted: '2026-09-01' });
  check('refuses a posting date before the purchase', res.status === 400, String(res.status));
  check('and says why', (await res.json() as any).error === 'posted before it happened', '');
}
{
  const res = await post({ nickname: 'crw', amount: '5.00', date: '2026-09-05', posted: '2026-12-01' });
  check('refuses a posting date in the future', res.status === 400, String(res.status));
}
{
  const res = await post({ nickname: 'crw', amount: '5.00', date: '2026-09-05', posted: 'not-a-date' });
  check('refuses an unparseable posting date', res.status === 400, String(res.status));
}
{
  const res = await post({ nickname: 'crw', amount: '5.00', date: '2026-12-01' });
  check('still refuses a future purchase date', res.status === 400, String(res.status));
}
{
  const res = await post({ nickname: 'nope', amount: '5.00' });
  check('refuses an unknown card', res.status === 400, String(res.status));
}

// --- category, explicit and learned -----------------------------------------
{
  const res = await post({ nickname: 'crw', amount: '80.00', date: '2026-09-09', note: 'NTUC', category: 'groceries' });
  const body = (await res.json()) as any;
  check('stores an explicit category', rowFor(body.id).category === 'groceries', JSON.stringify(rowFor(body.id)));

  // Having tagged NTUC once, an untagged entry there should categorise itself.
  const res2 = await post({ nickname: 'crw', amount: '12.00', date: '2026-09-10', note: 'NTUC' });
  const body2 = (await res2.json()) as any;
  check('learns the merchant for next time', body2.category === 'groceries', JSON.stringify(body2));
}

// --- balances recorded from the dashboard -----------------------------------
const postTo = (path: string, body: unknown) =>
  worker.fetch(
    new Request(`https://x.test${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env
  );

db.prepare(`INSERT INTO programs (key,name,kind,unit,expiry_months) VALUES ('krisflyer','KrisFlyer','airline','miles',36)`).run();
db.prepare(`INSERT INTO programs (key,name,kind,unit) VALUES ('citi_ty','Citi ThankYou','bank','points')`).run();

{
  const res = await postTo('/api/tranche', { program_key: 'citi_ty', points: '50,000', expires_at: '2027-06-30', note: 'statement' });
  const b = (await res.json()) as any;
  check('records a balance', res.status === 200, JSON.stringify(b));
  check('accepts a comma-formatted amount',
    (db.prepare(`SELECT points FROM balance_tranches WHERE id = ?`).get(b.id) as any).points === 50000, '');
  check('keeps the expiry given', b.expires_at === '2027-06-30', JSON.stringify(b));
}
{
  // KrisFlyer carries a 36-month rule, so an omitted expiry is derived from it.
  const res = await postTo('/api/tranche', { program_key: 'krisflyer', points: '20000' });
  const b = (await res.json()) as any;
  check("derives an expiry from the programme's own rule", b.expires_at === '2029-09-11', JSON.stringify(b));
}
{
  // Citi has no expiry rule here, so none is invented.
  const res = await postTo('/api/tranche', { program_key: 'citi_ty', points: '1000' });
  check('invents no expiry when the programme has no rule', ((await res.json()) as any).expires_at === null, '');
}
{
  check('refuses an unknown programme', (await postTo('/api/tranche', { program_key: 'nope', points: '10' })).status === 400, '');
  check('refuses a non-numeric amount', (await postTo('/api/tranche', { program_key: 'citi_ty', points: 'abc' })).status === 400, '');
  check('refuses a zero amount', (await postTo('/api/tranche', { program_key: 'citi_ty', points: '0' })).status === 400, '');
  check('refuses an unparseable expiry', (await postTo('/api/tranche', { program_key: 'citi_ty', points: '10', expires_at: 'soon' })).status === 400, '');
}
{
  // Batches roll up into one balance, and the nearest expiry is the one shown.
  const res = await worker.fetch(new Request(`https://x.test/api/points?t=${token}`), env);
  const b = (await res.json()) as any;
  const ty = b.balances.find((r: any) => r.program_key === 'citi_ty');
  check('batches sum into one balance', ty.total === 51000, JSON.stringify(ty));
  check('every programme is listed for the dropdown', b.programs.length >= 2, String(b.programs.length));
  check('batches come back individually', b.tranches.length === 3, String(b.tranches.length));
}
{
  const before = ((await (await worker.fetch(new Request(`https://x.test/api/points?t=${token}`), env)).json()) as any).tranches;
  const res = await postTo('/api/tranche/delete', { id: before[0].id });
  check('a batch can be deleted', res.status === 200, '');
  const after = ((await (await worker.fetch(new Request(`https://x.test/api/points?t=${token}`), env)).json()) as any).tranches;
  check('and is gone', after.length === before.length - 1, `${after.length} vs ${before.length}`);
}
{
  const res = await postTo('/api/program', { name: 'Malaysia Airlines Enrich', kind: 'airline', unit: 'miles', key: 'Malaysia Airlines Enrich' });
  const b = (await res.json()) as any;
  check('a new programme can be added', res.status === 200, JSON.stringify(b));
  check('and its key is slugified', b.key === 'malaysia_airlines_enrich', b.key);
  check('refuses a programme with no name', (await postTo('/api/program', { key: 'x' })).status === 400, '');
}

// --- editing a transaction in place ----------------------------------------
{
  const made = await post({ nickname: 'crw', amount: '30.00', date: '2026-09-06', note: 'Kopi Shop' });
  const id = ((await made.json()) as any).id;

  check('a new row with no category is flagged for review',
    rowFor(id).needs_review === 1 && rowFor(id).category === null, JSON.stringify(rowFor(id)));

  const r = await postTo('/api/tx/update', { id, field: 'category', value: 'dining' });
  check('a cell edit saves', r.status === 200, JSON.stringify(await r.clone().json()));
  check('and clears the review flag',
    rowFor(id).category === 'dining' && rowFor(id).needs_review === 0, JSON.stringify(rowFor(id)));
  check('an edited category counts as confirmed', rowFor(id).category_source === 'manual', '');

  // Categorising once teaches the merchant, as in the bot.
  const next = await post({ nickname: 'crw', amount: '4.00', date: '2026-09-07', note: 'Kopi Shop' });
  const nb = (await next.json()) as any;
  check('the merchant is learned from an edit', nb.category === 'dining', JSON.stringify(nb));
  check('and marked as inferred rather than confirmed', rowFor(nb.id).category_source === 'learned', '');

  check('amount is editable', (await postTo('/api/tx/update', { id, field: 'amount', value: '31.50' })).status === 200, '');
  check('and stored in cents', rowFor(id).amount_cents === 3150, `got ${rowFor(id).amount_cents}`);
  check('clearing a category returns it to review',
    (await postTo('/api/tx/update', { id, field: 'category', value: null })).status === 200 &&
      rowFor(id).needs_review === 1, JSON.stringify(rowFor(id)));

  check('a posting date before the purchase is refused',
    (await postTo('/api/tx/update', { id, field: 'posted_at', value: '2026-01-01' })).status === 400, '');
  check('a future date is refused',
    (await postTo('/api/tx/update', { id, field: 'occurred_at', value: '2027-01-01' })).status === 400, '');
  check('an unknown field is refused',
    (await postTo('/api/tx/update', { id, field: 'created_at', value: 'x' })).status === 400, '');
  check('an unknown card is refused',
    (await postTo('/api/tx/update', { id, field: 'card_id', value: '999' })).status === 400, '');
}

// --- the review queue splits on whether the MCC is knowable -----------------
{
  const pending = await post({ nickname: 'crw', amount: '18.00', date: '2026-09-10', note: 'Mystery' });
  const pid = ((await pending.json()) as any).id;
  const posted = await post({ nickname: 'crw', amount: '19.00', date: '2026-09-01', posted: '2026-09-03', note: 'Other Mystery' });
  const oid = ((await posted.json()) as any).id;

  const res = await worker.fetch(new Request(`https://x.test/api/review?t=${token}`), env);
  const b = (await res.json()) as any;
  check('a posted uncategorised purchase is ready to classify',
    b.ready.some((r: any) => r.id === oid), JSON.stringify(b.ready.map((r: any) => r.id)));
  check('a pending one is held back instead',
    b.waiting.some((r: any) => r.id === pid), JSON.stringify(b.waiting.map((r: any) => r.id)));
  check('and the two buckets do not overlap',
    !b.ready.some((r: any) => b.waiting.find((w: any) => w.id === r.id)), '');
}

// --- auth -------------------------------------------------------------------
{
  const res = await worker.fetch(
    new Request('https://x.test/api/tx', { method: 'POST', body: '{}' }),
    env
  );
  check('rejects an unauthenticated post', res.status === 401, String(res.status));
}

// --- the ledger's contract with /api/transactions --------------------------
// Earlier tests read rows straight from the database, so an endpoint that
// dropped columns the UI depends on went unnoticed: every row rendered as
// uncategorised because `category` was never selected.
{
  const made = await post({ nickname: 'crw', amount: '52.00', date: '2026-09-04', note: 'Odette', category: 'dining' });
  const id = ((await made.json()) as any).id;

  const res = await worker.fetch(new Request(`https://x.test/api/transactions?limit=50&t=${token}`), env);
  const list = ((await res.json()) as any).transactions as any[];
  const row = list.find((r) => r.id === id);

  check('the row comes back at all', !!row, JSON.stringify(list.slice(0, 2)));
  check('with its category', row.category === 'dining', JSON.stringify(row));
  check('with how confident that category is', row.category_source === 'manual', JSON.stringify(row));
  check('with the review flag', row.needs_review === 0, JSON.stringify(row));
  check('and with card_id, which the card dropdown needs', typeof row.card_id === 'number', JSON.stringify(row));

  // Every field the ledger renders or edits must be present on every row.
  const required = ['id', 'card_id', 'amount_cents', 'occurred_at', 'posted_at', 'merchant', 'category', 'category_source', 'nickname'];
  const missing = required.filter((k) => !(k in row));
  check('no editable column is missing', missing.length === 0, `missing: ${missing.join(', ')}`);

  // A genuinely uncategorised row must be distinguishable from a categorised one.
  const blank = await post({ nickname: 'crw', amount: '7.00', date: '2026-09-04', note: 'Unknown Place' });
  const bid = ((await blank.json()) as any).id;
  const res2 = await worker.fetch(new Request(`https://x.test/api/transactions?limit=50&t=${token}`), env);
  const list2 = ((await res2.json()) as any).transactions as any[];
  check('an uncategorised row reports a null category',
    list2.find((r) => r.id === bid).category === null, JSON.stringify(list2.find((r) => r.id === bid)));
  check('while the categorised one keeps its value',
    list2.find((r) => r.id === id).category === 'dining', '');
  check('so the two are actually distinguishable',
    list2.find((r) => r.id === bid).category !== list2.find((r) => r.id === id).category, '');
}

// --- ledger time frames -----------------------------------------------------
// Ranges are resolved server-side so they follow the app's timezone rather
// than whatever the browsing device is set to.
{
  const mk = (amount: string, date: string, merchant: string) =>
    post({ nickname: 'crw', amount, date, note: merchant, category: 'dining' });
  await mk('10.00', '2026-09-11', 'Today');        // today
  await mk('20.00', '2026-09-10', 'Yesterday');
  await mk('30.00', '2026-09-07', 'Five days ago');
  await mk('40.00', '2026-08-15', 'Last month');
  await mk('50.00', '2026-02-02', 'Earlier this year');
  await mk('60.00', '2025-11-11', 'Last year');

  const page = async (qs: string) => {
    const res = await worker.fetch(new Request(`https://x.test/api/transactions?${qs}&t=${token}`), env);
    return (await res.json()) as any;
  };
  const has = (p: any, m: string) => p.transactions.some((t: any) => t.merchant === m);

  const t1 = await page('range=today&limit=100');
  check('today includes today', has(t1, 'Today'), '');
  check('today excludes yesterday', !has(t1, 'Yesterday'), '');
  check('and reports the resolved range', t1.range.from === '2026-09-11' && t1.range.to === '2026-09-11', JSON.stringify(t1.range));

  const t2 = await page('range=yesterday&limit=100');
  check('yesterday is exactly one day', has(t2, 'Yesterday') && !has(t2, 'Today'), JSON.stringify(t2.range));

  const t3 = await page('range=7d&limit=100');
  check('last 7 days reaches back five days', has(t3, 'Five days ago'), '');
  check('but not to last month', !has(t3, 'Last month'), '');
  check('and spans seven days inclusive', t3.range.from === '2026-09-05', JSON.stringify(t3.range));

  const t4 = await page('range=month&limit=100');
  check('this month starts on the first', t4.range.from === '2026-09-01', JSON.stringify(t4.range));
  check('and excludes August', !has(t4, 'Last month'), '');

  const t5 = await page('range=lastmonth&limit=100');
  check('last month is August only', has(t5, 'Last month') && !has(t5, 'Today'), JSON.stringify(t5.range));
  check('ending on the 31st', t5.range.to === '2026-08-31', JSON.stringify(t5.range));

  const t6 = await page('range=ytd&limit=100');
  check('year to date reaches January', has(t6, 'Earlier this year'), '');
  check('but not last year', !has(t6, 'Last year'), '');

  const t7 = await page('range=all&limit=100');
  check('all includes last year', has(t7, 'Last year'), '');
  check('and reports no bounds', t7.range.from === null && t7.range.to === null, JSON.stringify(t7.range));

  const t8 = await page('from=2026-08-01&to=2026-08-31&limit=100');
  check('a custom range works', has(t8, 'Last month') && !has(t8, 'Today'), JSON.stringify(t8.range));

  // The summary has to describe the whole range, not just the rows returned.
  const t9 = await page('range=all&limit=2');
  check('the limit caps the rows returned', t9.transactions.length === 2, String(t9.transactions.length));
  check('while the count covers the whole range', t9.total_count > 2, String(t9.total_count));
  check('and so does the total', t9.total_cents > 0, String(t9.total_cents));
}

// --- settings, overlaid on the deployed config ------------------------------
{
  const res = await worker.fetch(new Request(`https://x.test/api/settings?t=${token}`), env);
  const b = (await res.json()) as any;
  check('settings are listed', b.settings.length >= 6, String(b.settings.length));
  const mv = b.settings.find((s: any) => s.key === 'MILE_VALUE_CENTS');
  check('each shows the deployed default', mv.default_value === '1.5', JSON.stringify(mv));
  check('and nothing stored yet', mv.stored_value === null, JSON.stringify(mv));

  // No secret may be listed, whatever its name.
  const keys = b.settings.map((s: any) => s.key);
  for (const secret of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_SECRET', 'APP_SECRET', 'OWNER_CHAT_ID']) {
    check(`${secret} is not exposed`, !keys.includes(secret), keys.join(','));
  }

  const saved = await postTo('/api/settings', { key: 'MILE_VALUE_CENTS', value: '1.2' });
  check('a setting saves', saved.status === 200, JSON.stringify(await saved.clone().json()));

  // And it must actually take effect, not merely be recorded.
  const after = await worker.fetch(new Request(`https://x.test/api/settings?t=${token}`), env);
  const ab = (await after.json()) as any;
  check('the stored value is reported', ab.settings.find((s: any) => s.key === 'MILE_VALUE_CENTS').stored_value === '1.2', '');
  check('while the default is still visible',
    ab.settings.find((s: any) => s.key === 'MILE_VALUE_CENTS').default_value === '1.5', '');

  check('rejects a non-number where one is required',
    (await postTo('/api/settings', { key: 'POSTING_LAG_DAYS', value: 'soon' })).status === 400, '');
  check('rejects malformed thresholds',
    (await postTo('/api/settings', { key: 'UTIL_THRESHOLDS', value: '50;80' })).status === 400, '');
  check('rejects an absurd timezone offset',
    (await postTo('/api/settings', { key: 'TZ_OFFSET_MINUTES', value: '99999' })).status === 400, '');
  check('refuses to write a secret',
    (await postTo('/api/settings', { key: 'APP_SECRET', value: 'hunter2' })).status === 400, '');

  const reset = await postTo('/api/settings', { key: 'MILE_VALUE_CENTS', value: null });
  check('resetting clears the override', reset.status === 200, '');
  const back = (await (await worker.fetch(new Request(`https://x.test/api/settings?t=${token}`), env)).json()) as any;
  check('and the default applies again',
    back.settings.find((s: any) => s.key === 'MILE_VALUE_CENTS').stored_value === null, '');
}

// --- usage ------------------------------------------------------------------
{
  const res = await worker.fetch(new Request(`https://x.test/api/usage?t=${token}`), env);
  const u = (await res.json()) as any;
  check('usage reports row counts', u.db.total_rows > 0, JSON.stringify(u.db.total_rows));
  check('names the tables', u.db.rows.some((r: any) => r.table === 'transactions'), '');
  check('carries the D1 limit', u.db.limit_bytes === 5 * 1024 * 1024 * 1024, String(u.db.limit_bytes));
  check('says where the size figure came from',
    ['pragma', 'estimated', 'unavailable'].includes(u.db.size_source), u.db.size_source);
  check('lists the free-tier allowances', u.free_tier.length >= 5, String(u.free_tier.length));
  check('and is honest that worker metrics are not available here', u.worker.available === false, '');
}

// --- a database behind the code explains itself -----------------------------
// The API had no error handling: a missing table threw out of the handler and
// the browser saw a bare 500, which is undiagnosable from the UI.
{
  const old = new DatabaseSync(':memory:');
  const w2 = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => w2(sql, a),
    first: async () => old.prepare(sql).get(...(args as any)) ?? null,
    all: async () => ({ results: old.prepare(sql).all(...(args as any)) }),
    run: async () => {
      const r = old.prepare(sql).run(...(args as any));
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  const oldEnv = { ...env, DB: { prepare: (s: string) => w2(s) } } as unknown as Env;

  // The shape the database had before migration 006.
  old.exec(`CREATE TABLE cards (id INTEGER PRIMARY KEY, issuer TEXT, product TEXT, nickname TEXT)`);
  old.exec(`CREATE TABLE transactions (id INTEGER PRIMARY KEY, card_id INTEGER, amount_cents INTEGER,
            occurred_at TEXT, posted_at TEXT, merchant TEXT, category TEXT, source TEXT)`);
  old.exec(`INSERT INTO cards (issuer,product,nickname) VALUES ('Citi','Rewards','crw')`);
  old.exec(`INSERT INTO transactions (card_id,amount_cents,occurred_at,merchant) VALUES (1,2500,'2026-09-05','NTUC')`);

  const res = await worker.fetch(
    new Request('https://x.test/api/tx/update', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1, field: 'category', value: 'groceries' }),
    }),
    oldEnv
  );
  const body = (await res.json()) as any;
  check('a stale schema returns a response, not a crash', res.status === 500, String(res.status));
  check('the response names the missing table', /merchant_categories/.test(body.error ?? ''), JSON.stringify(body));
  check('and says what to do about it', /\/migrate/.test(body.error ?? ''), JSON.stringify(body));
  check('and flags it as a migration problem', body.needs_migration === true, JSON.stringify(body));
}

// A failure that is not a schema problem still returns its own message.
{
  const brokenEnv = {
    ...env,
    DB: { prepare: () => { throw new Error('D1_ERROR: connection lost'); } },
  } as unknown as Env;
  const res = await worker.fetch(new Request(`https://x.test/api/points?t=${token}`), brokenEnv);
  const body = (await res.json()) as any;
  check('an unexpected error still returns JSON', res.status === 500, String(res.status));
  check('carrying its message', /connection lost/.test(body.error ?? ''), JSON.stringify(body));
  check('and is not mislabelled as a migration issue', body.needs_migration !== true, JSON.stringify(body));
}

// --- the scan trigger -------------------------------------------------------
{
  const before = sent.length;
  const res = await worker.fetch(
    new Request('https://x.test/api/scan', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deep: false, push: false }),
    }),
    env
  );
  const body = (await res.json()) as any;
  check('a scan can be triggered from the app', res.status === 200, String(res.status));
  check('and reports what it read', typeof body.feeds_read === 'number' && Array.isArray(body.fresh), JSON.stringify(body));
  check('push: false keeps it off Telegram', sent.length === before, `${before} -> ${sent.length}`);
}

{
  const res = await worker.fetch(
    new Request('https://x.test/api/scan', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'not-a-url' }),
    }),
    env
  );
  check('an unreadable URL is reported, not thrown', res.status === 502, String(res.status));
}

// --- the scanner inbox ------------------------------------------------------
db.prepare(
  `INSERT INTO feed_items (guid, feed, title, link, apply_url, excerpt, terms, score, topic)
   VALUES ('g1','MileLion','30,000 bonus miles','https://blog.test/p','https://uob.com.sg/apply','Spend S$1,000','bonus miles',6,'promo')`
).run();
db.prepare(
  `INSERT INTO feed_items (guid, feed, title, link, topic, action)
   VALUES ('g2','MileLion','Old news','https://blog.test/q','promo','ignored')`
).run();
{
  const res = await worker.fetch(new Request(`https://x.test/api/feed?t=${token}`), env);
  const body = (await res.json()) as any;
  check('the inbox lists undecided matches', body.items.length === 1, JSON.stringify(body.items?.map((i: any) => i.guid)));
  check('and carries what the reader found', body.items[0].apply_url === 'https://uob.com.sg/apply', JSON.stringify(body.items[0]));
  check('with the excerpt', body.items[0].excerpt === 'Spend S$1,000', JSON.stringify(body.items[0]));

  const all = (await (await worker.fetch(new Request(`https://x.test/api/feed?state=all&t=${token}`), env)).json()) as any;
  check('state=all includes the decided ones', all.items.length === 2, String(all.items.length));
}

{
  const id = (db.prepare(`SELECT id FROM feed_items WHERE guid = 'g1'`).get() as any).id;
  const res = await worker.fetch(
    new Request('https://x.test/api/feed/action', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'track' }),
    }),
    env
  );
  const body = (await res.json()) as any;
  check('tracking from the app creates an offer', res.status === 200 && !!body.offer_id, JSON.stringify(body));
  const offer = db.prepare(`SELECT * FROM offers WHERE id = ?`).get(body.offer_id) as any;
  check('pointing at the apply link', offer.source_url === 'https://uob.com.sg/apply', JSON.stringify(offer));
  const item = db.prepare(`SELECT * FROM feed_items WHERE id = ?`).get(id) as any;
  check('and the item leaves the inbox', item.action === 'tracked' && item.offer_id === body.offer_id, JSON.stringify(item));
}

{
  const res = await worker.fetch(
    new Request('https://x.test/api/feed/action', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1, action: 'burn' }),
    }),
    env
  );
  check('an unknown action is refused', res.status === 400, String(res.status));
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall passed');
process.exit(fails ? 1 : 0);
