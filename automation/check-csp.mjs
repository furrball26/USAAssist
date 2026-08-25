#!/usr/bin/env node
/*
 * CSP guard for the production artifact (index.html, the GitHub Pages / worklaw.app-
 * fallback build). GitHub Pages cannot set HTTP response headers, so a <meta
 * http-equiv="Content-Security-Policy"> is the only delivery mechanism — and because
 * it's just text in index.html, nothing stops it from being silently dropped by a
 * future edit to build.mjs. This script fails the build if that happens, and also
 * fails if the policy has quietly regressed to something weaker than what build.mjs
 * is supposed to emit (stale script-src hashes, 'unsafe-inline'/'unsafe-eval' on
 * scripts, or a cross-origin script/connect source that has no reason to be there in
 * a self-contained, inlined build).
 *
 * Run: node automation/check-csp.mjs
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname;
const html = readFileSync(ROOT + 'index.html', 'utf8');
const problems = [];

const metaTags = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g)];
if (metaTags.length === 0) {
  problems.push('index.html has NO <meta http-equiv="Content-Security-Policy"> tag — production ships with zero CSP');
} else if (metaTags.length > 1) {
  problems.push(`index.html has ${metaTags.length} CSP <meta> tags — expected exactly 1`);
} else {
  const csp = metaTags[0][1];
  const directives = Object.fromEntries(
    csp.split(';').map((s) => s.trim()).filter(Boolean).map((d) => {
      const [name, ...vals] = d.split(/\s+/);
      return [name, vals];
    })
  );

  const need = (name) => {
    if (!directives[name]) problems.push(`CSP is missing the "${name}" directive`);
    return directives[name] || [];
  };

  if (!directives['default-src'] || !directives['default-src'].includes("'none'")) {
    problems.push(`CSP "default-src" must be 'none' (got: ${(directives['default-src'] || []).join(' ') || '(missing)'})`);
  }

  const scriptSrc = need('script-src');
  if (scriptSrc.includes("'unsafe-inline'") || scriptSrc.includes("'unsafe-eval'")) {
    problems.push("CSP script-src must not contain 'unsafe-inline' or 'unsafe-eval' — index.html's inline scripts must be allowlisted by hash instead");
  }
  // Every inline <script>...</script> body in index.html must have a matching
  // 'sha256-...' entry in script-src — catches stale hashes after a hand-edit or a
  // build.mjs regression that stops recomputing them.
  const scriptBodies = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (scriptBodies.length === 0) {
    problems.push('index.html has no inline <script> blocks to hash — unexpected for the self-contained build');
  }
  const scriptHashSet = new Set(scriptSrc.filter((v) => v.startsWith("'sha256-")).map((v) => v.slice(1, -1)));
  for (const [i, body] of scriptBodies.entries()) {
    const hash = 'sha256-' + createHash('sha256').update(body, 'utf8').digest('base64');
    if (!scriptHashSet.has(hash)) {
      problems.push(`inline <script> block #${i + 1} hash (${hash}) is not present in CSP script-src — stale or missing hash`);
    }
  }
  // No CDN origins (unpkg/jsdelivr) belong in the self-contained production build's
  // script-src or connect-src — those are dev-only (index.dev.html) or Vercel-shell-only
  // (vercel/index.html) concerns; their presence here would mean the dev CSP leaked in.
  for (const dir of ['script-src', 'connect-src']) {
    const vals = directives[dir] || [];
    for (const bad of ['unpkg.com', 'cdn.jsdelivr.net']) {
      if (vals.some((v) => v.includes(bad))) {
        problems.push(`CSP "${dir}" references ${bad}, which the self-contained production build never needs (or fetches from)`);
      }
    }
  }

  const objectSrc = need('object-src');
  if (!objectSrc.includes("'none'")) problems.push("CSP \"object-src\" must be 'none'");
  const baseUri = need('base-uri');
  if (!baseUri.includes("'none'")) problems.push("CSP \"base-uri\" must be 'none'");
}

if (problems.length) {
  console.log('❌ CHECK-CSP FAILED');
  problems.forEach((p) => console.log('   ' + p));
  process.exit(1);
}
console.log('✅ CHECK-CSP PASSED — index.html ships a CSP <meta> with correct, fresh script-src hashes');
process.exit(0);
