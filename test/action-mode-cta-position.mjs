#!/usr/bin/env node
/*
 * Action-first mode's primary-CTA reachability regression test (P1 FIND-10,
 * docs/audit-2026-08-29.md).
 *
 * Action-first mode's entire premise is speed: one step, one action. The step
 * headline used to render at font-size:40px/line-height:43.2px — ~302px tall
 * across a long, multi-line step string — and the primary "Do this step"
 * button rendered AFTER the Deadline Watch card and its explainer
 * sub-blocks, landing at top:1048px on an 844px viewport (1.25 screens
 * down). Fixed by (1) capping the headline to the same 28px scale
 * HomeStandard's H1 uses, and (2) moving the primary CTA to render directly
 * under the headline, ahead of the Deadline Watch card.
 *
 * This asserts, on a real rendered page at an 844px-tall viewport, using the
 * wage issue's longest step string (step index 3 — "Optional: send a
 * wage-demand letter — or skip straight to a free WHD complaint or a
 * private lawsuit; no demand letter is required by law"), that "Do this
 * step" lands within the first screen (top < 700px, leaving headroom for
 * the fixed tab bar), not 1+ screens down.
 *
 * Run: node test/action-mode-cta-position.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { resolveChromePath } from './lib/chrome.mjs';
import puppeteer from 'puppeteer-core';
import { gotoApp } from './lib/nav.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.svg':'image/svg+xml' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = normalize(join(ROOT, p));
  if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const chrome = resolveChromePath();

const MAX_TOP = 700; // must land within the first 844px screen, with headroom for the tab bar

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

try {

const pg = await b.newPage();
await pg.setViewport({ width: 390, height: 844 });
const errs = [];
pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

// Mark the wage issue's first two steps done so currentStepIdx lands on its
// longest step string (index 3, the "Optional: send a wage-demand letter..."
// text) — the worst case that produced the original 1048px measurement.
const seed = {
  onboarded: true, stateSel: 'Texas', county: 'Travis County', issue: 'Unpaid overtime or wages',
  profile: { name: 'Pat Vega', employer: 'Northgate Co', payType: 'Hourly', rate: '20' },
  caseOpened: new Date().toISOString(), homeMode: 'action', entries: [], messages: [],
  done: { 'wage-exempt-check': true, 'wage-classification-letter': true, 'wage-log-hours': true },
};
await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
await new Promise(r => setTimeout(r, 700));

const result = await pg.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Do this step');
  const h1 = document.querySelector('h1');
  return {
    doThisTop: btn ? btn.getBoundingClientRect().top : null,
    h1Text: h1 ? h1.textContent : null,
    h1FontSize: h1 ? getComputedStyle(h1).fontSize : null,
  };
});

const problems = [];
if (!result.h1Text || !result.h1Text.includes('Optional: send a wage-demand letter')) {
  problems.push('expected step 4 (the longest wage step) to be current, got h1: ' + JSON.stringify(result.h1Text));
}
if (parseFloat(result.h1FontSize) > 32) {
  problems.push('Action-first H1 font-size is ' + result.h1FontSize + ' — expected it capped near HomeStandard\'s 28px scale');
}
if (result.doThisTop == null) {
  problems.push('"Do this step" button not found');
} else if (result.doThisTop > MAX_TOP) {
  problems.push('"Do this step" top is ' + result.doThisTop.toFixed(0) + 'px on an 844px viewport — expected <= ' + MAX_TOP + 'px (first screen)');
}
errs.forEach(e => problems.push(e));

const ok = problems.length === 0;
if (!ok) fails++;
console.log((ok ? '✅' : '❌') + ' Action-first "Do this step" reachable within the first screen (top=' + (result.doThisTop == null ? 'n/a' : result.doThisTop.toFixed(0) + 'px') + ', h1=' + result.h1FontSize + ')' + (ok ? '' : '\n   ' + problems.join('\n   ')));
await pg.close();

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL ACTION-MODE-CTA-POSITION CASES PASSED');
process.exit(fails ? 1 : 0);
