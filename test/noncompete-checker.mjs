#!/usr/bin/env node
/*
 * Non-compete enforceability checker regression test.
 *
 * Guards the new document-review tool (see NonCompeteChecker in index.dev.html):
 *
 *   1. For a state WITH a sourced nonCompete.enforceability fact (e.g. California —
 *      see content/states/CA.json), the checker shows the enforceability stance
 *      (value + summary), its citation, a "Source ↗" link, and the federal
 *      nonCompete.ftcRuleStatus note — all pulled live via factByTopic, never
 *      hardcoded.
 *   2. For a state WITH NO nonCompete.enforceability fact (e.g. Alabama), the
 *      checker shows the honest "we don't have a sourced answer" copy and does
 *      NOT fabricate or leak a stance/citation from another state.
 *   3. The tool ("Is my non-compete enforceable?") is gated to the document-review
 *      issue — absent on a wage case's dashboard, present on a document case's —
 *      same gating pattern as the wage/harassment/discrimination self-checks.
 *
 * Run: node test/noncompete-checker.mjs
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
const seedFor = (issueName, stateSel, homeMode) => ({
  onboarded:true, stateSel, county: stateSel === 'California' ? 'Los Angeles County' : 'Jefferson County',
  issue:issueName,
  profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
  caseOpened:new Date().toISOString(), homeMode:homeMode || 'standard', done:{}, messages:[], entries:[],
});
const DOC_ISSUE = 'A document to review';
const TOOL_LABEL = 'Is my non-compete enforceable?';

const newPage = async () => {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  return { pg, errs };
};

try {

// 1. Covered state (California) — shows a real stance, citation, source link, and
//    the federal FTC-rule-status note.
{
  const { pg, errs } = await newPage();
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seedFor(DOC_ISSUE, 'California'));
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  await click(pg, TOOL_LABEL);
  await new Promise(r => setTimeout(r, 300));
  const text = await bodyText(pg);
  const sourceHref = await pg.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find(el => el.textContent.includes('Source'));
    return a ? a.getAttribute('href') : null;
  });

  const problems = [];
  if (!/void|banned|voidable/i.test(text)) problems.push('missing the California enforceability stance (banned/voidable), got: ' + JSON.stringify(text.slice(0, 800)));
  if (!/16600/.test(text)) problems.push('missing the Cal. Bus. & Prof. Code § 16600 citation');
  if (!sourceHref || !/^https:\/\//.test(sourceHref)) problems.push('missing a "Source ↗" link with an https:// href, got: ' + sourceHref);
  if (!/FTC/i.test(text)) problems.push('missing the federal FTC rule-status note');
  if (!/state law/i.test(text)) problems.push('FTC note should explain enforceability is governed by state law');
  if (!/not legal advice/i.test(text)) problems.push('missing the not-legal-advice framing');
  if (!/what courts generally weigh/i.test(text)) problems.push('missing the general reasonableness-factors note');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' covered state (California) shows a sourced stance + citation + source link + FTC status' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 2. Uncovered state (Alabama has no nonCompete.enforceability fact) — honest
//    "no sourced answer" copy, never a fabricated/leaked stance.
{
  const { pg, errs } = await newPage();
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seedFor(DOC_ISSUE, 'Alabama'));
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  await click(pg, TOOL_LABEL);
  await new Promise(r => setTimeout(r, 300));
  const text = await bodyText(pg);

  const problems = [];
  if (!/don.t have a sourced answer for Alabama/i.test(text)) problems.push('missing the honest "no sourced answer for Alabama" message, got: ' + JSON.stringify(text.slice(0, 800)));
  if (!/talk to an employment attorney/i.test(text)) problems.push('missing the "talk to an employment attorney" hedge');
  if (/16600/.test(text)) problems.push('leaked California\'s § 16600 citation into an uncovered state');
  if (/banned\/voidable/i.test(text)) problems.push('fabricated/leaked a specific enforceability stance for an uncovered state');
  if (/\(DRAFT\)/.test(text) && !/don.t have a sourced answer/i.test(text)) problems.push('should not show a per-state DRAFT fact card when there is no fact to show');
  if (!/FTC/i.test(text)) problems.push('federal FTC note should still show even when the state has no fact');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' uncovered state (Alabama) shows the honest "no sourced answer" message, never a fabricated stance' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 3. Tool is gated to the document-review issue — absent on a wage dashboard,
//    present on a document dashboard (Standard mode Tools grid).
{
  const { pg: pgWage, errs: errsWage } = await newPage();
  await pgWage.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seedFor('Unpaid overtime or wages', 'Texas'));
  await gotoApp(pgWage, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  const wageHome = await bodyText(pgWage);
  await pgWage.close();

  const { pg: pgDoc, errs: errsDoc } = await newPage();
  await pgDoc.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seedFor(DOC_ISSUE, 'Texas'));
  await gotoApp(pgDoc, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  const docHome = await bodyText(pgDoc);
  await pgDoc.close();

  const problems = [];
  if (wageHome.includes(TOOL_LABEL)) problems.push('wage dashboard wrongly offers the non-compete checker tool');
  if (!docHome.includes(TOOL_LABEL)) problems.push('document-review dashboard is missing the non-compete checker tool');
  errsWage.forEach(e => problems.push('wage: ' + e));
  errsDoc.forEach(e => problems.push('doc: ' + e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' "Is my non-compete enforceable?" tool is gated to the document-review issue' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

// 4. The doc-review clause scanner's flagged non-compete clause links straight
//    into the checker.
{
  const { pg, errs } = await newPage();
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seedFor(DOC_ISSUE, 'California'));
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  await click(pg, 'Review a document');
  await new Promise(r => setTimeout(r, 300));
  await pg.evaluate(() => {
    const ta = document.getElementById('doc-text');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'Employee agrees not to compete with the Company or work for a competitor for 12 months after termination.');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 300));

  const textAfterScan = await bodyText(pg);
  const hasLink = textAfterScan.includes('Is my non-compete enforceable?');

  await click(pg, 'Is my non-compete enforceable? →');
  await new Promise(r => setTimeout(r, 300));
  const textAfterClick = await bodyText(pg);

  const problems = [];
  if (!/Non-compete \/ restrictive covenant/.test(textAfterScan)) problems.push('pasted non-compete text was not flagged by the scanner, got: ' + JSON.stringify(textAfterScan.slice(0, 600)));
  if (!hasLink) problems.push('flagged non-compete clause is missing the CTA into the checker');
  if (!/what courts generally weigh/i.test(textAfterClick)) problems.push('clicking the CTA did not land on the checker screen');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' flagged non-compete clause links into the enforceability checker' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL NON-COMPETE CHECKER CASES PASSED');
process.exit(fails ? 1 : 0);
