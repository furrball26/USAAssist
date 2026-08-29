#!/usr/bin/env node
/*
 * Regular/overtime pay breakdown regression test.
 *
 * The Log screen must automatically show REGULAR and OVERTIME pay computed
 * from logged hours and the user's hourly rate, grouped by workweek — using
 * the SAME per-workweek 40-hour threshold (29 U.S.C. § 207) as the existing
 * owed-amount estimate (computeOwedBreakdown), so the two stay consistent:
 * only hours actually over 40 in a given workweek are ever priced as
 * overtime. When no rate is on file, hours must still show but no dollar
 * figure may be fabricated.
 * Run: node test/log-pay-breakdown.mjs
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

async function openLog(seed) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Log an incident')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  return { pg, errs };
}

try {

// Case 1: $20/hr, week 1 = 45 hrs (crosses 40 -> 40 reg + 5 OT), week 2 = 6 hrs
// (never crosses 40 -> all regular, regardless of payStatus — this is GROSS pay
// for the hours, not the "owed" shortfall computeOwedBreakdown reports).
{
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[],
    entries: [
      { date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'x', color:'#EF7B22', tag:'Wage & hour', hours:45, payStatus:'unpaid' },
      { date:'JAN 12, 2026 · 9:00 AM', iso:'2026-01-12T09:00:00.000Z', title:'Unpaid or extra hours', body:'x', color:'#EF7B22', tag:'Wage & hour', hours:6, payStatus:'straight' },
    ],
  };
  const { pg, errs } = await openLog(seed);
  const text = await pg.evaluate(() => document.body.textContent);
  const problems = [];
  if (!/Regular & overtime pay, by workweek/.test(text)) problems.push('pay-breakdown card not shown');
  if (!/Regular: 40 hrs = \$800\.00/.test(text)) problems.push('week 1 regular pay (40 hrs * $20 = $800.00) missing/wrong: ' + text.slice(0, 500));
  if (!/Overtime \(1\.5×\): 5 hrs = \$150\.00/.test(text)) problems.push('week 1 overtime pay (5 hrs * $20 * 1.5 = $150.00) missing/wrong');
  if (!/Regular: 6 hrs = \$120\.00/.test(text)) problems.push('week 2 regular pay (6 hrs * $20 = $120.00) missing/wrong — must NOT be treated as overtime just because it was logged');
  if (/Overtime \(1\.5×\): 6 hrs/.test(text)) problems.push('week 2 wrongly priced as overtime despite never crossing the 40-hr/week threshold');
  if (!text.includes('$920.00 regular + $150.00 overtime = $1,070.00')) problems.push('total line wrong/missing, expected "$920.00 regular + $150.00 overtime = $1,070.00"');
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' regular/overtime pay is split per-workweek at the 40-hr threshold' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: no rate on file — hours must still show, but no dollar figure may be
// fabricated (honest-degrade, matching the owed-estimate's existing behavior).
{
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[],
    entries: [
      { date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'x', color:'#EF7B22', tag:'Wage & hour', hours:12, payStatus:'unpaid' },
    ],
  };
  const { pg, errs } = await openLog(seed);
  const text = await pg.evaluate(() => document.body.textContent);
  const problems = [];
  if (!/Add your hourly rate in your profile to see dollar amounts/.test(text)) problems.push('missing the honest no-rate message');
  if (/\$0\.00/.test(text)) problems.push('a fabricated $0.00 figure was shown instead of the honest no-rate message');
  if (!/Regular: 12 hrs(?! =)/.test(text)) problems.push('hours-only regular line missing/wrong when no rate is set');
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' no rate on file shows hours only, never a fabricated dollar figure' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3: a salaried worker gets the hourly-equivalent-derived pay breakdown too.
{
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Salary', salary:'41600', rate:'' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[],
    entries: [
      { date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'x', color:'#EF7B22', tag:'Wage & hour', hours:10, payStatus:'unpaid' },
    ],
  };
  const { pg, errs } = await openLog(seed);
  const text = await pg.evaluate(() => document.body.textContent);
  const problems = [];
  // 41600/52/40 = $20.00/hr equivalent; 10 hrs, under 40, all regular = $200.00.
  if (!/Regular: 10 hrs = \$200\.00/.test(text)) problems.push('salaried hourly-equivalent regular pay ($20.00/hr * 10 hrs = $200.00) missing/wrong: ' + text.slice(0, 500));
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' salaried worker gets a pay breakdown from the hourly-equivalent rate' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL LOG-PAY-BREAKDOWN CASES PASSED');
process.exit(fails ? 1 : 0);
