#!/usr/bin/env node
/*
 * All-tools screen regression test (fanout fix — TOOL_CATALOGUE / AllTools).
 *
 * Home's "More tools" shelf gates each tile to the ONE issue it was built
 * for (cfg.key === 'wage' / 'harassment' / 'discrimination' / 'document' /
 * 'termination'), so a case filed under a different issue had NO path at all
 * to the non-compete checker, damages estimator, records-request tracker or
 * ADA process tracker — four fully-built, tested tools that were dead ends
 * for most users. The new "All tools" screen (nav('allTools'), reached via a
 * full-width "See all N tools" row under the Home shelf) lists every tool
 * the app has, grouped by intent, with the same per-issue gates preserved as
 * a SUGGESTED-chip hint rather than a hard lock.
 *
 * Covers:
 *   1. A wage case — the regression called out by name — can reach the
 *      non-compete checker, damages estimator, records-request tracker and
 *      ADA process tracker from Home via "See all tools", none of which its
 *      own issue-gated Tools shelf ever offers it. Also sweeps the rest of
 *      the always-reachable catalogue (log, review a document, draft a
 *      letter, agencies, case strength, chat) for the same case.
 *   2. Browser Back from All tools returns to the Dashboard.
 *   3. The SUGGESTED chip marks exactly the tools each issue's ORIGINAL
 *      Home-shelf gate already pointed at, for every issue type — and every
 *      one of the 13 catalogue tools is listed for every issue (nothing is
 *      hidden, unlike the old shelf).
 *   4. The three self-checks (overtime exemption / harassment / discrimination
 *      identifier) share ONE stateful Q&A engine keyed to the case's actual
 *      issue (wizNode/wizPath IS the case's own self-check progress — see the
 *      TOOL_CATALOGUE comment in index.dev.html). Tapping the one that
 *      matches the case's issue opens the real, correctly-labeled wizard;
 *      tapping a mismatched one shows an explanation in place and never
 *      touches wizNode — so exploring a different issue's self-check can
 *      never silently overwrite the case's real, already-answered one.
 *
 * Run: node test/all-tools.mjs
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

const click = async (pg, t) => { const found = await pg.evaluate((x) => { const e = [...document.querySelectorAll('button,a')].find(el => el.textContent.includes(x)); if (e) e.click(); return !!e; }, t); await new Promise(r => setTimeout(r, 300)); return found; };
const bodyText = async (pg) => pg.evaluate(() => document.body.innerText);
const newPage = async () => {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  return { pg, errs };
};
const seedAndOpen = async (pg, issue, extra = {}) => {
  const seed = Object.assign({
    onboarded:true, stateSel:'Texas', county:'Travis County', issue,
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  }, extra);
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
};

// The 13-tool catalogue, mirrored from TOOL_CATALOGUE in index.dev.html —
// label + which issue key (if any) the old Home-shelf gate suggests it for.
const CATALOGUE = [
  { label:'Am I exempt from overtime?', suggestedFor:['wage'] },
  { label:'Is this harassment?', suggestedFor:['harassment'] },
  { label:'Is this discrimination?', suggestedFor:['discrimination'] },
  { label:'Review a document', suggestedFor:null },
  { label:'Is my non-compete enforceable?', suggestedFor:['document'] },
  { label:'Log an incident or hours', suggestedFor:null },
  { label:'Understand your case', suggestedFor:null },
  { label:'Track my records request', suggestedFor:['termination'] },
  { label:'Track the ADA process', suggestedFor:['discrimination'] },
  { label:'Draft a letter', suggestedFor:null },
  { label:'Estimate possible damages', suggestedFor:['termination','harassment','discrimination'] },
  { label:'Where to file a complaint', suggestedFor:null },
  { label:'Ask a question', suggestedFor:null },
];

try {

// 1. Wage case can reach every tool via "See all tools" — the named
//    regression (non-compete/damages/records/ADA) plus the rest of the
//    always-on catalogue.
{
  const { pg, errs } = await newPage();
  await seedAndOpen(pg, 'Unpaid overtime or wages');
  const problems = [];

  const homeText = await bodyText(pg);
  if (!/See all 13 tools/.test(homeText)) problems.push('Home is missing the "See all 13 tools" row, or the count is wrong: ' + JSON.stringify(homeText.match(/See all \d+ tools/)));
  // The regression itself: none of these four exist anywhere on the wage
  // dashboard today (confirmed by process-trackers.mjs/damages-estimator.mjs/
  // noncompete-checker.mjs asserting they're gated OFF wage) — so reaching
  // them at all has to go through "See all tools".
  ['Is my non-compete enforceable?', 'Estimate possible damages', 'Track my records request', 'Track the ADA process'].forEach(l => {
    if (homeText.includes(l)) problems.push('"' + l + '" unexpectedly already on the wage Home dashboard — regression setup invalid');
  });

  // Each tool's own "back" link targets wherever it's normally reached FROM
  // (e.g. the non-compete checker's back link reads "Document review", not
  // "Dashboard", since it's normally reached from Doc) — use the tab bar's
  // Home button to get back for the next tap instead of relying on any one
  // tool's specific back-link label.
  const goHome = async () => { await pg.evaluate(() => { const b = [...document.querySelectorAll('.tabbar-btn')].find(x => x.textContent.includes('Home')); if (b) b.click(); }); await new Promise(r => setTimeout(r, 300)); };
  const openAllTools = async () => { await click(pg, 'See all 13 tools'); const t = await bodyText(pg); if (!/^All tools/m.test(t) && !t.includes('All tools')) problems.push('"See all tools" row did not open the All-tools screen'); };

  await openAllTools();
  const allToolsText = await bodyText(pg);
  CATALOGUE.forEach(t => { if (!allToolsText.includes(t.label)) problems.push('All tools is missing "' + t.label + '" for a wage case'); });

  // Non-compete checker.
  await click(pg, 'Is my non-compete enforceable?');
  let t = await bodyText(pg);
  if (!t.includes('Is my non-compete enforceable?') || !/reasonableness|enforceab/i.test(t)) problems.push('non-compete checker did not render from All tools on a wage case');
  await goHome();

  // Damages estimator — and the copy fix: a wage case must not be told this
  // is "a discrimination claim" (the pre-existing ternary only knew
  // harassment/discrimination; see the DamagesEstimator patch).
  await openAllTools();
  await click(pg, 'Estimate possible damages');
  t = await bodyText(pg);
  if (!t.includes('What damages might apply?')) problems.push('damages estimator did not render from All tools on a wage case');
  if (!/a wage claim may include/.test(t)) problems.push('damages estimator on a wage case does not use wage-labeled copy: ' + JSON.stringify(t.slice(0, 400)));
  if (/a discrimination claim may include/.test(t)) problems.push('damages estimator on a wage case wrongly shows discrimination-labeled copy');
  await goHome();

  // Records-request tracker.
  await openAllTools();
  await click(pg, 'Track my records request');
  t = await bodyText(pg);
  if (!t.includes('Track your records request')) problems.push('records-request tracker did not render from All tools on a wage case');
  await goHome();

  // ADA process tracker.
  await openAllTools();
  await click(pg, 'Track the ADA process');
  t = await bodyText(pg);
  if (!t.includes('Track the interactive process')) problems.push('ADA process tracker did not render from All tools on a wage case');
  await goHome();

  // Rest of the always-on catalogue, for completeness.
  await openAllTools();
  await click(pg, 'Review a document');
  t = await bodyText(pg);
  if (!t.includes('Review a document')) problems.push('doc review did not render from All tools');
  await goHome();

  await openAllTools();
  await click(pg, 'Draft a letter');
  t = await bodyText(pg);
  if (!t.includes('A template you send yourself.')) problems.push('letter screen did not render from All tools on a wage case (previously unreachable — the shelf hides "Draft a letter" for wage)');
  await goHome();

  await openAllTools();
  await click(pg, 'Where to file a complaint');
  t = await bodyText(pg);
  // move 4 (235806c) retitled the Agencies screen "Take action" (PHASE 4 · ACT)
  // as part of unifying it into the take-action hub; it no longer headlines
  // "Where to file a complaint" verbatim, so assert on the new heading plus
  // the still-present agency-links section instead.
  if (!t.includes('Take action') || !t.includes('File directly with the enforcing agencies')) problems.push('agencies ("Take action" hub) did not render from All tools');
  await goHome();

  await openAllTools();
  await click(pg, 'Understand your case');
  t = await bodyText(pg);
  if (!t.includes('Understand your case')) problems.push('case strength did not render from All tools');
  await goHome();

  await openAllTools();
  await click(pg, 'Ask a question');
  const chatOnPage = await pg.evaluate(() => { const b = document.querySelector('.tabbar-btn[aria-current="page"]'); return b && b.textContent; });
  if (!/ask ai/i.test(chatOnPage || '')) problems.push('chat did not become the active tab from All tools, got: ' + JSON.stringify(chatOnPage));
  await goHome();

  await openAllTools();
  await click(pg, 'Log an incident or hours');
  const logOnPage = await pg.evaluate(() => { const b = document.querySelector('.tabbar-btn[aria-current="page"]'); return b && b.textContent; });
  if (!/log/i.test(logOnPage || '')) problems.push('log did not become the active tab from All tools, got: ' + JSON.stringify(logOnPage));

  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' wage case reaches every tool (incl. non-compete/damages/records/ADA) via "See all tools"' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 2. Browser Back from All tools returns to the Dashboard.
{
  const { pg, errs } = await newPage();
  await seedAndOpen(pg, 'Unpaid overtime or wages');
  const problems = [];
  await click(pg, 'See all 13 tools');
  let t = await bodyText(pg);
  if (!t.includes('All tools')) problems.push('did not land on All tools');
  await pg.goBack();
  await new Promise(r => setTimeout(r, 300));
  t = await bodyText(pg);
  if (!/CASE #/.test(t)) problems.push('Back from All tools did not return to the Dashboard: ' + JSON.stringify(t.slice(0, 200)));
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Back from All tools returns to the Dashboard' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 3. SUGGESTED chip marks exactly the old per-issue gate's tools, for every
//    issue type — and nothing is ever hidden (all 13 rows, every issue).
{
  const ISSUE_NAMES = { wage:'Unpaid overtime or wages', harassment:'Harassment or a hostile workplace', discrimination:'Discrimination', termination:'Fired or pushed out', document:'A document to review' };
  for (const key of Object.keys(ISSUE_NAMES)) {
    const { pg, errs } = await newPage();
    await seedAndOpen(pg, ISSUE_NAMES[key]);
    const problems = [];
    await click(pg, 'See all'); // matches "See all N tools" regardless of N
    const ok1 = await bodyText(pg);
    if (!ok1.includes('All tools')) problems.push('could not open All tools for issue ' + key);

    for (const tool of CATALOGUE) {
      const info = await pg.evaluate((lbl) => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes(lbl));
        return btn ? { present:true, suggested: btn.textContent.includes('SUGGESTED') } : { present:false, suggested:false };
      }, tool.label);
      if (!info.present) problems.push('"' + tool.label + '" is missing from All tools for issue "' + key + '" (should never be hidden)');
      const shouldBeSuggested = Array.isArray(tool.suggestedFor) && tool.suggestedFor.includes(key);
      if (info.present && info.suggested !== shouldBeSuggested) {
        problems.push('"' + tool.label + '" SUGGESTED=' + info.suggested + ' for issue "' + key + '", expected ' + shouldBeSuggested);
      }
    }
    errs.forEach(e => problems.push(e));
    const ok = problems.length === 0;
    if (!ok) fails++;
    console.log((ok ? '✅' : '❌') + ' issue "' + key + '": all 13 tools listed, SUGGESTED chip matches the old gate' + (ok ? '' : '\n   ' + problems.join('\n   ')));
    await pg.close();
  }
}

// 4. The three self-checks share one stateful engine keyed to the case's
//    real issue — matching self-check opens the real wizard; a mismatched
//    one shows an explanation instead and never touches wizNode/wizPath.
{
  const { pg, errs } = await newPage();
  await seedAndOpen(pg, 'Unpaid overtime or wages'); // wage case
  const problems = [];
  await click(pg, 'See all 13 tools');

  // Mismatched: "Is this harassment?" on a wage case.
  await click(pg, 'Is this harassment?');
  let t = await bodyText(pg);
  if (!t.includes('All tools')) problems.push('tapping a mismatched self-check navigated away from All tools instead of explaining in place');
  if (!/built for a case filed as "Harassment/.test(t)) problems.push('mismatched self-check explanation is missing/wrong: ' + JSON.stringify(t.slice(0, 600)));
  if (!/Unpaid overtime & wages/.test(t)) problems.push('mismatched self-check explanation does not name the case\'s actual issue');
  const wizAfterMismatch = await pg.evaluate(() => (JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').wizNode));
  if (wizAfterMismatch !== 'start' && wizAfterMismatch != null) problems.push('exploring a mismatched self-check touched the shared wizNode: ' + JSON.stringify(wizAfterMismatch));

  // Matching: "Am I exempt from overtime?" on the same wage case opens the
  // real, correctly-labeled wizard.
  await click(pg, 'Am I exempt from overtime?');
  t = await bodyText(pg);
  if (!/OVERTIME EXEMPTION CHECK/.test(t)) problems.push('matching self-check did not open the real overtime-exemption wizard: ' + JSON.stringify(t.slice(0, 300)));
  if (!t.includes('How are you paid?')) problems.push('matching self-check wizard did not show its first question');

  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' mismatched self-check explains in place (no wizNode corruption); matching self-check opens the real wizard' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL ALL-TOOLS CASES PASSED');
process.exit(fails ? 1 : 0);
