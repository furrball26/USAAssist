#!/usr/bin/env node
/*
 * FLSA process-fidelity regression test (docs/flsa-process-gap.md, §5.3).
 *
 * Guards the app-side copy/flow changes for the wage/overtime (issueKey==='wage')
 * enforcement-process gaps identified in that spec:
 *
 *   1. G2 — the on-screen "you may be owed about $X" dashboard figure is labeled
 *      as back wages only, since a private lawsuit can recover roughly double that
 *      plus attorney's fees (remedies.liquidatedDamages / remedies.attorneysFees).
 *   2. G4 — the app tells a wage user to complain in writing (classification-request
 *      letter, wage-demand letter, Agencies tab) without ever saying that activity is
 *      protected from retaliation (retaliation.flsa, 29 U.S.C. § 215(a)(3)).
 *   3. G2/G3 — a non-exempt wizard result shows the "How to actually recover this"
 *      WHD-complaint-vs-private-lawsuit panel (enforcement.paths), including the
 *      waiver warning, not just a route to a demand letter.
 *   4. G1 — the SOL timing-trap line appears on the non-exempt wizard result: the
 *      2-3 year deadline keeps running and a WHD complaint does not pause it.
 *
 * Run: node test/flsa-process-fidelity.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { execSync } from 'node:child_process';
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
const chrome = execSync(`find "${ROOT}chrome-headless-shell" -type f -name 'chrome-headless-shell' | head -1`).toString().trim();

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;
const click = async (pg, t) => { await pg.evaluate((x) => { const e = [...document.querySelectorAll('button,a')].find(el => el.textContent.includes(x)); e && e.click(); }, t); await new Promise(r => setTimeout(r, 300)); };
const bodyText = async (pg) => await pg.evaluate(() => document.body.innerText);

try {

// 1. Liquidated-damages label on the on-screen owed estimate (Plain-mode dashboard).
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'plain', done:{}, messages:[],
    entries: [{ date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'covered a shift', color:'#EF7B22', tag:'Wage & hour', hours:10, payStatus:'unpaid' }],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  const all = await bodyText(pg);
  const problems = [];
  // 10 unpaid hours in a single sub-40-hr workweek: owed at the straight 1x rate
  // ($200.00), not the 1.5x overtime rate — the week never crosses the 40-hr/
  // week FLSA overtime threshold.
  if (!/You may be owed about \$200\.00/.test(all)) problems.push('expected owed-estimate headline ($200.00 = 10 * $20 * 1.0 — under the 40-hr/week overtime threshold), got: ' + JSON.stringify(all.slice(0, 400)));
  if (/\$300\.00/.test(all)) problems.push('shows the OLD overstated figure ($300.00 = 10*20*1.5), wrongly applying the overtime multiplier to a sub-40-hr workweek');
  if (!/back wages only/i.test(all)) problems.push('missing the "back wages only" label on the owed estimate');
  if (!/double/i.test(all)) problems.push('missing the "up to double" liquidated-damages framing near the estimate');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' owed-estimate is labeled "back wages only" with the liquidated-damages framing' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 2. Retaliation note surfaces on the wage flow: both letters + the Agencies tab.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[],
    entries: [{ date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'covered a shift', color:'#EF7B22', tag:'Wage & hour', hours:10, payStatus:'unpaid' }],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  const problems = [];

  // Home's "Draft a letter" Tools card was removed (redundant with the step list
  // and the wizard's non-exempt result) — reach the classification-request letter
  // via its "Your next steps" row instead.
  await click(pg, 'Ask HR, in writing, for your overtime');
  await new Promise(r => setTimeout(r, 300));
  const classText = await bodyText(pg);
  if (!/215\(a\)\(3\)/.test(classText) || !/retaliation/i.test(classText)) problems.push('classification-request letter missing retaliation protection statement, got: ' + JSON.stringify(classText.slice(0, 600)));

  await click(pg, 'Wage demand');
  await new Promise(r => setTimeout(r, 300));
  const demandText = await bodyText(pg);
  if (!/215\(a\)\(3\)/.test(demandText) || !/retaliation/i.test(demandText)) problems.push('wage-demand letter missing retaliation protection statement, got: ' + JSON.stringify(demandText.slice(0, 600)));
  if (!/liquidated damages/i.test(demandText)) problems.push('wage-demand letter missing the liquidated-damages leverage sentence');

  await click(pg, 'Home');
  await click(pg, 'Agencies');
  await new Promise(r => setTimeout(r, 300));
  const agenciesText = await bodyText(pg);
  if (!/protected/i.test(agenciesText) || !/retaliat/i.test(agenciesText)) problems.push('Agencies tab missing the protected-activity / retaliation note for a wage case, got: ' + JSON.stringify(agenciesText.slice(0, 600)));

  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' retaliation.flsa note surfaces on classification-request, wage-demand, and Agencies' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 3/4. Non-exempt wizard result shows the WHD-vs-lawsuit "recover this" panel
//      (including the waiver warning) AND the SOL timing-trap line.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  // Home -> "Am I exempt" -> Hourly -> No (hourlyType/r_hourly) -> non-exempt result.
  await click(pg, 'Am I exempt');
  await click(pg, 'Hourly');
  await click(pg, 'No');
  await new Promise(r => setTimeout(r, 300));

  const resultText = await bodyText(pg);
  const problems = [];
  if (!/non-exempt/i.test(resultText)) problems.push('expected a non-exempt wizard result, got: ' + JSON.stringify(resultText.slice(0, 300)));
  if (!/How to actually recover this/i.test(resultText)) problems.push('missing the "How to actually recover this" WHD-vs-lawsuit panel');
  if (!/liquidated damages/i.test(resultText) || !/double/i.test(resultText)) problems.push('recover panel missing the "about double" liquidated-damages framing');
  if (!/attorney.?s fees/i.test(resultText)) problems.push('recover panel missing attorney\'s-fees framing');
  if (!/waive/i.test(resultText)) problems.push('recover panel missing the WHD-supervised-payment waiver warning');
  if (!/keeps running while you wait/i.test(resultText)) problems.push('missing the SOL timing-trap line on the non-exempt result');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' non-exempt wizard result shows the recover-this panel and the SOL timing note' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL FLSA PROCESS-FIDELITY CASES PASSED');
process.exit(fails ? 1 : 0);
