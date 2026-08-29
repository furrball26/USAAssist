#!/usr/bin/env node
/*
 * Log-entry file/photo attachment regression test (F15).
 *
 * A log entry can have a file/photo attached, stored as a data URL with a
 * hard size cap (ATTACHMENT_MAX_BYTES). Covers: attaching a small image and
 * having it persist on the saved entry + render in the entry list; rejecting
 * an oversized file with an inline error (no silent truncation, no crash);
 * and the Remove control clearing a staged (not-yet-submitted) attachment.
 *
 * Run: node test/log-attachment.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
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

// A minimal valid 1x1 transparent PNG.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const tmp = mkdtempSync(join(tmpdir(), 'worklaw-attach-'));
const tinyPngPath = join(tmp, 'evidence.png');
writeFileSync(tinyPngPath, TINY_PNG);
const bigPath = join(tmp, 'too-big.bin');
writeFileSync(bigPath, Buffer.alloc(2 * 1024 * 1024)); // 2MB, over the 1.5MB cap

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

try {

async function toLogScreen() {
  const pg = await b.newPage();
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Harassment or a hostile workplace',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Log')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 400));
  return pg;
}

// Case 1: attach a small image, submit, and it shows up on the saved entry
// both in the DOM and in localStorage.
{
  const pg = await toLogScreen();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  const fileInput = await pg.$('#log-attachment');
  const problems = [];
  if (!fileInput) problems.push('#log-attachment file input not found on the Log screen');
  else {
    await fileInput.uploadFile(tinyPngPath);
    await new Promise(r => setTimeout(r, 400));
    const previewName = await pg.evaluate(() => { const el = [...document.querySelectorAll('span')].find(s => s.textContent === 'evidence.png'); return el ? el.textContent : null; });
    if (previewName !== 'evidence.png') problems.push('attachment preview did not show the picked file name after upload');

    await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /^Add to log$/.test(b.textContent.trim())); if (btn) btn.click(); });
    await new Promise(r => setTimeout(r, 300));

    const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').entries || []);
    const savedAttachment = stored[0] && stored[0].attachment;
    if (!savedAttachment) problems.push('saved entry has no attachment field: ' + JSON.stringify(stored[0]));
    else {
      if (savedAttachment.name !== 'evidence.png') problems.push('saved attachment name mismatch: ' + JSON.stringify(savedAttachment.name));
      if (!/^data:image\/png;base64,/.test(savedAttachment.dataUrl || '')) problems.push('saved attachment dataUrl is not a PNG data URL: ' + JSON.stringify((savedAttachment.dataUrl || '').slice(0, 40)));
    }

    const rendersInList = await pg.evaluate(() => !![...document.querySelectorAll('a[download]')].find(a => a.textContent.includes('evidence.png')));
    if (!rendersInList) problems.push('saved entry does not render a downloadable attachment link in the entry list');
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' attaching a small image persists on the entry and renders in the list' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: an oversized file is rejected with an inline error, not silently
// accepted or truncated.
{
  const pg = await toLogScreen();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  const fileInput = await pg.$('#log-attachment');
  const problems = [];
  if (!fileInput) problems.push('#log-attachment file input not found');
  else {
    await fileInput.uploadFile(bigPath);
    await new Promise(r => setTimeout(r, 400));
    const errorShown = await pg.evaluate(() => { const el = [...document.querySelectorAll('[role="alert"]')].find(e => /limited to/i.test(e.textContent)); return el ? el.textContent : null; });
    const attachmentStaged = await pg.evaluate(() => !![...document.querySelectorAll('span')].find(s => s.textContent === 'too-big.bin'));
    if (!errorShown) problems.push('no inline error shown for an oversized file');
    if (attachmentStaged) problems.push('oversized file was staged as an attachment despite exceeding the cap');
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' an oversized file is rejected with an inline error, not accepted' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3: Remove clears a staged (not-yet-submitted) attachment.
{
  const pg = await toLogScreen();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  const fileInput = await pg.$('#log-attachment');
  const problems = [];
  if (!fileInput) problems.push('#log-attachment file input not found');
  else {
    await fileInput.uploadFile(tinyPngPath);
    await new Promise(r => setTimeout(r, 400));
    const removed = await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /^Remove$/.test(b.textContent.trim())); if (btn) { btn.click(); return true; } return false; });
    await new Promise(r => setTimeout(r, 200));
    const stillStaged = await pg.evaluate(() => !![...document.querySelectorAll('span')].find(s => s.textContent === 'evidence.png'));
    const fileInputBack = await pg.evaluate(() => !!document.querySelector('#log-attachment'));
    if (!removed) problems.push('no Remove button found after attaching a file');
    if (stillStaged) problems.push('attachment preview still shown after Remove');
    if (!fileInputBack) problems.push('file input did not reappear after Remove');
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Remove clears a staged attachment before submit' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL LOG-ATTACHMENT CASES PASSED');
process.exit(fails ? 1 : 0);
