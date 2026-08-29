#!/usr/bin/env node
/*
 * Owed-estimate correctness regression test (F5, and the Aug 2026 automated-review
 * Critical finding: FLSA overtime is a PER-WORKWEEK threshold — only hours actually
 * worked beyond 40 in a given workweek are overtime, no matter how many other hours
 * are logged in other weeks).
 *
 * The wage-demand letter's owed-amount estimate must:
 *  - group logged hours by workweek (not treat a whole multi-week log as if every
 *    hour fell in one ">40 hrs" week);
 *  - within a week that never reached 40 hours, owe hours paid $0 at 1x (straight
 *    wages) and NEVER apply the 1.5x overtime multiplier to them;
 *  - within a week that never reached 40 hours, owe $0 for hours already paid
 *    straight-time (correctly paid — no overtime threshold crossed, so no 0.5x
 *    premium is owed);
 *  - within a week that DID cross 40 hours, split at the boundary: the first 40
 *    hours are regular (1x if unpaid, $0 if already paid straight-time) and only
 *    the hours past 40 get the overtime treatment (1.5x if unpaid, the 0.5x
 *    differential if already paid straight-time).
 * Run: node test/wage-estimate.mjs
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

// $20/hr, workweek 1 (Jan 5 2026): 45 hrs paid $0 — DID cross the 40-hr threshold,
// so 40 hrs are owed at 1x ($800) and the 5 hrs past 40 are owed at 1.5x ($150).
// Workweek 2 (Jan 12 2026): 6 hrs paid straight-time only — did NOT cross 40, so
// nothing further is owed for them (correctly paid; no overtime threshold crossed).
// Correct total owed = 800 + 150 + 0 = $950. (The pre-fix bug ignored the 40-hr/
// week threshold entirely and would have charged 45*20*1.5 + 6*20*0.5 = $1,410 —
// treating the whole 45-hr week as overtime and wrongly charging an overtime
// premium on the under-40-hr week's already-correctly-paid hours.)
const seed = {
  onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
  profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
  caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[],
  entries: [
    { date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'worked a 45-hour week, paid nothing for it', color:'#EF7B22', tag:'Wage & hour', hours:45, payStatus:'unpaid' },
    { date:'JAN 12, 2026 · 9:00 AM', iso:'2026-01-12T09:00:00.000Z', title:'Unpaid or extra hours', body:'6-hour shift, only paid straight time', color:'#EF7B22', tag:'Wage & hour', hours:6, payStatus:'straight' },
  ],
};

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let ok = false;
try {
const pg = await b.newPage();
const errs = [];
pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

await pg.evaluateOnNewDocument((s) => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), seed);
await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
await new Promise(r => setTimeout(r, 700));

// "Draft a letter" is only shown for non-wage issues now (redundant for wage —
// both letters are reachable via the step list); use the classification step.
await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Ask HR, in writing, for your overtime')); if (btn) btn.click(); });
await new Promise(r => setTimeout(r, 300));
await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /Wage demand/.test(b.textContent)); if (btn) btn.click(); });
await new Promise(r => setTimeout(r, 300));

const letterText = await pg.evaluate(() => {
  const els = [...document.querySelectorAll('div')].filter(d => d.textContent.includes('To whom it may concern'));
  return els.length ? els[els.length - 1].textContent : null;
});

const problems = [];
if (!letterText) {
  problems.push('wage-demand letter body not found');
} else {
  if (!letterText.includes('2 separate workweeks')) problems.push('expected "2 separate workweeks" grouping text, got: ' + JSON.stringify(letterText));
  if (!/5 hours worked beyond 40 hours/.test(letterText)) problems.push('missing the actual-overtime breakdown ("5 hours worked beyond 40 hours...")');
  if (!/40 hours of straight-time work.*that were paid nothing/.test(letterText)) problems.push('missing the under-40-hr regular-wages breakdown ("40 hours of straight-time work...")');
  if (!letterText.includes('$950.00')) problems.push('expected owed estimate $950.00 (40*20*1 + 5*20*1.5; the 6 already-paid, under-40-hr straight-time hours owe nothing), got: ' + JSON.stringify(letterText));
  if (letterText.includes('$1,410.00') || letterText.includes('$1410.00')) problems.push('letter shows the OLD overstated figure ($1,410.00 = 45*20*1.5 + 6*20*0.5, ignoring the per-workweek 40-hr overtime threshold entirely)');
  if (/45 hours worked beyond 40 hours/.test(letterText)) problems.push('letter wrongly claims all 45 hours were overtime, instead of only the 5 hours past the 40-hr/week threshold');
  if (/6 hours (worked beyond 40 hours|at one-half times)/.test(letterText)) problems.push('letter wrongly charges an overtime premium on the 6-hr week that never crossed the 40-hr threshold (already correctly paid straight-time)');
}
errs.forEach(e => problems.push(e));

ok = problems.length === 0;
console.log((ok ? '✅' : '❌') + ' owed-estimate breakdown & workweek grouping' + (ok ? '' : '\n   ' + problems.slice(0, 8).join('\n   ')));
} finally {
  await b.close();
  server.close();
}
console.log(ok ? '\n✅ WAGE-ESTIMATE TEST PASSED' : '\n❌ WAGE-ESTIMATE TEST FAILED');
process.exit(ok ? 0 : 1);
