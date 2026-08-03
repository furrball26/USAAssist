#!/usr/bin/env node
/*
 * Deadline-banner regression test. For states whose ONLY deadline fact is a
 * wage-claim deadline (NC/SD/WY), a termination (discrimination/retaliation)
 * case must surface the operative FEDERAL EEOC charge window (180/300 days) on
 * the dashboard DEADLINE WATCH banner — NOT the far-longer state wage-claim
 * deadline, which previously short-circuited and hid the EEOC deadline.
 * Guards the pickDeadlineFactAcross fix. Run: node test/deadline.mjs
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

// States with a wage-claim deadline but no discrimination-charge deadline of their own.
const CASES = [
  { state:'North Carolina', county:'Wake County' },
  { state:'South Dakota', county:'Minnehaha County' },
  { state:'Wyoming', county:'Laramie County' },
];

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

for (const c of CASES) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:c.state, county:c.county, issue:'Fired or pushed out',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Salary', rate:'' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), seed);
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:'networkidle0', timeout:20000 });
  await new Promise(r => setTimeout(r, 700));

  // Read ONLY the DEADLINE WATCH banner button, not the whole page.
  const banner = await pg.evaluate(() => {
    const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes('DEADLINE WATCH'));
    return el ? el.textContent : null;
  });

  const problems = [];
  if (!banner) {
    problems.push('DEADLINE WATCH banner missing entirely');
  } else {
    if (!banner.includes('180')) problems.push('banner does not show the EEOC 180/300-day charge deadline: ' + JSON.stringify(banner));
    if (/wage/i.test(banner) || /Wage and Hour Act/i.test(banner)) problems.push('banner still shows a wage-claim deadline: ' + JSON.stringify(banner));
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' ' + c.state + ' / termination' + (ok ? '' : '\n   ' + problems.slice(0, 6).join('\n   ')));
  await pg.close();
}

await b.close(); server.close();
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL DEADLINE CASES PASSED');
process.exit(fails ? 1 : 0);
