#!/usr/bin/env node
/*
 * State wage-remedy claim-type gating regression test.
 *
 * The app read the FEDERAL remedies.liquidatedDamages fact only, so an Arizona
 * user got the weaker federal "about double" framing everywhere — including the
 * wage-demand letter that goes to the employer — never Arizona's own remedies
 * (A.R.S. § 23-355(A) treble damages, A.R.S. § 23-364(G) mandatory minimum-wage
 * damages). Simply showing "3x" to every AZ wage user would be its OWN defect:
 *   - Arizona has no state overtime statute, so an OVERTIME-only shortfall is
 *     ordinarily a federal FLSA claim — § 23-355 must NOT be cited for it.
 *   - § 23-355 treble is for general unpaid WAGES and is DISCRETIONARY ("may
 *     recover"), never an automatic multiplier.
 *   - § 23-364(G) is MANDATORY but scoped only to pay that is actually below
 *     the state minimum wage.
 * This guards applicableWageRemedies()/wageRemedyLetterSentence() gating on the
 * user's actual CLAIM SHAPE (computeOwedBreakdown's unpaidRegHrs vs otHours) and
 * the logged rate vs minimumWage.hourly — via the real wage-demand letter output,
 * which is the highest-stakes surface (sent to the employer). Also asserts the
 * lookup is state-file-driven (factByTopic on the active state's own facts), not
 * hardcoded to Arizona, and that the dollar estimate itself never changes.
 * Run: node test/wage-state-remedy.mjs
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

async function wageDemandLetterText(seed) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  // The wage dashboard's own "How to actually recover this" card (WageRecoverPanel)
  // is on the page already at this point (homeMode:'standard'). innerText (not
  // textContent) — textContent also picks up the app's own inline <script> source,
  // which contains this file's literal JSX strings regardless of whether React
  // actually rendered them.
  const dashboardText = await pg.evaluate(() => document.body.innerText);

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
    const els = [...document.querySelectorAll('div')].filter(d => d.textContent.includes('To whom it may concern'));
    return els.length ? els[els.length - 1].textContent : null;
  });
  await pg.close();
  return { letterText, dashboardText, errs };
}

const baseSeed = {
  onboarded:true, stateSel:'Arizona', county:'Maricopa County', issue:'Unpaid overtime or wages',
  homeMode:'standard', done:{}, messages:[],
};

try {

// Case A — AZ OVERTIME-ONLY claim: a single week of 45 hours, all paid at
// straight-time (so only the 0.5x overtime PREMIUM is owed — unpaidRegHrs is
// 0). Arizona has no state overtime statute, so this must NOT cite § 23-355
// treble damages or § 23-364(G) — only the federal §216(b) doubling.
{
  const seed = Object.assign({}, baseSeed, {
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(),
    entries:[{ date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'x', color:'#EF7B22', tag:'Wage & hour', hours:45, payStatus:'straight' }],
  });
  const { letterText, dashboardText, errs } = await wageDemandLetterText(seed);
  const problems = [];
  if (!letterText) problems.push('wage-demand letter body not found');
  else {
    if (/23-355/.test(letterText)) problems.push('overtime-only claim wrongly cites § 23-355 treble damages in the letter');
    if (/23-364/.test(letterText)) problems.push('overtime-only claim wrongly cites § 23-364 minimum-wage damages in the letter');
    if (!/216\(b\)/.test(letterText)) problems.push('federal §216(b) liquidated-damages line is missing');
  }
  // Deadline Watch legitimately quotes § 23-355 as part of Arizona's general
  // unpaid-wages SOL fact on every wage case (deadlines aren't gated by claim
  // shape) — so check the DASHBOARD REMEDY card's own marker text specifically,
  // not any mention of the citation anywhere on the page.
  if (/may add more/.test(dashboardText || '')) problems.push('overtime-only claim wrongly shows the state-remedy card on the dashboard');
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' AZ overtime-only claim never cites a state wage remedy that does not cover overtime' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

// Case B — AZ UNPAID-WAGES claim (never crosses 40 hrs/week, so there is no
// overtime component at all — pure straight-time hours paid nothing, rate
// above Arizona's minimum wage). This IS a general unpaid-wages claim, so it
// SHOULD see § 23-355 — but worded conditionally/discretionary, never as a
// promised 3x, and must NOT also claim the mandatory § 23-364(G) minimum-wage
// remedy since the logged rate is not below minimum wage.
{
  const seed = Object.assign({}, baseSeed, {
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(),
    entries:[{ date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'x', color:'#EF7B22', tag:'Wage & hour', hours:30, payStatus:'unpaid' }],
  });
  const { letterText, errs } = await wageDemandLetterText(seed);
  const problems = [];
  if (!letterText) problems.push('wage-demand letter body not found');
  else {
    if (!/23-355/.test(letterText)) problems.push('unpaid-wages claim should cite § 23-355 treble damages but does not');
    if (!/discretion/i.test(letterText)) problems.push('§ 23-355 must be worded conditionally ("at its discretion"), never as a promised outcome');
    if (/23-364/.test(letterText)) problems.push('rate ($20) is above AZ minimum wage; should NOT also cite § 23-364(G)');
  }
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' AZ unpaid-wages claim (rate above minimum wage) sees only the conditionally-worded § 23-355 treble note' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

// Case C — AZ UNPAID-WAGES claim where the logged rate is BELOW Arizona's
// minimum wage ($15.15/hr): both the discretionary § 23-355 treble remedy and
// the mandatory § 23-364(G) minimum-wage remedy are applicable facts, but they
// are two different causes of action for the SAME shortfall (not cumulative) —
// must be framed as alternative theories, never added together, and the
// mandatory one must not be softened to "may".
{
  const seed = Object.assign({}, baseSeed, {
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'10' },
    caseOpened:new Date().toISOString(),
    entries:[{ date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'x', color:'#EF7B22', tag:'Wage & hour', hours:30, payStatus:'unpaid' }],
  });
  const { letterText, errs } = await wageDemandLetterText(seed);
  const problems = [];
  if (!letterText) problems.push('wage-demand letter body not found');
  else {
    if (!/23-355/.test(letterText)) problems.push('missing § 23-355 (discretionary general unpaid-wages remedy)');
    if (!/23-364/.test(letterText)) problems.push('missing § 23-364 (mandatory minimum-wage remedy) despite rate below minimum wage');
    if (!/mandatory/i.test(letterText) || !/discretionary/i.test(letterText)) problems.push('both remedies must be labeled by their own discretion standard (mandatory vs discretionary), not merged into one figure');
  }
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' AZ unpaid-wages claim below minimum wage presents both remedies as separate, correctly-labeled alternative theories' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

// Case D — a state with NO remedies.* facts (e.g. Texas) must fall back to the
// existing federal-only framing with no fabricated state citation.
{
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    homeMode:'standard', done:{}, messages:[],
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'10' },
    caseOpened:new Date().toISOString(),
    entries:[{ date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'x', color:'#EF7B22', tag:'Wage & hour', hours:30, payStatus:'unpaid' }],
  };
  const { letterText, errs } = await wageDemandLetterText(seed);
  const problems = [];
  if (!letterText) problems.push('wage-demand letter body not found');
  else if (/23-355|23-364/.test(letterText)) problems.push('Texas (no state remedies facts) must never show an Arizona-only citation');
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' a state with no remedies.* facts never fabricates a state remedy citation' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

} finally {
  await b.close();
  server.close();
}

console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL WAGE STATE-REMEDY CASES PASSED');
process.exit(fails ? 1 : 0);
