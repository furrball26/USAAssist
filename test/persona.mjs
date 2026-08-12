#!/usr/bin/env node
/*
 * Persona-consistency test: for several (state, issue, profile) cases, seed the case,
 * walk key screens, and assert the app reflects the user's inputs with NO leakage of
 * the old hardcoded California/Sam-Okonkwo persona, and no JS errors. Run: node test/persona.mjs
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

// Strings from the old hardcoded persona that must NEVER appear in any rendered screen.
const LEAKS = ['Sam Okonkwo', 'Rivera Logistics', 'CASE #24-118', '$2,418', '62 hours', '62.5', 'Embarcadero', 'March–June', 'Mar–Jun', 'Opened 14 days ago'];

const CASES = [
  { state:'Texas', county:'Travis County', issue:'Unpaid overtime or wages', profile:{name:'Jordan Lee', employer:'Acme Freight LLC', payType:'Hourly', rate:'20'}, hours:10,
    expect:['Acme Freight LLC','Jordan Lee','Texas'], forbidExtra:['Alameda','Oakland','California Labor Code'] },
  { state:'New York', county:'Kings County', issue:'Discrimination', profile:{name:'Sam Diaz', employer:'Metro Retail Inc', payType:'Salary', rate:''}, hours:0,
    expect:['New York','Metro Retail Inc'], forbidExtra:['Alameda','Oakland'] },
  { state:'Florida', county:'Miami-Dade County', issue:'Fired or pushed out', profile:{name:'Chris Poe', employer:'Sunbelt Co', payType:'Hourly', rate:''}, hours:0,
    expect:['Florida','Sunbelt Co'], forbidExtra:['Alameda','Oakland'] },
];

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

for (const c of CASES) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:c.state, county:c.county, issue:c.issue, profile:c.profile,
    caseOpened:new Date().toISOString(),
    entries: c.hours ? [{ date:'JAN 5, 2026 · 9:00 AM', title:'Unpaid or extra hours', body:'covered a shift', color:'#EF7B22', tag:'Wage & hour', hours:c.hours }] : [],
    done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), seed);
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:'networkidle0', timeout:20000 });
  await new Promise(r => setTimeout(r, 600));

  const click = async (t) => { await pg.evaluate((x) => { const e = [...document.querySelectorAll('button,a')].find(el => el.textContent.includes(x)); e && e.click(); }, t); await new Promise(r => setTimeout(r, 300)); };
  const collect = async () => await pg.evaluate(() => document.body.innerText);

  let all = '';
  for (const stop of ['Home', 'Ask AI', 'Rights', 'Agencies']) { await click(stop); all += '\n' + await collect(); }
  await click('Home'); await click('Draft a letter'); const letterTxt = await collect(); all += '\n' + letterTxt;
  await click('Home'); await click('Am I exempt'); all += '\n' + await collect();

  const problems = [];
  LEAKS.forEach(l => { if (all.includes(l)) problems.push('LEAK: ' + l); });
  (c.forbidExtra || []).forEach(l => { if (all.includes(l)) problems.push('FORBIDDEN: ' + l); });
  c.expect.forEach(e => { if (!all.includes(e)) problems.push('MISSING expected: ' + e); });
  if (!/not legal advice/i.test(all)) problems.push('MISSING disclaimer "not legal advice"');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' ' + c.state + ' / ' + c.issue + (ok ? '' : '\n   ' + problems.slice(0, 8).join('\n   ')));
  await pg.close();
}

await b.close(); server.close();
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL PERSONA CASES PASSED');
process.exit(fails ? 1 : 0);
