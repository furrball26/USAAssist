#!/usr/bin/env node
/*
 * OSHA whistleblower deadline regression test (F4).
 *
 * A termination case whose logged evidence names a safety/OSHA/whistleblower
 * concern must surface the much shorter federal OSHA §11(c) 30-day complaint
 * deadline (deadlines.oshaWhistleblower), clearly labeled and ALONGSIDE the
 * regular EEOC/state discrimination-charge Deadline Watch card — never
 * replacing it (a user may also have a discrimination angle) and never
 * appearing for an ordinary termination that never mentions safety.
 *
 * Run: node test/osha-deadline.mjs
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

async function seedAndOpen(pg, { entries = [], messages = [] } = {}) {
  const seed = {
    onboarded:true, stateSel:'Ohio', county:'Franklin County', issue:'Fired or pushed out',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries, done:{}, messages,
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:'networkidle0', timeout:20000 });
  await new Promise(r => setTimeout(r, 700));
}

const oshaCardText = (pg) => pg.evaluate(() => {
  const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes('OSHA WHISTLEBLOWER DEADLINE'));
  return el ? el.textContent : null;
});

// Case 1: a termination case with a logged entry naming a safety complaint
// must show the OSHA 30-day card, alongside the regular Deadline Watch card.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await seedAndOpen(pg, {
    entries: [{ date:'Jan 1, 2026', iso:new Date().toISOString(), title:'Reason given', tag:'Statement', color:'#2B3AA8',
      body:'My manager fired me two days after I reported a safety hazard on the loading dock.' }],
  });

  const osha = await oshaCardText(pg);
  const regular = await pg.evaluate(() => {
    const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes('DEADLINE WATCH'));
    return el ? el.textContent : null;
  });

  const problems = [];
  if (!osha) problems.push('OSHA whistleblower card missing for a safety-retaliation termination');
  else if (!/30 days/.test(osha)) problems.push('OSHA card does not show the 30-day figure: ' + JSON.stringify(osha));
  if (!regular) problems.push('regular Deadline Watch card was replaced instead of shown alongside the OSHA card');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' safety-retaliation termination shows the OSHA 30-day card alongside Deadline Watch' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: an ordinary termination (no safety language anywhere) must NOT show
// the OSHA card — issue type alone is never enough to trigger it.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await seedAndOpen(pg, {
    entries: [{ date:'Jan 1, 2026', iso:new Date().toISOString(), title:'Reason given', tag:'Statement', color:'#2B3AA8',
      body:'My manager said the team was being restructured and my role was eliminated.' }],
  });

  const osha = await oshaCardText(pg);
  const problems = [];
  if (osha) problems.push('OSHA card wrongly shown for an ordinary (non-safety) termination: ' + JSON.stringify(osha));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' ordinary termination (no safety language) does not show the OSHA card' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3: a user typing "OSHA"/"whistleblower" in chat (not just the log)
// also triggers the card — detection reads user chat messages too.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await seedAndOpen(pg, {
    messages: [
      { role:'ai', text:'You mentioned being fired or pushed out. Tell me the reason you were given.' },
      { role:'user', text:'I think I got fired for being an OSHA whistleblower about unsafe machinery.' },
    ],
  });

  const osha = await oshaCardText(pg);
  const problems = [];
  if (!osha) problems.push('OSHA card missing when the safety language is only in a user chat message');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' safety language in a user chat message also triggers the OSHA card' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 4: a wage issue (non-termination) that happens to mention "safety" must
// NOT show the card — issue key must be termination, not just keyword match.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:'Ohio', county:'Franklin County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard',
    entries:[{ date:'Jan 1, 2026', iso:new Date().toISOString(), title:'Hours', tag:'Wage & hour', color:'#EF7B22',
      body:'Worked a safety training shift that was unpaid.' }],
    done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:'networkidle0', timeout:20000 });
  await new Promise(r => setTimeout(r, 700));

  const osha = await oshaCardText(pg);
  const problems = [];
  if (osha) problems.push('OSHA card wrongly shown for a non-termination (wage) issue: ' + JSON.stringify(osha));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' wage issue mentioning "safety" does not show the OSHA card (issue key gate)' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

await b.close(); server.close();
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL OSHA-DEADLINE CASES PASSED');
process.exit(fails ? 1 : 0);
