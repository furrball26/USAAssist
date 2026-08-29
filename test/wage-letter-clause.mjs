#!/usr/bin/env node
/*
 * Wage-demand-letter "additional overtime protection" clause regression test.
 *
 * buildLetter()'s wage-demand kind adds a state-law clause + citation ("[State]
 * law (...) provides additional overtime protection that may increase what I am
 * owed") only when the state's OWN overtime.daily fact describes a genuinely more
 * protective rule than the federal 40-hr/week-only standard (a real daily-hours
 * trigger, e.g. CA/AK's 8-hr/day rule, CO's 12-hr/day rule, NV's 24-hour-period
 * rule). States whose overtime.daily fact merely restates or tracks the federal
 * standard — worded any of several ways — must NOT get the clause, since this
 * text goes into a letter the app tells the user to send to their employer. A
 * state's separate, higher SALARY floor for the overtime EXEMPTION (e.g.
 * Washington's overtime.salaryThreshold) must not trigger the clause either: it
 * doesn't change the pay-rate/hours-threshold owed for hours already logged.
 * Guards the stateAddsRealOvertimeProtection fix (F2). Run: node test/wage-letter-clause.mjs
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

const CASES = [
  // No real daily/hours-threshold protection beyond federal — must NOT get the clause.
  { state:'Massachusetts', county:'Suffolk County', addsClause:false },
  { state:'Minnesota', county:'Hennepin County', addsClause:false },
  { state:'Washington', county:'King County', addsClause:false }, // higher EXEMPT salary floor only — irrelevant here
  { state:'New Jersey', county:'Essex County', addsClause:false },
  // Genuine daily/hours-threshold overtime protection beyond federal — must get the clause.
  { state:'California', county:'Los Angeles County', addsClause:true },
  { state:'Alaska', county:'Anchorage Municipality', addsClause:true },
  { state:'Colorado', county:'Denver County', addsClause:true },
  { state:'Nevada', county:'Clark County', addsClause:true },
];

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

try {

for (const c of CASES) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:c.state, county:c.county, issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard',
    entries:[{ date:'JAN 5, 2026 · 9:00 AM', title:'Unpaid or extra hours', body:'covered a shift', color:'#EF7B22', tag:'Wage & hour', hours:10 }],
    done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  // Home → "Ask HR, in writing, for your overtime..." step (Tools' "Draft a
  // letter" card is only shown for non-wage issues now — it's redundant for
  // wage, since both letters are reachable via the step list), then switch to
  // the "Wage demand" kind.
  await pg.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Ask HR, in writing, for your overtime'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 300));
  await pg.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /Wage demand/.test(b.textContent));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 300));

  const letterText = await pg.evaluate(() => {
    const els = [...document.querySelectorAll('div')].filter(d => d.textContent.includes('Demand for unpaid overtime wages') || d.textContent.includes('To whom it may concern'));
    return els.length ? els[els.length - 1].textContent : null;
  });

  const problems = [];
  if (!letterText) {
    problems.push('wage-demand letter body not found');
  } else {
    const hasClause = /provides additional overtime protection/.test(letterText);
    if (hasClause !== c.addsClause) {
      problems.push('expected addsClause=' + c.addsClause + ' but letter ' + (hasClause ? 'DOES' : 'does NOT') + ' contain the clause');
    }
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' ' + c.state + ' / wage-demand clause=' + c.addsClause + (ok ? '' : '\n   ' + problems.slice(0, 6).join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL WAGE-LETTER CLAUSE CASES PASSED');
process.exit(fails ? 1 : 0);
