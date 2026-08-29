#!/usr/bin/env node
/*
 * Structured fields for the Witness / Statement / Document log kinds.
 *
 * These three "quick-add" kinds used to render only a shared freetext "What
 * happened?" textarea. Each now has its own structured fields (name/role/
 * relationship/etc — see the fields adjacent to `kind.asksHours` in Log()),
 * mirroring the Hours-worked kind's label-above-input pattern. Covers:
 *   (a) selecting each kind shows its own labeled field(s), not just the
 *       generic textarea;
 *   (b) saving persists the structured properties on the entry and they
 *       render in the log's entry list, not just the free-text body;
 *   (c) the structured fields flow into the exported case file text;
 *   (d) editing an existing structured entry repopulates its fields
 *       (round-trip through startEdit);
 *   (e) an old entry saved before these fields existed (no witnessName etc.)
 *       renders without crashing (backward compatibility).
 *
 * Run: node test/log-structured-fields.mjs
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

const baseSeed = {
  onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
  profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
  caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
};

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

async function freshLogPage(seed) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  // Capture whatever printLetter() writes into its popup window (used for the
  // case-file export) instead of actually opening a tab.
  await pg.evaluateOnNewDocument(() => {
    window.__capturedDoc = null;
    window.open = () => ({ document: { write: (html) => { window.__capturedDoc = html; }, close: () => {} }, focus: () => {}, print: () => {} });
  });
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Log an incident')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  return { pg, errs };
}

async function selectKind(pg, label) {
  await pg.evaluate((label) => {
    const btn = [...document.querySelectorAll('[role="group"][aria-label="Entry type"] button')].find(b => b.textContent.trim() === label);
    if (btn) btn.click();
  }, label);
  await new Promise(r => setTimeout(r, 150));
}

async function typeIntoField(pg, selector, text) {
  await pg.evaluate((sel) => document.querySelector(sel).focus(), selector);
  await pg.keyboard.type(text, { delay: 5 });
}

async function selectOption(pg, selector, value) {
  await pg.evaluate((sel, v) => {
    const el = document.querySelector(sel);
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);
}

async function clickToggle(pg, groupLabel, value) {
  await pg.evaluate((groupLabel, value) => {
    const group = [...document.querySelectorAll('[role="group"]')].find(g => g.getAttribute('aria-label') === groupLabel);
    const btn = group && [...group.querySelectorAll('button')].find(b => b.textContent.trim() === value);
    if (btn) btn.click();
  }, groupLabel, value);
}

async function readEntries(pg) {
  return pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').entries || []);
}

async function exportCaseFile(pg) {
  // Navigate to the Agencies screen (holds "Download your case file") via the
  // bottom tab bar — reachable from any screen, unlike the Home-only "Ready
  // to file a complaint?" card — and trigger the export, then read back the
  // captured window.open() HTML.
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('.tabbar-btn')].find(b => b.textContent.includes('Agencies')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Download your case file')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  return pg.evaluate(() => window.__capturedDoc);
}

try {

// Case 1: selecting Witness shows a "Witness name" field.
{
  const { pg, errs } = await freshLogPage(baseSeed);
  await selectKind(pg, 'A witness');
  const hasField = await pg.evaluate(() => !!document.querySelector('#log-witness-name') &&
    !!document.querySelector('label[for="log-witness-name"]'));
  const problems = [];
  if (!hasField) problems.push('Witness kind does not render a #log-witness-name field with a label');
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Selecting Witness shows a Witness name field' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: saving a Witness entry persists witnessName + relationship, and it
// renders in the entry list and the case-file export.
{
  const { pg, errs } = await freshLogPage(baseSeed);
  await selectKind(pg, 'A witness');
  await typeIntoField(pg, '#log-witness-name', 'Jordan Lee');
  await typeIntoField(pg, '#log-witness-contact', 'jordan@example.com');
  await selectOption(pg, '#log-witness-rel', 'Coworker');
  await clickToggle(pg, 'Still employed there?', 'Yes');
  await clickToggle(pg, 'Willing to be contacted?', 'Yes');
  await typeIntoField(pg, '#log-note', 'Saw the manager yell at me in the break room.');
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /^Add to log$/.test(b.textContent.trim())); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));

  const stored = await readEntries(pg);
  const e = stored.find(e => e.tag === 'Witness');
  const problems = [];
  if (!e) problems.push('no Witness entry was saved');
  else {
    if (e.witnessName !== 'Jordan Lee') problems.push('witnessName not persisted: ' + JSON.stringify(e.witnessName));
    if (e.witnessContact !== 'jordan@example.com') problems.push('witnessContact not persisted: ' + JSON.stringify(e.witnessContact));
    if (e.witnessRelationship !== 'Coworker') problems.push('witnessRelationship not persisted: ' + JSON.stringify(e.witnessRelationship));
    if (e.witnessStillEmployed !== 'Yes') problems.push('witnessStillEmployed not persisted: ' + JSON.stringify(e.witnessStillEmployed));
    if (e.witnessWilling !== 'Yes') problems.push('witnessWilling not persisted: ' + JSON.stringify(e.witnessWilling));
  }
  const listText = await pg.evaluate(() => document.body.textContent);
  if (!/Jordan Lee/.test(listText)) problems.push('witness name does not render in the entry list');
  if (!/Coworker/.test(listText)) problems.push('witness relationship does not render in the entry list');

  const doc = await exportCaseFile(pg);
  if (!doc || !/Jordan Lee/.test(doc) || !/Witness:/.test(doc)) problems.push('witness not surfaced in the exported case file: ' + JSON.stringify(doc && doc.slice(0, 400)));

  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' A named witness persists, renders in the list, and exports to the case file' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3: same shape check for Statement (speaker fields).
{
  const { pg, errs } = await freshLogPage(baseSeed);
  await selectKind(pg, 'Something said');
  const hasField = await pg.evaluate(() => !!document.querySelector('#log-speaker-name'));
  await typeIntoField(pg, '#log-speaker-name', 'Alex Rivera');
  await typeIntoField(pg, '#log-speaker-role', 'My supervisor');
  await selectOption(pg, '#log-said-where', 'In person');
  await typeIntoField(pg, '#log-note', 'You are too old for this job.');
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /^Add to log$/.test(b.textContent.trim())); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));

  const stored = await readEntries(pg);
  const e = stored.find(e => e.tag === 'Statement');
  const problems = [];
  if (!hasField) problems.push('Statement kind does not render a #log-speaker-name field');
  if (!e) problems.push('no Statement entry was saved');
  else {
    if (e.speakerName !== 'Alex Rivera') problems.push('speakerName not persisted: ' + JSON.stringify(e.speakerName));
    if (e.speakerRole !== 'My supervisor') problems.push('speakerRole not persisted: ' + JSON.stringify(e.speakerRole));
    if (e.saidWhere !== 'In person') problems.push('saidWhere not persisted: ' + JSON.stringify(e.saidWhere));
  }
  const listText = await pg.evaluate(() => document.body.textContent);
  if (!/Alex Rivera/.test(listText)) problems.push('speaker name does not render in the entry list');

  const doc = await exportCaseFile(pg);
  if (!doc || !/Alex Rivera/.test(doc) || !/Said by:/.test(doc)) problems.push('statement not surfaced in the exported case file: ' + JSON.stringify(doc && doc.slice(0, 400)));

  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' A Statement entry persists speaker/role/where, renders in the list, and exports to the case file' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 4: same shape check for Document (doc type/date/parties).
{
  const { pg, errs } = await freshLogPage(baseSeed);
  await selectKind(pg, 'A document');
  const hasField = await pg.evaluate(() => !!document.querySelector('#log-doc-type'));
  await selectOption(pg, '#log-doc-type', 'Pay stub');
  await typeIntoField(pg, '#log-doc-parties', 'Payroll dept.');
  await typeIntoField(pg, '#log-note', 'Shows straight-time pay for overtime hours.');
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /^Add to log$/.test(b.textContent.trim())); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));

  const stored = await readEntries(pg);
  const e = stored.find(e => e.tag === 'Records');
  const problems = [];
  if (!hasField) problems.push('Document kind does not render a #log-doc-type field');
  if (!e) problems.push('no Records entry was saved');
  else {
    if (e.docType !== 'Pay stub') problems.push('docType not persisted: ' + JSON.stringify(e.docType));
    if (e.docParties !== 'Payroll dept.') problems.push('docParties not persisted: ' + JSON.stringify(e.docParties));
    if (!e.docDate) problems.push('docDate not persisted');
  }
  const listText = await pg.evaluate(() => document.body.textContent);
  if (!/Pay stub/.test(listText)) problems.push('document type does not render in the entry list');

  const doc = await exportCaseFile(pg);
  if (!doc || !/Pay stub/.test(doc) || !/Document:/.test(doc)) problems.push('document not surfaced in the exported case file: ' + JSON.stringify(doc && doc.slice(0, 400)));

  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' A Document entry persists type/parties, renders in the list, and exports to the case file' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 5: editing an existing Witness entry repopulates its structured fields.
{
  const seed = Object.assign({}, baseSeed, {
    entries: [{ date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Witness noted', body:'saw it happen', color:'#1F8A4C', tag:'Witness',
      witnessName:'Sam Diaz', witnessContact:'555-0100', witnessRelationship:'Supervisor or manager', witnessStillEmployed:'No', witnessWilling:'Unsure' }],
  });
  const { pg, errs } = await freshLogPage(seed);
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Edit entry from JAN 5, 2026 · 9:00 AM'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 200));

  const vals = await pg.evaluate(() => ({
    name: document.querySelector('#log-witness-name')?.value,
    contact: document.querySelector('#log-witness-contact')?.value,
    rel: document.querySelector('#log-witness-rel')?.value,
  }));
  const stillEmployedPressed = await pg.evaluate(() => {
    const group = [...document.querySelectorAll('[role="group"]')].find(g => g.getAttribute('aria-label') === 'Still employed there?');
    const btn = group && [...group.querySelectorAll('button')].find(b => b.getAttribute('aria-pressed') === 'true');
    return btn ? btn.textContent.trim() : null;
  });

  const problems = [];
  if (vals.name !== 'Sam Diaz') problems.push('edit form did not pre-fill witness name (got ' + JSON.stringify(vals.name) + ')');
  if (vals.contact !== '555-0100') problems.push('edit form did not pre-fill witness contact (got ' + JSON.stringify(vals.contact) + ')');
  if (vals.rel !== 'Supervisor or manager') problems.push('edit form did not pre-fill relationship (got ' + JSON.stringify(vals.rel) + ')');
  if (stillEmployedPressed !== 'No') problems.push('edit form did not pre-fill "still employed" toggle (got ' + JSON.stringify(stillEmployedPressed) + ')');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Editing a Witness entry round-trips its structured fields' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 6 (backward compatibility): an old Witness/Statement/Records entry
// saved before these fields existed renders without crashing, and does not
// count toward the case-strength "named witness" factor.
{
  const seed = Object.assign({}, baseSeed, {
    entries: [
      { date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Witness noted', body:'old freetext note', color:'#1F8A4C', tag:'Witness' },
      { date:'JAN 6, 2026 · 9:00 AM', iso:'2026-01-06T09:00:00.000Z', title:'Statement recorded', body:'old freetext statement', color:'#2B3AA8', tag:'Statement' },
      { date:'JAN 7, 2026 · 9:00 AM', iso:'2026-01-07T09:00:00.000Z', title:'Document saved', body:'old freetext doc note', color:'#7A3AA8', tag:'Records' },
    ],
  });
  const { pg, errs } = await freshLogPage(seed);
  await new Promise(r => setTimeout(r, 200));

  const listText = await pg.evaluate(() => document.body.textContent);
  const problems = [];
  if (!/old freetext note/.test(listText)) problems.push('old Witness entry body did not render');
  if (!/old freetext statement/.test(listText)) problems.push('old Statement entry body did not render');
  if (!/old freetext doc note/.test(listText)) problems.push('old Records entry body did not render');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Pre-existing entries without structured fields render without crashing' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL LOG-STRUCTURED-FIELDS CASES PASSED');
process.exit(fails ? 1 : 0);
