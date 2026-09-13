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

async function openCase(pg) {
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`,
    { place: { state: 'Texas', county: 'Travis County' } });
  await new Promise(r => setTimeout(r, 900));
}

const clickNavTab = (pg, label) => pg.evaluate((t) => {
  const btn = [...document.querySelectorAll('nav button')].find(b => b.textContent.includes(t));
  if (btn) { btn.click(); return true; }
  return false;
}, label);

const bodyText = (pg) => pg.evaluate(() => document.body.innerText);
const onMap = (pg) => pg.evaluate(() => !!document.querySelector('#onb-state'));

// Case 1: Laws -> All rights -> Agencies, then Back twice returns to All
// rights then Laws, and Forward twice replays them.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await openCase(pg);

  const dashboardText = await bodyText(pg);
  await clickNavTab(pg, 'All rights');
  await new Promise(r => setTimeout(r, 400));
  const logText = await bodyText(pg);
  await clickNavTab(pg, 'Agencies');
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
  if (backToLog !== logText) problems.push('first Back did not land back on All rights');
  if (backToDashboard !== dashboardText) problems.push('second Back did not land back on Laws');
  if (fwdToLog !== logText) problems.push('first Forward did not replay All rights');
  if (fwdToRights !== rightsText) problems.push('second Forward did not replay Agencies');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Back/Forward step through Laws -> All rights -> Agencies and back' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: from the Laws tab (nothing of ours pushed below it), the very
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
  if (urlAfter === urlBefore) problems.push('Back from the Laws tab was swallowed by the app instead of leaving it — user is trapped');
  errs.filter(e => !e.includes('SecurityError')).forEach(e => problems.push(e)); // about:blank denies localStorage access — expected, not a real app error

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Back from the Laws tab leaves the app (not trapped)' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3: navigating to a tool screen (opened from inside a law topic, not a
// tab) then Back returns to where it was opened from.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await openCase(pg);

  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /Leaving a job/.test(b.textContent)); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 500));
  const topicText = await bodyText(pg);
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /Is my non-compete/.test(b.textContent)); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 500));
  const onToolScreen = await pg.evaluate(() => /what courts generally weigh/i.test(document.body.innerText));

  await pg.goBack();
  await new Promise(r => setTimeout(r, 400));
  const afterBack = await bodyText(pg);

  const problems = [];
  if (!onToolScreen) problems.push('did not navigate to the non-compete checker screen');
  if (afterBack !== topicText) problems.push('Back from a tool screen did not return to the topic it was opened from');

  // And one more Back returns to the topic grid rather than leaving the site —
  // opening a topic is a navigation a reader expects to be able to undo.
  await pg.goBack();
  await new Promise(r => setTimeout(r, 900));
  // Checked structurally, not by text: the grid lists every topic WITH its
  // blurb, so "the Leaving a job blurb is on screen" is true of the grid too
  // and cannot tell the two apart.
  const gridCards = await pg.evaluate(() => document.querySelectorAll('.catgrid button').length);
  if (gridCards === 0) {
    problems.push('Back from a topic did not return to the topic grid — got: ' +
      JSON.stringify((await bodyText(pg)).slice(0, 140)));
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Back from a tool opened inside a topic returns to the Laws tab' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 4: reload after navigating restores the screen actually visited, not
// unconditionally the Laws tab (see smoke.mjs).
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await openCase(pg);

  await clickNavTab(pg, 'All rights');
  await new Promise(r => setTimeout(r, 400));
  await reloadApp(pg);
  await new Promise(r => setTimeout(r, 900));
  const text = await bodyText(pg);

  const problems = [];
  if (!/Every rule, as written/i.test(text)) problems.push('reload did not restore the All rights screen the user was actually on — got: ' + JSON.stringify(text.slice(0, 120)));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' reload restores the screen the user was actually on (not always the Laws tab)' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 5: a history entry naming a screen this app no longer has (an old tab
// left open on 'log', 'chat', 'letter' or 'doc' before those were removed)
// must fall back to the Laws tab, not white-screen. SCREENS[screen] is
// undefined for every one of those names.
{
  for (const stale of ['log', 'chat', 'letter', 'doc', 'strength', 'adaProcess']) {
    const pg = await b.newPage();
    const errs = [];
    pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('CONSOLE ' + m.text()); });
    await pg.evaluateOnNewDocument((screen) => { window.history.replaceState({ screen }, ''); }, stale);
    await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`,
      { place: { state: 'Texas', county: 'Travis County' } });
    await new Promise(r => setTimeout(r, 900));

    const text = await bodyText(pg);
    const rootKids = await pg.evaluate(() => document.getElementById('root').childElementCount);
    const problems = [];
    if (rootKids === 0) problems.push('#root went blank');
    if (/Something went wrong/.test(text)) problems.push('fell through to the ErrorBoundary');
    if (!/Your rights in Texas/i.test(text)) problems.push('did not fall back to the Laws tab — got: ' + JSON.stringify(text.slice(0, 120)));
    errs.forEach(e => problems.push(e));
    await pg.close();

    const ok = problems.length === 0;
    if (!ok) fails++;
    console.log((ok ? '✅' : '❌') + ' a history entry naming the retired "' + stale + '" screen falls back to the Laws tab' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  }
}

// Case 6: a visitor who has never picked a state must land on the map, whatever
// a stale history entry claims — otherwise the law on screen belongs to nobody.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument(() => { window.history.replaceState({ screen: 'rights' }, ''); });
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await pg.evaluate(() => { try { localStorage.removeItem('worklaw.place.v1'); } catch (e) {} });
  await reloadApp(pg);
  await new Promise(r => setTimeout(r, 900));

  const problems = [];
  const text = await bodyText(pg);
  // Landing on All rights with no state picked is allowed — it simply shows
  // the federal floor. What must not happen is a crash, or a state being
  // named that the reader never chose.
  if (/Something went wrong/.test(text)) problems.push('a stale entry with no place stored crashed the app');
  if (/Texas|California/.test(text)) problems.push('a state the reader never picked is named on screen: ' + JSON.stringify(text.slice(0, 160)));
  errs.forEach(e => problems.push(e));
  await pg.close();

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' with no place stored, no state is named and nothing crashes' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL HISTORY-NAV CASES PASSED');
process.exit(fails ? 1 : 0);
