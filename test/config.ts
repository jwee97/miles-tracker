/**
 * The deployed configuration, checked against the code that reads it.
 *
 * This exists because a setting can be documented in SETUP.md, read by the
 * Worker, and still be absent from wrangler.toml — in which case it works on
 * whatever machine someone typed it into and nowhere else. SEARCH_PROVIDER
 * spent several deploys in exactly that state: added by hand, then gone again
 * on the next push, because the repository never carried it.
 *
 * So every non-secret variable the Env type declares has to appear in
 * wrangler.toml, and every secret has to stay out of it. Those are the two
 * failure directions: config that does not survive a deploy, and a credential
 * that gets committed.
 */
import { readFileSync } from 'node:fs';

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};

const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const types = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');

/** The [vars] block, which is what a deploy actually ships. */
const varsBlock = (() => {
  const start = toml.indexOf('\n[vars]');
  if (start < 0) return '';
  const rest = toml.slice(start + 7);
  const next = rest.search(/\n\[[a-z[]/);
  return next < 0 ? rest : rest.slice(0, next);
})();

const declared = new Set(
  [...varsBlock.matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1])
);

/**
 * Credentials. These must never appear in wrangler.toml, in [vars] or
 * anywhere else in it — they are set with `wrangler secret put`.
 */
const SECRETS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_SECRET',
  'OWNER_CHAT_ID',
  'APP_SECRET',
  'CF_API_TOKEN',
  'SEARCH_API_KEY',
];

/** Settings a person edits in the app rather than at deploy time. */
const RUNTIME_ONLY = ['CF_ACCOUNT_ID', 'CF_SCRIPT_NAME', 'CF_DATABASE_ID'];

// Everything the Worker reads, taken from the Env interface itself so a new
// setting cannot be added to the code and quietly forgotten here.
const envBlock = types.slice(types.indexOf('export interface Env {'), types.indexOf('\n}', types.indexOf('export interface Env {')));
const envKeys = [...envBlock.matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\s*[?:]/gm)].map((m) => m[1]).filter((k) => k !== 'DB');

check('the Env interface was parsed', envKeys.length > 10, String(envKeys.length));
check('and so was the [vars] block', declared.size > 5, String(declared.size));

for (const key of envKeys) {
  if (SECRETS.includes(key) || RUNTIME_ONLY.includes(key)) continue;
  check(`${key} survives a deploy`, declared.has(key), 'read by the Worker but missing from wrangler.toml [vars]');
}

for (const secret of SECRETS) {
  check(`${secret} is not committed`, !new RegExp(`^${secret}\\s*=`, 'm').test(toml), 'a credential must be set with `wrangler secret put`');
}

// Search specifically, since this is the one that kept vanishing.
check('search discovery names its provider in the repository', declared.has('SEARCH_PROVIDER'));
check('with a real value rather than an empty placeholder', /SEARCH_PROVIDER\s*=\s*"\w+"/.test(varsBlock), varsBlock.match(/SEARCH_PROVIDER.*/)?.[0] ?? 'absent');
check('and its daily budget alongside it', declared.has('MAX_SEARCH_QUERIES_PER_DAY'));
check('while the key it needs stays a secret', !/SEARCH_API_KEY\s*=/.test(toml));

// The settings a person can edit must not include anything that is a secret:
// the app would then be able to read a credential back out to a screen.
const settings = readFileSync(new URL('../src/settings.ts', import.meta.url), 'utf8');
for (const secret of SECRETS) {
  check(`${secret} is not editable from the app`, !new RegExp(`key:\\s*'${secret}'`).test(settings));
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
