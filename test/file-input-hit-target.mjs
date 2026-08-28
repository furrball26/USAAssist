#!/usr/bin/env node
/*
 * File-input styling/hit-target regression test (Aug 2026 automated-review
 * High-severity finding, flagged independently by wl-design and wl-ux).
 *
 * Log's "Attach a photo or file" and Doc Review's "Note a file name" both
 * rendered the bare OS-default file-picker button — visually inconsistent with
 * the app's bordered-pill control language, and measured at ~22px tall vs. the
 * 44px minimum every other control in the app meets. Guards that:
 *  - Log now shows a real, app-styled 44px+ "Choose file" button (the native
 *    input is visually hidden but still present/focusable/keyboard-operable);
 *  - Doc Review's native input is hidden inside its already-large clickable
 *    card instead of rendering its own clashing OS button;
 *  - both file inputs still actually work (a chosen file is picked up).
 * Run: node test/file-input-hit-target.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
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

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;
const tmpFile = ROOT + 'test/_tmp-upload.txt';
writeFileSync(tmpFile, 'test upload');

try {

// 1. Log: styled "Choose file" button meets the 44px hit-target bar, and
//    choosing a file still works end to end.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'', employer:'', payType:'', rate:'' },
    caseOpened:new Date().toISOString(), entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument(s => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 500));
  await pg.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Log'); b && b.click(); });
  await new Promise(r => setTimeout(r, 300));

  const box = await pg.evaluate(() => {
    const lbl = [...document.querySelectorAll('label')].find(l => l.textContent.trim() === 'Choose file');
    if (!lbl) return null;
    const r = lbl.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  const problems = [];
  if (!box) problems.push('no styled "Choose file" button found');
  else if (box.h < 44) problems.push('"Choose file" button is only ' + box.h + 'px tall, under the 44px hit-target bar');

  const input = await pg.$('#log-attachment');
  if (input) await input.uploadFile(tmpFile);
  await new Promise(r => setTimeout(r, 300));
  const attached = await pg.evaluate(() => document.body.innerText.includes('_tmp-upload.txt'));
  if (!attached) problems.push('choosing a file via the hidden input did not attach it (functionality regressed)');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Log: styled 44px+ "Choose file" button, still functional' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// 2. Doc Review: the native input is visually hidden (the card is the visible
//    target), and choosing a file still works.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Discrimination',
    profile:{ name:'', employer:'', payType:'', rate:'' },
    caseOpened:new Date().toISOString(), entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument(s => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 500));
  await pg.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /Review a document/.test(x.textContent)); b && b.click(); });
  await new Promise(r => setTimeout(r, 300));

  const state = await pg.evaluate(() => {
    const lbl = document.querySelector('label.fileInputCard');
    const inp = lbl && lbl.querySelector('input[type=file]');
    if (!lbl || !inp) return null;
    const inpR = inp.getBoundingClientRect();
    return { nativeButtonVisible: inpR.width > 2 && inpR.height > 2 };
  });
  const problems = [];
  if (!state) problems.push('doc-review file input/card not found');
  else if (state.nativeButtonVisible) problems.push('native file-picker button is still visibly rendered inside the styled card');

  const input = await pg.$('label.fileInputCard input[type=file]');
  if (input) await input.uploadFile(tmpFile);
  await new Promise(r => setTimeout(r, 300));
  const noted = await pg.evaluate(() => document.body.innerText.includes('_tmp-upload.txt'));
  if (!noted) problems.push('choosing a file via the hidden input did not note its name (functionality regressed)');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Doc Review: native button hidden inside the styled card, still functional' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
  try { unlinkSync(tmpFile); } catch(e) {}
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL FILE-INPUT HIT-TARGET CASES PASSED');
process.exit(fails ? 1 : 0);
