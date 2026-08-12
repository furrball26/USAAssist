#!/usr/bin/env node
/*
 * Per-entry log edit/delete regression test (F12).
 *
 * The incident log's evidence entries could previously only be prepended or
 * wiped-all — a single wrong entry required deleting the entire case. Each
 * entry must have its own Edit (preserving its original timestamp) and Delete
 * control. Run: node test/log-entry-edit-delete.mjs
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

const seed = {
  onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
  profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
  caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[],
  entries: [
    { date:'JAN 5, 2026 · 9:00 AM', iso:'2026-01-05T09:00:00.000Z', title:'Unpaid or extra hours', body:'first entry', color:'#EF7B22', tag:'Wage & hour', hours:8, payStatus:'unpaid' },
    { date:'JAN 6, 2026 · 9:00 AM', iso:'2026-01-06T09:00:00.000Z', title:'Statement recorded', body:'second entry', color:'#2B3AA8', tag:'Statement' },
  ],
};

async function freshPage() {
  const pg = await b.newPage();
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Log an incident')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  return pg;
}

// Case 1: Delete removes only the targeted entry.
{
  const pg = await freshPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  pg.on('dialog', d => d.accept());

  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Delete entry from JAN 5, 2026 · 9:00 AM'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));

  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').entries);
  const problems = [];
  if (!stored || stored.length !== 1) problems.push('expected 1 remaining entry, got ' + JSON.stringify(stored));
  else if (stored[0].body !== 'second entry') problems.push('deleted the wrong entry: ' + JSON.stringify(stored));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Delete removes only the targeted entry' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: Edit preserves the original timestamp while changing the note/hours.
{
  const pg = await freshPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Edit entry from JAN 5, 2026 · 9:00 AM'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 200));
  const hoursVal = await pg.evaluate(() => document.querySelector('#log-hours')?.value);
  await pg.evaluate(() => { const ta = document.querySelector('textarea[aria-label="What happened"]'); if (ta) { ta.focus(); ta.select(); } });
  await pg.keyboard.type(' — corrected', { delay:2 });
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save changes'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));

  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').entries);
  const edited = (stored || []).find(e => e.iso === '2026-01-05T09:00:00.000Z');
  const problems = [];
  if (hoursVal !== '8') problems.push('edit form did not pre-fill hours (got ' + JSON.stringify(hoursVal) + ')');
  if (!edited) problems.push('the original entry (by iso timestamp) is gone after editing — timestamp was not preserved');
  else {
    if (edited.date !== 'JAN 5, 2026 · 9:00 AM') problems.push('entry date/timestamp changed on edit: ' + JSON.stringify(edited.date));
    if (!/corrected/.test(edited.body)) problems.push('edited note did not save: ' + JSON.stringify(edited.body));
  }
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Edit updates the entry while preserving its timestamp' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3 (R11): the per-entry Edit/Delete buttons meet the app's 44px
// minimum hit-target standard (they were previously 36px).
{
  const pg = await freshPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  const heights = await pg.evaluate(() => [...document.querySelectorAll('button')]
    .filter(b => /^Edit entry from|^Delete entry from/.test(b.getAttribute('aria-label') || ''))
    .map(b => ({ label: b.getAttribute('aria-label'), height: b.getBoundingClientRect().height })));

  const problems = [];
  if (heights.length === 0) problems.push('no Edit/Delete entry buttons found to measure');
  heights.forEach(h => { if (h.height < 44) problems.push(h.label + ' is only ' + h.height + 'px tall (< 44px minimum hit target)'); });
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Edit/Delete entry buttons meet the 44px minimum hit target' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL LOG-ENTRY EDIT/DELETE CASES PASSED');
process.exit(fails ? 1 : 0);
