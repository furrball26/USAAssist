#!/usr/bin/env node
/*
 * Discrimination self-check identifier regression test.
 *
 * Guards the guided branching Q&A added for issueKey==='discrimination',
 * modeled on the existing FLSA overtime-exemption wizard (TREE_WAGE/
 * RESULTS_WAGE — see WIZARD_CONFIG/wizardConfigFor in index.dev.html):
 *
 *   1. The "Is this discrimination?" tool is shown ONLY on a discrimination
 *      case's dashboard (cfg.key === 'discrimination'), never on a wage
 *      case's — same gating as the wage wizard's "Am I exempt from
 *      overtime?" tile.
 *   2. Driving the tree to two different terminal answers ("employer under
 *      15 employees — federal coverage gap" and "protected class + adverse
 *      action + comparator — has the shape of a claim") renders a cited,
 *      non-conclusory result (hedged language — "may", "generally" —
 *      never a definitive legal conclusion).
 *   3. Every result carries the not-legal-advice framing and the EEOC
 *      deadline block (deadlines.eeocCharge), same as the wage wizard.
 *
 * Run: node test/discrimination-identifier.mjs
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
const seedFor = (issueName, homeMode) => ({
  onboarded:true, stateSel:'Texas', county:'Travis County', issue:issueName,
  profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
  caseOpened:new Date().toISOString(), homeMode:homeMode || 'standard', done:{}, messages:[], entries:[],
});
const NOT_LEGAL_ADVICE_RE = /not a legal opinion about your situation.{0,40}talk to an attorney/i;
const DEFINITIVE_CLAIM_RE = /\byou (have|are entitled to|will (win|recover)|definitely)\b/i;

try {

// 1. The tool is absent on a wage case's dashboard, present on a discrimination case's.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seedFor('Unpaid overtime or wages'));
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  const wageHome = await bodyText(pg);
  await pg.close();

  const pg2 = await b.newPage();
  pg2.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg2.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg2.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seedFor('Discrimination'));
  await gotoApp(pg2, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  const discHome = await bodyText(pg2);
  await pg2.close();

  const problems = [];
  if (/Is this discrimination\?/.test(wageHome)) problems.push('wage dashboard wrongly offers the discrimination identifier tool');
  if (!/Is this discrimination\?/.test(discHome)) problems.push('discrimination dashboard is missing the "Is this discrimination?" tool');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' "Is this discrimination?" tool is discrimination-only' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

// 2. Terminal result A — employer under 15 employees, federal coverage gap.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seedFor('Discrimination'));
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  await click(pg, 'Is this discrimination?');
  await click(pg, 'One of those is involved');
  await click(pg, 'Fewer than 15');
  await new Promise(r => setTimeout(r, 300));

  const text = await bodyText(pg);
  const problems = [];
  if (!/coverage/i.test(text)) problems.push('missing the employer-coverage explanation, got: ' + JSON.stringify(text.slice(0, 500)));
  if (!/\bmay\b/i.test(text)) problems.push('result reads as a flat statement, not hedged ("may")');
  if (DEFINITIVE_CLAIM_RE.test(text)) problems.push('result reads as a definitive legal conclusion');
  if (!/42 U\.S\.C\./.test(text)) problems.push('missing a citation');
  if (!NOT_LEGAL_ADVICE_RE.test(text)) problems.push('missing the not-legal-advice framing');
  if (!/DEADLINE WATCH/.test(text)) problems.push('missing the deadline block');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' terminal result: employer coverage gap' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 3. Terminal result B — protected class, 15+ employer, fired, comparator treated
//    better -> "has the shape of a discrimination claim".
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seedFor('Discrimination'));
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  await click(pg, 'Is this discrimination?');
  await click(pg, 'One of those is involved');
  await click(pg, '15 or more');
  await click(pg, 'Fired');
  await click(pg, 'Yes, someone was treated better');
  await new Promise(r => setTimeout(r, 300));

  const text = await bodyText(pg);
  const problems = [];
  if (!/shape of a discrimination claim/i.test(text)) problems.push('expected the "has the shape of a discrimination claim" result, got: ' + JSON.stringify(text.slice(0, 500)));
  if (!/\bmay\b/i.test(text) && !/generally/i.test(text)) problems.push('result reads as a flat statement, not hedged');
  if (DEFINITIVE_CLAIM_RE.test(text)) problems.push('result reads as a definitive legal conclusion');
  if (!/2000e-2|Bostock/i.test(text)) problems.push('missing a citation');
  if (!NOT_LEGAL_ADVICE_RE.test(text)) problems.push('missing the not-legal-advice framing');
  if (!/DEADLINE WATCH/.test(text)) problems.push('missing the deadline block');
  if (!/Log this decision/.test(text) || !/Draft a complaint letter/.test(text)) problems.push('missing the onward CTAs (log this decision / draft a complaint letter)');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' terminal result: has the shape of a discrimination claim' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL DISCRIMINATION IDENTIFIER CASES PASSED');
process.exit(fails ? 1 : 0);
