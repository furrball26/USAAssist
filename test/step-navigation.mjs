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

// Case 3: the Standard home's "Do this next" hero must not get stuck on an
// auto-done middle step. Regression for the bug where the hero's current-step
// index was derived from Math.min(doneCount, len-1) — doneCount assumes
// completed steps are a contiguous prefix, but stepAutoDone can auto-complete
// a middle step (the wage 'log hours' step auto-dones as soon as any hours
// entry exists, before the earlier exemption-check step is marked done). That
// inflated doneCount and pointed the hero at a step that was already done, so
// marking steps done never advanced past it. Fixed by deriving currentStepIdx
// from findIndex(!isStepDone) instead (see index.dev.html) — the first
// actually-incomplete step, regardless of which step auto-completed out of
// order.
//
// Seed a wage case WITH a logged hours entry (so the 'log hours' step, index 2
// of 4, auto-dones immediately, before steps 0/1 are marked done) and, using
// the Standard home's own self-report checkbox (proven independent/
// non-navigating in Case 2 above) to mark steps done in order, assert the "Do
// this next" hero's headline (a) starts on step 0 (not the auto-done step 2),
// (b) after step 0 and step 1 are checked off, SKIPS the already-auto-done
// step 2 and lands on step 3 — never getting stuck repeating step 2 — and (c)
// after step 3 is also checked off, still shows a valid last step with no
// error, having advanced through all 4 steps.
{
  const seed = Object.assign({}, baseSeed, {
    entries: [{ date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'x', color:'#EF7B22', tag:'Wage & hour', hours:8, payStatus:'unpaid' }],
  });
  const pg = await freshPage(seed);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  // The wage issue's 4 step strings, in order (index.dev.html ISSUES['Unpaid
  // overtime or wages'].steps) — index 2 ("Log every unpaid...") auto-dones
  // from the seeded hours entry above, before either earlier step is checked.
  const STEP_TEXT = [
    'Run the overtime-exemption self-check to see whether you should be getting overtime pay',
    'Ask HR, in writing, for your overtime (FLSA) classification and its basis',
    'Log every unpaid or off-the-clock hour you can remember — it is evidence',
    'Optional: send a wage-demand letter — or skip straight to a free WHD complaint or a private lawsuit; no demand letter is required by law',
  ];

  const readHero = () => pg.evaluate(() => {
    const label = [...document.querySelectorAll('span')].find(s => s.textContent.trim() === 'DO THIS NEXT');
    if (!label) return null;
    const heroDiv = label.parentElement && label.parentElement.querySelector(':scope > div');
    return heroDiv ? heroDiv.textContent.trim() : null;
  });
  // Clicks step `idx`'s checkbox (the self-report, non-navigating affordance
  // proven in Case 2) — identified the same way Case 1/2 locate step rows.
  const checkStep = (idx) => pg.evaluate((i) => {
    const heading = [...document.querySelectorAll('h2')].find(h => h.textContent.includes('Your next steps'));
    if (!heading) return false;
    const container = heading.nextElementSibling.nextElementSibling; // skip the helper <p>
    const row = container && container.children[i];
    const cb = row && row.children[0];
    if (cb) { cb.click(); return true; }
    return false;
  }, idx);

  const heroSequence = [];
  heroSequence.push(await readHero());
  await checkStep(0);
  await new Promise(r => setTimeout(r, 250));
  heroSequence.push(await readHero());
  await checkStep(1);
  await new Promise(r => setTimeout(r, 250));
  heroSequence.push(await readHero());
  await checkStep(3);
  await new Promise(r => setTimeout(r, 250));
  heroSequence.push(await readHero());

  const problems = [];
  if (heroSequence[0] !== STEP_TEXT[0]) problems.push('expected the hero to start on step 0, got: ' + JSON.stringify(heroSequence[0]));
  if (heroSequence[1] !== STEP_TEXT[1]) problems.push('after checking step 0, expected the hero to advance to step 1, got: ' + JSON.stringify(heroSequence[1]));
  if (heroSequence[2] !== STEP_TEXT[3]) problems.push('after checking steps 0 and 1, expected the hero to SKIP the auto-done step 2 (log hours) and land on step 3, but it got stuck / showed: ' + JSON.stringify(heroSequence[2]));
  if (heroSequence[3] !== STEP_TEXT[3]) problems.push('after checking every step, expected the hero to still show a valid final step, got: ' + JSON.stringify(heroSequence[3]));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Standard home\'s "Do this next" hero advances past an auto-done middle step (wage log-hours)' + (ok ? ' — sequence: ' + JSON.stringify(heroSequence) : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL STEP-NAVIGATION CASES PASSED');
process.exit(fails ? 1 : 0);
