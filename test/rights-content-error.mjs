#!/usr/bin/env node
/*
 * Rights-library content-fetch-error copy regression test (Aug 2026 automated-
 * review High-severity finding).
 *
 * When BOTH the federal and state content fetches fail (same-origin fetch, and
 * its jsDelivr/raw.githubusercontent fallback), the federal-facts block is
 * itself gated on `fedFacts.length` and never renders. The state-error banner
 * used to unconditionally promise "The federal protections below still apply
 * nationwide" regardless — a distressed, possibly-offline user would see two red
 * error paragraphs and a disclaimer promising content that isn't there. Same bug
 * in the "Draft — pending attorney review" banner, which unconditionally
 * promised the same thing whenever state data loaded (even if federal failed
 * independently, since the two fetches are not coupled).
 *
 * Guards that both banners only reference "the federal protections below" when
 * federal facts actually loaded. Run: node test/rights-content-error.mjs
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
let fails = 0;

try {

// Both federal AND state content fetches fail (same-origin path and the
// jsDelivr/raw.githubusercontent fallback both blocked) — the worst case.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  // Chrome's own network-layer "Failed to load resource" console.error for the
  // blocked requests is expected here and is not an app bug — only fail on a
  // real app-level console error.
  pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('CONSOLE ' + m.text()); });
  await pg.setRequestInterception(true);
  pg.on('request', req => {
    if (/content\/_federal\.json/.test(req.url()) || /content\/states\//.test(req.url())) req.abort();
    else req.continue();
  });

  const seed = {
    onboarded:true, stateSel:'California', county:'Los Angeles County', issue:'Discrimination',
    profile:{ name:'', employer:'', payType:'', rate:'' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  await pg.evaluateOnNewDocument(s => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 500));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Rights'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 900)); // allow both fetches (+ fallback attempt) to settle

  const bodyText = await pg.evaluate(() => document.body.innerText);
  const problems = [];
  if (!/Couldn.t load/.test(bodyText)) problems.push('expected a content-fetch error banner, got: ' + JSON.stringify(bodyText.slice(0, 300)));
  if (/federal protections (below )?(still )?appl(y|ies) nationwide/i.test(bodyText)) problems.push('Rights screen still promises "federal protections below" while federal facts failed to load too: ' + JSON.stringify(bodyText.slice(0, 500)));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Rights error copy does not promise federal facts that failed to load' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Only the STATE fetch fails; federal succeeds — the banner SHOULD still
// promise the federal protections, since they really are shown below.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('CONSOLE ' + m.text()); });
  await pg.setRequestInterception(true);
  pg.on('request', req => {
    if (/content\/states\//.test(req.url())) req.abort();
    else req.continue();
  });

  const seed = {
    onboarded:true, stateSel:'California', county:'Los Angeles County', issue:'Discrimination',
    profile:{ name:'', employer:'', payType:'', rate:'' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  };
  await pg.evaluateOnNewDocument(s => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 500));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Rights'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 900));

  const bodyText = await pg.evaluate(() => document.body.innerText);
  const problems = [];
  if (!/Couldn.t load California rules/.test(bodyText)) problems.push('expected the state-fetch error banner, got: ' + JSON.stringify(bodyText.slice(0, 300)));
  if (!/federal protections (below )?(still )?appl(y|ies) nationwide/i.test(bodyText)) problems.push('federal facts DID load but the banner dropped the (now-true) "federal protections below" line: ' + JSON.stringify(bodyText.slice(0, 500)));
  if (!/FEDERAL — APPLIES NATIONWIDE/.test(bodyText)) problems.push('federal facts section did not actually render');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Rights error copy still promises federal facts when they DID load' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL RIGHTS-CONTENT-ERROR CASES PASSED');
process.exit(fails ? 1 : 0);
