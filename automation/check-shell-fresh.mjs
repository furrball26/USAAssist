#!/usr/bin/env node
/*
 * Shell-freshness check (R14, docs/review-2-report.md).
 *
 * render-shell.mjs injects index.dev.html's <style> block into the vercel/index.html
 * template at render time (so the deployed shell's CSS can never drift from the app's),
 * and substitutes the template's `{{SHA}}` placeholder with a real commit SHA. Neither
 * of those steps had any test coverage. This script runs render-shell.mjs (against HEAD)
 * and asserts:
 *   1. the rendered output has exactly one <style> block,
 *   2. that block is byte-identical to index.dev.html's <style> body, and
 *   3. no literal "{{SHA}}" placeholder remains — CONTENT_BASE (and the app.js <script>
 *      src) resolve to a real 40-hex-char commit SHA.
 *
 * Run: node automation/check-shell-fresh.mjs
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname;
const problems = [];

const rendered = execFileSync(process.execPath, [ROOT + 'automation/render-shell.mjs'], {
  cwd: ROOT,
  encoding: 'utf8',
});

// 1. exactly one <style> block
const openTags = rendered.match(/<style>/g) || [];
const closeTags = rendered.match(/<\/style>/g) || [];
if (openTags.length !== 1 || closeTags.length !== 1) {
  problems.push(`expected exactly one <style>...</style> block, found ${openTags.length} open / ${closeTags.length} close`);
}

// 2. that block equals index.dev.html's <style> body verbatim
const dev = readFileSync(ROOT + 'index.dev.html', 'utf8');
const devStyleMatch = dev.match(/<style>[\s\S]*?<\/style>/);
if (!devStyleMatch) {
  problems.push('could not find a <style> block in index.dev.html to compare against');
} else {
  const shellStyleMatch = rendered.match(/<style>[\s\S]*?<\/style>/);
  if (!shellStyleMatch) {
    problems.push('rendered shell has no <style>...</style> block at all');
  } else if (shellStyleMatch[0] !== devStyleMatch[0]) {
    problems.push('rendered shell <style> block is NOT byte-identical to index.dev.html\'s <style> block (CSS has drifted)');
  }
}

// 3. no literal {{SHA}} placeholder remains
if (rendered.includes('{{SHA}}')) {
  problems.push('rendered shell still contains the literal "{{SHA}}" placeholder — substitution did not run');
}

// CONTENT_BASE meta + the app.js <script> src must both show a real 40-hex-char commit SHA.
const metaMatch = rendered.match(/<meta name="worklaw-content-base" content="https:\/\/cdn\.jsdelivr\.net\/gh\/furrball26\/USAAssist@([0-9a-f]{40})\/"/i);
if (!metaMatch) {
  problems.push('CONTENT_BASE <meta> does not show a real 40-char commit SHA (got: ' + (rendered.match(/<meta name="worklaw-content-base"[^>]*>/) || ['(not found)'])[0] + ')');
}
const scriptMatch = rendered.match(/<script[^>]*\bsrc="https:\/\/cdn\.jsdelivr\.net\/gh\/furrball26\/USAAssist@([0-9a-f]{40})\/assets\/app\.js"/i);
if (!scriptMatch) {
  problems.push('app.js <script src> does not show a real 40-char commit SHA');
}
if (metaMatch && scriptMatch && metaMatch[1] !== scriptMatch[1]) {
  problems.push(`CONTENT_BASE sha (${metaMatch[1]}) and app.js script sha (${scriptMatch[1]}) disagree`);
}

// 4. The jsDelivr assets/app.js <script> must carry a real `integrity` attribute (SRI),
// and its sha384 digest must match a fresh hash of the *committed* assets/app.js — a
// stale hash (e.g. app.js changed but render-shell wasn't re-run, or someone hand-edited
// the integrity value) would either fail SRI in the browser or, worse, silently pin to
// the wrong bytes. Also assert crossorigin="anonymous" is present (required for SRI to
// actually be enforced on a cross-origin <script>).
const appScriptTagMatch = rendered.match(/<script[^>]*\bsrc="https:\/\/cdn\.jsdelivr\.net\/gh\/furrball26\/USAAssist@[0-9a-f]{40}\/assets\/app\.js"[^>]*><\/script>/i);
if (!appScriptTagMatch) {
  problems.push('could not find the assets/app.js <script src> tag in the rendered shell');
} else {
  const tag = appScriptTagMatch[0];
  const integrityMatch = tag.match(/integrity="(sha384-[^"]+)"/);
  if (!integrityMatch) {
    problems.push('assets/app.js <script> tag has no integrity="sha384-…" attribute (no SRI)');
  } else {
    const appJs = readFileSync(ROOT + 'assets/app.js');
    const freshHash = 'sha384-' + createHash('sha384').update(appJs).digest('base64');
    if (integrityMatch[1] !== freshHash) {
      problems.push(`assets/app.js <script> integrity hash is stale — tag has "${integrityMatch[1]}", a fresh hash of the committed assets/app.js is "${freshHash}"`);
    }
  }
  if (!/crossorigin="anonymous"/.test(tag)) {
    problems.push('assets/app.js <script> tag is missing crossorigin="anonymous" — required for SRI to actually be enforced on a cross-origin script');
  }
}

if (problems.length) {
  console.log('❌ CHECK-SHELL-FRESH FAILED');
  problems.forEach((p) => console.log('   ' + p));
  process.exit(1);
}
console.log('✅ CHECK-SHELL-FRESH PASSED — one <style> block, matches index.dev.html verbatim, no {{SHA}} left');
process.exit(0);
