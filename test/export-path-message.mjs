#!/usr/bin/env node
/*
 * Export-path message accuracy regression test (F18).
 *
 * printLetter() falls back to a Blob download if window.open is blocked, but
 * "Export case file for this firm" always claimed "opened in a new tab" even
 * when it silently fell back to a download. The confirmation message must
 * reflect the actual path taken. Run: node test/export-path-message.mjs
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
let fails = 0;

async function freshPage(blockPopup) {
  const pg = await b.newPage();
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  if (blockPopup) {
    // Simulate a popup-blocked browser: window.open returns null, forcing printLetter's
    // Blob-download fallback path.
    await pg.evaluateOnNewDocument(() => { window.open = () => null; });
  }
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:'networkidle0', timeout:20000 });
  await new Promise(r => setTimeout(r, 700));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Ready for a real attorney')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  return pg;
}

// Case 1: normal window.open works -> "opened in a new tab" message.
{
  const pg = await freshPage(false);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Export case file for this firm')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  const msg = await pg.evaluate(() => { const p = [...document.querySelectorAll('p')].find(p => p.textContent.includes('sample listing')); return p ? p.textContent : null; });

  const problems = [];
  if (!msg || !/opened in a new tab/.test(msg)) problems.push('expected "opened in a new tab" message, got: ' + JSON.stringify(msg));
  if (msg && /downloaded/.test(msg)) problems.push('message wrongly claims a download when window.open succeeded');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' window.open success shows "opened in a new tab"' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: window.open blocked -> message must say downloaded, NOT "opened in a new tab".
{
  const pg = await freshPage(true);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Export case file for this firm')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  const msg = await pg.evaluate(() => { const p = [...document.querySelectorAll('p')].find(p => p.textContent.includes('sample listing')); return p ? p.textContent : null; });

  const problems = [];
  if (!msg) problems.push('no confirmation message shown');
  else {
    if (/opened in a new tab/.test(msg)) problems.push('message falsely claims "opened in a new tab" when window.open was blocked: ' + JSON.stringify(msg));
    if (!/downloaded/.test(msg)) problems.push('expected a "downloaded" message when window.open was blocked, got: ' + JSON.stringify(msg));
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' window.open blocked shows the real "downloaded" fallback message' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

await b.close(); server.close();
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL EXPORT-PATH-MESSAGE CASES PASSED');
process.exit(fails ? 1 : 0);
