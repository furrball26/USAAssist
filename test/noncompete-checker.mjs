#!/usr/bin/env node
/*
 * Non-compete enforceability checker regression test.
 *
 * Guards the new document-review tool (see NonCompeteChecker in index.dev.html):
 *
 *   1. For a state WITH a sourced nonCompete.enforceability fact (e.g. California —
 *      see content/states/CA.json), the checker shows the enforceability stance
 *      (value + summary), its citation, a link to the official source, and the federal
 *      nonCompete.ftcRuleStatus note — all pulled live via factByTopic, never
 *      hardcoded.
 *   2. For a state WITH NO nonCompete.enforceability fact (e.g. Alabama), the
 *      checker shows the honest "we don't have a sourced answer" copy and does
 *      NOT fabricate or leak a stance/citation from another state.
 *   3. The tool ("Is my non-compete enforceable?") is gated to the Leaving a job
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
// The check hangs off the law topic it belongs to now, not a case's issue.
const TOOL_LABEL = 'Is my non-compete enforceable?';
// The check hangs off the law topic it belongs to now, not a case's issue.
const openCheck = async (pg) => {
  await click(pg, 'Leaving a job');
  await new Promise(r => setTimeout(r, 350));
  await click(pg, TOOL_LABEL);
  await new Promise(r => setTimeout(r, 400));
};

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
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`, { place: { state: 'California', county: '—' } });
  await new Promise(r => setTimeout(r, 700));

  await openCheck(pg);
  await new Promise(r => setTimeout(r, 300));
  const text = await bodyText(pg);
  // Matched on the link's PURPOSE, not its wording. This screen renders the
  // shared factCard(), whose outbound label is a presentation detail that has
  // already changed once ("Source ↗" -> "Read the official text ↗"); what must
  // hold is that the sourced stance carries an https:// link to the official
  // source, which is what makes it sourced at all.
  const sourceHref = await pg.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find(el =>
      /source|official text/i.test((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')));
    return a ? a.getAttribute('href') : null;
  });

  const problems = [];
  if (!/void|banned|voidable/i.test(text)) problems.push('missing the California enforceability stance (banned/voidable), got: ' + JSON.stringify(text.slice(0, 800)));
  if (!/16600/.test(text)) problems.push('missing the Cal. Bus. & Prof. Code § 16600 citation');
  if (!sourceHref || !/^https:\/\//.test(sourceHref)) problems.push('missing an https:// link to the official source, got: ' + sourceHref);
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
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`, { place: { state: 'Alabama', county: '—' } });
  await new Promise(r => setTimeout(r, 700));

  await openCheck(pg);
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

// 3. The check lives under Leaving a job, and nowhere else.
{
  const { pg, errs } = await newPage();
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`, { place: { state: 'Texas', county: '—' } });
  await new Promise(r => setTimeout(r, 800));
  const grid = await bodyText(pg);

  await click(pg, 'Pay & overtime');
  await new Promise(r => setTimeout(r, 400));
  const payTopic = await bodyText(pg);
  await click(pg, 'All topics');
  await new Promise(r => setTimeout(r, 400));
  await click(pg, 'Leaving a job');
  await new Promise(r => setTimeout(r, 400));
  const leavingTopic = await bodyText(pg);
  await pg.close();

  const problems = [];
  if (grid.includes(TOOL_LABEL)) problems.push('the topic grid itself offers the non-compete check, before any topic is opened');
  if (payTopic.includes(TOOL_LABEL)) problems.push('the pay topic wrongly offers the non-compete check');
  if (!leavingTopic.includes(TOOL_LABEL)) problems.push('the Leaving a job topic is missing the non-compete check');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' "' + TOOL_LABEL + '" lives under Leaving a job only' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

// (The fourth case here used to walk from the document-review clause scanner
// into this checker. Document review is gone, so that path no longer exists;
// the checker is reached from the Leaving a job topic, covered by case 3.)

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL NON-COMPETE CHECKER CASES PASSED');
process.exit(fails ? 1 : 0);
