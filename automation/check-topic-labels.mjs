#!/usr/bin/env node
/*
 * Every shipping rule has a human name (index.dev.html: TOPIC_LABELS).
 *
 * Topic keys are internal identifiers — `overtime.salaryFloorWeekly`,
 * `minimumWage.tippedCashWage`. The All rights tab printed them straight to
 * readers, which is developer vocabulary shown to someone under stress who may
 * be reading in a second language.
 *
 * A label map alone is not enough: the failure mode is a NEW fact added later
 * whose key nobody remembers to name, which then leaks silently — exactly the
 * kind of quiet gap that has no symptom until a user sees it. So this walks
 * every fact that actually ships (federal, all states, all localities) and
 * fails the build on any key without an explicit label.
 *
 * It also fails on labels that are obviously still machine-shaped, so the map
 * cannot be satisfied by pasting the key in as its own "label".
 *
 * Run: node automation/check-topic-labels.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const dev = readFileSync(join(ROOT, 'index.dev.html'), 'utf8');

const block = dev.match(/const TOPIC_LABELS = \{([\s\S]*?)\n\};/);
if (!block) { console.log('❌ CHECK-TOPIC-LABELS: could not find TOPIC_LABELS in index.dev.html'); process.exit(1); }
const labels = {};
for (const m of block[1].matchAll(/'([^']+)':\s*'((?:[^'\\]|\\.)*)'/g)) labels[m[1]] = m[2];
if (!Object.keys(labels).length) { console.log('❌ CHECK-TOPIC-LABELS: parsed no labels'); process.exit(1); }

/* Collect every topic key that actually ships. */
const keys = new Set();
const eat = (file) => {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  (j.facts || []).forEach(f => keys.add(String(f.topic)));
  (j.localities || []).forEach(loc => (loc.facts || []).forEach(f => keys.add(String(f.topic))));
};
eat(join(ROOT, 'content/_federal.json'));
const states = join(ROOT, 'content/states');
readdirSync(states).filter(f => f.endsWith('.json') && f !== '_TEMPLATE.json').forEach(f => eat(join(states, f)));
const local = join(ROOT, 'content/local');
readdirSync(local).forEach(d => {
  const dir = join(local, d);
  if (!statSync(dir).isDirectory()) return;
  readdirSync(dir).filter(f => f.endsWith('.json')).forEach(f => eat(join(dir, f)));
});

let bad = 0;
const missing = [...keys].filter(k => !labels[k]).sort();
if (missing.length) {
  bad++;
  console.log(`❌ ${missing.length} shipping topic key(s) have no plain-language label:`);
  missing.forEach(k => console.log(`     ${k}`));
  console.log('   Add each to TOPIC_LABELS in index.dev.html. Without one, the raw key');
  console.log('   is what the reader sees in the All rights tab.');
} else {
  console.log(`✅ all ${keys.size} shipping topic keys have a plain-language label`);
}

/* A label that is just the key, or still carries camelCase/dots, is not a
   label — it is the problem wearing the fix's clothes. */
const lazy = Object.entries(labels)
  .filter(([k, v]) => v === k || /[.]/.test(v) || /[a-z][A-Z]/.test(v))
  .map(([k, v]) => `${k} -> "${v}"`);
if (lazy.length) {
  bad++;
  console.log(`❌ ${lazy.length} label(s) are still machine-shaped:`);
  lazy.forEach(l => console.log(`     ${l}`));
} else {
  console.log(`✅ no label is a restated key`);
}

/* Unused labels are not a failure — content shrinks — but say so, because a
   typo in a key looks exactly like an unused label. */
const unused = Object.keys(labels).filter(k => !keys.has(k)).sort();
if (unused.length) {
  console.log(`ℹ️  ${unused.length} label(s) have no fact shipping today (fine, unless one is a typo):`);
  unused.forEach(k => console.log(`     ${k}`));
}

console.log(bad ? '\n❌ CHECK-TOPIC-LABELS FAILED' : '\n✅ CHECK-TOPIC-LABELS PASSED');
process.exit(bad ? 1 : 0);
