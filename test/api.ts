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
  check('it reports the counts behind each filter', body.counts.new === 1 && body.counts.ignored === 1, JSON.stringify(body.counts));

  const all = (await (await worker.fetch(new Request(`https://x.test/api/feed?state=all&t=${token}`), env)).json()) as any;
  check('state=all includes the decided ones', all.items.length === 2, String(all.items.length));
  const ignored = (await (await worker.fetch(new Request(`https://x.test/api/feed?state=ignored&t=${token}`), env)).json()) as any;
  check(
    'state=ignored shows only those',
    ignored.items.length === 1 && ignored.items[0].action === 'ignored',
    JSON.stringify(ignored.items)
  );
}

// --- paging and date ranges -------------------------------------------------
for (let n = 0; n < 25; n++) {
  const day = String((n % 25) + 1).padStart(2, '0');
  db.prepare(
    `INSERT INTO feed_items (guid, feed, title, link, topic, published_at, score)
     VALUES (?, 'MileLion', ?, ?, 'promo', ?, ?)`
  ).run(`p${n}`, `Promo ${n}`, `https://blog.test/${n}`, `2026-08-${day}T02:00:00Z`, n % 7);
}
db.prepare(
  `INSERT INTO feed_items (guid, feed, title, link, topic, published_at) VALUES ('sep1','MileLion','This month','https://blog.test/sep','promo','2026-09-05T02:00:00Z')`
).run();
{
  const p1 = (await (await worker.fetch(new Request(`https://x.test/api/feed?per_page=10&t=${token}`), env)).json()) as any;
  check('a page holds what you asked for', p1.items.length === 10, String(p1.items.length));
  check('and says how many there are', p1.total === 27, String(p1.total));
  check('and how many pages that is', p1.pages === 3, String(p1.pages));

  const p3 = (await (await worker.fetch(new Request(`https://x.test/api/feed?per_page=10&page=3&t=${token}`), env)).json()) as any;
  check('the last page holds the remainder', p3.items.length === 7, String(p3.items.length));
  const overlap = p1.items.filter((a: any) => p3.items.some((b: any) => b.id === a.id));
  check('pages do not overlap', overlap.length === 0, JSON.stringify(overlap.map((i: any) => i.id)));

  const beyond = (await (await worker.fetch(new Request(`https://x.test/api/feed?per_page=10&page=99&t=${token}`), env)).json()) as any;
  check('a page past the end clamps to the last one', beyond.page === 3 && beyond.items.length === 7, JSON.stringify({ page: beyond.page, n: beyond.items.length }));

  const huge = (await (await worker.fetch(new Request(`https://x.test/api/feed?per_page=9999&t=${token}`), env)).json()) as any;
  check('per_page is capped', huge.per_page === 50, String(huge.per_page));
}
{
  const month = (await (await worker.fetch(new Request(`https://x.test/api/feed?range=month&t=${token}`), env)).json()) as any;
  check('this month excludes last month', month.total === 1, String(month.total));
  check('and names the range it used', month.range.label === 'This month', month.range.label);
  check('with the dates it resolved to', month.range.from === '2026-09-01', String(month.range.from));

  const lastMonth = (await (await worker.fetch(new Request(`https://x.test/api/feed?range=lastmonth&t=${token}`), env)).json()) as any;
  check('last month has the rest', lastMonth.total === 25, String(lastMonth.total));
  const everything = (await (await worker.fetch(new Request(`https://x.test/api/feed?range=all&t=${token}`), env)).json()) as any;
  check('all time has everything', everything.total === 27, String(everything.total));
}

// --- judging several at once ------------------------------------------------
{
  const ids = ((await (await worker.fetch(new Request(`https://x.test/api/feed?per_page=5&t=${token}`), env)).json()) as any).items.map(
    (i: any) => i.id
  );
  const res = await worker.fetch(
    new Request('https://x.test/api/feed/action', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, action: 'ignore' }),
    }),
    env
  );
  const body = (await res.json()) as any;
  check('a batch can be ignored in one request', body.ignored === 5, JSON.stringify(body));
  const gone = db
    .prepare(`SELECT COUNT(*) c FROM feed_items WHERE id IN (${ids.join(',')}) AND action = 'ignored'`)
    .get() as any;
  check('and every one of them is marked', gone.c === 5, String(gone.c));
  check('so the inbox shrinks', ((await (await worker.fetch(new Request(`https://x.test/api/feed?t=${token}`), env)).json()) as any).total === 22, '');

  const many = await worker.fetch(
    new Request('https://x.test/api/feed/action', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from({ length: 201 }, (_, n) => n + 1), action: 'ignore' }),
    }),
    env
  );
  check('an unreasonable batch is refused', many.status === 400, String(many.status));

  const empty = await worker.fetch(
    new Request('https://x.test/api/feed/action', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [], action: 'ignore' }),
    }),
    env
  );
  check('and so is an empty one', empty.status === 400, String(empty.status));
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

// --- reviewing an offer from the app ---------------------------------------
const authed = (path: string, body?: unknown) =>
  worker.fetch(
    body === undefined
      ? new Request(`https://x.test${path}${path.includes('?') ? '&' : '?'}t=${token}`)
      : new Request(`https://x.test${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
    env
  );

db.prepare(`INSERT INTO offers (id,status,source_url,source_title) VALUES (50,'pending','https://uob.com.sg/apply','UOB offer')`).run();
{
  const body = (await (await authed('/api/offers')).json()) as any;
  check('pending offers reach the app', body.offers.some((o: any) => o.id === 50), JSON.stringify(body.offers?.map((o: any) => o.id)));
  const pending = body.offers.find((o: any) => o.id === 50);
  check('with no clauses yet', pending.eligibility.rules.length === 0, JSON.stringify(pending.eligibility));
  check('and a needs_review verdict', pending.eligibility.verdict === 'needs_review', pending.eligibility.verdict);
}
{
  const body = (await (await authed('/api/offer/prompt?id=50')).json()) as any;
  check('the extraction prompt is available in the app', /Return ONLY a JSON object/.test(body.prompt ?? ''), JSON.stringify(body).slice(0, 80));
  check('and names the offer', /\/save 50/.test(body.prompt ?? ''), '');
  check('a missing offer has no prompt', (await authed('/api/offer/prompt?id=9999')).status === 404, '');
}
{
  const res = await authed('/api/offer/extract', {
    id: 50,
    json: '```json\n{"issuer":"UOB","product":"Lady\'s","min_spend":1000,"rules":[{"predicate":{"type":"min_income","amount_cents":3000000,"period":"year"},"quote":"income of S$30,000"}]}\n```',
  });
  const body = (await res.json()) as any;
  check('pasting Claude\'s reply saves the terms', res.status === 200 && body.rules_saved === 1, JSON.stringify(body));
  check('the offer becomes tracked', (db.prepare(`SELECT status FROM offers WHERE id = 50`).get() as any).status === 'tracked', '');
  check('and the clause needs you', body.eligibility.open_questions === 1, JSON.stringify(body.eligibility));

  const bad = await authed('/api/offer/extract', { id: 50, json: 'not json' });
  check('bad JSON is refused with a reason', bad.status === 400 && /valid JSON/.test(((await bad.json()) as any).error), '');
}
{
  const ruleId = (db.prepare(`SELECT id FROM offer_rules WHERE offer_id = 50`).get() as any).id;
  const res = await authed('/api/offer/rule', { rule_id: ruleId, decision: 'pass', note: 'Salary clears it' });
  const body = (await res.json()) as any;
  check('ticking a clause clears the offer', body.eligibility.verdict === 'eligible', JSON.stringify(body.eligibility));
  check('and records it as your answer', body.eligibility.rules[0].decision === 'pass', '');
  check('with the note', body.eligibility.rules[0].note === 'Salary clears it', '');

  const undo = (await (await authed('/api/offer/rule', { rule_id: ruleId, decision: null })).json()) as any;
  check('and it can be withdrawn', undo.eligibility.verdict === 'needs_review', undo.eligibility.verdict);

  check('a bad decision is refused', (await authed('/api/offer/rule', { rule_id: ruleId, decision: 'maybe' })).status === 400, '');
  check('an unknown rule is a 404', (await authed('/api/offer/rule', { rule_id: 9999, decision: 'pass' })).status === 404, '');

  const del = await authed('/api/offer/rule/delete', { rule_id: ruleId });
  check('a mis-extracted clause can be removed', del.status === 200, String(del.status));
  check('leaving no clauses behind', (db.prepare(`SELECT COUNT(*) c FROM offer_rules WHERE offer_id = 50`).get() as any).c === 0, '');
}
{
  check('an offer can be marked applied', (await authed('/api/offer/status', { id: 50, status: 'applied' })).status === 200, '');
  check('and dismissed', (await authed('/api/offer/status', { id: 50, status: 'dismissed' })).status === 200, '');
  const open = (await (await authed('/api/offers')).json()) as any;
  check('a dismissed offer leaves the default list', !open.offers.some((o: any) => o.id === 50), '');
  const all = (await (await authed('/api/offers?status=all')).json()) as any;
  check('but status=all still shows it', all.offers.some((o: any) => o.id === 50), '');
  check('an invalid status is refused', (await authed('/api/offer/status', { id: 50, status: 'banana' })).status === 400, '');
  check('an unknown offer is a 404', (await authed('/api/offer/status', { id: 9999, status: 'applied' })).status === 404, '');
}

// --- editing the sources ----------------------------------------------------
{
  const add = await authed('/api/feeds/save', { url: 'https://www.example.com/feed/?utm_source=x', label: 'Example' });
  const body = (await add.json()) as any;
  check('a source can be added from the app', add.status === 200, String(add.status));
  check('and its URL is cleaned on the way in', body.url === 'https://example.com/feed', body.url);

  const listed = (await (await authed('/api/feeds')).json()) as any;
  const row = listed.feeds.find((f: any) => f.url === 'https://example.com/feed');
  check('it comes back in the list', !!row, JSON.stringify(listed.feeds));
  check('with no items read yet', row.items === 0 && row.last_seen === null, JSON.stringify(row));

  check('a junk URL is refused', (await authed('/api/feeds/save', { url: 'nonsense' })).status === 400, '');
  check('an unknown kind is refused', (await authed('/api/feeds/save', { url: 'https://a.test/f', kind: 'atom' })).status === 400, '');
}
{
  // History follows a rename: feed_items point at the label, not the URL.
  db.prepare(`INSERT INTO feed_items (guid, feed, title, link) VALUES ('x1','Example','A post','https://example.com/p')`).run();
  const res = await authed('/api/feeds/save', {
    old_url: 'https://example.com/feed',
    url: 'https://example.com/rss',
    label: 'Example Blog',
    kind: 'rss',
    active: true,
  });
  check('the URL can be changed', res.status === 200, String(res.status));
  const row = db.prepare(`SELECT * FROM feeds WHERE url = 'https://example.com/rss'`).get() as any;
  check('keeping one row, not two', !!row && !db.prepare(`SELECT 1 FROM feeds WHERE url = 'https://example.com/feed'`).get(), '');
  check('with the new kind', row.kind === 'rss', String(row.kind));
  const item = db.prepare(`SELECT feed FROM feed_items WHERE guid = 'x1'`).get() as any;
  check('and what it already scanned follows the rename', item.feed === 'Example Blog', item.feed);
  check('renaming a source that is gone is a 404', (await authed('/api/feeds/save', { old_url: 'https://nope.test/f', url: 'https://nope.test/g' })).status === 404, '');
}
{
  const paused = await authed('/api/feeds/save', { url: 'https://example.com/rss', label: 'Example Blog', active: false });
  check('a source can be paused', paused.status === 200, String(paused.status));
  check('which the scan honours', (db.prepare(`SELECT active FROM feeds WHERE url = 'https://example.com/rss'`).get() as any).active === 0, '');

  check('and removed', (await authed('/api/feeds/delete', { url: 'https://example.com/rss' })).status === 200, '');
  check('leaving its history behind', !!db.prepare(`SELECT 1 FROM feed_items WHERE guid = 'x1'`).get(), '');
  check('removing it twice is a 404', (await authed('/api/feeds/delete', { url: 'https://example.com/rss' })).status === 404, '');
}

// --- housekeeping over the API ----------------------------------------------
{
  const store = (await (await authed('/api/feed/storage')).json()) as any;
  check('storage is reported', typeof store.text_bytes === 'number' && store.total > 0, JSON.stringify(store).slice(0, 120));
  check('with the retention window in force', store.retention_days === 180, String(store.retention_days));

  const bad = await authed('/api/feed/purge', { mode: 'vapourise', scope: 'ignored' });
  check('an unknown mode is refused', bad.status === 400, String(bad.status));
  const badScope = await authed('/api/feed/purge', { mode: 'delete', scope: 'everything' });
  check('and an unknown scope', badScope.status === 400, String(badScope.status));

  const before = (db.prepare(`SELECT COUNT(*) c FROM feed_items`).get() as any).c;
  const res = await authed('/api/feed/purge', { mode: 'delete', scope: 'ignored' });
  const body = (await res.json()) as any;
  check('ignored items can be deleted from the app', res.status === 200 && body.affected > 0, JSON.stringify(body).slice(0, 120));
  const after = (db.prepare(`SELECT COUNT(*) c FROM feed_items`).get() as any).c;
  check('and the rows are actually gone', after === before - body.affected, `${before} -> ${after}`);
  check('the response carries fresh storage figures', body.storage.ignored === 0, JSON.stringify(body.storage));
}

// --- usage explains where the space goes ------------------------------------
{
  const usage = (await (await authed('/api/usage')).json()) as any;
  check('usage breaks storage down by table', !!usage.storage?.feed_items && !!usage.storage?.transactions, JSON.stringify(usage.storage ?? {}).slice(0, 120));
  check('with a per-transaction size', usage.storage.transactions.bytes_per_row > 0, String(usage.storage.transactions.bytes_per_row));
  check(
    'and a projection rather than a guess',
    usage.storage.transactions_years_to_1pct === null || usage.storage.transactions_years_to_1pct > 0,
    String(usage.storage.transactions_years_to_1pct)
  );
}

// --- earning into the wallet ------------------------------------------------
db.prepare(`INSERT OR IGNORE INTO programs (key,name,kind,unit,expiry_months) VALUES ('citi_ty','Citi ThankYou','bank','points',60)`).run();
db.prepare(`UPDATE cards SET program_key = 'citi_ty' WHERE nickname = 'crw'`).run();
db.prepare(`INSERT INTO earn_rules (card_id, category, mpd, reward_type) SELECT id, '*', 1.2, 'miles' FROM cards WHERE nickname='crw'`).run();
{
  const res = await authed('/api/tx', { nickname: 'crw', amount: '100.00', date: '2026-09-10', note: 'Cold Storage' });
  const body = (await res.json()) as any;
  check('adding a transaction records what it earns', body.expected_miles > 0, JSON.stringify(body).slice(0, 140));
  check('and which programme it lands in', body.expected_program === 'citi_ty', String(body.expected_program));

  const pending = (await (await authed('/api/credits')).json()) as any;
  check('it shows as waiting to be banked', pending.credits.some((c: any) => c.id === body.id), JSON.stringify(pending.by_program));
  // This database already holds balances from the earlier tests, so the
  // assertions are on the change, not the absolute total.
  const before = ((await (await authed('/api/wallet')).json()) as any).totals.points;

  const accepted = (await (await authed('/api/credits/accept', { ids: [body.id] })).json()) as any;
  check('accepting banks it', accepted.accepted === 1 && accepted.points === body.expected_miles, JSON.stringify(accepted).slice(0, 120));
  check('and the wallet grows by exactly that', accepted.wallet.totals.points === before + body.expected_miles, `${before} -> ${accepted.wallet.totals.points}`);
  check('the queue is empty again', ((await (await authed('/api/credits')).json()) as any).credits.length === 0, '');

  const undone = (await (await authed('/api/credits/undo', { id: body.id })).json()) as any;
  check('and it can be taken back out', undone.wallet.totals.points === before, `${undone.wallet.totals.points} vs ${before}`);
  check('undoing it twice is a 404', (await authed('/api/credits/undo', { id: body.id })).status === 404, '');
  check('accepting nothing is refused', (await authed('/api/credits/accept', { ids: [] })).status === 400, '');
}
{
  check('a card programme can be set from the app', (await authed('/api/card/program', { nickname: 'crw', program_key: 'citi_ty' })).status === 200, '');
  check('an unknown programme is refused', (await authed('/api/card/program', { nickname: 'crw', program_key: 'nope' })).status === 400, '');
  check('an unknown card is a 404', (await authed('/api/card/program', { nickname: 'zzz', program_key: 'citi_ty' })).status === 404, '');
  check('and it can be cleared', (await authed('/api/card/program', { nickname: 'crw', program_key: null })).status === 200, '');
}

// --- offers that have ended -------------------------------------------------
db.prepare(`INSERT INTO offers (id,status,issuer,valid_until) VALUES (60,'tracked','UOB','2026-09-01')`).run();
db.prepare(`INSERT INTO offers (id,status,issuer,valid_until) VALUES (61,'tracked','DBS','2026-12-31')`).run();
{
  const body = (await (await authed('/api/offers')).json()) as any;
  const ended = body.offers.find((o: any) => o.id === 60);
  const live = body.offers.find((o: any) => o.id === 61);
  check('an offer says how long is left', live.days_left > 0, String(live.days_left));
  check('and an ended one says it has ended', ended.expired === true && ended.days_left < 0, JSON.stringify({ e: ended.expired, d: ended.days_left }));

  const sweep = (await (await authed('/api/offers/sweep', {})).json()) as any;
  check('the sweep marks it expired', sweep.expired === 1, JSON.stringify(sweep));
  check('leaving the live one alone', (db.prepare(`SELECT status FROM offers WHERE id=61`).get() as any).status === 'tracked', '');
  check('and it drops out of the default list', !(((await (await authed('/api/offers')).json()) as any).offers.some((o: any) => o.id === 60)), '');
}

// --- the merchant-code table ------------------------------------------------
// This database is migrated but not seeded, so the codes it compares against
// are put in here rather than pulled from seed.sql (which would also add feeds
// and offers the earlier assertions count).
for (const [code, desc, cat] of [
  ['5812', 'Eating places and restaurants', 'dining'],
  ['5411', 'Grocery stores and supermarkets', 'groceries'],
  ['9311', 'Tax payments', 'government'],
  ['7995', 'Betting and casino gaming', 'financial'],
  ['4814', 'Telecommunication Services', 'utilities'],
] as const) {
  db.prepare(`INSERT OR IGNORE INTO mcc_codes (code, description, category) VALUES (?, ?, ?)`).run(code, desc, cat);
}
db.prepare(`INSERT INTO exclusions (card_id, mcc, reason, source) VALUES (NULL, '9311', 'Tax is excluded', 'seed')`).run();
{
  const m = (await (await authed('/api/mcc/matrix')).json()) as any;
  check('the code table is served', m.rows.length === 5, String(m.rows?.length));
  check('with its paging state', m.page === 1 && m.pages === 1 && m.total === 5, JSON.stringify({ p: m.page, n: m.pages, t: m.total }));
  check('with a column per open card', m.cards.length >= 1, JSON.stringify(m.cards?.map((c: any) => c.nickname)));
  check('and a summary', typeof m.summary.excluded_everywhere === 'number', JSON.stringify(m.summary));
  check('saying whether excluded spend counts', m.min_spend_counts_excluded === false, String(m.min_spend_counts_excluded));

  const filtered = (await (await authed('/api/mcc/matrix?filter=excluded')).json()) as any;
  check('the filter narrows the rows', filtered.rows.length < m.rows.length, `${filtered.rows.length} of ${m.rows.length}`);
  check('but not the summary', filtered.summary.codes === m.summary.codes, '');
  const searched = (await (await authed('/api/mcc/matrix?q=5812')).json()) as any;
  check('search finds one code', searched.rows.length === 1 && searched.rows[0].code === '5812', JSON.stringify(searched.rows?.map((r: any) => r.code)));
}
{
  const add = await authed('/api/exclusion', { mcc: '7995', reason: 'gambling earns nothing' });
  check('an exclusion can be added from the app', add.status === 200, String(add.status));
  const m = (await (await authed('/api/mcc/matrix?q=7995')).json()) as any;
  check('and it shows on every card', m.rows[0].cells.every((c: any) => c.state === 'excluded'), JSON.stringify(m.rows[0]?.cells));
  check('marked as excluded everywhere', m.rows[0].excluded_everywhere === true, '');

  check('a bad code is refused', (await authed('/api/exclusion', { mcc: '79' })).status === 400, '');
  check('an unknown card is a 404', (await authed('/api/exclusion', { mcc: '7995', nickname: 'zzz' })).status === 404, '');

  const off = await authed('/api/exclusion', { mcc: '7995', active: false });
  check('and it can be removed', off.status === 200, String(off.status));
  const after = (await (await authed('/api/mcc/matrix?q=7995')).json()) as any;
  check('after which it earns again', after.rows[0].cells.every((c: any) => c.state !== 'excluded'), JSON.stringify(after.rows[0]?.cells));
  check('removing it twice is a 404', (await authed('/api/exclusion', { mcc: '7995', active: false })).status === 404, '');
}

// --- adding a card and its rates from the app -------------------------------
// The guess only offers a programme the database knows about, so it needs one.
db.prepare(`INSERT OR IGNORE INTO programs (key,name,kind,unit,expiry_months) VALUES ('uob_uni','UOB UNI$','bank','UNI$',24)`).run();
{
  const res = await authed('/api/card', {
    issuer: 'UOB',
    product: "Lady's Card",
    nickname: 'lady',
    limit: '8000',
    statement_day: 15,
    opened_at: '2026-02-01',
    base_mpd: '0.4',
  });
  const body = (await res.json()) as any;
  check('a card can be added from the app', res.status === 200, JSON.stringify(body));
  const row = db.prepare(`SELECT * FROM cards WHERE nickname = 'lady'`).get() as any;
  check('with its limit in cents', row.credit_limit_cents === 800000, String(row.credit_limit_cents));
  check('and a product key derived from the name', row.product_key === 'uob_lady_s_card', row.product_key);
  check('and a programme guessed from the issuer', body.program_key === 'uob_uni', String(body.program_key));

  check('a duplicate nickname is refused', (await authed('/api/card', { issuer: 'X', product: 'Y', nickname: 'lady' })).status === 400, '');
  check('a nickname with spaces is refused', (await authed('/api/card', { issuer: 'X', product: 'Y', nickname: 'my card' })).status === 400, '');
  check('a card with no product is refused', (await authed('/api/card', { issuer: 'X', nickname: 'zz' })).status === 400, '');
}
{
  const res = await authed('/api/card/rule', {
    nickname: 'lady',
    category: 'dining',
    rate: '4',
    reward_type: 'miles',
    cap: '1000',
    cap_window: 'calendar_month',
    mcc_include: '5812, 5814',
  });
  check('a rate can be added', res.status === 200, String(res.status));
  const rule = db.prepare(`SELECT * FROM earn_rules ORDER BY id DESC LIMIT 1`).get() as any;
  check('with its cap in cents', rule.cap_cents === 100000, String(rule.cap_cents));
  check('and the MCC list normalised', rule.mcc_include === '5812,5814', String(rule.mcc_include));

  check(
    'a bad MCC list is refused',
    (await authed('/api/card/rule', { nickname: 'lady', category: 'dining', rate: '4', mcc_include: 'abc' })).status === 400,
    ''
  );
  check(
    'an unknown cap window is refused',
    (await authed('/api/card/rule', { nickname: 'lady', category: 'x', rate: '4', cap_window: 'weekly' })).status === 400,
    ''
  );
  check('a rule for an unknown card is a 404', (await authed('/api/card/rule', { nickname: 'nope', rate: '1' })).status === 404, '');

  const listed = (await (await authed('/api/cards')).json()) as any;
  const lady = listed.cards.find((c: any) => c.nickname === 'lady');
  check('the card lists its rules', lady.rules.length === 1, JSON.stringify(lady.rules?.length));
  check('and the categories come with it', listed.categories.length > 0, String(listed.categories?.length));

  check('a rule can be removed', (await authed('/api/card/rule/delete', { id: rule.id })).status === 200, '');
  check('after which the card has none', ((await (await authed('/api/cards')).json()) as any).cards.find((c: any) => c.nickname === 'lady').rules.length === 0, '');
}
{
  const res = await authed('/api/card/close', { nickname: 'lady', closed_at: '2026-09-01' });
  check('a card can be closed', res.status === 200, String(res.status));
  check('keeping the date eligibility needs', (db.prepare(`SELECT closed_at FROM cards WHERE nickname='lady'`).get() as any).closed_at === '2026-09-01', '');
  check('and reopened', (await authed('/api/card/close', { nickname: 'lady', closed_at: null })).status === 200, '');
}

// --- pasting a statement ------------------------------------------------------
{
  const text = ['14 SEP  15 SEP  NTUC FAIRPRICE  23.45', '15/09/2026  GRAB *TRIP  12.30', 'GARBAGE LINE  9.99'].join('\n');
  const res = await authed('/api/statement/parse', { text, nickname: 'crw' });
  const body = (await res.json()) as any;
  check('a pasted statement is read', body.rows.length === 2, JSON.stringify(body.rows?.map((r: any) => r.merchant)));
  check('with a total to check against the bill', body.total_cents === 3575, String(body.total_cents));
  check('and the line it could not read is reported', body.skipped.length === 1, JSON.stringify(body.skipped));
  check('nothing is written by parsing', (db.prepare(`SELECT COUNT(*) c FROM transactions WHERE source = 'statement'`).get() as any).c === 0, '');

  const imported = (await (await authed('/api/statement/import', { nickname: 'crw', rows: body.rows })).json()) as any;
  check('and then imported', imported.imported === 2, JSON.stringify(imported));
  const rows = db.prepare(`SELECT * FROM transactions WHERE source = 'statement' ORDER BY id`).all() as any[];
  check('with both dates kept', rows[0].occurred_at === '2026-09-14' && rows[0].posted_at === '2026-09-15', JSON.stringify(rows[0]));
  check('and marked as coming from a statement', rows.every((r) => r.source === 'statement'), '');

  const again = (await (await authed('/api/statement/parse', { text, nickname: 'crw' })).json()) as any;
  check('importing the same statement twice is flagged', again.duplicates === 2, String(again.duplicates));
  check('an empty paste is refused', (await authed('/api/statement/parse', { text: '   ' })).status === 400, '');
  check('an import for an unknown card is a 404', (await authed('/api/statement/import', { nickname: 'zz', rows: body.rows })).status === 404, '');
}

// --- merchants with no code ---------------------------------------------------
{
  const unknown = (await (await authed('/api/mcc/unknown')).json()) as any;
  check('merchants with no code are listed', unknown.merchants.length > 0, JSON.stringify(unknown.merchants?.slice(0, 2)));
  const target = unknown.merchants[0].merchant;
  const res = await authed('/api/mcc/assign', { merchant: target, mcc: '5411' });
  const body = (await res.json()) as any;
  check('a code can be assigned', res.status === 200, JSON.stringify(body));
  check('and applied to spend already logged', body.updated > 0, String(body.updated));
  const after = (await (await authed('/api/mcc/unknown')).json()) as any;
  check('so it leaves the list', !after.merchants.some((m: any) => m.merchant === target), '');
  check('a bad code is refused', (await authed('/api/mcc/assign', { merchant: 'x', mcc: '12' })).status === 400, '');
}

// --- looking one merchant up --------------------------------------------------
{
  // The fixture fetch returns {"ok":true}, so the directory half finds nothing;
  // what matters here is that our own table answers and the shape is right.
  db.prepare(
    `INSERT OR REPLACE INTO merchant_mcc (merchant, mcc, source, confidence) VALUES ('circles life','4814','user','confirmed')`
  ).run();
  const body = (await (await authed('/api/mcc/lookup?q=Circles%20Life')).json()) as any;
  check('a merchant we know is answered from our own table', body.known?.mcc === '4814', JSON.stringify(body.known));
  check('the directory results come back as a list', Array.isArray(body.results), JSON.stringify(body.results));
  // The fixture fetch returns {"ok":true}, which is valid JSON with no
  // merchants — so an unreachable directory and an empty one stay distinct.
  check('an unreadable answer is reported, not shown as no matches', body.results.length === 0 && body.error === null, JSON.stringify(body));
  check('and the source is named', body.source === 'check-mcc.sg', String(body.source));
  check('an empty query is refused', (await authed('/api/mcc/lookup?q=')).status === 400, '');
}

// --- off-card spending --------------------------------------------------------
{
  const res = await authed('/api/other/add', { amount: '12.80', date: '2026-09-10', method: 'paylah', merchant: 'Maxwell', category: 'dining' });
  const body = (await res.json()) as any;
  check('off-card spending can be added', res.status === 200, JSON.stringify(body));
  check('a wallet is assumed card-capable', body.card_possible === 1, String(body.card_possible));

  const cash = (await (await authed('/api/other/add', { amount: '5.00', method: 'cash', merchant: 'Hawker' })).json()) as any;
  check('cash is not', cash.card_possible === 0, String(cash.card_possible));

  check('an amount is required', (await authed('/api/other/add', { method: 'cash' })).status === 400, '');
  check('and a future date refused', (await authed('/api/other/add', { amount: '5', date: '2030-01-01' })).status === 400, '');

  const month = (await (await authed('/api/other?month=2026-09')).json()) as any;
  check('the month comes back with its rows', month.rows.length >= 1, String(month.rows?.length));
  check('with the methods for the picker', month.methods.some((m: any) => m.key === 'paylah'), '');
  check('and the months that have data', Array.isArray(month.months), JSON.stringify(month.months));

  const edited = await authed('/api/other/update', { id: body.id, field: 'category', value: 'groceries' });
  check('a row can be recategorised', edited.status === 200, String(edited.status));
  check('which teaches the merchant', (db.prepare(`SELECT category FROM merchant_categories WHERE merchant = 'maxwell'`).get() as any)?.category === 'groceries', '');
  check('an unknown field is refused', (await authed('/api/other/update', { id: body.id, field: 'nonsense', value: 'x' })).status === 400, '');

  check('and a row can be removed', (await authed('/api/other/delete', { id: cash.id })).status === 200, '');
  check('removing it twice is a 404', (await authed('/api/other/delete', { id: cash.id })).status === 404, '');
}

// --- minimum-spend requirements from the app ----------------------------------
{
  const res = await authed('/api/card/requirement', {
    nickname: 'crw',
    kind: 'signup_min',
    amount: '1000',
    window: 'fixed_window',
    deadline: '2026-12-31',
    min_txns: 5,
    reward_note: '30,000 miles',
  });
  check('a minimum can be set from the app', res.status === 200, String(res.status));
  const row = db.prepare(`SELECT * FROM requirements ORDER BY id DESC LIMIT 1`).get() as any;
  check('with the amount in cents', row.amount_cents === 100000, String(row.amount_cents));
  check('and the transaction count', row.min_txns === 5, String(row.min_txns));

  check(
    'a one-off window without a deadline is refused',
    (await authed('/api/card/requirement', { nickname: 'crw', amount: '500', window: 'fixed_window' })).status === 400,
    ''
  );
  check('an unknown window is refused', (await authed('/api/card/requirement', { nickname: 'crw', amount: '500', window: 'weekly' })).status === 400, '');
  check('an unknown card is a 404', (await authed('/api/card/requirement', { nickname: 'zz', amount: '500' })).status === 404, '');

  const listed = (await (await authed('/api/cards')).json()) as any;
  check('cards carry their requirements', listed.cards.find((c: any) => c.nickname === 'crw').requirements.length >= 1, '');
  check('a requirement can be removed', (await authed('/api/card/requirement/delete', { id: row.id })).status === 200, '');
}

// --- transfer routes from the app ---------------------------------------------
{
  db.prepare(`INSERT OR IGNORE INTO programs (key,name,kind,unit,expiry_months) VALUES ('krisflyer','KrisFlyer','airline','miles',36)`).run();
  const res = await authed('/api/route', {
    from_program: 'uob_uni',
    to_program: 'krisflyer',
    from_units: 5000,
    to_units: 10000,
    fee_cents: '27.25',
    min_block: 5000,
    block_increment: 5000,
  });
  const body = (await res.json()) as any;
  check('a route can be added', res.status === 200, JSON.stringify(body));
  const row = db.prepare(`SELECT * FROM conversions WHERE id = ?`).get(body.id) as any;
  check('with its fee in cents', row.fee_cents === 2725, String(row.fee_cents));
  check('and unverified unless you say so', row.verified_at === null, String(row.verified_at));

  check('an unknown programme is refused', (await authed('/api/route', { from_program: 'nope', to_program: 'krisflyer', from_units: 1, to_units: 1 })).status === 400, '');
  check('a ratio needs both sides', (await authed('/api/route', { from_program: 'uob_uni', to_program: 'krisflyer', from_units: 0, to_units: 5 })).status === 400, '');

  check('marking it checked is one call', (await authed('/api/route', { id: body.id, verified: true })).status === 200, '');
  check('which dates it', (db.prepare(`SELECT verified_at FROM conversions WHERE id = ?`).get(body.id) as any).verified_at !== null, '');

  const listed = (await (await authed('/api/routes')).json()) as any;
  check('routes come back with their programme names', listed.routes.some((r: any) => r.to_name === 'KrisFlyer'), '');
  check('and it can be removed', (await authed('/api/route/delete', { id: body.id })).status === 200, '');
}

// --- reading a rewards page ----------------------------------------------------
{
  const res = await authed('/api/card/scan', {
    nickname: 'crw',
    text: 'Earn 4 mpd on online spend, capped at S$1,000 per calendar month. Excluded MCCs: 4900, 9311.',
  });
  const body = (await res.json()) as any;
  check('a pasted rewards page can be read from the app', res.status === 200, String(res.status));
  const rate = body.candidates.find((c: any) => c.kind === 'rate');
  check('the rate comes back with the sentence it came from', rate?.rate === 4 && /Earn 4 mpd/.test(rate.quote), JSON.stringify(rate));
  check('and its cap', rate?.cap_cents === 100000, String(rate?.cap_cents));
  check('the excluded codes come back described', body.codes.some((c: any) => c.mcc === '4900' && c.excluded_here), JSON.stringify(body.codes));
  check('with a prompt for the prose this cannot read', /addearn crw/.test(body.prompt), body.prompt.slice(0, 60));

  // Reading is not saving: the whole design rests on this.
  const rules = db.prepare(`SELECT COUNT(*) AS n FROM earn_rules WHERE mcc_include = '4900'`).get() as any;
  check('reading a page writes nothing', Number(rules.n) === 0, String(rules.n));

  check('an unknown card is refused', (await authed('/api/card/scan', { nickname: 'nope', text: 'x' })).status === 404, '');
  check('and so is no card at all', (await authed('/api/card/scan', { text: 'x' })).status === 400, '');
}

// --- the bot accepts what the prompt tells Claude to write ---------------------
// The prompt in /cardrules promises `mcc <codes>`; a command shape the bot then
// rejects would make the whole flow dead-end at the last step.
{
  const tg = (text: string) =>
    worker.fetch(
      new Request('https://x.test/tg', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'y', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { chat: { id: 1 }, from: { id: 1 }, text } }),
      }),
      env
    );

  await tg('/addearn crw online 4 cap 1000 window calendar_month group tenx mcc 5262,5964,5969');
  const rule = db
    .prepare(`SELECT * FROM earn_rules WHERE card_id = (SELECT id FROM cards WHERE nickname='crw') AND category='online'`)
    .get() as any;
  check('the bot accepts a rate restricted to merchant codes', rule?.mcc_include === '5262,5964,5969', JSON.stringify(rule));
  check('and still reads the cap beside it', rule?.cap_cents === 100000 && rule?.cap_group === 'tenx', JSON.stringify(rule));

  const before = db.prepare(`SELECT COUNT(*) AS n FROM earn_rules`).get() as any;
  await tg('/addearn crw dining 4 mcc 526');
  const after = db.prepare(`SELECT COUNT(*) AS n FROM earn_rules`).get() as any;
  check('a code that is not four digits is refused, not stored', Number(after.n) === Number(before.n), `${before.n} -> ${after.n}`);
}

// --- a tiered rolling quarter, end to end ------------------------------------
{
  const tg = (text: string) =>
    worker.fetch(
      new Request('https://x.test/tg', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'y', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { chat: { id: 1 }, from: { id: 1 }, text } }),
      }),
      env
    );

  const made = await authed('/api/card', {
    issuer: 'UOB',
    product: 'UOB One',
    nickname: 'one',
    limit: '10000',
    statement_day: 18,
    opened_at: '2026-02-10',
  });
  check('a card for the quarterly test is added', made.status === 200, String(made.status));

  const res = await authed('/api/card/requirement', {
    nickname: 'one',
    kind: 'monthly_min',
    amount: '600',
    window: 'statement_quarter',
    min_txns: 10,
    per_month: true,
    prorate_first: true,
    tiers: [
      { min_spend: '600', reward: '50' },
      { min_spend: '1000', reward: '110' },
    ],
  });
  const body = (await res.json()) as any;
  check('a rolling-quarter minimum can be added from the app', res.status === 200, String(res.status));
  check('with its tiers', body.tiers === 2, JSON.stringify(body));
  check('and the lowest rung becomes the minimum', body.amount_cents === 60000, JSON.stringify(body));

  const row = db.prepare(`SELECT * FROM requirements WHERE id = ?`).get(body.id) as any;
  check('the quarter is anchored to the card', row.per_month === 1 && row.window === 'statement_quarter', JSON.stringify(row));
  check('and pro-rates its first quarter', row.prorate_first === 1, String(row.prorate_first));

  check(
    'a tier with no payout is refused',
    (await authed('/api/card/requirement', { nickname: 'one', amount: '600', window: 'calendar_month', tiers: [{ min_spend: '600' }] })).status === 400,
    ''
  );

  // A rolling quarter with nothing to count from would put every month in
  // quarter one, so it is refused rather than guessed.
  await authed('/api/card', { issuer: 'X', product: 'No Date', nickname: 'nodate', limit: '1000' });
  const bad = await authed('/api/card/requirement', { nickname: 'nodate', amount: '600', window: 'statement_quarter' });
  check('a rolling quarter with no anchor is refused', bad.status === 400, String(bad.status));
  check('and says what is missing', /issued|anchor/i.test(((await bad.json()) as any).error ?? ''), '');

  // The bot writes the same ladder.
  // A ladder whose lowest rung is below the stored minimum must move the
  // minimum down: that mismatch is what reported a good month as a miss.
  db.prepare(`UPDATE requirements SET amount_cents = 100000 WHERE id = ?`).run(body.id);
  await tg('/tiers one 600=50 1000=110 2000=300');
  const fixed = db.prepare(`SELECT amount_cents FROM requirements WHERE id = ?`).get(body.id) as any;
  check('the bot brings the minimum into line with the ladder', fixed.amount_cents === 60000, String(fixed.amount_cents));
  const tiers = db.prepare(`SELECT * FROM requirement_tiers WHERE requirement_id = ? ORDER BY min_spend_cents`).all(body.id) as any[];
  check('the bot replaces the ladder rather than appending to it', tiers.length === 3, String(tiers.length));
  check('and stores it in cents', tiers[2].min_spend_cents === 200000 && tiers[2].reward_cents === 30000, JSON.stringify(tiers[2]));

  await tg('/tiers one 600=50 1000=110 2000=300');
  check('sending it twice does not double it', (db.prepare(`SELECT COUNT(*) AS n FROM requirement_tiers WHERE requirement_id = ?`).get(body.id) as any).n === 3, '');

  const before = (db.prepare(`SELECT COUNT(*) AS n FROM requirement_tiers`).get() as any).n;
  await tg('/tiers one 600');
  check('a rung without a payout is refused, not stored', (db.prepare(`SELECT COUNT(*) AS n FROM requirement_tiers`).get() as any).n === before, '');

  await tg('/tiers one none');
  check('and they can be cleared', (db.prepare(`SELECT COUNT(*) AS n FROM requirement_tiers WHERE requirement_id = ?`).get(body.id) as any).n === 0, '');
}

// --- the summary leads with minimum spend, not the limit ---------------------
{
  const s = (await (await authed('/api/summary')).json()) as any;
  check('the dashboard reports how many minimums are met', typeof s.overall.minimums_met === 'number', JSON.stringify(s.overall));
  check('and what is still to spend', typeof s.overall.still_needed_cents === 'number', '');
  check('the limit is kept, just not as the headline', typeof s.overall.limit_cents === 'number', '');

  const card = s.cards.find((c: any) => c.nickname === 'one');
  check('a card names the requirement its bar is about', card.headline_id !== null, JSON.stringify(card.headline_id));
  const headline = card.requirements.find((r: any) => r.id === card.headline_id);
  check('the bar tracks the minimum, not the limit', Math.abs(card.percent - (headline.spent_cents / headline.amount_cents) * 100) < 0.01, JSON.stringify({ p: card.percent, h: headline.spent_cents }));
  check('utilization is still reported alongside it', typeof card.util_percent === 'number', String(card.util_percent));
  check('the quarter comes with it', headline.quarter?.index >= 1 && headline.months.length === 3, JSON.stringify(headline.quarter));
  check('the real minimum is reported, not the stored number', headline.floor_cents === 60000, String(headline.floor_cents));
  check('and the ceiling and target come with it', 'ceiling_tier' in headline && 'target_cents' in headline, JSON.stringify(Object.keys(headline)));

  // Most at risk first: that is the whole point of the reordering.
  const unmet = s.cards.filter((c: any) => c.headline_id !== null);
  const days = unmet.map((c: any) => c.requirements.find((r: any) => r.id === c.headline_id)).filter((r: any) => !r.met).map((r: any) => r.days_left);
  check('cards are ordered by how soon a minimum can be missed', days.every((d: number, i: number) => i === 0 || days[i - 1] <= d), JSON.stringify(days));
}

// --- paging the long lists ---------------------------------------------------
{
  const page = async (n: number, per: number) =>
    (await (await authed(`/api/transactions?limit=${per}&page=${n}&range=all`)).json()) as any;

  const first = await page(1, 2);
  check('the ledger comes back paged', first.per_page === 2 && first.pages >= 1, JSON.stringify({ p: first.per_page, n: first.pages }));
  check('a page holds no more than asked', first.transactions.length <= 2, String(first.transactions.length));
  check('and the total still counts everything', first.total_count >= first.transactions.length, JSON.stringify(first.total_count));

  if (first.pages > 1) {
    const second = await page(2, 2);
    check('page two is different rows', second.transactions[0]?.id !== first.transactions[0]?.id, '');
    // Asking past the end must show the last page, not an empty table.
    const far = await page(999, 2);
    check('a page past the end clamps to the last one', far.page === far.pages && far.transactions.length > 0, JSON.stringify({ p: far.page, n: far.pages }));
  }
}

// --- merchants with no code: paged, and ignorable ----------------------------
{
  const unknown = async (q = '') => (await (await authed(`/api/mcc/unknown${q}`)).json()) as any;

  const all = await unknown();
  check('the unknown-merchant list is paged', typeof all.pages === 'number' && typeof all.total === 'number', JSON.stringify(Object.keys(all)));
  check('and says how many are ignored', typeof all.ignored === 'number', String(all.ignored));

  if (all.total > 0) {
    const one = await unknown('?per=1&page=1');
    check('one per page returns one', one.merchants.length === 1, String(one.merchants.length));
    check('and reports the rest as more pages', one.pages === one.total, JSON.stringify({ p: one.pages, t: one.total }));

    const name = one.merchants[0].merchant;
    const res = await authed('/api/mcc/ignore', { merchant: name });
    check('a merchant can be ignored', res.status === 200, String(res.status));

    const after = await unknown();
    check('and drops out of the list', !after.merchants.some((m: any) => m.merchant === name), name);
    check('while still being counted', after.ignored === all.ignored + 1, `${all.ignored} -> ${after.ignored}`);
    check('and the total shrinks with it', after.total === all.total - 1, `${all.total} -> ${after.total}`);
    check('the ignored one is listed so it can be found again', after.ignored_list.some((g: any) => g.merchant === name), JSON.stringify(after.ignored_list));

    await authed('/api/mcc/ignore', { merchant: name, undo: true });
    const back = await unknown();
    check('putting it back restores it', back.total === all.total && back.ignored === all.ignored, `${back.total}/${back.ignored}`);

    check('ignoring nothing is refused', (await authed('/api/mcc/ignore', { merchant: '  ' })).status === 400, '');
  }
}

// --- Cloudflare's own meters -------------------------------------------------
{
  // Unconfigured is the state this will be in for most people, and it has to
  // say so rather than reporting a confident zero.
  const r = (await (await authed('/api/platform?days=7')).json()) as any;
  check('the platform panel answers even with no token', r.configured === false, JSON.stringify(r.missing));
  check('and names what is missing', Array.isArray(r.missing) && r.missing.length > 0, '');
  check('without ever naming a token value', !JSON.stringify(r).includes('Bearer'), '');
}

// --- a minimum can be corrected, not only deleted ----------------------------
{
  // The shape that read $1,621 against a $1,000 minimum: a whole calendar
  // quarter, no tiers. Being unable to fix it in place is how a card stays
  // wrong, so the same endpoint updates.
  await authed('/api/card', { issuer: 'UOB', product: 'One Card', nickname: 'uobone', limit: '35700', statement_day: 30, opened_at: '2026-01-01' });
  const made = (await (await authed('/api/card/requirement', {
    nickname: 'uobone',
    kind: 'monthly_min',
    amount: '1000',
    window: 'calendar_quarter',
    min_txns: 5,
    reward_note: '$100 quarterly rebate',
  })).json()) as any;
  check('the wrong shape can be created, as it was', made.id > 0, JSON.stringify(made));

  const fixed = await authed('/api/card/requirement', {
    id: made.id,
    nickname: 'uobone',
    kind: 'monthly_min',
    amount: '600',
    window: 'statement_quarter',
    min_txns: 5,
    per_month: true,
    prorate_first: false,
    anchor_at: '2026-01-01',
    tiers: [
      { min_spend: '600', reward: '60' },
      { min_spend: '1000', reward: '100' },
      { min_spend: '2000', reward: '200' },
    ],
  });
  const body = (await fixed.json()) as any;
  check('and corrected in place', fixed.status === 200 && body.id === made.id, JSON.stringify(body));

  const row = db.prepare(`SELECT * FROM requirements WHERE id = ?`).get(made.id) as any;
  check('the window is now a rolling statement quarter', row.window === 'statement_quarter', row.window);
  check('gated on every month', row.per_month === 1, String(row.per_month));
  check('with the lowest rung as the minimum', row.amount_cents === 60000, String(row.amount_cents));
  const tiers = db.prepare(`SELECT COUNT(*) AS n FROM requirement_tiers WHERE requirement_id = ?`).get(made.id) as any;
  check('and the ladder attached', Number(tiers.n) === 3, String(tiers.n));

  // Editing again must replace the ladder, not add a second copy of it.
  await authed('/api/card/requirement', {
    id: made.id,
    nickname: 'uobone',
    amount: '600',
    window: 'statement_quarter',
    per_month: true,
    anchor_at: '2026-01-01',
    tiers: [{ min_spend: '600', reward: '60' }],
  });
  const again = db.prepare(`SELECT COUNT(*) AS n FROM requirement_tiers WHERE requirement_id = ?`).get(made.id) as any;
  check('editing replaces the ladder rather than appending', Number(again.n) === 1, String(again.n));

  check(
    'a requirement belonging to another card is refused',
    (await authed('/api/card/requirement', { id: made.id, nickname: 'crw', amount: '600', window: 'calendar_month' })).status === 404,
    ''
  );
}

// --- rates that move with the tier -------------------------------------------
{
  const res = await authed('/api/card/rule', {
    nickname: 'uobone',
    category: 'groceries',
    rate: '6',
    reward_type: 'cashback',
    min_tier: '1000',
  });
  check('a rate can be tied to a spend rung', res.status === 200, String(res.status));
  const rule = db.prepare(`SELECT * FROM earn_rules WHERE card_id = (SELECT id FROM cards WHERE nickname='uobone') AND category='groceries'`).get() as any;
  check('and the rung is stored in cents', rule.min_tier_cents === 100000, String(rule.min_tier_cents));

  const tg = (text: string) =>
    worker.fetch(
      new Request('https://x.test/tg', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'y', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { chat: { id: 1 }, from: { id: 1 }, text } }),
      }),
      env
    );
  await tg('/addearn uobone dining 8% tier 2000');
  const botRule = db.prepare(`SELECT * FROM earn_rules WHERE card_id = (SELECT id FROM cards WHERE nickname='uobone') AND category='dining'`).get() as any;
  check('the bot understands the tier keyword too', botRule?.min_tier_cents === 200000, JSON.stringify(botRule));
}

// --- the catalogue, once the migration has run --------------------------------
{
  // The first migrate does the linking; everything after it must find nothing
  // left to do, which is asserted under maintenance below.
  const first_run = (await (await authed('/api/migrate', {})).json()) as any;
  check('the migration links existing cards to products', first_run.products.cards_linked > 0, JSON.stringify(first_run.products));
  check('and versions their rules', first_run.products.rule_sets_created > 0, JSON.stringify(first_run.products));
  check('skipping nothing silently', first_run.products.skipped.length === 0, JSON.stringify(first_run.products.skipped));

  const list = (await (await authed('/api/catalog/cards')).json()) as any;
  check('the catalogue lists the products behind the cards', list.products.length > 0, JSON.stringify(list).slice(0, 200));
  const first = list.products[0];
  check('each says who holds it', Array.isArray(first.held_by), JSON.stringify(first.held_by));
  check('and which version is in force', first.current_rule_set !== null, JSON.stringify(first.current_rule_set));
  check('a migrated product is flagged as unverified', list.products.every((p: any) => p.stale === true), JSON.stringify(list.products.map((p: any) => [p.product_key, p.stale])));

  const q = (await (await authed(`/api/catalog/cards?q=${encodeURIComponent(first.issuer)}`)).json()) as any;
  check('it can be searched', q.products.length > 0 && q.products.length <= list.products.length, `${q.products.length}/${list.products.length}`);

  const detail = (await (await authed(`/api/catalog/cards/${encodeURIComponent(first.product_key)}`)).json()) as any;
  check('one product opens to its versions', detail.versions.length >= 1, JSON.stringify(detail.versions?.length));
  check('with the rules inside each', Array.isArray(detail.versions[0].rules), '');
  check('and no day covered twice', detail.overlaps.length === 0, JSON.stringify(detail.overlaps));
  check('an unknown product is a 404', (await authed('/api/catalog/cards/nope')).status === 404, '');
}

// --- maintenance from the app --------------------------------------------------
{
  const res = await authed('/api/migrate', {});
  const body = (await res.json()) as any;
  check('the database can be migrated from the app', res.status === 200, String(res.status));

  // A migration that runs on every deploy has to be idempotent: by now the
  // linking has already happened, and there must be nothing left to do.
  check('a repeat migration finds nothing to link', body.products.cards_linked === 0, JSON.stringify(body.products));

  const again = (await (await authed('/api/migrate', {})).json()) as any;
  check('running it again changes nothing', again.alreadyCurrent === true, JSON.stringify(again).slice(0, 200));
  check('and creates no second product', again.products.products_created === 0, JSON.stringify(again.products));
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall passed');
process.exit(fails ? 1 : 0);
