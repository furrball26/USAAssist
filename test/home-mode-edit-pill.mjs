#!/usr/bin/env node
/*
 * Edit-location pill on Home regression test (F17), updated for the
 * Standard/Action-first/Plain mode-switcher removal.
 *
 * The ◉ edit-location/profile pill previously only rendered in HomeStandard
 * — Action-first and Plain modes had no way at all to fix a wrong state or
 * county without first switching back to Standard. Those two alternate
 * layouts (and the ModeSwitch tab control that picked between them) are now
 * gone entirely — Home is always the Standard layout. This test checks the
 * pill still works on the single Home, and that a case saved under one of
 * the retired `homeMode` values ('action'/'plain') still loads fine and
 * shows the single Standard layout with no mode tabs.
 *
 * Run: node test/home-mode-edit-pill.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { resolveChromePath } from './lib/chrome.mjs';
import puppeteer from 'puppeteer-core';
import { gotoApp, reloadApp } from './lib/nav.mjs';

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

async function freshPage(homeMode) {
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

// homeMode is exercised for its saved-case (backward-compat) value only —
// it no longer picks a layout. A case saved under a retired mode value
// ('action'/'plain') must still open onto the single Standard home, with no
// mode tabs and a working ◉ edit-location pill, same as a fresh 'standard' case.
for (const mode of ['standard', 'action', 'plain']) {
  const pg = await freshPage(mode);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  const pillPresent = await pg.evaluate(() => !!document.querySelector('button[aria-label^="Edit your state"]'));
  const modeTabsGone = await pg.evaluate(() => !document.querySelector('[role="group"][aria-label="Dashboard view"]'));
  const clicked = await pg.evaluate(() => { const btn = document.querySelector('button[aria-label^="Edit your state"]'); if (btn) { btn.click(); return true; } return false; });
  await new Promise(r => setTimeout(r, 300));
  const onOnboardingScreen = await pg.evaluate(() => !!document.querySelector('#onb-state'));

  const problems = [];
  if (!pillPresent) problems.push('◉ edit-location pill missing on Home (saved homeMode: "' + mode + '")');
  if (!modeTabsGone) problems.push('Standard/Action-first/Plain mode tabs still render (saved homeMode: "' + mode + '")');
  if (!clicked) problems.push('◉ pill not clickable (saved homeMode: "' + mode + '")');
  if (!onOnboardingScreen) problems.push('tapping ◉ did not open the edit-location flow (saved homeMode: "' + mode + '")');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' saved homeMode "' + mode + '" opens the single Home with a working ◉ edit-location pill and no mode tabs' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL HOME-MODE EDIT-PILL CASES PASSED');
process.exit(fails ? 1 : 0);
