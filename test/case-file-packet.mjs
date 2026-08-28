#!/usr/bin/env node
/*
 * Attorney/agency-ready case-file packet (buildCaseFile restructure).
 *
 * The exported case file used to be a flat header + a chronological dump of
 * entries. buildCaseFile() now emits clearly labeled sections — HEADER, KEY
 * DEADLINE, CLAIM SNAPSHOT, WITNESSES, EVIDENCE / DOCUMENTS, STATEMENTS, FULL
 * TIMELINE, DISCLAIMER — built from the structured witness/statement/document
 * fields (see log-structured-fields.mjs) and the computed deadline
 * (computeDeadlineFromEvent) / per-workweek pay breakdown
 * (computeWeeklyPayBreakdown). Covers:
 *   (a) a named Witness entry surfaces in a WITNESSES section;
 *   (b) a Records entry with a docType surfaces in an EVIDENCE / DOCUMENTS
 *       section, exhibit-numbered;
 *   (c) an event date + a parseable jurisdiction deadline fact (Texas wage
 *       claim, "180 days") surfaces a computed "File by ..." date in a KEY
 *       DEADLINE section;
 *   (d) old, pre-structured-fields freetext entries still render in the FULL
 *       TIMELINE (never silently dropped) while being skipped from the
 *       structured WITNESSES/EVIDENCE sections that have nothing to key on.
 *
 * Run: node test/case-file-packet.mjs
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

// Texas has a clean "180 days" wage-claim deadline fact (Tex. Labor Code
// § 61.051(c)) — parseDeadlineWindow can read it, so an eventDate on the
// profile lets computeDeadlineFromEvent produce a real "File by ..." date.
const seed = {
  onboarded: true, stateSel: 'Texas', county: 'Travis County', issue: 'Unpaid overtime or wages',
  profile: { name: 'Pat Vega', employer: 'Northgate Co', payType: 'Hourly', rate: '20', eventDate: '2026-06-01' },
  caseOpened: new Date().toISOString(), homeMode: 'standard', done: {}, messages: [],
  entries: [
    // Structured Witness entry — must surface in WITNESSES.
    { date: 'JAN 5, 2026 · 9:00 AM', iso: '2026-01-05T09:00:00.000Z', title: 'Witness noted', body: 'Saw the manager falsify my time card.',
      color: '#1F8A4C', tag: 'Witness', witnessName: 'Jordan Lee', witnessContact: '555-0100',
      witnessRelationship: 'Coworker', witnessStillEmployed: 'Yes', witnessWilling: 'Yes' },
    // Structured Records (document) entry — must surface in EVIDENCE / DOCUMENTS.
    { date: 'JAN 6, 2026 · 9:00 AM', iso: '2026-01-06T09:00:00.000Z', title: 'Document saved', body: 'Shows straight-time pay for overtime hours.',
      color: '#7A3AA8', tag: 'Records', docType: 'Pay stub', docDate: '2026-01-03', docParties: 'Payroll dept.' },
    // Old, pre-structured-fields entries (no witnessName/speakerName/docType) —
    // must still render in FULL TIMELINE, and must be skipped (not crash) in
    // the structured sections that have nothing to key on.
    { date: 'JAN 7, 2026 · 9:00 AM', iso: '2026-01-07T09:00:00.000Z', title: 'Witness noted', body: 'old freetext witness note',
      color: '#1F8A4C', tag: 'Witness' },
    { date: 'JAN 8, 2026 · 9:00 AM', iso: '2026-01-08T09:00:00.000Z', title: 'Document saved', body: 'old freetext document note',
      color: '#7A3AA8', tag: 'Records' },
  ],
};

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

try {

const pg = await b.newPage();
const errs = [];
pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
// Capture whatever printLetter() writes into its popup window instead of
// actually opening a tab — same pattern as export-path-message.mjs /
// log-structured-fields.mjs.
await pg.evaluateOnNewDocument(() => {
  window.__capturedDoc = null;
  window.open = () => ({ document: { write: (html) => { window.__capturedDoc = html; }, close: () => {} }, focus: () => {}, print: () => {} });
});
await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
// Give the federal/state content fetches (needed for the Texas wage-claim
// deadline fact) time to resolve before exporting.
await new Promise(r => setTimeout(r, 1200));

await pg.evaluate(() => { const btn = [...document.querySelectorAll('.tabbar-btn')].find(b => b.textContent.includes('Agencies')); if (btn) btn.click(); });
await new Promise(r => setTimeout(r, 400));
await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Download your case file')); if (btn) btn.click(); });
await new Promise(r => setTimeout(r, 400));
const doc = await pg.evaluate(() => window.__capturedDoc);

const problems = [];
if (!doc) {
  problems.push('printLetter() never captured a document — export did not fire');
} else {
  // Section structure and ordering.
  const sectionOrder = ['== HEADER ==', '== KEY DEADLINE ==', '== CLAIM SNAPSHOT ==', '== WITNESSES ==', '== EVIDENCE / DOCUMENTS ==', '== STATEMENTS ==', '== FULL TIMELINE'];
  let lastIdx = -1;
  sectionOrder.forEach(h => {
    const idx = doc.indexOf(h);
    if (idx === -1) problems.push('missing section header: ' + h);
    else if (idx <= lastIdx) problems.push('section out of order: ' + h);
    else lastIdx = idx;
  });

  const witnessesSection = doc.slice(doc.indexOf('== WITNESSES =='), doc.indexOf('== EVIDENCE'));
  if (!/Jordan Lee/.test(witnessesSection)) problems.push('WITNESSES section missing the named witness (Jordan Lee): ' + JSON.stringify(witnessesSection.slice(0, 300)));
  if (!/coworker|Coworker/i.test(witnessesSection)) problems.push('WITNESSES section missing relationship context');
  if (/old freetext witness note/.test(witnessesSection)) problems.push('unnamed legacy Witness entry leaked into the structured WITNESSES section');

  const evidenceSection = doc.slice(doc.indexOf('== EVIDENCE / DOCUMENTS =='), doc.indexOf('== STATEMENTS =='));
  if (!/Pay stub/.test(evidenceSection)) problems.push('EVIDENCE section missing the logged document (Pay stub): ' + JSON.stringify(evidenceSection.slice(0, 300)));
  if (!/Exhibit [A-Z]/.test(evidenceSection)) problems.push('EVIDENCE section is not exhibit-numbered');
  if (/old freetext document note/.test(evidenceSection)) problems.push('undated/untyped legacy Records entry leaked into the structured EVIDENCE section');

  const deadlineSection = doc.slice(doc.indexOf('== KEY DEADLINE =='), doc.indexOf('== CLAIM SNAPSHOT =='));
  if (!/File by /.test(deadlineSection)) problems.push('KEY DEADLINE section has no computed "File by ..." date: ' + JSON.stringify(deadlineSection.slice(0, 300)));
  if (!/180 days|Texas Payday Law|Tex\. Labor Code/i.test(deadlineSection)) problems.push('KEY DEADLINE section missing the underlying limitations period text');

  // Old freetext-only entries must still appear in the complete record.
  const timelineSection = doc.slice(doc.indexOf('== FULL TIMELINE'));
  if (!/old freetext witness note/.test(timelineSection)) problems.push('legacy Witness entry (no witnessName) missing from FULL TIMELINE');
  if (!/old freetext document note/.test(timelineSection)) problems.push('legacy Records entry (no docType) missing from FULL TIMELINE');
  if (!/Jordan Lee/.test(timelineSection)) problems.push('structured Witness entry missing from FULL TIMELINE');
  if (!/Pay stub/.test(timelineSection)) problems.push('structured Records entry missing from FULL TIMELINE');

  if (!/not legal advice/i.test(doc)) problems.push('DISCLAIMER text missing from the export');
}
errs.forEach(e => problems.push(e));

const ok = problems.length === 0;
if (!ok) fails++;
console.log((ok ? '✅' : '❌') + ' buildCaseFile() emits a sectioned attorney/agency packet with witnesses, evidence, computed deadline, and a complete timeline' + (ok ? '' : '\n   ' + problems.join('\n   ')));
await pg.close();

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL CASE-FILE-PACKET CASES PASSED');
process.exit(fails ? 1 : 0);
