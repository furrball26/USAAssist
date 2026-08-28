#!/usr/bin/env node
/*
 * Editing a log entry's date must actually change the date everywhere that
 * date is used — a bug fixed here.
 *
 * ROOT CAUSE: in Log's submit(), the entry's `date` (display string) and
 * `iso` (drives sort order / weekStartKey / the timeline) were only ever
 * (re)computed inside `if (kind.asksHours)`. For the non-hours kinds —
 * Statement (driven by "When" / saidWhen) and Records (driven by docDate) —
 * date/iso were set once at CREATION and never updated on edit, so editing a
 * Statement's "When" or a Document's date silently did nothing to: the entry
 * list, the case-file export (FULL TIMELINE / EVIDENCE / STATEMENTS), and any
 * letter that lists entry dates (e.g. the discrimination/harassment
 * "complaint" letter, which maps ctx.entries.map(e => e.date)).
 *
 * FIX: submit() now recomputes date/iso from each kind's own driving date
 * field (Hours -> logDate/logStartTime, Statement -> logSaidWhen, Records ->
 * logDocDate) on both add and edit, whenever that field changed from what the
 * edit form was pre-filled with. Witness has no dedicated date field and is
 * left untouched. Covers:
 *   (a) editing a Statement's "When" propagates to the entry list, the
 *       case-file export, and the complaint letter's date list;
 *   (b) editing a Records entry's document date propagates the same way;
 *   (c) the Hours kind's date-edit path still works (regression check).
 *
 * Run: node test/log-date-edit.mjs
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

const discriminationSeed = (entries) => ({
  onboarded:true, stateSel:'California', county:'Los Angeles County', issue:'Discrimination',
  profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Salary', rate:'' },
  caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries,
});

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

async function freshPage(seed) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  // Capture whatever printLetter() writes into its popup window (case-file
  // export / letter print) instead of actually opening a tab.
  await pg.evaluateOnNewDocument(() => {
    window.__capturedDoc = null;
    window.open = () => ({ document: { write: (html) => { window.__capturedDoc = html; }, close: () => {} }, focus: () => {}, print: () => {} });
  });
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  return { pg, errs };
}

async function goLog(pg) {
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Log an incident')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
}

async function editEntryByAriaLabel(pg, label) {
  await pg.evaluate((label) => { const btn = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label); if (btn) btn.click(); }, label);
  await new Promise(r => setTimeout(r, 250));
}

async function setDateField(pg, selector, value) {
  // React wraps a controlled <input>'s native value setter, so a plain
  // `el.value = v` + dispatchEvent is a no-op from React's perspective — go
  // through the native setter directly (same trick React's own test-utils
  // use) so the onChange handler actually fires with the new value.
  await pg.evaluate((sel, v) => {
    const el = document.querySelector(sel);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);
}

async function saveEntry(pg) {
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /^Save changes$|^Add to log$/.test(b.textContent.trim())); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
}

async function readEntries(pg) {
  return pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').entries || []);
}

async function exportCaseFile(pg) {
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('.tabbar-btn')].find(b => b.textContent.includes('Agencies')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Download your case file')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  return pg.evaluate(() => window.__capturedDoc);
}

async function complaintLetterText(pg) {
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Home'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 250));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Draft a letter')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /Complaint/.test(b.textContent)); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  return pg.evaluate(() => {
    const els = [...document.querySelectorAll('div')].filter(d => d.textContent.includes('To whom it may concern'));
    return els.length ? els[els.length - 1].textContent : null;
  });
}

try {

// Case (a): editing a Statement's "When" (saidWhen) propagates to the entry
// list, the case-file export, and the complaint letter's date list.
{
  const seed = discriminationSeed([
    { date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Something said', body:'Told me I was "too old for this job."',
      color:'#2B3AA8', tag:'Statement', speakerName:'Alex Rivera', speakerRole:'My supervisor', saidWhen:'2026-01-05', saidWhere:'In person' },
  ]);
  const { pg, errs } = await freshPage(seed);
  await goLog(pg);
  await editEntryByAriaLabel(pg, 'Edit entry from JAN 5, 2026 · 9:00 AM');

  const prefilledSaidWhen = await pg.evaluate(() => document.querySelector('#log-said-when')?.value);
  await setDateField(pg, '#log-said-when', '2026-02-20');
  await saveEntry(pg);

  const problems = [];
  if (prefilledSaidWhen !== '2026-01-05') problems.push('edit form did not pre-fill saidWhen, got ' + JSON.stringify(prefilledSaidWhen));

  const stored = await readEntries(pg);
  const e = stored.find(e => e.tag === 'Statement');
  if (!e) problems.push('Statement entry disappeared after edit');
  else {
    if (e.saidWhen !== '2026-02-20') problems.push('saidWhen not updated: ' + JSON.stringify(e.saidWhen));
    if (!/FEB 20, 2026/.test(e.date || '')) problems.push('entry.date was not recomputed from the new saidWhen: ' + JSON.stringify(e.date));
    const localDate = (iso) => { const d = new Date(iso); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    if (!e.iso || localDate(e.iso) !== '2026-02-20') problems.push('entry.iso was not recomputed from the new saidWhen: ' + JSON.stringify(e.iso));
  }

  const listText = await pg.evaluate(() => document.body.textContent);
  if (!/FEB 20, 2026/.test(listText)) problems.push('entry list still shows the old date, not the edited one');
  if (/JAN 5, 2026 · 9:00 AM/.test(listText)) problems.push('entry list still shows the OLD stamp after the edit');

  const doc = await exportCaseFile(pg);
  if (!doc) problems.push('case-file export did not fire');
  else {
    if (!/FEB 20, 2026/.test(doc)) problems.push('case-file export does not show the edited date anywhere');
    const timeline = doc.slice(doc.indexOf('== FULL TIMELINE'));
    if (!/FEB 20, 2026/.test(timeline)) problems.push('FULL TIMELINE does not show the edited date: ' + JSON.stringify(timeline.slice(0, 300)));
  }

  const letterText = await complaintLetterText(pg);
  if (!letterText) problems.push('complaint letter body not found');
  else if (!/FEB 20, 2026/.test(letterText)) problems.push('complaint letter\'s "Documented incidents" list does not show the edited date: ' + JSON.stringify(letterText.slice(0, 600)));

  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' (a) editing a Statement\'s "When" propagates to the entry list, case-file export, and complaint letter' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case (b): editing a Records entry's document date propagates the same way.
{
  const seed = discriminationSeed([
    { date:'JAN 6, 2026 · 9:00 AM', iso:'2026-01-06T09:00:00.000Z', title:'Document saved', body:'Performance review showing no issues before the demotion.',
      color:'#7A3AA8', tag:'Records', docType:'Performance review', docDate:'2026-01-03', docParties:'HR' },
  ]);
  const { pg, errs } = await freshPage(seed);
  await goLog(pg);
  await editEntryByAriaLabel(pg, 'Edit entry from JAN 6, 2026 · 9:00 AM');

  const prefilledDocDate = await pg.evaluate(() => document.querySelector('#log-doc-date')?.value);
  await setDateField(pg, '#log-doc-date', '2026-03-11');
  await saveEntry(pg);

  const problems = [];
  if (prefilledDocDate !== '2026-01-03') problems.push('edit form did not pre-fill docDate, got ' + JSON.stringify(prefilledDocDate));

  const stored = await readEntries(pg);
  const e = stored.find(e => e.tag === 'Records');
  if (!e) problems.push('Records entry disappeared after edit');
  else {
    if (e.docDate !== '2026-03-11') problems.push('docDate not updated: ' + JSON.stringify(e.docDate));
    if (!/MAR 11, 2026/.test(e.date || '')) problems.push('entry.date was not recomputed from the new docDate: ' + JSON.stringify(e.date));
  }

  const listText = await pg.evaluate(() => document.body.textContent);
  if (!/MAR 11, 2026/.test(listText)) problems.push('entry list still shows the old date, not the edited one');

  const doc = await exportCaseFile(pg);
  if (!doc) problems.push('case-file export did not fire');
  else {
    const evidence = doc.slice(doc.indexOf('== EVIDENCE / DOCUMENTS =='), doc.indexOf('== STATEMENTS =='));
    if (!/2026-03-11/.test(evidence)) problems.push('EVIDENCE section does not show the edited document date: ' + JSON.stringify(evidence.slice(0, 300)));
    const timeline = doc.slice(doc.indexOf('== FULL TIMELINE'));
    if (!/MAR 11, 2026/.test(timeline)) problems.push('FULL TIMELINE does not show the edited date: ' + JSON.stringify(timeline.slice(0, 300)));
  }

  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' (b) editing a Records entry\'s document date propagates to the entry list, EVIDENCE section, and FULL TIMELINE' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case (c): the Hours kind's date-edit path still works (regression check —
// this one already worked before the fix and must not break).
{
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[],
    entries:[{ date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'a shift', color:'#EF7B22', tag:'Wage & hour', hours:8, payStatus:'unpaid' }],
  };
  const { pg, errs } = await freshPage(seed);
  await goLog(pg);
  await editEntryByAriaLabel(pg, 'Edit entry from JAN 5, 2026 · 9:00 AM');
  await setDateField(pg, '#log-date', '2026-04-15');
  await saveEntry(pg);

  const stored = await readEntries(pg);
  const e = stored.find(e => e.tag === 'Wage & hour');
  const problems = [];
  if (!e) problems.push('Hours entry disappeared after edit');
  else {
    if (!/APR 15, 2026/.test(e.date || '')) problems.push('Hours entry.date was not recomputed on a date edit (regression): ' + JSON.stringify(e.date));
    const localDate = (iso) => { const d = new Date(iso); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    if (!e.iso || localDate(e.iso) !== '2026-04-15') problems.push('Hours entry.iso was not recomputed on a date edit (regression): ' + JSON.stringify(e.iso));
  }

  // A note-only edit of an Hours entry must NOT shift its date/time.
  await editEntryByAriaLabel(pg, 'Edit entry from ' + (e ? e.date : ''));
  await pg.evaluate(() => { const el = document.querySelector('#log-note'); el.focus(); });
  await pg.keyboard.type(' — noted for the file', { delay: 5 });
  await saveEntry(pg);
  const stored2 = await readEntries(pg);
  const e2 = stored2.find(e => e.tag === 'Wage & hour');
  if (!e2 || e2.iso !== (e && e.iso)) problems.push('a note-only edit shifted the Hours entry\'s iso: before=' + JSON.stringify(e && e.iso) + ' after=' + JSON.stringify(e2 && e2.iso));

  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' (c) Hours-kind date edit still works, and a note-only edit does not shift its date/time (regression)' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL LOG-DATE-EDIT CASES PASSED');
process.exit(fails ? 1 : 0);
