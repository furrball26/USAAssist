#!/usr/bin/env node
/*
 * Browser Back/Forward history regression test (F-history).
 *
 * In-app screen navigation is wired to the History API: navigating pushes a
 * history entry, and the browser Back/Forward buttons step through in-app
 * screens (e.g. a tool screen -> Dashboard) instead of leaving the app on
 * the very first press. From the Dashboard/onboarding entry itself — which
 * only ever gets replaceState'd, never pushed on top of — the *next* Back
 * leaves the app normally (no trap). A reload also now restores whatever
 * screen the user was actually on (browsers keep pushState/replaceState
 * `state` across F5), not unconditionally the dashboard — guarded so a
 * stale history entry can never skip the onboarding gate for a since-cleared
 * case.
 *
 * Run: node test/history-nav.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { execSync } from 'node:child_process';
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
const chrome = execSync(`find "${ROOT}chrome-headless-shell" -type f -name 'chrome-headless-shell' | head -1`).toString().trim();

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

try {

async function openCase(pg) {
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Salary', rate:'50000' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
}

const clickNavTab = (pg, label) => pg.evaluate((t) => {
  const btn = [...document.querySelectorAll('nav button')].find(b => b.textContent.includes(t));
  if (btn) { btn.click(); return true; }
  return false;
}, label);

const bodyText = (pg) => pg.evaluate(() => document.body.innerText);
const onOnboarding = (pg) => pg.evaluate(() => !!document.querySelector('#onb-state'));

// Case 1: Dashboard -> Log -> Rights, then Back twice returns to Log then
// Dashboard, and Forward twice replays Log then Rights.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await openCase(pg);

  const dashboardText = await bodyText(pg);
  await clickNavTab(pg, 'Log');
  await new Promise(r => setTimeout(r, 300));
  const logText = await bodyText(pg);
  await clickNavTab(pg, 'Rights');
  await new Promise(r => setTimeout(r, 300));
  const rightsText = await bodyText(pg);

  await pg.goBack();
  await new Promise(r => setTimeout(r, 300));
  const backToLog = await bodyText(pg);

  await pg.goBack();
  await new Promise(r => setTimeout(r, 300));
  const backToDashboard = await bodyText(pg);

  await pg.goForward();
  await new Promise(r => setTimeout(r, 300));
  const fwdToLog = await bodyText(pg);

  await pg.goForward();
  await new Promise(r => setTimeout(r, 300));
  const fwdToRights = await bodyText(pg);

  const problems = [];
  if (backToLog !== logText) problems.push('first Back did not land back on Log');
  if (backToDashboard !== dashboardText) problems.push('second Back did not land back on the Dashboard');
  if (fwdToLog !== logText) problems.push('first Forward did not replay Log');
  if (fwdToRights !== rightsText) problems.push('second Forward did not replay Rights');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Back/Forward step through Dashboard -> Log -> Rights and back' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: from the Dashboard (nothing of ours pushed below it), the very
// next Back leaves the app entirely — no trap.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await openCase(pg);

  const urlBefore = pg.url();
  await pg.goBack();
  await new Promise(r => setTimeout(r, 400));
  const urlAfter = pg.url();

  const problems = [];
  if (urlAfter === urlBefore) problems.push('Back from the Dashboard was swallowed by the app instead of leaving it — user is trapped');
  errs.filter(e => !e.includes('SecurityError')).forEach(e => problems.push(e)); // about:blank denies localStorage access — expected, not a real app error

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Back from the Dashboard leaves the app (not trapped)' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3: navigating to a tool screen (via the Tools grid, not just tabs)
// then Back returns to the Dashboard — the exact "Letter -> Dashboard" case
// called out in spec.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await openCase(pg);

  const dashboardText = await bodyText(pg);
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /Review a document/.test(b.textContent)); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  const onDocScreen = await pg.evaluate(() => /Review a document/i.test(document.body.innerText));

  await pg.goBack();
  await new Promise(r => setTimeout(r, 300));
  const afterBack = await bodyText(pg);

  const problems = [];
  if (!onDocScreen) problems.push('did not navigate to the "Review a document" tool screen');
  if (afterBack !== dashboardText) problems.push('Back from a tool screen did not return to the Dashboard');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Back from a Tools-grid screen returns to the Dashboard' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 4: reload after navigating restores the screen actually visited, not
// unconditionally the Dashboard (the new intended behavior — see smoke.mjs).
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await openCase(pg);

  await clickNavTab(pg, 'Log');
  await new Promise(r => setTimeout(r, 300));
  await reloadApp(pg);
  await new Promise(r => setTimeout(r, 500));
  const text = await bodyText(pg);

  const problems = [];
  if (!/Incident log/i.test(text)) problems.push('reload did not restore the Log screen the user was actually on — got: ' + JSON.stringify(text.slice(0, 80)));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' reload restores the screen the user was actually on (not always the Dashboard)' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 5: a stale history entry pointing at a tool screen must never skip
// the onboarding gate once the underlying case is gone (e.g. "Delete my
// case & start over", or simply a fresh/never-onboarded visit).
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await openCase(pg);
  await clickNavTab(pg, 'Log'); // stamps this session-history entry's state with {screen:'log'}
  await new Promise(r => setTimeout(r, 300));

  // Clear the case (simulating "Delete my case & start over" / a fresh
  // browser profile) then reload — the history entry's `state` (still
  // {screen:'log'} from the click above) survives the reload even though
  // localStorage no longer has a case behind it. Registering a second
  // evaluateOnNewDocument here (it runs AFTER openCase()'s seed script, in
  // registration order, on every subsequent navigation including reload) is
  // what actually keeps the case cleared across the reload — a plain
  // `pg.evaluate(() => localStorage.clear())` gets silently undone by the
  // still-registered seed script re-seeding on the reload's fresh document.
  await pg.evaluateOnNewDocument(() => localStorage.clear());
  await reloadApp(pg);
  await new Promise(r => setTimeout(r, 500));

  const isOnboarding = await onOnboarding(pg);
  const problems = [];
  if (!isOnboarding) problems.push('a stale "log" history entry skipped onboarding for a case that no longer exists');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' a stale history entry never skips onboarding for a cleared case' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL HISTORY-NAV CASES PASSED');
process.exit(fails ? 1 : 0);
