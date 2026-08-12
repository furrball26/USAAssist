#!/usr/bin/env node
/*
 * Document-review honesty/real-scan regression test (F8).
 *
 * The picker only ever noted a filename and showed 3 hardcoded example clauses
 * identical for everyone — the whole document-review issue-type was inform-
 * then-abandon. Pasting real text must now be actually scanned (rules-based
 * keyword matching, run locally) and produce clauses drawn from THAT text, not
 * the static example; the copy must not claim uploaded files are read.
 * Run: node test/doc-review-scan.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { execSync } from 'node:child_process';
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
const chrome = execSync(`find "${ROOT}chrome-headless-shell" -type f -name 'chrome-headless-shell' | head -1`).toString().trim();

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

try {

async function freshPage() {
  const pg = await b.newPage();
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'A document to review',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Review a document')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  return pg;
}

// Case 1: pasting text with a non-compete clause (and no arbitration/release
// language) must flag ONLY the matching clause type, quoting the pasted text.
{
  const pg = await freshPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  const pasted = 'This is a job offer. Employee agrees to a strict non-compete and shall not work for a competitor within 50 miles for 2 years after separation.';
  await pg.evaluate(() => { const ta = document.querySelector('#doc-text'); ta && ta.focus(); });
  await pg.keyboard.type(pasted, { delay:0 });
  await new Promise(r => setTimeout(r, 200));

  const pageText = await pg.evaluate(() => document.body.textContent);
  const cardTitles = await pg.evaluate(() => [...document.querySelectorAll('h1,span')].map(e => e.textContent));

  const problems = [];
  if (!/1 clause flagged in your pasted text/.test(pageText)) problems.push('expected exactly 1 flagged clause, page text: ' + JSON.stringify(pageText.slice(0, 400)));
  if (!cardTitles.some(t => /Non-compete/.test(t))) problems.push('non-compete clause was not flagged');
  if (cardTitles.some(t => /Release of claims/.test(t))) problems.push('release-of-claims clause flagged on text that never mentions a release (false positive)');
  if (!pageText.includes('50 miles')) problems.push('flagged clause does not quote the actual pasted text');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' pasted text is actually scanned and quotes real text' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2b (R9): "non-competition" (not just "non-compete") must also be
// flagged — the original regex `non-?compete` didn't match the `-ion` form.
{
  const pg = await freshPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  const pasted = 'Employee agrees to a period of non-competition for 12 months following separation from the company.';
  await pg.evaluate(() => { const ta = document.querySelector('#doc-text'); ta && ta.focus(); });
  await pg.keyboard.type(pasted, { delay:0 });
  await new Promise(r => setTimeout(r, 200));

  const pageText = await pg.evaluate(() => document.body.textContent);
  const cardTitles = await pg.evaluate(() => [...document.querySelectorAll('h1,span')].map(e => e.textContent));

  const problems = [];
  if (!cardTitles.some(t => /Non-compete/.test(t))) problems.push('"non-competition" was not flagged as a non-compete clause');
  if (!pageText.includes('12 months')) problems.push('flagged clause does not quote the actual pasted text');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' "non-competition" wording is flagged (broadened non-compete regex)' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: with nothing pasted, the screen must NOT claim uploaded files are read.
{
  const pg = await freshPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  const pageText = await pg.evaluate(() => document.body.textContent);
  const problems = [];
  if (!/Uploaded files are not read/i.test(pageText)) problems.push('copy no longer honestly discloses that uploaded files are not read');
  if (!/EXAMPLE/.test(pageText)) problems.push('static demo clauses are no longer clearly labeled EXAMPLE');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' copy is honest about what is/isn\'t analyzed' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL DOC-REVIEW-SCAN CASES PASSED');
process.exit(fails ? 1 : 0);
