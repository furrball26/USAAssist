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
import { execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

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
await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:'networkidle0', timeout:20000 });
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

const ok = problems.length === 0;
console.log((ok ? '✅' : '❌') + ' discrimination case can draft a real accommodation-request letter' + (ok ? '' : '\n   ' + problems.join('\n   ')));

await b.close(); server.close();
console.log(ok ? '\n✅ ACCOMMODATION-LETTER TEST PASSED' : '\n❌ ACCOMMODATION-LETTER TEST FAILED');
process.exit(ok ? 0 : 1);
