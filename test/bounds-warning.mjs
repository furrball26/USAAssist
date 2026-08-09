#!/usr/bin/env node
/*
 * Bounds/validation regression test (F6).
 *
 * Absurd but technically "valid" inputs (a huge hourly rate, or a huge number of
 * hours on one log entry) must never silently flow into a sendable wage-demand
 * letter — the app must show a soft warning near the input AND on the Letter
 * screen before the user sends the letter. Not a hard block (real edge cases
 * exist), just never silent. Run: node test/bounds-warning.mjs
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

// Case 1: an absurd rate + hours pair (the exact numbers from the gap report) must
// surface a warning on the Letter screen, not a silent $149,998,350,001.50 figure.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'999999' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[],
    entries: [{ date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'x', color:'#EF7B22', tag:'Wage & hour', hours:99999, payStatus:'unpaid' }],
  };
  await pg.evaluateOnNewDocument((s) => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), seed);
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:'networkidle0', timeout:20000 });
  await new Promise(r => setTimeout(r, 700));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Draft a letter')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /Wage demand/.test(b.textContent)); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));

  // Scope to rendered role="alert" text, not document.body.textContent — the
  // dev page embeds its own JSX source in an inline <script> that is itself a
  // body-text-node and would otherwise match this same phrase unconditionally.
  const alertText = await pg.evaluate(() => [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent).join(' | '));
  const problems = [];
  const hasWarning = /looks unusually high/.test(alertText);
  if (!hasWarning) problems.push('no bounds warning shown on the Letter screen for an absurd rate/hours pair (alerts: ' + JSON.stringify(alertText) + ')');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' absurd rate+hours shows a Letter-screen warning' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: a normal, sane rate/hours pair must NOT show the warning (no false positives).
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'22' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[],
    entries: [{ date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'x', color:'#EF7B22', tag:'Wage & hour', hours:8, payStatus:'unpaid' }],
  };
  await pg.evaluateOnNewDocument((s) => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), seed);
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:'networkidle0', timeout:20000 });
  await new Promise(r => setTimeout(r, 700));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Draft a letter')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /Wage demand/.test(b.textContent)); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));

  const alertText = await pg.evaluate(() => [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent).join(' | '));
  const problems = [];
  if (/looks unusually high/.test(alertText)) problems.push('warning shown for a normal $22/hr, 8-hour case (false positive): ' + JSON.stringify(alertText));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' sane rate+hours shows NO warning (no false positive)' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3: the onboarding rate field itself warns inline for an absurd rate.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  // localStorage persists per-origin across pages in the same browser, so explicitly
  // clear the case saved by an earlier case in this file before starting fresh onboarding.
  await pg.evaluateOnNewDocument(() => localStorage.clear());
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:'networkidle0', timeout:20000 });
  await new Promise(r => setTimeout(r, 500));
  const clickContinue = async () => { await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /Continue|Open my dashboard/.test(b.textContent.trim())); if (btn) btn.click(); }); await new Promise(r => setTimeout(r, 200)); };
  // Step 1: state.
  await pg.evaluate(() => { const sel = document.querySelector('#onb-state'); if (sel) { sel.value = 'Texas'; sel.dispatchEvent(new Event('change', { bubbles:true })); } });
  await new Promise(r => setTimeout(r, 150));
  await clickContinue();
  // Step 2: county.
  await pg.evaluate(() => { const sel = document.querySelector('#onb-county'); if (sel && sel.options.length > 1) { sel.value = sel.options[1].value; sel.dispatchEvent(new Event('change', { bubbles:true })); } });
  await new Promise(r => setTimeout(r, 150));
  await clickContinue();
  // Step 3: issue (radio-role button).
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('[role="radio"]')].find(b => /overtime|wages/i.test(b.textContent)); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 150));
  await clickContinue();
  // Step 4: case details — pick Hourly to reveal the rate field.
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Hourly'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 200));
  const rateInput = await pg.evaluate(() => !!document.querySelector('#onb-rate'));
  const problems = [];
  if (!rateInput) {
    problems.push('could not reach the hourly-rate onboarding field via this walk');
  } else {
    await pg.evaluate(() => { const i = document.querySelector('#onb-rate'); i && i.focus(); });
    await pg.keyboard.type('999999', { delay:2 });
    await new Promise(r => setTimeout(r, 150));
    const warned = await pg.evaluate(() => [...document.querySelectorAll('[role="alert"]')].some(e => e.textContent.includes('unusually high hourly rate')));
    if (!warned) problems.push('no inline warning shown for a $999,999/hr onboarding entry');
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' onboarding rate field warns inline for an absurd rate' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

await b.close(); server.close();
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL BOUNDS-WARNING CASES PASSED');
process.exit(fails ? 1 : 0);
