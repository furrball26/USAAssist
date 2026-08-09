#!/usr/bin/env node
/*
 * Edit-location pill in every home mode regression test (F17).
 *
 * The ◉ edit-location/profile pill previously only rendered in HomeStandard
 * — Action-first and Plain modes had no way at all to fix a wrong state or
 * county without first switching back to Standard. It must now be present
 * (and open the onboarding edit flow) in all three modes.
 *
 * Run: node test/home-mode-edit-pill.mjs
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

async function freshPage(homeMode) {
  const pg = await b.newPage();
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode, entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:'networkidle0', timeout:20000 });
  await new Promise(r => setTimeout(r, 700));
  return pg;
}

for (const mode of ['standard', 'action', 'plain']) {
  const pg = await freshPage(mode);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  const pillPresent = await pg.evaluate(() => !![...document.querySelectorAll('button')].find(b => b.textContent.includes('◉')));
  const clicked = await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('◉')); if (btn) { btn.click(); return true; } return false; });
  await new Promise(r => setTimeout(r, 300));
  const onOnboardingScreen = await pg.evaluate(() => !!document.querySelector('#onb-state'));

  const problems = [];
  if (!pillPresent) problems.push('◉ edit-location pill missing in "' + mode + '" home mode');
  if (!clicked) problems.push('◉ pill not clickable in "' + mode + '" home mode');
  if (!onOnboardingScreen) problems.push('tapping ◉ in "' + mode + '" mode did not open the edit-location flow');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' "' + mode + '" home mode has a working ◉ edit-location pill' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

await b.close(); server.close();
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL HOME-MODE EDIT-PILL CASES PASSED');
process.exit(fails ? 1 : 0);
