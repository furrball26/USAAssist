#!/usr/bin/env node
/*
 * Process trackers regression test (Aug 2026 — wl-builder).
 *
 * The app generated one-shot letters for a records request (buildLetter's
 * records-request kind, gated to termination) and an ADA accommodation
 * request (accommodation-request kind, gated to discrimination) but never
 * tracked the multi-step PROCESS that follows either letter. Covers the two
 * new lightweight trackers:
 *
 *   1. RecordsRequestTracker ("Track my records request", gated to
 *      termination) — persists profile.recordsRequest, renders a status line
 *      ("Request sent ... — no response yet"), survives reload, and appears
 *      in the exported case file's RECORDS REQUEST section.
 *   2. AdaProcessTracker ("Track the ADA process", gated to discrimination
 *      AND harassment — letterKindsFor grants both issues the same
 *      accommodation-request Letter tab, so both need a way to log a real
 *      request/denial for that letter to reference) — persists profile.adaLog
 *      as an ordered array, renders entries in the order they were logged,
 *      survives reload, and appears in the exported case file's ADA
 *      INTERACTIVE PROCESS section, in order.
 *
 * Also guards that each tile is gated to its own issue(s) only (not offered on
 * a wage/other-issue dashboard, and not offered for the other tracker).
 *
 * Run: node test/process-trackers.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { resolveChromePath } from './lib/chrome.mjs';
import puppeteer from 'puppeteer-core';
import { gotoApp, reloadApp } from './lib/nav.mjs';

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
const typeIntoField = async (pg, selector, text) => { await pg.evaluate((sel) => document.querySelector(sel).focus(), selector); await pg.keyboard.type(text, { delay: 5 }); };
const newPage = async () => {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  return { pg, errs };
};
// Same window.open-capture pattern as case-file-packet.mjs / export-path-message.mjs.
const armExportCapture = async (pg) => {
  await pg.evaluateOnNewDocument(() => {
    window.__capturedDoc = null;
    window.open = () => ({ document: { write: (html) => { window.__capturedDoc = html; }, close: () => {} }, focus: () => {}, print: () => {} });
  });
};
const captureExport = async (pg) => {
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('.tabbar-btn')].find(b => b.textContent.includes('Agencies')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 400));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Download your case file')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 400));
  return pg.evaluate(() => window.__capturedDoc);
};

try {

// 1. Records-request tracker — gated to termination; persists; status line;
//    survives reload; appears in the export.
{
  const { pg, errs } = await newPage();
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Fired or pushed out',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await armExportCapture(pg);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  const problems = [];
  const homeText = await bodyText(pg);
  if (!homeText.includes('Track my records request')) problems.push('termination dashboard is missing the records-request tracker tile');
  if (homeText.includes('Track the ADA process')) problems.push('termination dashboard wrongly offers the ADA process tracker tile');

  await click(pg, 'Track my records request');
  await new Promise(r => setTimeout(r, 300));

  await typeIntoField(pg, '#rr-date-sent', '03032026');
  await click(pg, 'Certified mail');
  await click(pg, 'No response yet');
  await pg.evaluate(() => { document.querySelector('#rr-missing').focus(); });
  await pg.keyboard.type('time records', { delay: 5 });
  await new Promise(r => setTimeout(r, 200));

  const trackerText = await bodyText(pg);
  if (!/Request sent March 3, 2026/i.test(trackerText)) problems.push('status line missing the expected sent date: ' + JSON.stringify(trackerText.slice(0, 700)));
  if (!/no response/i.test(trackerText)) problems.push('status line missing "no response" phrasing');

  const stored = await pg.evaluate(() => (JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').profile || {}));
  if (!stored.recordsRequest || stored.recordsRequest.dateSent !== '2026-03-03') problems.push('records request did not persist to profile.recordsRequest: ' + JSON.stringify(stored.recordsRequest));
  else {
    if (stored.recordsRequest.method !== 'Certified mail') problems.push('method did not persist: ' + JSON.stringify(stored.recordsRequest));
    if (stored.recordsRequest.noResponseYet !== true) problems.push('noResponseYet did not persist as true: ' + JSON.stringify(stored.recordsRequest));
    if (stored.recordsRequest.missing !== 'time records') problems.push('"what\'s missing" note did not persist: ' + JSON.stringify(stored.recordsRequest));
  }

  // Survives reload. The seeding evaluateOnNewDocument callback above re-fires
  // on every navigation (including reload) and would otherwise stomp the
  // tracker data just entered via the UI back to the original seed — persist
  // the CURRENT localStorage blob via a second onNewDocument callback (runs
  // after the first, same key, last write wins) before reloading.
  const currentBlob = await pg.evaluate(() => localStorage.getItem('worklaw.case.v2'));
  await pg.evaluateOnNewDocument((s) => localStorage.setItem('worklaw.case.v2', s), currentBlob);
  await reloadApp(pg);
  await new Promise(r => setTimeout(r, 700));
  await click(pg, 'Track my records request');
  await new Promise(r => setTimeout(r, 300));
  const afterReload = await bodyText(pg);
  if (!/no response/i.test(afterReload)) problems.push('records-request tracker did not survive reload (status line gone)');
  const dateVal = await pg.evaluate(() => document.querySelector('#rr-date-sent')?.value);
  if (dateVal !== '2026-03-03') problems.push('date-sent input did not restore after reload, got: ' + JSON.stringify(dateVal));

  // Appears in the exported case file.
  const doc = await captureExport(pg);
  if (!doc) problems.push('case-file export never fired');
  else {
    if (!doc.includes('== RECORDS REQUEST ==')) problems.push('export is missing the RECORDS REQUEST section');
    if (!/no response yet/i.test(doc)) problems.push('export RECORDS REQUEST section is missing the no-response status');
    if (!doc.includes('time records')) problems.push('export RECORDS REQUEST section is missing the "still missing" note');
    if (!/Certified mail/.test(doc)) problems.push('export RECORDS REQUEST section is missing the method');
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' records-request tracker persists, shows a status line, survives reload, and exports' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 2. ADA interactive-process tracker — gated to discrimination; 2 entries
//    persist and render in order; survives reload; appear in order in the export.
{
  const { pg, errs } = await newPage();
  const seed = {
    onboarded:true, stateSel:'California', county:'Los Angeles County', issue:'Discrimination',
    profile:{ name:'Sam Rivera', employer:'Acme Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await armExportCapture(pg);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  const problems = [];
  const homeText = await bodyText(pg);
  if (!homeText.includes('Track the ADA process')) problems.push('discrimination dashboard is missing the ADA process tracker tile');
  if (homeText.includes('Track my records request')) problems.push('discrimination dashboard wrongly offers the records-request tracker tile');

  await click(pg, 'Track the ADA process');
  await new Promise(r => setTimeout(r, 300));

  // Entry 1: requested accommodation, Jan 5.
  await typeIntoField(pg, '#ada-date', '01052026');
  await click(pg, 'Requested accommodation');
  await pg.evaluate(() => { document.querySelector('#ada-notes').focus(); });
  await pg.keyboard.type('Sent a written accommodation request', { delay: 5 });
  await click(pg, 'Add to the process log');

  // Entry 2: meeting held, Jan 12.
  await typeIntoField(pg, '#ada-date', '01122026');
  await click(pg, 'Meeting held');
  await pg.evaluate(() => { document.querySelector('#ada-notes').focus(); });
  await pg.keyboard.type('Discussed options with HR', { delay: 5 });
  await click(pg, 'Add to the process log');
  await new Promise(r => setTimeout(r, 200));

  const trackerText = await bodyText(pg);
  if (!trackerText.includes('Sent a written accommodation request')) problems.push('first ADA log entry note is not rendered');
  if (!trackerText.includes('Discussed options with HR')) problems.push('second ADA log entry note is not rendered');
  if (!/good faith/i.test(trackerText)) problems.push('missing the ADA both-sides-good-faith hedge on the tracker screen');

  // Rendered cards, in DOM order (via each entry's own delete button — a
  // stable per-entry hook, unlike matching label text which also appears in
  // the always-present "add" form's buttons).
  const deleteLabels = await pg.evaluate(() => [...document.querySelectorAll('button')]
    .map(b => b.getAttribute('aria-label') || '')
    .filter(l => l.startsWith('Delete entry from')));
  if (!(deleteLabels.length === 2 && deleteLabels[0].includes('2026-01-05') && deleteLabels[1].includes('2026-01-12'))) {
    problems.push('ADA log entries do not render in the order they were added: ' + JSON.stringify(deleteLabels));
  }

  const stored = await pg.evaluate(() => (JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').profile || {}));
  if (!Array.isArray(stored.adaLog) || stored.adaLog.length !== 2) problems.push('ADA log did not persist to profile.adaLog: ' + JSON.stringify(stored.adaLog));
  else {
    if (stored.adaLog[0].what !== 'requested' || stored.adaLog[1].what !== 'meeting') problems.push('ADA log entries persisted out of order or with the wrong "what": ' + JSON.stringify(stored.adaLog));
    if (stored.adaLog[0].date !== '2026-01-05' || stored.adaLog[1].date !== '2026-01-12') problems.push('ADA log entry dates did not persist correctly: ' + JSON.stringify(stored.adaLog));
  }

  // Survives reload — see the matching comment in case 1 above for why the
  // current localStorage blob must be re-armed before reloading.
  const currentBlob = await pg.evaluate(() => localStorage.getItem('worklaw.case.v2'));
  await pg.evaluateOnNewDocument((s) => localStorage.setItem('worklaw.case.v2', s), currentBlob);
  await reloadApp(pg);
  await new Promise(r => setTimeout(r, 700));
  await click(pg, 'Track the ADA process');
  await new Promise(r => setTimeout(r, 300));
  const afterReload = await bodyText(pg);
  if (!afterReload.includes('Sent a written accommodation request') || !afterReload.includes('Discussed options with HR')) {
    problems.push('ADA log did not survive reload');
  }

  // Appears, in order, in the exported case file.
  const doc = await captureExport(pg);
  if (!doc) problems.push('case-file export never fired');
  else {
    if (!doc.includes('== ADA INTERACTIVE PROCESS ==')) problems.push('export is missing the ADA INTERACTIVE PROCESS section');
    if (!/good faith/i.test(doc)) problems.push('export is missing the both-sides-good-faith hedge');
    const di1 = doc.indexOf('Requested accommodation');
    const di2 = doc.indexOf('Meeting held');
    if (!(di1 >= 0 && di2 >= 0 && di1 < di2)) problems.push('export ADA entries are not in the order they were logged: ' + JSON.stringify({ di1, di2 }));
    if (!doc.includes('Sent a written accommodation request') || !doc.includes('Discussed options with HR')) problems.push('export ADA entries are missing their notes');
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' ADA interactive-process tracker persists 2 entries in order, survives reload, and exports' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 3. ADA interactive-process tracker is ALSO reachable for a harassment case
//    (letterKindsFor grants harassment the same accommodation-request Letter
//    tab as discrimination — see the comment there — so harassment needs the
//    same Home entry point to log a request/denial). Keep this scoped to just
//    confirming the tile appears and the tracker persists/exports for
//    harassment too; the full multi-entry/ordering/reload behavior is already
//    covered by case 2 above using the same tracker component.
{
  const { pg, errs } = await newPage();
  const seed = {
    onboarded:true, stateSel:'California', county:'Los Angeles County', issue:'Harassment or a hostile workplace',
    profile:{ name:'Jordan Lee', employer:'Acme Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await armExportCapture(pg);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  const problems = [];
  const homeText = await bodyText(pg);
  if (!homeText.includes('Track the ADA process')) problems.push('harassment dashboard is missing the ADA process tracker tile');
  if (homeText.includes('Track my records request')) problems.push('harassment dashboard wrongly offers the records-request tracker tile');

  await click(pg, 'Track the ADA process');
  await new Promise(r => setTimeout(r, 300));

  await typeIntoField(pg, '#ada-date', '02092026');
  await click(pg, 'Accommodation denied');
  await pg.evaluate(() => { document.querySelector('#ada-notes').focus(); });
  await pg.keyboard.type('HR denied the accommodation in writing', { delay: 5 });
  await click(pg, 'Add to the process log');
  await new Promise(r => setTimeout(r, 200));

  const trackerText = await bodyText(pg);
  if (!trackerText.includes('HR denied the accommodation in writing')) problems.push('ADA log entry note is not rendered for a harassment case');

  const stored = await pg.evaluate(() => (JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').profile || {}));
  if (!Array.isArray(stored.adaLog) || stored.adaLog.length !== 1 || stored.adaLog[0].date !== '2026-02-09' || stored.adaLog[0].what !== 'denied') {
    problems.push('ADA log did not persist to profile.adaLog for a harassment case: ' + JSON.stringify(stored.adaLog));
  }

  // Appears in the exported case file, same as the discrimination case.
  const doc = await captureExport(pg);
  if (!doc) problems.push('case-file export never fired');
  else {
    if (!doc.includes('== ADA INTERACTIVE PROCESS ==')) problems.push('export is missing the ADA INTERACTIVE PROCESS section for a harassment case');
    if (!doc.includes('HR denied the accommodation in writing')) problems.push('export ADA entry is missing its note for a harassment case');
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' ADA interactive-process tracker is also reachable and works for a harassment case' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 4. Neither tracker tile leaks onto an unrelated (wage) dashboard.
{
  const { pg, errs } = await newPage();
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  const text = await bodyText(pg);

  const problems = [];
  if (text.includes('Track my records request')) problems.push('wage dashboard wrongly offers the records-request tracker tile');
  if (text.includes('Track the ADA process')) problems.push('wage dashboard wrongly offers the ADA process tracker tile');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' neither tracker tile is offered on an unrelated (wage) dashboard' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL PROCESS-TRACKER CASES PASSED');
process.exit(fails ? 1 : 0);
