#!/usr/bin/env node
/*
 * Accommodation-request letter regression test (F9).
 *
 * ADA_REPLY tells chat users "I can draft that request from a template," but
 * letterKindsFor had no accommodation-request kind — an ADA/disability user
 * only ever got a generic Title VII complaint letter. Discrimination-issue
 * users must be able to actually get the accommodation-request letter.
 * Run: node test/accommodation-letter.mjs
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
let ok = false;
let ok2 = false;
try {
const pg = await b.newPage();
const errs = [];
pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

const seed = {
  onboarded:true, stateSel:'California', county:'Los Angeles County', issue:'Discrimination',
  profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
  caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
};
await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
await new Promise(r => setTimeout(r, 700));

await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Draft a letter')); if (btn) btn.click(); });
await new Promise(r => setTimeout(r, 300));

const kindButtons = await pg.evaluate(() => [...document.querySelectorAll('[role="group"][aria-label="Letter type"] button')].map(b => b.textContent));
const problems = [];
if (!kindButtons.some(t => /Accommodation request/.test(t))) problems.push('no "Accommodation request" letter kind offered for a discrimination case: ' + JSON.stringify(kindButtons));

await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /Accommodation request/.test(b.textContent)); if (btn) btn.click(); });
await new Promise(r => setTimeout(r, 300));

const letterText = await pg.evaluate(() => {
  const els = [...document.querySelectorAll('div')].filter(d => d.textContent.includes('To whom it may concern'));
  return els.length ? els[els.length - 1].textContent : null;
});
if (!letterText) problems.push('accommodation-request letter body not found');
else {
  if (!/reasonable accommodation/i.test(letterText)) problems.push('letter body does not describe a reasonable-accommodation request: ' + JSON.stringify(letterText));
  if (!letterText.includes('42 U.S.C. § 12112')) problems.push('letter is missing the ADA citation');
  if (!/interactive process/i.test(letterText)) problems.push('letter does not mention the interactive process');
}
errs.forEach(e => problems.push(e));

ok = problems.length === 0;
console.log((ok ? '✅' : '❌') + ' discrimination case can draft a real accommodation-request letter' + (ok ? '' : '\n   ' + problems.join('\n   ')));

// Flow audit finding #4 — a wage case's Letter screen must show ONLY its two
// wage letters (no ADA tab it doesn't belong on), but the chat's ADA reply CTA
// must still deep-link to a real, working accommodation-request letter for a
// wage user, even though that kind is not in the wage issue's own tab list.
const pg2 = await b.newPage();
const errs2 = [];
pg2.on('pageerror', e => errs2.push('PAGEERROR ' + e.message));
pg2.on('console', m => { if (m.type() === 'error') errs2.push('CONSOLE ' + m.text()); });
const seed2 = {
  onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
  profile:{ name:'Jordan Lee', employer:'Acme Freight LLC', payType:'Hourly', rate:'20' },
  caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
};
await pg2.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed2);
await gotoApp(pg2, `http://127.0.0.1:${PORT}/index.html`);
await new Promise(r => setTimeout(r, 700));

await pg2.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Ask HR, in writing')); b && b.click(); });
await new Promise(r => setTimeout(r, 300));
const wageTabs = await pg2.evaluate(() => [...document.querySelectorAll('[role="group"][aria-label="Letter type"] button')].map(b => b.textContent));
const problems2 = [];
if (wageTabs.some(t => /Accommodation/.test(t))) problems2.push('wage Letter screen shows an accommodation-request tab: ' + JSON.stringify(wageTabs));
if (!(wageTabs.length === 2 && /Classification/.test(wageTabs[0]) && /Wage demand/.test(wageTabs[1]))) problems2.push('wage Letter tabs are not exactly [Classification, Wage demand]: ' + JSON.stringify(wageTabs));

await pg2.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent === 'Home'); b && b.click(); });
await new Promise(r => setTimeout(r, 300));
await pg2.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Ask AI')); b && b.click(); });
await new Promise(r => setTimeout(r, 300));
await pg2.evaluate(() => { const i = document.querySelector('input[placeholder="Type your question"]'); i && i.focus(); });
await pg2.keyboard.type('How do I ask for an ADA accommodation?', { delay:3 });
await pg2.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Send'); b && b.click(); });
await new Promise(r => setTimeout(r, 1300));
const ctaFound = await pg2.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Draft this letter')); if (b) { b.click(); return true; } return false; });
if (!ctaFound) problems2.push('chat ADA reply has no "Draft this letter" CTA for a wage case');
await new Promise(r => setTimeout(r, 400));
const letterText2 = await pg2.evaluate(() => {
  const els = [...document.querySelectorAll('div')].filter(d => d.textContent.includes('To whom it may concern'));
  return els.length ? els[els.length - 1].textContent : null;
});
if (!letterText2 || !/reasonable accommodation/i.test(letterText2)) problems2.push('ADA chat CTA did not open a real accommodation-request letter for a wage case: ' + JSON.stringify(letterText2));
errs2.forEach(e => problems2.push(e));

ok2 = problems2.length === 0;
console.log((ok2 ? '✅' : '❌') + ' wage Letter screen has no ADA tab, but the chat ADA CTA still reaches a real accommodation-request letter' + (ok2 ? '' : '\n   ' + problems2.join('\n   ')));
} finally {
  await b.close();
  server.close();
}
ok = ok && ok2;
console.log(ok ? '\n✅ ACCOMMODATION-LETTER TEST PASSED' : '\n❌ ACCOMMODATION-LETTER TEST FAILED');
process.exit(ok ? 0 : 1);
