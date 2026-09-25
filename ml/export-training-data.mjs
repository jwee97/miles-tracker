#!/usr/bin/env node
/**
 * Pull the confirmed-label corpus out of a running deployment.
 *
 * The Worker is the only thing that can read the database, so this is a fetch
 * rather than a query. It writes JSONL because that is what the training
 * script reads and what a person can `grep`.
 *
 *   MILES_URL=https://… MILES_TOKEN=… npm run ml:export-training-data
 *
 * The token is the same app token the PWA holds. It is read from the
 * environment and never written into the output file — the corpus is meant to
 * be shareable with a training process that has no business holding
 * credentials.
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const base = process.env.MILES_URL;
const token = process.env.MILES_TOKEN;

if (!base || !token) {
  console.error('Set MILES_URL (the deployment) and MILES_TOKEN (an app token).');
  process.exit(2);
}

const res = await fetch(`${base.replace(/\/$/, '')}/api/intelligence/training-data`, {
  headers: { Authorization: `Bearer ${token}` },
});

if (!res.ok) {
  console.error(`export failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const { examples, count, exported_at } = await res.json();

mkdirSync('ml/merchant/data', { recursive: true });
const out = 'ml/merchant/data/labels.jsonl';
writeFileSync(out, examples.map((e) => JSON.stringify(e)).join('\n') + (count ? '\n' : ''));

console.log(`${count} confirmed label${count === 1 ? '' : 's'} → ${out} (as of ${exported_at})`);
if (count < 1500) {
  console.log(
    `\nThat is below the 1,500 the readiness gate asks for. Training on this would\n` +
      `produce a classifier whose confidence means nothing. See docs/intelligence-model-decision.md.`
  );
}
