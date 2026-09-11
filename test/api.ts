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

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall passed');
process.exit(fails ? 1 : 0);
