#!/usr/bin/env node
/*
 * Dark-background focus-ring contrast regression test (R6, docs/review-2-report.md).
 *
 * The browser's default focus ring was only ~1.5:1 against the (now-retired)
 * Action-first home's navy #2B3AA8 background (WCAG 1.4.11 needs >=3:1) —
 * effectively invisible to a keyboard user. A global :focus-visible rule
 * paints a two-tone "halo" (white inner outline + dark outer box-shadow
 * ring) that stays high-contrast regardless of background. Home is a single
 * (always light/cream) Standard layout now; this still runs across the
 * legacy `homeMode` values a saved case might carry, purely as a backward-
 * compat check that the halo mechanism itself is unaffected by that field.
 *
 * Run: node test/focus-visible-contrast.mjs
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

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

try {

async function openHome(homeMode) {
  const pg = await b.newPage();
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode, entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  return pg;
}

for (const mode of ['action', 'plain', 'standard']) {
  const pg = await openHome(mode);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  // Tab forward through the page (via real keyboard events, so :focus-visible
  // actually matches) until we land on a <button>.
  let focusInfo = null;
  for (let i = 0; i < 8 && !focusInfo; i++) {
    await pg.keyboard.press('Tab');
    focusInfo = await pg.evaluate(() => {
      const el = document.activeElement;
      if (!el || el.tagName !== 'BUTTON') return null;
      const cs = getComputedStyle(el);
      return { outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, outlineStyle: cs.outlineStyle, boxShadow: cs.boxShadow, text: el.textContent.slice(0, 30) };
    });
  }

  const problems = [];
  if (!focusInfo) problems.push('never landed keyboard focus on a <button> within 8 Tab presses');
  else {
    if (focusInfo.outlineStyle === 'none' || parseFloat(focusInfo.outlineWidth) < 2) problems.push('focused button has no visible outline: ' + JSON.stringify(focusInfo));
    // The dark #14181F (rgb(20, 24, 31)) outer ring must be present in the box-shadow.
    if (!/rgb\(20,\s*24,\s*31\)/.test(focusInfo.boxShadow)) problems.push('focused button is missing the dark outer halo ring in box-shadow: ' + JSON.stringify(focusInfo.boxShadow));
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' home mode "' + mode + '": keyboard-focused button shows a high-contrast halo ring' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL FOCUS-VISIBLE-CONTRAST CASES PASSED');
process.exit(fails ? 1 : 0);
