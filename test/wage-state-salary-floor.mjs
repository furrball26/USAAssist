#!/usr/bin/env node
/*
 * FIND-01 (docs/audit-2026-08-29.md) — the overtime-exemption wizard's federal
 * salary-level question ("Is your salary at least $684/week?") is a self-report
 * against the FEDERAL floor only. Several states set a HIGHER white-collar salary
 * floor (content topic 'overtime.salaryFloorWeekly'); a worker who clears $684/week
 * federally can still fall below a state's own, higher number, and the salary-basis
 * test is a floor, not a duties test — failing it is disqualifying no matter how
 * exempt the duties look. Guards:
 *
 *   1. CA + a below-state-floor salary + executive duties (manages 2+, has
 *      hire/fire authority) does NOT render a bare "Possibly exempt" verdict —
 *      it is downgraded/annotated to reflect the state floor.
 *   2. A state with NO numeric salary-floor fact (Texas) leaves the ordinary
 *      federal-only "Possibly exempt — executive" verdict unchanged.
 *   3. An hourly worker (no salary-basis question applies the same way) does not
 *      crash and does not get a false "not exempt" from this check specifically —
 *      the existing hourly-path verdict renders normally.
 *
 * Run: node test/wage-state-salary-floor.mjs
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
const click = async (pg, t) => { await pg.evaluate((x) => { const e = [...document.querySelectorAll('button,a')].find(el => el.textContent.includes(x)); e && e.click(); }, t); await new Promise(r => setTimeout(r, 300)); };
const bodyText = async (pg) => await pg.evaluate(() => document.body.innerText);

const newSeededPage = async (seed) => {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  return { pg, errs };
};

// Drives: Home -> "Am I exempt" -> "A fixed salary every period" ->
// "Yes, $684/week or more" -> "No, or not sure" (HCE) -> "Manage two or more
// employees" -> "Yes, I have that authority" (execAuth) -> r_exec.
const driveToExecResult = async (pg) => {
  await click(pg, 'Am I exempt');
  await click(pg, 'A fixed salary every period');
  await click(pg, 'Yes, $684/week or more');
  await click(pg, 'No, or not sure');
  await click(pg, 'Manage two or more employees');
  await click(pg, 'Yes, I have that authority');
  await new Promise(r => setTimeout(r, 300));
};

try {

// 1. CA, salary $52,000/yr ($1,000/wk) — clears the federal $684/wk floor but is
//    $352/wk below CA's ~$1,352/wk white-collar floor — must NOT be a bare
//    "Possibly exempt" verdict.
{
  const seed = {
    onboarded:true, stateSel:'California', county:'Los Angeles County', issue:'Unpaid overtime or wages',
    profile:{ name:'Jordan Lee', employer:'Northgate Co', payType:'Salary', salary:'52000' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  const { pg, errs } = await newSeededPage(seed);
  await driveToExecResult(pg);
  const resultText = await bodyText(pg);
  const problems = [];
  if (/^Possibly exempt — executive/im.test(resultText) || /RESULT\s*\n\s*Possibly exempt — executive/i.test(resultText)) {
    problems.push('rendered a bare "Possibly exempt — executive" verdict for a CA worker below the state salary floor');
  }
  if (!/below the state floor|not exempt in california/i.test(resultText)) {
    problems.push('missing a state-salary-floor downgrade/annotation in the result, got: ' + JSON.stringify(resultText.slice(0, 600)));
  }
  if (!/1,352|1352/.test(resultText)) problems.push('missing CA\'s own numeric floor figure (should come from content, not be invented)');
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' CA below-state-floor salaried "executive" is downgraded, not a bare possibly-exempt verdict' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 2. Texas has no numeric overtime.salaryFloorWeekly fact — federal-only verdict
//    for the same duties/salary shape must be unchanged ("Possibly exempt").
{
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Salary', salary:'52000' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  const { pg, errs } = await newSeededPage(seed);
  await driveToExecResult(pg);
  const resultText = await bodyText(pg);
  const problems = [];
  if (!/Possibly exempt — executive/i.test(resultText)) problems.push('a state with no salary-floor fact should leave the federal-only verdict unchanged, got: ' + JSON.stringify(resultText.slice(0, 400)));
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' state with no salary-floor fact leaves the federal-only verdict unchanged' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 3. Hourly worker in CA — the state-floor check must not crash and must not
//    itself manufacture a false "not exempt" beyond the app's existing hourly
//    handling (r_hourly / r_hourly_comp_no already cover hourly workers).
{
  const seed = {
    onboarded:true, stateSel:'California', county:'Los Angeles County', issue:'Unpaid overtime or wages',
    profile:{ name:'Casey Kim', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  const { pg, errs } = await newSeededPage(seed);
  await click(pg, 'Am I exempt');
  await click(pg, 'Hourly');
  await click(pg, 'No');
  await new Promise(r => setTimeout(r, 300));
  const resultText = await bodyText(pg);
  const problems = [];
  if (!/non-exempt/i.test(resultText)) problems.push('expected the existing hourly non-exempt verdict, got: ' + JSON.stringify(resultText.slice(0, 300)));
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' hourly worker path renders without crashing or a spurious result' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}

if (fails) { console.error(`\n${fails} check(s) failed.`); process.exit(1); }
console.log('\nAll wage-state-salary-floor checks passed.');
