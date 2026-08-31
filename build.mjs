#!/usr/bin/env node
/*
 * WorkLaw build: index.dev.html (JSX source of truth) -> index.html + assets/app.js
 *
 * index.html and assets/app.js are generated artifacts. Only edit index.dev.html.
 * React/ReactDOM UMD and the fonts are already inlined in index.html; this script
 * only regenerates the APP CODE block (JSX transpiled to React.createElement) and
 * splices it in, then minifies the same code to assets/app.js for the Vercel shell.
 *
 * Run:  node build.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { transformSync } from 'esbuild';

const ROOT = new URL('.', import.meta.url).pathname;
const read = (p) => readFileSync(ROOT + p, 'utf8');

// 1. Extract the JSX app block from the dev file.
const dev = read('index.dev.html');
const OPEN = '<script type="text/babel" data-presets="react">';
const start = dev.indexOf(OPEN);
if (start < 0) throw new Error('dev: babel <script> open tag not found');
const bodyStart = start + OPEN.length;
const end = dev.indexOf('</script>', bodyStart);
if (end < 0) throw new Error('dev: babel </script> close tag not found');
const jsx = dev.slice(bodyStart, end);

// 2. Transpile JSX -> plain JS (classic runtime; React/ReactDOM are globals).
// No `format` wrapper: keep output as top-level statements starting with
// `const { useState ... }` so the `<script>const {` splice marker below stays
// stable and the build is idempotent (re-runnable) against index.html.
const compiled = transformSync(jsx, {
  loader: 'jsx',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  legalComments: 'none',
}).code;

// 3. Minify the same code for assets/app.js.
const minified = transformSync(jsx, {
  loader: 'jsx',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  minify: true,
  legalComments: 'none',
}).code;

// 4. Sync the shared app <style> block (device/screen/tabbar/media queries,
// etc.) into index.html, then splice the compiled JS block in (replace the
// existing app <script>).
let html = read('index.html');

// 4a. The <style> block. index.html's FIRST <style> tag is a production-only
// self-hosted @font-face block (base64 fonts; no analog in index.dev.html,
// which links Google Fonts for dev instead). Its SECOND <style> tag mirrors
// index.dev.html's one-and-only <style> block verbatim — keep it in sync so
// CSS-only changes (new classes, new @media breakpoints) actually ship in
// the production artifact, not just the dev page.
const devStyleOpen = dev.indexOf('<style>');
const devStyleClose = dev.indexOf('</style>', devStyleOpen);
if (devStyleOpen < 0 || devStyleClose < 0) throw new Error('dev: <style> block not found');
const devStyleBody = dev.slice(devStyleOpen + '<style>'.length, devStyleClose);

const firstStyleClose = html.indexOf('</style>');
const secondStyleOpen = html.indexOf('<style>', firstStyleClose);
const secondStyleClose = html.indexOf('</style>', secondStyleOpen);
if (firstStyleClose < 0 || secondStyleOpen < 0 || secondStyleClose < 0) {
  throw new Error('index.html: expected two <style> blocks (fonts, then app CSS)');
}
html = html.slice(0, secondStyleOpen + '<style>'.length) + devStyleBody + html.slice(secondStyleClose);

// 4b. The app JS block.
const APP_OPEN = '<script>const {';
const aStart = html.indexOf(APP_OPEN);
if (aStart < 0) throw new Error('index.html: app <script>const { block not found');
const renderIdx = html.indexOf('ReactDOM.createRoot', aStart);
const aEnd = html.indexOf('</script>', renderIdx);
if (renderIdx < 0 || aEnd < 0) throw new Error('index.html: app block close not found');
let newHtml = html.slice(0, aStart) + '<script>' + compiled.trim() + '</script>' + html.slice(aEnd + '</script>'.length);

// 4c. Content-Security-Policy <meta>. index.html is fully self-contained (React,
// ReactDOM, and the app code are all inlined as <script>...</script> blocks with no
// `src`, fonts are base64 `data:` URIs, and the app needs zero same-origin script
// files) — so script-src is hash-allowlisted to exactly those three inline blocks
// rather than weakened with 'unsafe-inline'. Recomputed fresh on every build so a
// changed inline script always gets a matching, correct hash (never a stale one).
// Strip any previously-injected CSP meta first so re-running build.mjs stays idempotent.
// Precondition: index.html (a generated artifact) must carry at most one CSP meta
// going in. More than one is not a state build.mjs should ever "fix" for you — it
// means the artifact wasn't in the shape this splice-over-existing-file approach
// assumes, most likely a hand/merge-resolved conflict in index.html itself that kept
// both sides (index.html must never be hand-edited or hand-merged; see CONTRIBUTING.md
// — resolve index.dev.html instead and rebuild). Silently normalising down to one
// would hide that the artifact is untrustworthy and may carry other unresolved
// conflict damage beyond just this tag. Fail loudly instead. (The /g flag below is
// belt-and-suspenders for the single-meta case this check allows through.)
const existingCspMetas = newHtml.match(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/g) || [];
if (existingCspMetas.length > 1) {
  throw new Error(
    `index.html: found ${existingCspMetas.length} CSP <meta> tags before build — expected 0 or 1. ` +
    'This generated artifact is not in the shape build.mjs expects (likely a merge conflict ' +
    'resolved by keeping both sides in index.html directly). Do not hand-fix index.html: ' +
    'discard it, resolve the conflict in index.dev.html instead, then run `node build.mjs` again.'
  );
}
newHtml = newHtml.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n/g, '');

const scriptHashes = [...newHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
  (m) => 'sha256-' + createHash('sha256').update(m[1], 'utf8').digest('base64')
);
if (scriptHashes.length !== 3) {
  throw new Error(`index.html: expected exactly 3 inline <script> blocks (react, react-dom, app), found ${scriptHashes.length}`);
}
const csp = [
  "default-src 'none'",
  `script-src 'self' ${scriptHashes.map((h) => `'${h}'`).join(' ')}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  // CONTENT_BASE is same-origin ('' on GitHub Pages/local; index.html never sets
  // window.CONTENT_BASE or a worklaw-content-base <meta>) — only the hardcoded
  // SHA-pinned CONTENT_FALLBACK_BASE (raw.githubusercontent.com) is ever cross-origin.
  "connect-src 'self' https://raw.githubusercontent.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ') + ';';
const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}">\n`;
newHtml = newHtml.replace('<meta charset="utf-8">\n', (m) => m + cspMeta);
if (!newHtml.includes(cspMeta)) throw new Error('index.html: could not inject CSP <meta> after <meta charset="utf-8">');

writeFileSync(ROOT + 'index.html', newHtml);

// 5. Write assets/app.js.
writeFileSync(ROOT + 'assets/app.js', minified.trim() + '\n');

console.log('build ok');
console.log('  index.html  app block:', compiled.length, 'chars');
console.log('  assets/app.js        :', minified.length, 'chars');
