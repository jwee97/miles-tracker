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

// --- auth -------------------------------------------------------------------
{
  const res = await worker.fetch(
    new Request('https://x.test/api/tx', { method: 'POST', body: '{}' }),
    env
  );
  check('rejects an unauthenticated post', res.status === 401, String(res.status));
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall passed');
process.exit(fails ? 1 : 0);
