#!/usr/bin/env node
/*
 * Standard-home "next steps" navigation regression test (F7).
 *
 * Tapping a step on the default (Standard) home must NAVIGATE to the tool that
 * step is about (log/wizard/letter/doc) — not just self-report by toggling a
 * checkbox with no other effect, which let a user mark 100% "done" having done
 * nothing. The checkbox itself must remain as a separate, independent
 * done/undone affordance that does NOT navigate. Run: node test/step-navigation.mjs
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

async function freshPage(seed) {
  const pg = await b.newPage();
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  return pg;
}

const baseSeed = {
  onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
  profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
  caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
};

// Case 1: tapping the main step row (not the checkbox) must navigate away from Home.
{
  const pg = await freshPage(baseSeed);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  const beforeHeading = await pg.evaluate(() => document.querySelector('h1')?.textContent);
  // Click the step's main (navigating) button — identified as the sibling of the
  // checkbox in each step row, i.e. the second button in that row's wrapper div.
  const clicked = await pg.evaluate(() => {
    const heading = [...document.querySelectorAll('h2')].find(h => h.textContent.includes('Your next steps'));
    if (!heading) return false;
    const container = heading.nextElementSibling.nextElementSibling; // skip the helper <p>
    const firstRow = container && container.firstElementChild;
    const stepBtn = firstRow && firstRow.children[1];
    if (stepBtn) { stepBtn.click(); return true; }
    return false;
  });
  await new Promise(r => setTimeout(r, 400));
  const afterHeading = await pg.evaluate(() => document.querySelector('h1')?.textContent);

  const problems = [];
  if (!clicked) problems.push('could not find the step row to click');
  if (clicked && afterHeading === beforeHeading) problems.push('clicking a step did not navigate (still on: ' + JSON.stringify(afterHeading) + ')');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' tapping a step navigates to its tool' + (ok ? ' (now on: ' + JSON.stringify(afterHeading) + ')' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: tapping ONLY the checkbox must NOT navigate — it stays on Home and just
// toggles the done state (the self-report affordance still exists, independently).
{
  const pg = await freshPage(baseSeed);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  const beforeHeading = await pg.evaluate(() => document.querySelector('h1')?.textContent);
  const result = await pg.evaluate(() => {
    const cb = document.querySelector('[role="checkbox"]');
    if (!cb) return null;
    const before = cb.getAttribute('aria-checked');
    cb.click();
    return before;
  });
  await new Promise(r => setTimeout(r, 300));
  const afterHeading = await pg.evaluate(() => document.querySelector('h1')?.textContent);
  const afterChecked = await pg.evaluate(() => document.querySelector('[role="checkbox"]')?.getAttribute('aria-checked'));

  const problems = [];
  if (result == null) problems.push('no step checkbox found');
  if (afterHeading !== beforeHeading) problems.push('clicking the checkbox alone navigated away from Home (should only toggle done)');
  if (result === afterChecked) problems.push('checkbox aria-checked did not toggle');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' tapping only the checkbox toggles done without navigating' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3: Action-first "Mark it done" must not get stuck on an auto-done middle
// step. Regression for the bug where the hero's current-step index was derived
// from Math.min(doneCount, len-1) — doneCount assumes completed steps are a
// contiguous prefix, but stepAutoDone can auto-complete a middle step (the wage
// 'log hours' step auto-dones as soon as any hours entry exists, before the
// earlier exemption-check step is marked done). That inflated doneCount and
// pointed the hero at a step that was already done, so clicking "Mark it done"
// never advanced past it. Seed a wage case in Action-first mode WITH a logged
// hours entry (so the log step auto-dones out of order) and assert repeated
// clicks on "Mark it done" advance the STEP N label all the way to the end.
{
  const seed = Object.assign({}, baseSeed, {
    homeMode: 'action',
    entries: [{ date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'x', color:'#EF7B22', tag:'Wage & hour', hours:8, payStatus:'unpaid' }],
  });
  const pg = await freshPage(seed);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  const readStep = () => pg.evaluate(() => {
    const p = [...document.querySelectorAll('p')].find(el => /^STEP \d+ OF \d+/.test(el.textContent || ''));
    return p ? p.textContent : null;
  });
  const clickMarkDone = () => pg.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Mark it done');
    if (btn) { btn.click(); return true; }
    return false;
  });

  const steps = [];
  let stuck = false;
  const first = await readStep();
  steps.push(first);
  for (let i = 0; i < 6; i++) {
    const clicked = await clickMarkDone();
    if (!clicked) break;
    await new Promise(r => setTimeout(r, 250));
    const now = await readStep();
    steps.push(now);
  }
  // "Stuck" = the label never changes across repeated clicks after the first one.
  const distinct = new Set(steps).size;
  if (distinct < 2) stuck = true;
  const finalStep = steps[steps.length - 1];
  const reachedEnd = /STEP 4 OF 4/.test(finalStep || '');

  const problems = [];
  if (stuck) problems.push('STEP label never advanced across repeated "Mark it done" clicks: ' + JSON.stringify(steps));
  if (!reachedEnd) problems.push('did not reach the last step (STEP 4 OF 4) — ended on ' + JSON.stringify(finalStep) + '; sequence: ' + JSON.stringify(steps));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Action-first "Mark it done" advances past an auto-done middle step (wage log-hours)' + (ok ? ' — sequence: ' + JSON.stringify(steps) : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL STEP-NAVIGATION CASES PASSED');
process.exit(fails ? 1 : 0);
