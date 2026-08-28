#!/usr/bin/env node
/*
 * CSP sync check: `index.dev.html`'s <meta http-equiv="Content-Security-Policy"> and
 * `vercel.json`'s Content-Security-Policy response header are two independently hand-
 * maintained copies of "the same policy" for two different shells (GitHub Pages dev shell
 * vs the worklaw.app Vercel shell) — nothing mechanically keeps them in sync, so one can
 * drift from the other without either build failing. (This is distinct from
 * automation/check-csp.mjs, which validates the *generated* production index.html's CSP
 * against build.mjs's own output — this script instead cross-checks the two
 * independently-authored source files.)
 *
 * Parses both into directive -> Set<origin/keyword> maps and asserts they match, modulo
 * two structural, documented exceptions (both called out in the comment directly above the
 * CSP <meta> tag in index.dev.html):
 *   1. script-src: index.dev.html additionally allows 'unsafe-inline' and 'unsafe-eval',
 *      required only because it transpiles + runs the app in-browser via Babel standalone;
 *      the compiled Vercel shell doesn't need either.
 *   2. frame-ancestors: cannot be set via a <meta> tag at all (browsers ignore it there),
 *      so it only exists in vercel.json, at the HTTP-header level.
 * Any other directive missing, extra, or with a mismatched origin list on either side is a
 * hard failure — that's real drift, not a documented design choice.
 *
 * Run: node automation/check-csp-sync.mjs
 */
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;

function parseCsp(csp) {
  const map = {};
  csp.split(';').map((s) => s.trim()).filter(Boolean).forEach((d) => {
    const [name, ...vals] = d.split(/\s+/);
    map[name] = new Set(vals);
  });
  return map;
}

function fmt(set) {
  return set && set.size ? [...set].sort().join(' ') : '(missing)';
}

function main() {
  const problems = [];

  let devHtml;
  try {
    devHtml = readFileSync(ROOT + 'index.dev.html', 'utf8');
  } catch (e) {
    console.log(`❌ check-csp-sync: could not read index.dev.html (${e.message})`);
    process.exit(1);
  }
  const devMatch = devHtml.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
  if (!devMatch) {
    console.log('❌ check-csp-sync: index.dev.html has no CSP <meta> tag to compare');
    process.exit(1);
  }
  const dev = parseCsp(devMatch[1]);

  let vercelJson;
  try {
    vercelJson = JSON.parse(readFileSync(ROOT + 'vercel.json', 'utf8'));
  } catch (e) {
    console.log(`❌ check-csp-sync: could not read/parse vercel.json (${e.message})`);
    process.exit(1);
  }
  const headerBlock = (vercelJson.headers || []).flatMap((h) => h.headers || []);
  const cspHeader = headerBlock.find((h) => h.key === 'Content-Security-Policy');
  if (!cspHeader) {
    console.log('❌ check-csp-sync: vercel.json has no Content-Security-Policy header to compare');
    process.exit(1);
  }
  const vercel = parseCsp(cspHeader.value);

  // Documented structural exceptions, applied before comparison.
  // 1. script-src: dev-only Babel-in-browser needs 'unsafe-inline'/'unsafe-eval'.
  const devScriptSrc = new Set(dev['script-src'] || []);
  devScriptSrc.delete("'unsafe-inline'");
  devScriptSrc.delete("'unsafe-eval'");
  // 2. frame-ancestors: structurally can't exist in a <meta> CSP; only vercel.json has it.
  const directivesToCompare = new Set([...Object.keys(dev), ...Object.keys(vercel)]);
  directivesToCompare.delete('frame-ancestors');

  for (const directive of [...directivesToCompare].sort()) {
    const devVals = directive === 'script-src' ? devScriptSrc : (dev[directive] || new Set());
    const vercelVals = vercel[directive] || new Set();
    const missingFromVercel = [...devVals].filter((v) => !vercelVals.has(v));
    const missingFromDev = [...vercelVals].filter((v) => !devVals.has(v));
    if (missingFromVercel.length || missingFromDev.length) {
      problems.push(
        `"${directive}" mismatch — index.dev.html: ${fmt(devVals)} | vercel.json: ${fmt(vercelVals)}` +
        (missingFromVercel.length ? ` (vercel.json missing: ${missingFromVercel.join(' ')})` : '') +
        (missingFromDev.length ? ` (index.dev.html missing: ${missingFromDev.join(' ')})` : '')
      );
    }
  }

  // Sanity: vercel.json's script-src must NOT carry 'unsafe-inline'/'unsafe-eval' — if it
  // does, the documented exception has leaked into the shell that doesn't need it.
  const vercelScriptSrc = vercel['script-src'] || new Set();
  if (vercelScriptSrc.has("'unsafe-inline'") || vercelScriptSrc.has("'unsafe-eval'")) {
    problems.push("vercel.json script-src carries 'unsafe-inline'/'unsafe-eval' — the compiled Vercel shell does not run in-browser Babel and should not need these");
  }
  // Sanity: vercel.json must have frame-ancestors — it's the only place it CAN be set.
  if (!(vercel['frame-ancestors'] || new Set()).size) {
    problems.push('vercel.json is missing "frame-ancestors" — this is the only layer that can set it (a <meta> CSP cannot), so its absence here means clickjacking protection is not actually enforced anywhere');
  }

  if (problems.length) {
    console.log('❌ CHECK-CSP-SYNC FAILED — index.dev.html <meta> CSP and vercel.json header CSP have drifted:');
    problems.forEach((p) => console.log('   ' + p));
    console.log('\n   (Expected differences: script-src unsafe-inline/unsafe-eval in index.dev.html only; frame-ancestors in vercel.json only — both documented in the comment above the CSP <meta> in index.dev.html.)');
    process.exit(1);
  }
  console.log('✅ CHECK-CSP-SYNC PASSED — index.dev.html and vercel.json CSPs match (modulo the documented script-src/frame-ancestors exceptions)');
  process.exit(0);
}

main();
