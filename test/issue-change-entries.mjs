#!/usr/bin/env node
/*
 * Evidence-bleed-across-issues regression test (R4, docs/review-2-report.md —
 * the un-fixed half of F11).
 *
 * Changing the issue via the ◉ location/profile pill used to reset the `done`
 * checklist but NOT the logged `entries` — so a new issue silently inherited
 * the prior issue's evidence log (it would count toward the new issue's Case
 * Strength and appear in its exported case file). Save must now warn/confirm
 * and clear `entries` when the pill's edit actually changes the issue; a
 * Cancel-on-the-confirm must discard the whole edit (nothing commits); an
 * issue change with nothing logged, or an edit that leaves the issue
 * unchanged, must not prompt at all.
 *
 * Run: node test/issue-change-entries.mjs
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

try {

async function freshPage(entries) {
  const pg = await b.newPage();
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard',
    entries: entries || [], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  return pg;
}

const oneWageEntry = [{ date:'1/1/2026', iso:new Date().toISOString(), tag:'wage', title:'Unpaid overtime', body:'Worked 6 hours off the clock unpaid.', hours:'6', payStatus:'unpaid' }];

const openPillAndPickIssue = async (pg, newIssueName) => {
  await pg.evaluate(() => { const btn = document.querySelector('button[aria-label^="Edit your state"]'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  const clickContinue = async () => { await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /^Continue$/.test(b.textContent.trim())); if (btn) btn.click(); }); await new Promise(r => setTimeout(r, 200)); };
  await clickContinue(); // step1 (state) -> step2
  await clickContinue(); // step2 (county) -> step3 (issue)
  await pg.evaluate((name) => { const btn = [...document.querySelectorAll('button[role="radio"]')].find(b => b.textContent.includes(name)); if (btn) btn.click(); }, newIssueName);
  await new Promise(r => setTimeout(r, 150));
  await clickContinue(); // step3 -> step4
};

const clickSave = async (pg) => {
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /Save changes/.test(b.textContent.trim())); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 250));
};

// Case 1: changing the issue with entries logged prompts a confirm; accepting
// it commits the new issue AND clears the stale entries.
{
  const pg = await freshPage(oneWageEntry);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const dialogMsgs = [];
  pg.on('dialog', async (d) => { dialogMsgs.push(d.message()); await d.accept(); });

  await openPillAndPickIssue(pg, 'Discrimination');
  await clickSave(pg);

  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}'));
  const problems = [];
  if (dialogMsgs.length !== 1) problems.push('expected exactly one confirm dialog, got ' + dialogMsgs.length);
  if (dialogMsgs[0] && !/clears your 1 logged entry/i.test(dialogMsgs[0])) problems.push('confirm message does not clearly warn about clearing the logged entry: ' + JSON.stringify(dialogMsgs[0]));
  if (stored.issue !== 'Discrimination') problems.push('issue did not commit — got ' + JSON.stringify(stored.issue));
  if (!Array.isArray(stored.entries) || stored.entries.length !== 0) problems.push('entries were NOT cleared on issue change — got ' + JSON.stringify(stored.entries));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' issue change with logged entries: confirm warns, then clears entries on accept' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: dismissing the confirm discards the WHOLE edit — issue and entries
// both stay exactly as they were (not a partial commit).
{
  const pg = await freshPage(oneWageEntry);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  pg.on('dialog', async (d) => { await d.dismiss(); });

  await openPillAndPickIssue(pg, 'Discrimination');
  await clickSave(pg);

  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}'));
  const problems = [];
  if (stored.issue !== 'Unpaid overtime or wages') problems.push('issue should NOT have committed after dismissing the confirm — got ' + JSON.stringify(stored.issue));
  if (!Array.isArray(stored.entries) || stored.entries.length !== 1) problems.push('entries should be untouched after dismissing the confirm — got ' + JSON.stringify(stored.entries));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' dismissing the confirm discards the whole edit (no partial commit)' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3: changing the issue with NO entries logged needs no confirm at all.
{
  const pg = await freshPage([]);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const dialogMsgs = [];
  pg.on('dialog', async (d) => { dialogMsgs.push(d.message()); await d.accept(); });

  await openPillAndPickIssue(pg, 'Discrimination');
  await clickSave(pg);

  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}'));
  const problems = [];
  if (dialogMsgs.length !== 0) problems.push('should not prompt when there is nothing to lose, got ' + dialogMsgs.length + ' dialog(s): ' + JSON.stringify(dialogMsgs));
  if (stored.issue !== 'Discrimination') problems.push('issue did not commit — got ' + JSON.stringify(stored.issue));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' issue change with no logged entries commits silently (no needless prompt)' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 4: an edit that leaves the issue UNCHANGED never prompts and never
// touches entries, even with entries logged.
{
  const pg = await freshPage(oneWageEntry);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const dialogMsgs = [];
  pg.on('dialog', async (d) => { dialogMsgs.push(d.message()); await d.accept(); });

  // Re-pick the SAME issue (no-op change), then Save.
  await openPillAndPickIssue(pg, 'Unpaid overtime or wages');
  await clickSave(pg);

  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}'));
  const problems = [];
  if (dialogMsgs.length !== 0) problems.push('should not prompt when the issue did not change, got ' + dialogMsgs.length + ' dialog(s)');
  if (!Array.isArray(stored.entries) || stored.entries.length !== 1) problems.push('entries should be untouched when the issue did not change — got ' + JSON.stringify(stored.entries));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' an unchanged issue never prompts and never touches entries' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL ISSUE-CHANGE-ENTRIES CASES PASSED');
process.exit(fails ? 1 : 0);
