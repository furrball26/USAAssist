#!/usr/bin/env node
/*
 * Owed-estimate correctness regression test (F5).
 *
 * The wage-demand letter's owed-amount estimate must distinguish hours paid $0
 * (owed the full 1.5x overtime rate) from hours already paid straight-time but
 * denied the overtime premium (owed only the 0.5x differential — treating those
 * as unpaid overstates them ~3x), and must group logged hours by workweek instead
 * of describing a multi-week log as if it were all ">40 hours in a workweek".
 * Run: node test/wage-estimate.mjs
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

// $20/hr, 10 hrs paid $0 in workweek 1 (Jan 5 2026) + 6 hrs paid straight-time
// only in workweek 2 (Jan 12 2026) => owed = 10*20*1.5 + 6*20*0.5 = 300 + 60 = 360.
const seed = {
  onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
  profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
  caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[],
  entries: [
    { date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'covered a shift, paid nothing for it', color:'#EF7B22', tag:'Wage & hour', hours:10, payStatus:'unpaid' },
    { date:'JAN 12, 2026 · 9:00 AM', iso:'2026-01-12T09:00:00.000Z', title:'Unpaid or extra hours', body:'worked over 40, only paid straight time', color:'#EF7B22', tag:'Wage & hour', hours:6, payStatus:'straight' },
  ],
};

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const pg = await b.newPage();
const errs = [];
pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

await pg.evaluateOnNewDocument((s) => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), seed);
await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:'networkidle0', timeout:20000 });
await new Promise(r => setTimeout(r, 700));

await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Draft a letter')); if (btn) btn.click(); });
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
  if (!letterText.includes('16 hours')) problems.push('expected total 16 hours, got: ' + JSON.stringify(letterText));
  if (!letterText.includes('2 separate workweeks')) problems.push('expected "2 separate workweeks" grouping text, got: ' + JSON.stringify(letterText));
  if (!/10 hours paid nothing/.test(letterText)) problems.push('missing the unpaid-hours breakdown ("10 hours paid nothing")');
  if (!/6 hours paid straight-time only/.test(letterText)) problems.push('missing the straight-time breakdown ("6 hours paid straight-time only")');
  if (!letterText.includes('$360.00')) problems.push('expected owed estimate $360.00 (10*20*1.5 + 6*20*0.5), got: ' + JSON.stringify(letterText));
  if (letterText.includes('$450.00')) problems.push('letter shows the OLD overstated figure ($450.00 = 16*20*1.5, treating every hour as unpaid)');
}
errs.forEach(e => problems.push(e));

const ok = problems.length === 0;
console.log((ok ? '✅' : '❌') + ' owed-estimate breakdown & workweek grouping' + (ok ? '' : '\n   ' + problems.slice(0, 8).join('\n   ')));

await b.close(); server.close();
console.log(ok ? '\n✅ WAGE-ESTIMATE TEST PASSED' : '\n❌ WAGE-ESTIMATE TEST FAILED');
process.exit(ok ? 0 : 1);
