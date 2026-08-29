#!/usr/bin/env node
/*
 * Privacy regression test: the "Delete my case & start over" control must erase
 * the sensitive case (employer, name, pay, incident log, chat) from localStorage
 * and return the app to onboarding. Guards the clearCase fix. Run: node test/privacy.mjs
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

const SECRETS = /secret incident|Acme Freight|my private note|Jordan Lee/;

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let problems = ['harness did not run'];
try {
const pg = await b.newPage();
pg.on('dialog', d => d.accept());
const seed = {
  onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
  profile:{ name:'Jordan Lee', employer:'Acme Freight LLC', payType:'Hourly', rate:'20' },
  homeMode:'standard', entries:[{ date:'X', title:'t', body:'secret incident', hours:5 }],
  messages:[{ role:'user', text:'my private note' }], done:{}, caseOpened:new Date().toISOString(),
};
await pg.evaluateOnNewDocument(s => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), seed);
await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
await new Promise(r => setTimeout(r, 600));

const before = await pg.evaluate(() => localStorage.getItem('worklaw.case.v2'));
const clicked = await pg.evaluate(() => { const el = [...document.querySelectorAll('button')].find(b => /Delete my case/i.test(b.textContent)); if (el) { el.click(); return true; } return false; });
await new Promise(r => setTimeout(r, 600));
const after = await pg.evaluate(() => localStorage.getItem('worklaw.case.v2'));
const onOnboarding = await pg.evaluate(() => /Where do you work|Employment law changes by state/i.test(document.body.innerText));

problems = [];
if (!SECRETS.test(before || '')) problems.push('seed did not contain expected sensitive data (test setup broken)');
if (!clicked) problems.push('"Delete my case" control not found on the dashboard');
if (SECRETS.test(after || '')) problems.push('sensitive data still present in localStorage after delete');
if (!onOnboarding) problems.push('app did not return to onboarding after delete');
} finally {
  await b.close();
  server.close();
}
if (problems.length) { console.log('❌ PRIVACY FAILED\n   ' + problems.join('\n   ')); process.exit(1); }
console.log('✅ PRIVACY PASSED — case data cleared and app reset to onboarding');
process.exit(0);
