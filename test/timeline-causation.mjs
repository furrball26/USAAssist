#!/usr/bin/env node
/*
 * Timeline / causation (retaliation) feature.
 *
 * Retaliation and discrimination cases often turn on "I did X protected
 * thing, then the employer did Y adverse thing shortly after." Log entries
 * can now be optionally classified via entry.causalRole ('protected' |
 * 'adverse' | undefined — old entries simply lack the field; see
 * CAUSAL_ROLE_OPTIONS / the "Is this a protected activity or an adverse
 * action?" group in Log()). When a case has at least one dated 'protected'
 * entry AND one dated 'adverse' entry, causationPairs() pairs each adverse
 * entry with the nearest earlier protected entry and computes the day-gap,
 * and:
 *   (a) Case Strength renders a "Timeline: protected activity → employer
 *       action" summary with the computed gap and a hedged "not proof" note;
 *   (b) buildCaseFile()'s export includes a "TIMELINE / POSSIBLE
 *       RETALIATION" section with the same pairing/gap;
 *   (c) a case with no such entries (or only one side) shows neither.
 *
 * Run: node test/timeline-causation.mjs
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

const baseSeed = {
  onboarded: true, stateSel: 'Texas', county: 'Travis County', issue: 'Discrimination',
  profile: { name: 'Pat Vega', employer: 'Northgate Co', payType: 'Salary' },
  caseOpened: new Date().toISOString(), homeMode: 'standard', done: {}, messages: [],
};

// A protected-activity entry (reported safety concerns) followed 7 days later
// by an adverse-action entry (written up) — the causalRole/saidWhen pairing
// causalEntryDate/causationPairs use.
const causationEntries = [
  { date: 'MAR 3, 2026 · 9:00 AM', iso: '2026-03-03T09:00:00.000Z', title: 'Statement recorded',
    body: 'reported safety concerns to my supervisor', color: '#2B3AA8', tag: 'Statement',
    speakerName: 'Me', saidWhen: '2026-03-03', causalRole: 'protected' },
  { date: 'MAR 10, 2026 · 9:00 AM', iso: '2026-03-10T09:00:00.000Z', title: 'Statement recorded',
    body: 'was written up for a minor issue', color: '#2B3AA8', tag: 'Statement',
    speakerName: 'Manager', saidWhen: '2026-03-10', causalRole: 'adverse' },
];

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

async function openPage(seed) {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  // Capture whatever printLetter() writes into its popup window (used for the
  // case-file export) instead of actually opening a tab — same pattern as
  // case-file-packet.mjs / log-structured-fields.mjs.
  await pg.evaluateOnNewDocument(() => {
    window.__capturedDoc = null;
    window.open = () => ({ document: { write: (html) => { window.__capturedDoc = html; }, close: () => {} }, focus: () => {}, print: () => {} });
  });
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 900));
  return { pg, errs };
}

async function gotoStrength(pg) {
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('CASE STRENGTH')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
}

async function exportCaseFile(pg) {
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('.tabbar-btn')].find(b => b.textContent.includes('Agencies')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Download your case file')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  return pg.evaluate(() => window.__capturedDoc);
}

try {

// Case 1: Case Strength renders the causation summary with the computed
// day-gap and the hedged "not proof" note, for a case with both a dated
// 'protected' and a dated 'adverse' entry.
{
  const seed = Object.assign({}, baseSeed, { entries: causationEntries });
  const { pg, errs } = await openPage(seed);
  await gotoStrength(pg);
  const bodyText = await pg.evaluate(() => document.getElementById('root').textContent);

  const problems = [];
  if (!/Timeline: protected activity/.test(bodyText)) problems.push('causation summary heading not found on Case Strength');
  if (!/7 days later/.test(bodyText)) problems.push('computed 7-day gap not rendered');
  if (!/March 3, 2026/.test(bodyText) || !/March 10, 2026/.test(bodyText)) problems.push('protected/adverse dates not rendered as expected');
  if (!/close timing can be evidence of retaliation, but timing alone is not proof/i.test(bodyText)) problems.push('hedged "timing is not proof" note not rendered');
  if (!/CLOSE TIMING/.test(bodyText)) problems.push('a 7-day gap should be highlighted as close timing');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Case Strength renders the causation summary with the computed gap + hedged note' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: the exported case file includes a TIMELINE / POSSIBLE RETALIATION
// section with the same pairing/gap.
{
  const seed = Object.assign({}, baseSeed, { entries: causationEntries });
  const { pg, errs } = await openPage(seed);
  const doc = await exportCaseFile(pg);

  const problems = [];
  if (!doc) problems.push('printLetter() never captured a document — export did not fire');
  else {
    if (!/== TIMELINE \/ POSSIBLE RETALIATION ==/.test(doc)) problems.push('missing TIMELINE / POSSIBLE RETALIATION section header');
    if (!/7 days? later/.test(doc)) problems.push('computed gap not present in the exported section');
    if (!/reported safety concerns to my supervisor/.test(doc)) problems.push('protected-activity entry text not present in the exported section');
    if (!/was written up for a minor issue/.test(doc)) problems.push('adverse-action entry text not present in the exported section');
    if (!/timing alone is not proof/i.test(doc)) problems.push('hedged note not present in the exported section');
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' The exported case file includes a TIMELINE / POSSIBLE RETALIATION section with the computed gap' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3: a case with no protected/adverse-classified entries shows neither
// the Case Strength summary nor the export section.
{
  const seed = Object.assign({}, baseSeed, {
    entries: [
      { date: 'MAR 3, 2026 · 9:00 AM', iso: '2026-03-03T09:00:00.000Z', title: 'Statement recorded',
        body: 'a plain note with no causal classification', color: '#2B3AA8', tag: 'Statement', saidWhen: '2026-03-03' },
    ],
  });
  const { pg, errs } = await openPage(seed);
  await gotoStrength(pg);
  const bodyText = await pg.evaluate(() => document.getElementById('root').textContent);
  const doc = await exportCaseFile(pg);

  const problems = [];
  if (/Timeline: protected activity/.test(bodyText)) problems.push('causation summary rendered even though no protected+adverse pair exists');
  if (doc && /== TIMELINE \/ POSSIBLE RETALIATION ==/.test(doc)) problems.push('export included the TIMELINE / POSSIBLE RETALIATION section even though no protected+adverse pair exists');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' A case with no protected+adverse pair shows neither the summary nor the export section' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 4: the "protected activity or adverse action" classifier is offered
// in the Log form for an eligible issue (discrimination), and round-trips
// through save + edit.
{
  const { pg, errs } = await openPage(Object.assign({}, baseSeed, { entries: [] }));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('.tabbar-btn')].find(b => b.textContent.includes('Log')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));

  const hasGroup = await pg.evaluate(() => !!document.querySelector('[role="group"][aria-label="Protected activity or adverse action? (optional)"]'));
  await pg.evaluate(() => {
    const group = [...document.querySelectorAll('[role="group"]')].find(g => g.getAttribute('aria-label') === 'Protected activity or adverse action? (optional)');
    const btn = group && [...group.querySelectorAll('button')].find(b => b.textContent.trim() === 'Protected activity');
    if (btn) btn.click();
  });
  await pg.evaluate(() => document.querySelector('#log-note').focus());
  await pg.keyboard.type('I complained to HR about my hours', { delay: 5 });
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /^Add to log$/.test(b.textContent.trim())); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));

  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').entries || []);
  const saved = stored[0];

  const problems = [];
  if (!hasGroup) problems.push('classifier group not rendered for an eligible issue (discrimination)');
  if (!saved || saved.causalRole !== 'protected') problems.push('causalRole was not persisted as "protected": ' + JSON.stringify(saved && saved.causalRole));

  // Edit round-trip.
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') && b.getAttribute('aria-label').indexOf('Edit entry from') === 0); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 200));
  const pressed = await pg.evaluate(() => {
    const group = [...document.querySelectorAll('[role="group"]')].find(g => g.getAttribute('aria-label') === 'Protected activity or adverse action? (optional)');
    const btn = group && [...group.querySelectorAll('button')].find(b => b.getAttribute('aria-pressed') === 'true');
    return btn ? btn.textContent.trim() : null;
  });
  if (pressed !== 'Protected activity') problems.push('edit form did not pre-fill the causal-role toggle (got ' + JSON.stringify(pressed) + ')');

  const listText = await pg.evaluate(() => document.getElementById('root').textContent);
  if (!/PROTECTED ACTIVITY/.test(listText)) problems.push('entry list does not show a "PROTECTED ACTIVITY" pill');

  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' The causal-role classifier is offered, persists, renders a pill, and round-trips through edit' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL TIMELINE-CAUSATION CASES PASSED');
process.exit(fails ? 1 : 0);
