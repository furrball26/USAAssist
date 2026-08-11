#!/usr/bin/env node
/*
 * Onboarding "‹ Back" regression test (F16).
 *
 * Every step past the first in the 4-step onboarding/edit flow must offer a
 * Back control that returns to the previous step WITHOUT losing what was
 * already entered on later steps, and without appearing on step 1. Also
 * covers the ◉ pill EDIT flow, where Back must only move within the staged
 * draft (never touch the live/committed case).
 *
 * Run: node test/onboarding-back.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

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

const clickText = (pg, re) => pg.evaluate((src) => {
  const re = new RegExp(src);
  const btn = [...document.querySelectorAll('button')].find(b => re.test(b.textContent.trim()));
  if (btn) { btn.click(); return true; }
  return false;
}, re.source);

const stepBanner = (pg) => pg.evaluate(() => document.querySelector('h1') ? document.querySelector('h1').textContent : null);

// Case 1: first-run onboarding — Back is absent on step 1, present from step 2
// on, and moving state -> county -> back to state preserves the state pick.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument(() => localStorage.clear());
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:'networkidle0', timeout:20000 });
  await new Promise(r => setTimeout(r, 500));

  const backOnStep1 = await clickText(pg, /^Back$/);

  // Step 1: pick a state, continue to step 2.
  await pg.evaluate(() => { const sel = document.querySelector('#onb-state'); sel.value = 'Texas'; sel.dispatchEvent(new Event('change', { bubbles:true })); });
  await new Promise(r => setTimeout(r, 150));
  await clickText(pg, /^Continue$/);
  await new Promise(r => setTimeout(r, 250));
  const onStep2 = await stepBanner(pg);

  // Back to step 1 — the state select should still show Texas.
  const backClicked = await clickText(pg, /^Back$/);
  await new Promise(r => setTimeout(r, 250));
  const backOnStep1Title = await stepBanner(pg);
  const stateStillSet = await pg.evaluate(() => { const sel = document.querySelector('#onb-state'); return sel ? sel.value : null; });

  const problems = [];
  if (backOnStep1) problems.push('Back button rendered on step 1 (should be absent)');
  if (!onStep2 || !/county|parish|borough/i.test(onStep2)) problems.push('did not land on step 2 after Continue: ' + JSON.stringify(onStep2));
  if (!backClicked) problems.push('no Back button found on step 2');
  if (!backOnStep1Title || /county|parish|borough/i.test(backOnStep1Title)) problems.push('Back did not return to step 1: ' + JSON.stringify(backOnStep1Title));
  if (stateStillSet !== 'Texas') problems.push('Back lost the step-1 state pick — select shows ' + JSON.stringify(stateStillSet));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' first-run onboarding: Back absent on step 1, present after, preserves earlier picks' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: the ◉ pill EDIT flow — Back moves within the staged draft only, and
// never commits anything to the live case (mirrors location-edit.mjs's Cancel
// coverage, but for Back specifically).
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:'networkidle0', timeout:20000 });
  await new Promise(r => setTimeout(r, 700));

  await pg.evaluate(() => { const btn = document.querySelector('button[aria-label^="Edit your state"]'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  await pg.evaluate(() => { const sel = document.querySelector('#onb-state'); sel.value = 'California'; sel.dispatchEvent(new Event('change', { bubbles:true })); });
  await new Promise(r => setTimeout(r, 150));
  await clickText(pg, /^Continue$/);
  await new Promise(r => setTimeout(r, 250));
  const backClicked = await clickText(pg, /^Back$/);
  await new Promise(r => setTimeout(r, 250));
  const stateSelValue = await pg.evaluate(() => { const sel = document.querySelector('#onb-state'); return sel ? sel.value : null; });
  const storedStateSel = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').stateSel);

  const problems = [];
  if (!backClicked) problems.push('no Back button found in the ◉ pill edit flow step 2');
  if (stateSelValue !== 'California') problems.push('Back lost the staged state change — select shows ' + JSON.stringify(stateSelValue));
  if (storedStateSel !== 'Texas') problems.push('Back committed the staged change to the live case — stored stateSel is ' + JSON.stringify(storedStateSel) + ', expected "Texas" (unchanged, since Save was never tapped)');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' ◉ pill edit flow: Back stays within the staged draft, never commits' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

await b.close(); server.close();
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL ONBOARDING-BACK CASES PASSED');
process.exit(fails ? 1 : 0);
