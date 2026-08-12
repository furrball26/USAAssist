#!/usr/bin/env node
/*
 * Issue-change `done` reset + "start a fresh case" regression test (F11).
 *
 * `done` is keyed by step INDEX, and different issues have different step lists —
 * switching issue must reset it, or a new issue shows steps pre-checked that were
 * never done for it. "Start a fresh case" must clear entries/done/caseOpened
 * without the full destructive delete (state/county/profile survive).
 * Run: node test/fresh-case.mjs
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

// Case 1: all 4 wage-issue steps done, then switch to a different issue via the ◉
// pill + Save — the new issue's steps must all read as NOT done.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[],
    done:{ 0:true, 1:true, 2:true, 3:true }, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  await pg.evaluate(() => { const btn = document.querySelector('button[aria-label^="Edit your state"]'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  const clickContinue = async () => { await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /^Continue$|Save changes/.test(b.textContent.trim())); if (btn) btn.click(); }); await new Promise(r => setTimeout(r, 250)); };
  await clickContinue(); // state (unchanged) -> county
  await clickContinue(); // county (unchanged) -> issue
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('[role="radio"]')].find(b => /Discrimination$/.test(b.textContent.split('Race')[0].trim())); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 150));
  await clickContinue(); // issue -> details
  await clickContinue(); // Save changes

  const storedDone = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').done);
  const doneCount = Object.values(storedDone || {}).filter(Boolean).length;
  const problems = [];
  if (doneCount !== 0) problems.push('done was not reset on issue change: ' + JSON.stringify(storedDone));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' switching issue resets stale done state' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: "Start a fresh case" clears entries/done/caseOpened but keeps jurisdiction.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:'2020-01-01T00:00:00.000Z', homeMode:'standard',
    entries:[{ date:'JAN 5, 2026', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'x', color:'#EF7B22', tag:'Wage & hour', hours:8, payStatus:'unpaid' }],
    done:{ 0:true }, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  // Auto-accept the confirm() dialog.
  pg.on('dialog', d => d.accept());
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Start a fresh case'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 400));

  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}'));
  const problems = [];
  if (stored.stateSel !== 'Texas') problems.push('jurisdiction was cleared (stateSel=' + JSON.stringify(stored.stateSel) + '), should survive "start a fresh case"');
  if ((stored.profile || {}).employer !== 'Northgate Co') problems.push('profile was cleared, should survive "start a fresh case"');
  if ((stored.entries || []).length !== 0) problems.push('entries were not cleared: ' + JSON.stringify(stored.entries));
  if (Object.values(stored.done || {}).some(Boolean)) problems.push('done was not cleared: ' + JSON.stringify(stored.done));
  if (stored.caseOpened === '2020-01-01T00:00:00.000Z') problems.push('caseOpened was not reset to a fresh date');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' "Start a fresh case" clears the case instance, keeps jurisdiction/profile' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL FRESH-CASE CASES PASSED');
process.exit(fails ? 1 : 0);
