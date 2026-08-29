#!/usr/bin/env node
/*
 * Damages / back-pay estimator regression test (non-wage issues).
 *
 * Guards the new tool (see DamagesEstimator in index.dev.html):
 *
 *   1. Termination + pay data + a "weeks out of work" input renders a rough,
 *      HYPOTHETICAL back-pay figure, always wrapped in explicit hedging —
 *      "if a claim succeeds", "rough", and "not ... owed" language — never
 *      presented as an authoritative amount.
 *   2. Termination with NO pay data on file shows the framework/explanation
 *      with no dollar figure at all (honest-degrade), never a fabricated or
 *      $0.00 number.
 *   3. The tool is gated to the non-wage issues (termination/harassment/
 *      discrimination) — absent on a wage dashboard.
 *   4. Discrimination shows the educational damage-category checklist (back
 *      pay, front pay, emotional distress, punitive damages, out-of-pocket
 *      costs) WITHOUT ever fabricating a specific emotional-distress dollar
 *      figure.
 *
 * Run: node test/damages-estimator.mjs
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
const newPage = async () => {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  return { pg, errs };
};
const TOOL_LABEL = 'Estimate possible damages';

try {

// 1. Termination + pay data + weeks-out input -> rough, explicitly hedged
//    back-pay figure. $25/hr * 40 hrs/week assumption = $1,000/week; 6 weeks
//    out = $6,000 rough figure.
{
  const { pg, errs } = await newPage();
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Fired or pushed out',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'25', weeksOut:'6' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  await click(pg, TOOL_LABEL);
  await new Promise(r => setTimeout(r, 300));
  const text = await bodyText(pg);

  const problems = [];
  if (!text.includes('$1,000.00')) problems.push('expected $1,000.00/week from $25/hr * 40hr assumption, got: ' + JSON.stringify(text.slice(0, 1200)));
  if (!text.includes('$6,000.00')) problems.push('expected rough back-pay figure $6,000.00 (6 weeks * $1,000/wk), got: ' + JSON.stringify(text.slice(0, 1200)));
  if (!/if a claim succeeds/i.test(text)) problems.push('missing "if a claim succeeds" hedging language');
  if (!/rough/i.test(text)) problems.push('missing "rough" hedging language');
  if (!/not\b[^.]*\bowed/i.test(text)) problems.push('missing "not ... owed" hedging language');
  if (!/mitigation/i.test(text)) problems.push('missing the mitigation caveat');
  if (!/front pay/i.test(text)) problems.push('missing the front-pay informational note');
  if (!/not legal advice/i.test(text)) problems.push('missing the not-legal-advice framing');
  if (!/40-hour/i.test(text)) problems.push('missing the labeled 40-hour-week assumption');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' termination + pay data + weeks-out renders a hedged, hypothetical back-pay figure' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 2. Termination with NO pay data on file — the framework/explanation still
//    renders, but with no dollar figure and no fabricated $0.00.
{
  const { pg, errs } = await newPage();
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Fired or pushed out',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'', rate:'', salary:'', weeksOut:'' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  await click(pg, TOOL_LABEL);
  await new Promise(r => setTimeout(r, 300));
  const text = await bodyText(pg);

  const problems = [];
  if (!/if a claim succeeds/i.test(text)) problems.push('missing the back-pay framework explanation with no pay data on file');
  if (!/add your hourly rate or salary/i.test(text)) problems.push('missing the honest prompt to add pay data before a figure can show');
  if (text.includes('$0.00')) problems.push('shows a fabricated $0.00 figure instead of honestly degrading to no number');
  if (/rough, hypothetical back pay so far/i.test(text)) problems.push('rough-figure card should not render at all with no pay data');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' termination with no pay data shows the framework with no dollar figure (honest-degrade)' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 3. Tool is gated to the non-wage issues — absent on a wage dashboard.
{
  const { pg: pgWage, errs: errsWage } = await newPage();
  const seedWage = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  await pgWage.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seedWage);
  await gotoApp(pgWage, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  const wageHome = await bodyText(pgWage);
  await pgWage.close();

  const { pg: pgTerm, errs: errsTerm } = await newPage();
  const seedTerm = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Fired or pushed out',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  await pgTerm.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seedTerm);
  await gotoApp(pgTerm, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  const termHome = await bodyText(pgTerm);
  await pgTerm.close();

  const problems = [];
  if (wageHome.includes(TOOL_LABEL)) problems.push('wage dashboard wrongly offers the damages estimator tool');
  if (!termHome.includes(TOOL_LABEL)) problems.push('termination dashboard is missing the damages estimator tool');
  errsWage.forEach(e => problems.push('wage: ' + e));
  errsTerm.forEach(e => problems.push('term: ' + e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' "Estimate possible damages" tool is gated to non-wage issues (termination/harassment/discrimination)' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

// 4. Discrimination shows the educational damage-category checklist without
//    ever fabricating an emotional-distress dollar figure.
{
  const { pg, errs } = await newPage();
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Discrimination',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  await click(pg, TOOL_LABEL);
  await new Promise(r => setTimeout(r, 300));
  const text = await bodyText(pg);

  const problems = [];
  if (!/Back pay/.test(text)) problems.push('missing the "Back pay" damage category');
  if (!/Front pay/.test(text)) problems.push('missing the "Front pay" damage category');
  if (!/Emotional distress/i.test(text)) problems.push('missing the "Emotional distress" damage category');
  if (!/Punitive damages/i.test(text)) problems.push('missing the "Punitive damages" damage category');
  if (!/Out-of-pocket costs/i.test(text)) problems.push('missing the "Out-of-pocket costs" damage category');
  if (!/does not estimate a number/i.test(text)) problems.push('emotional-distress category should explicitly say no number is estimated');
  // No specific fabricated distress dollar figure — the only dollar amounts
  // allowed on this screen are the statutory punitive-damages CAPS (a fixed,
  // sourced, general federal figure) and the user's own optional
  // out-of-pocket tally (which starts at $0.00, never a distress number).
  const distressSection = (text.split('Emotional distress')[1] || '').split('Punitive damages')[0];
  if (/\$[1-9]/.test(distressSection)) problems.push('a specific dollar figure appears under Emotional distress, got: ' + JSON.stringify(distressSection));
  if (!/1981a/.test(text)) problems.push('missing the Title VII punitive-damages statutory cap citation');
  if (!/not a valuation of your case/i.test(text)) problems.push('missing the "not a valuation of your case" framing');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' discrimination shows the educational damage-category checklist without a fabricated distress figure' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL DAMAGES-ESTIMATOR CASES PASSED');
process.exit(fails ? 1 : 0);
