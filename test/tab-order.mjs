#!/usr/bin/env node
/*
 * Desktop rail keyboard tab-order regression test (R3, docs/review-2-report.md).
 *
 * At >=1024px the left icon rail (<nav className="tabbar">) is visually FIRST
 * (grid-area places it in the leftmost column), but the JSX used to render
 * <main> before <nav> — grid-area placement doesn't depend on DOM order, but
 * keyboard tab order does, so a keyboard user had to tab through the entire
 * dashboard before ever reaching the nav (WCAG 2.4.3 violation). <nav> now
 * comes before <main> in the JSX; a `order:2` rule keeps the nav painted
 * LAST at the phone/tablet tiers, where it's a flex column bottom bar, so
 * this test also checks the narrower tiers are visually unaffected.
 *
 * Run: node test/tab-order.mjs
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

async function openHome(pg, width) {
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await pg.setViewport({ width, height:900, deviceScaleFactor:1 });
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
}

// Case 1: DOM order — <nav class="tabbar"> must precede <main class="scrollarea">
// in the document, regardless of viewport (grid-area placement at >=1024px
// doesn't depend on DOM order, so this should hold at every tier).
for (const width of [390, 900, 1280]) {
  const pg = await b.newPage();
  await openHome(pg, width);
  const navBeforeMain = await pg.evaluate(() => {
    const nav = document.querySelector('nav.tabbar');
    const main = document.querySelector('main.scrollarea');
    if (!nav || !main) return null;
    // Node.DOCUMENT_POSITION_FOLLOWING (4) set on `main` relative to `nav`
    // means nav precedes main.
    return !!(nav.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  const ok = navBeforeMain === true;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' ' + width + 'px: <nav class="tabbar"> precedes <main> in the DOM' + (ok ? '' : ' (got ' + navBeforeMain + ')'));
  await pg.close();
}

// Case 2: keyboard focus order at the desktop tier — the FIRST Tab press
// from the top of the page must land inside the rail nav, not inside <main>.
{
  const pg = await b.newPage();
  await openHome(pg, 1280);
  await pg.evaluate(() => document.body.focus());
  await pg.keyboard.press('Tab');
  const inNav = await pg.evaluate(() => !!(document.activeElement && document.activeElement.closest('nav.tabbar')));
  const ok = inNav === true;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' 1280px: first Tab from page top focuses the rail nav (matches its visual-first position)' + (ok ? '' : ' — landed on ' + await pg.evaluate(() => document.activeElement && document.activeElement.outerHTML.slice(0, 80))));
  await pg.close();
}

// Case 3: at the phone tier the tab bar must still be visually LAST (bottom
// bar) even though it is now first in the DOM — order:2 on .tabbar.
{
  const pg = await b.newPage();
  await openHome(pg, 390);
  const order = await pg.evaluate(() => {
    const rect = (sel) => document.querySelector(sel).getBoundingClientRect().top;
    return { statusbar: rect('.statusbar'), main: rect('main.scrollarea'), nav: rect('nav.tabbar') };
  });
  const problems = [];
  if (!(order.statusbar <= order.main && order.main <= order.nav)) {
    problems.push('expected visual top-to-bottom order statusbar -> main -> nav, got ' + JSON.stringify(order));
  }
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' 390px: tab bar still renders visually LAST (bottom bar) despite DOM order change' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL TAB-ORDER CASES PASSED');
process.exit(fails ? 1 : 0);
