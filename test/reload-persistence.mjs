#!/usr/bin/env node
/*
 * Reload-persistence regression test (F13).
 *
 * saveCase() previously omitted letterEdit, wizNode/wizPath, and docName even
 * though it persisted entries/messages/done — and the app tells users
 * "everything you enter stays on this device." A hand-edited letter, in-progress
 * classification-wizard position, or noted document name vanished on reload.
 * Run: node test/reload-persistence.mjs
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
let allOk = false;
try {
const pg = await b.newPage();
const errs = [];
pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

const seed = {
  onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
  profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
  caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  letterEdit:'This is my hand-edited letter text.', letterType:'wage-demand',
  wizNode:'salary-duties', wizPath:['start','salary'], docName:'severance-offer.pdf',
};
await pg.evaluateOnNewDocument((s) => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), seed);
await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
await new Promise(r => setTimeout(r, 700));

// Reload to force a fresh read from localStorage (as if the tab were closed/reopened).
await reloadApp(pg);
await new Promise(r => setTimeout(r, 500));

const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}'));

const problems = [];
if (stored.letterEdit !== seed.letterEdit) problems.push('letterEdit not persisted across reload: ' + JSON.stringify(stored.letterEdit));
if (stored.letterType !== seed.letterType) problems.push('letterType not persisted across reload: ' + JSON.stringify(stored.letterType));
if (stored.wizNode !== seed.wizNode) problems.push('wizNode not persisted across reload: ' + JSON.stringify(stored.wizNode));
if (JSON.stringify(stored.wizPath) !== JSON.stringify(seed.wizPath)) problems.push('wizPath not persisted across reload: ' + JSON.stringify(stored.wizPath));
if (stored.docName !== seed.docName) problems.push('docName not persisted across reload: ' + JSON.stringify(stored.docName));
errs.forEach(e => problems.push(e));

const ok = problems.length === 0;
console.log((ok ? '✅' : '❌') + ' letterEdit/letterType/wizNode/wizPath/docName survive reload' + (ok ? '' : '\n   ' + problems.join('\n   ')));

// Also verify the letter screen actually SHOWS the persisted hand-edited text
// after reload, not just that localStorage kept it.
// "Draft a letter" is only shown for non-wage issues now (redundant for wage —
// both letters are reachable via the step list); use the classification step.
// The letter screen shows the raw persisted letterEdit text regardless of which
// letter kind is active, so this doesn't affect the assertion below.
await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Ask HR, in writing, for your overtime')); if (btn) btn.click(); });
await new Promise(r => setTimeout(r, 300));
const shownText = await pg.evaluate(() => { const ta = document.querySelector('textarea'); return ta ? ta.value : null; });
const rendered = shownText === seed.letterEdit;
console.log((rendered ? '✅' : '❌') + ' Letter screen renders the persisted edited text after reload' + (rendered ? '' : ' (got: ' + JSON.stringify(shownText) + ')'));

allOk = ok && rendered;
} finally {
  await b.close();
  server.close();
}
console.log(allOk ? '\n✅ RELOAD-PERSISTENCE TEST PASSED' : '\n❌ RELOAD-PERSISTENCE TEST FAILED');
process.exit(allOk ? 0 : 1);
