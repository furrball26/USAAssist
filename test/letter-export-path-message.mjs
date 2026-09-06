#!/usr/bin/env node
/*
 * Letter-screen export-path message regression test.
 *
 * The Letter screen's "Export / print PDF" button called printLetter(subject,
 * text) and discarded the return value ('tab' | 'download' | 'failed'), so a
 * user with a popup blocker got a silent .txt download (or an outright
 * failure) with zero on-screen feedback. The case-file-packet export already
 * captures this same return value into state and renders a confirmation/error
 * message (see test/export-path-message.mjs) — this test is that same
 * coverage for the Letter screen. Run: node test/letter-export-path-message.mjs
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

async function letterScreenPage(blockPopup) {
  const pg = await b.newPage();
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Discrimination',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  if (blockPopup) {
    // Simulate a popup-blocked browser: window.open returns null, forcing printLetter's
    // Blob-download fallback path.
    await pg.evaluateOnNewDocument(() => { window.open = () => null; });
  }
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Draft a letter')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  return pg;
}

function readMsg(pg) {
  return pg.evaluate(() => {
    const p = [...document.querySelectorAll('p')].find(p => /letter (downloaded|opened in a new tab)|Export did not work/.test(p.textContent));
    return p ? p.textContent : null;
  });
}

// Case 0: before the export button is clicked, no confirmation message renders.
{
  const pg = await letterScreenPage(false);
  const msg = await readMsg(pg);
  const ok = !msg;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' no export message shown before the export button is clicked' + (ok ? '' : '\n   got: ' + JSON.stringify(msg)));
  await pg.close();
}

// Case 1: normal window.open works -> "opened in a new tab" message.
{
  const pg = await letterScreenPage(false);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Export / print PDF')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  const msg = await readMsg(pg);

  const problems = [];
  if (!msg || !/opened in a new tab/.test(msg)) problems.push('expected "opened in a new tab" message, got: ' + JSON.stringify(msg));
  if (msg && /downloaded/.test(msg)) problems.push('message wrongly claims a download when window.open succeeded');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Letter screen: window.open success shows "opened in a new tab"' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: window.open blocked -> message must say downloaded, NOT "opened in a new tab".
{
  const pg = await letterScreenPage(true);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Export / print PDF')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  const msg = await readMsg(pg);

  const problems = [];
  if (!msg) problems.push('no confirmation message shown');
  else {
    if (/opened in a new tab/.test(msg)) problems.push('message falsely claims "opened in a new tab" when window.open was blocked: ' + JSON.stringify(msg));
    if (!/downloaded/.test(msg)) problems.push('expected a "downloaded" message when window.open was blocked, got: ' + JSON.stringify(msg));
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Letter screen: window.open blocked shows the real "downloaded" fallback message' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL LETTER EXPORT-PATH-MESSAGE CASES PASSED');
process.exit(fails ? 1 : 0);
