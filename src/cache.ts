import type { Env } from './types';

/**
 * Reference data, read once per operation instead of once per row.
 *
 * A Worker invocation may make fifty subrequests on the free plan and every D1
 * call is one. Importing a statement re-read the same card, the same earn
 * rules, the same exclusions and the same requirements for every line — eight
 * identical queries a row, none of which can change while the import runs.
 *
 * **Caching is off unless a caller turns it on**, and that default is the
 * important part. `env` is not reliably per-request: a cron invocation does
 * hours of work through one, and an endpoint that writes a rule and then
 * prices a purchase against it would read its own stale answer. So the cache
 * does not live on the ambient environment. A caller that knows its operation
 * writes none of these tables wraps it in `withReadCache` and gets a cache for
 * exactly that long; everybody else reads through, as before.
 *
 * The first version of this cached on `env` directly. It was quietly wrong,
 * and the test suite said so immediately — a transaction added after a rule
 * was created earned nothing, because the rules had been read before the rule
 * existed.
 */

type Cache = Map<string, unknown>;
type WithCache = { __readCache?: Cache };

/**
 * An environment that remembers what it has read.
 *
 * Shallow: the same bindings, a fresh cache. Use it around one operation whose
 * reference data cannot change while it runs, and let it go out of scope
 * afterwards.
 */
export function withReadCache(env: Env): Env {
  return { ...env, __readCache: new Map() } as Env;
}

export async function cached<T>(env: Env, key: string, read: () => Promise<T>): Promise<T> {
  const cache = (env as WithCache).__readCache;
  if (!cache) return read();
  if (cache.has(key)) return cache.get(key) as T;
  const value = await read();
  cache.set(key, value);
  return value;
}
