#!/usr/bin/env node
/*
 * Salaried owed-estimate regression test (F14).
 *
 * profile.rate was only ever collected for Hourly workers, so owedEstimate was
 * always 0 for Salary — even though the exemption wizard exists specifically to
 * catch misclassified SALARIED employees. A stated annual salary must now
 * produce a real hourly-equivalent (assuming a standard 40-hour workweek) that
 * flows into the wage-demand letter's dollar figure.
 * Run: node test/salary-estimate.mjs
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

// $41,600/yr -> hourly-equivalent = 41600/52/40 = $20.00/hr exactly, times 10
// unpaid hours * 1.5 = $300.00 — a clean, checkable figure.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Salary', salary:'41600', rate:'' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[],
    entries: [{ date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'x', color:'#EF7B22', tag:'Wage & hour', hours:10, payStatus:'unpaid' }],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
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
  if (!letterText) problems.push('wage-demand letter body not found');
  else {
    if (!letterText.includes('$20.00 per hour')) problems.push('expected hourly-equivalent $20.00/hr from a $41,600 salary, got: ' + JSON.stringify(letterText));
    if (!letterText.includes('$300.00')) problems.push('expected owed estimate $300.00 (10 hrs * $20.00 * 1.5), got: ' + JSON.stringify(letterText));
    if (!/hourly-equivalent/.test(letterText)) problems.push('letter does not disclose the figure is a salary-derived hourly-equivalent (transparency)');
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' salaried worker gets a real owed-amount estimate from stated salary' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// A salaried worker who has NOT entered a salary still gets no estimate (no
// division-by-assumption garbage figure) — falls back to the no-amount phrasing.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Salary', salary:'', rate:'' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[],
    entries: [{ date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'x', color:'#EF7B22', tag:'Wage & hour', hours:10, payStatus:'unpaid' }],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
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
  if (!letterText) problems.push('wage-demand letter body not found');
  else if (letterText.includes('$0.00')) problems.push('letter shows a garbage $0.00 figure instead of falling back to no-amount phrasing');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' salaried worker with no salary entered gets no fabricated dollar figure' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

await b.close(); server.close();
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL SALARY-ESTIMATE CASES PASSED');
process.exit(fails ? 1 : 0);
