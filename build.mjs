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
const newHtml = html.slice(0, aStart) + '<script>' + compiled.trim() + '</script>' + html.slice(aEnd + '</script>'.length);
writeFileSync(ROOT + 'index.html', newHtml);

// 5. Write assets/app.js.
writeFileSync(ROOT + 'assets/app.js', minified.trim() + '\n');

console.log('build ok');
console.log('  index.html  app block:', compiled.length, 'chars');
console.log('  assets/app.js        :', minified.length, 'chars');
