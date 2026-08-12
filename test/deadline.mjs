#!/usr/bin/env node
/*
 * Deadline-banner regression test.
 *
 * Part 1 — federal fallback: for a state with NO discrimination-charge
 * deadline of its own (NC — the state's own fact explicitly says "no state
 * deadline; use the federal EEOC deadline"), a termination case must surface
 * the operative FEDERAL EEOC charge window (180/300 days) on the dashboard
 * DEADLINE WATCH banner — NOT the far-longer state wage-claim deadline, which
 * previously short-circuited and hid the EEOC deadline.
 *
 * Part 2 — state-specific wins: for states that DO have their own
 * discrimination/unfair-practice charge-filing deadline (SD: 180 days with
 * the SD Division of Human Rights; WY: six months with the WY Department of
 * Workforce Services), that state's OWN fact must win over the generic
 * federal EEOC fact — even though "eeocCharge" used to head the keyword
 * priority list. Guards the pickDeadlineFactAcross tiering fix (F1).
 *
 * Part 3 — Home vs. Case Strength agreement: the single deadline synthesized
 * on Home (pickDeadlineFactAcross) must be the SAME fact as the state line
 * shown on Case Strength (pickDeadlineFact on state facts alone) whenever the
 * state has its own charge-deadline fact — they must never disagree.
 *
 * Run: node test/deadline.mjs
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

const CASES = [
  // NC's own discriminationComplaint fact says "no state deadline" — the federal
  // 180-day EEOC window must surface, not the 2-year state wage-claim deadline.
  { state:'North Carolina', county:'Wake County', mustInclude:['180'], mustNotMatch:[/wage/i, /Wage and Hour Act/i] },
  // SD has its own 180-day charge deadline (SD Division of Human Rights) — happens
  // to also read "180", but must NOT be the wage-claim deadline.
  { state:'South Dakota', county:'Minnehaha County', mustInclude:['180'], mustNotMatch:[/wage/i, /Wage and Hour Act/i] },
  // WY has its own six-month charge deadline (WY Dept of Workforce Services) — this
  // must win over the generic federal 180/300-day fact, not just avoid the wage fact.
  { state:'Wyoming', county:'Laramie County', mustInclude:['six months'], mustNotMatch:[/wage/i, /Wage and Hour Act/i, /180 days/, /300 days/] },
];

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

try {

async function seedAndOpen(pg, state, county, issue) {
  const seed = {
    onboarded:true, stateSel:state, county, issue,
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Salary', rate:'' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
}

for (const c of CASES) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await seedAndOpen(pg, c.state, c.county, 'Fired or pushed out');

  // Read ONLY the DEADLINE WATCH banner button, not the whole page.
  const banner = await pg.evaluate(() => {
    const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes('DEADLINE WATCH'));
    return el ? el.textContent : null;
  });

  const problems = [];
  if (!banner) {
    problems.push('DEADLINE WATCH banner missing entirely');
  } else {
    (c.mustInclude || []).forEach(s => { if (!banner.includes(s)) problems.push('banner missing expected text ' + JSON.stringify(s) + ': ' + JSON.stringify(banner)); });
    (c.mustNotMatch || []).forEach(re => { if (re.test(banner)) problems.push('banner unexpectedly matches ' + re + ': ' + JSON.stringify(banner)); });
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' ' + c.state + ' / termination' + (ok ? '' : '\n   ' + problems.slice(0, 6).join('\n   ')));
  await pg.close();
}

// Part 3 — Home and Case Strength must never disagree on the operative deadline.
// California: state FEHA complaint deadline (3 years) must win on BOTH screens
// over the federal EEOC 180/300-day fact.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await seedAndOpen(pg, 'California', 'Los Angeles County', 'Discrimination');

  const homeBanner = await pg.evaluate(() => {
    const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes('DEADLINE WATCH'));
    return el ? el.textContent : null;
  });
  // Open Case Strength (the DEADLINE WATCH button itself navigates there).
  await pg.evaluate(() => {
    const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes('DEADLINE WATCH'));
    if (el) el.click();
  });
  await new Promise(r => setTimeout(r, 400));
  const strengthText = await pg.evaluate(() => document.body.textContent);

  const problems = [];
  if (!homeBanner) problems.push('DEADLINE WATCH banner missing on Home');
  else {
    if (!/FEHA|3 years/i.test(homeBanner)) problems.push('Home banner does not show the CA FEHA deadline: ' + JSON.stringify(homeBanner));
    if (/180 days|300 days/.test(homeBanner)) problems.push('Home banner shows the federal EEOC window instead of the CA FEHA deadline: ' + JSON.stringify(homeBanner));
  }
  if (!/FEHA/i.test(strengthText)) problems.push('Case Strength state line does not mention FEHA');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' California / discrimination — Home vs Strength agreement' + (ok ? '' : '\n   ' + problems.slice(0, 6).join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL DEADLINE CASES PASSED');
process.exit(fails ? 1 : 0);
