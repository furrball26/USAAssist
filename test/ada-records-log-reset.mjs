#!/usr/bin/env node
/*
 * "Start a fresh case" / issue-change stale ADA-and-records-log regression test.
 *
 * profile.adaLog (ADA interactive-process tracker entries) and
 * profile.recordsRequest (personnel-file-request tracker) are per-CASE
 * trackers, not durable profile facts — but neither "start a new case" path
 * cleared them: startFreshCase() reset entries/done/letters/chat/doc/wizard
 * but left profile.adaLog/profile.recordsRequest untouched even though its own
 * confirm copy promises a clean slate, and the ◉ location-pill's issue-change
 * save flow committed `editDraft.profile` — a shallow copy of the OLD profile
 * that still carried the old adaLog/recordsRequest. Because buildLetter() and
 * buildCaseFile() read ctx.adaLog/profile.recordsRequest unconditionally for
 * the accommodation-request/complaint letters, a brand-new case could silently
 * render a stale ADA denial (date + notes) left over from an entirely
 * different, prior case.
 *
 * Guards:
 *   1. "Start a fresh case" clears profile.adaLog to [] and profile.recordsRequest
 *      to no-dateSent, and the accommodation-request/complaint letters no
 *      longer mention the old denial or its date.
 *   2. Changing the issue via the ◉ pill + Save does the same, even when there
 *      are no logged `entries` to trigger the entries-loss confirm.
 *
 * Run: node test/ada-records-log-reset.mjs
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

const openLetter = async (pg, kindLabel) => {
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Draft a letter')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  await pg.evaluate((label) => { const btn = [...document.querySelectorAll('button')].find(x => x.textContent.includes(label)); if (btn) btn.click(); }, kindLabel);
  await new Promise(r => setTimeout(r, 300));
  return await pg.evaluate(() => {
    const els = [...document.querySelectorAll('div')].filter(d => d.textContent.includes('To whom it may concern'));
    return els.length ? els[els.length - 1].textContent : null;
  });
};

const staleAdaLog = [
  { date:'2020-02-01', what:'requested', notes:'flexible start time for a prior employer' },
  { date:'2020-02-20', what:'denied', notes:'PRIOR-CASE-DENIAL-STALE-TEXT manager refused outright' },
];
const staleRecordsRequest = { dateSent:'2020-02-01', method:'email', dateReceived:'', noResponseYet:true, produced:'', missing:'PRIOR-CASE-MISSING-STALE-TEXT' };

try {

// Case 1: "Start a fresh case" clears profile.adaLog/profile.recordsRequest,
// and the new case's letters no longer carry the stale denial.
{
  const seed = {
    onboarded:true, stateSel:'California', county:'Los Angeles County', issue:'Discrimination',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20', adaLog: staleAdaLog, recordsRequest: staleRecordsRequest },
    caseOpened:'2020-01-01T00:00:00.000Z', homeMode:'standard', entries:[], done:{}, messages:[],
  };
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  pg.on('dialog', d => d.accept());
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Start a fresh case'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 400));

  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}'));
  const problems = [];
  if (stored.profile.employer !== 'Northgate Co') problems.push('profile was over-cleared, should survive "start a fresh case"');
  if (!Array.isArray(stored.profile.adaLog) || stored.profile.adaLog.length !== 0) problems.push('profile.adaLog was NOT cleared: ' + JSON.stringify(stored.profile.adaLog));
  if (stored.profile.recordsRequest && stored.profile.recordsRequest.dateSent) problems.push('profile.recordsRequest was NOT cleared: ' + JSON.stringify(stored.profile.recordsRequest));

  const accText = await openLetter(pg, 'Accommodation request');
  if (accText && /PRIOR-CASE-DENIAL-STALE-TEXT/.test(accText)) problems.push('accommodation-request letter still contains the stale prior-case ADA denial text');
  if (accText && /2020-02-20|Feb(ruary)? 20, 2020/i.test(accText)) problems.push('accommodation-request letter still references the stale prior-case denial date');

  await pg.evaluate(() => { const b2 = [...document.querySelectorAll('button')].find(x => x.textContent === 'Home'); b2 && b2.click(); });
  await new Promise(r => setTimeout(r, 300));
  const complaintText = await openLetter(pg, 'Complaint letter');
  if (complaintText && /PRIOR-CASE-DENIAL-STALE-TEXT/.test(complaintText)) problems.push('complaint letter still contains the stale prior-case ADA denial text');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' "Start a fresh case" clears profile.adaLog/recordsRequest; no stale denial in letters' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: changing the issue via the ◉ pill + Save clears profile.adaLog/
// profile.recordsRequest too — even with no logged `entries` to trigger the
// separate entries-loss confirm.
{
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20', adaLog: staleAdaLog, recordsRequest: staleRecordsRequest },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const dialogMsgs = [];
  pg.on('dialog', async (d) => { dialogMsgs.push(d.message()); await d.accept(); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  await pg.evaluate(() => { const btn = document.querySelector('button[aria-label^="Edit your state"]'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  const clickContinue = async () => { await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /^Continue$|Save changes/.test(b.textContent.trim())); if (btn) btn.click(); }); await new Promise(r => setTimeout(r, 250)); };
  await clickContinue(); // state (unchanged) -> county
  await clickContinue(); // county (unchanged) -> issue
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button[role="radio"]')].find(b => b.textContent.includes('Discrimination')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 150));
  await clickContinue(); // issue -> details
  await clickContinue(); // Save changes

  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}'));
  const problems = [];
  if (dialogMsgs.length !== 0) problems.push('unexpected confirm dialog(s) with no entries logged: ' + JSON.stringify(dialogMsgs));
  if (stored.issue !== 'Discrimination') problems.push('issue did not commit — got ' + JSON.stringify(stored.issue));
  if (stored.profile.employer !== 'Northgate Co') problems.push('profile was over-cleared on issue change, should survive');
  if (!Array.isArray(stored.profile.adaLog) || stored.profile.adaLog.length !== 0) problems.push('profile.adaLog was NOT cleared on issue change: ' + JSON.stringify(stored.profile.adaLog));
  if (stored.profile.recordsRequest && stored.profile.recordsRequest.dateSent) problems.push('profile.recordsRequest was NOT cleared on issue change: ' + JSON.stringify(stored.profile.recordsRequest));

  const accText = await openLetter(pg, 'Accommodation request');
  if (accText && /PRIOR-CASE-DENIAL-STALE-TEXT/.test(accText)) problems.push('accommodation-request letter still contains the stale prior-issue ADA denial text');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' issue change via the ◉ pill clears profile.adaLog/recordsRequest; no stale denial in letters' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL ADA/RECORDS-REQUEST LOG RESET CASES PASSED');
process.exit(fails ? 1 : 0);
