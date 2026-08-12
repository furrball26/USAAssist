#!/usr/bin/env node
/*
 * Location/profile edit staging regression test (F10).
 *
 * Opening the ◉ pill and changing the state select must NOT silently commit the
 * new jurisdiction. Cancel must discard the change entirely (distinct from the
 * old single "Skip to dashboard" exit, which used to commit). Save must be the
 * only thing that commits it. Run: node test/location-edit.mjs
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

async function freshPage() {
  const pg = await b.newPage();
  const seed = {
    onboarded:true, stateSel:'Texas', county:'Travis County', issue:'Unpaid overtime or wages',
    profile:{ name:'Pat Vega', employer:'Northgate Co', payType:'Hourly', rate:'20' },
    caseOpened:new Date().toISOString(), homeMode:'standard', entries:[], done:{}, messages:[],
  };
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  return pg;
}

const openPillAndChangeState = async (pg, newState) => {
  await pg.evaluate(() => { const btn = document.querySelector('button[aria-label^="Edit your state"]'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
  await pg.evaluate((s) => { const sel = document.querySelector('#onb-state'); if (sel) { sel.value = s; sel.dispatchEvent(new Event('change', { bubbles:true })); } }, newState);
  await new Promise(r => setTimeout(r, 200));
};

// Case 1: Cancel discards the change — jurisdiction stays Texas.
{
  const pg = await freshPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  await openPillAndChangeState(pg, 'California');
  const cancelClicked = await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /Cancel/.test(b.textContent)); if (btn) { btn.click(); return true; } return false; });
  await new Promise(r => setTimeout(r, 300));
  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').stateSel);
  const pillText = await pg.evaluate(() => { const btn = document.querySelector('button[aria-label^="Edit your state"]'); return btn ? btn.textContent : null; });

  const problems = [];
  if (!cancelClicked) problems.push('no Cancel button found');
  if (stored !== 'Texas') problems.push('Cancel did not discard the change — stored stateSel is ' + JSON.stringify(stored) + ', expected "Texas"');
  if (pillText && pillText.includes('CA')) problems.push('pill still shows the cancelled state: ' + pillText);
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Cancel discards a staged jurisdiction change' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: changing the state, then navigating away mid-edit some other way (not
// possible via tabs since they're hidden during edit) — but merely SELECTING a
// new state must not itself have committed anything before Save/Cancel is tapped.
{
  const pg = await freshPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  await openPillAndChangeState(pg, 'California');
  const storedMidEdit = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').stateSel);

  const problems = [];
  if (storedMidEdit !== 'Texas') problems.push('selecting a new state alone already committed it — stored stateSel is ' + JSON.stringify(storedMidEdit));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' selecting a new state does not silently commit before Save' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3: walking all 4 steps and tapping Save DOES commit the new state.
{
  const pg = await freshPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  await openPillAndChangeState(pg, 'California');
  const clickContinue = async () => { await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => /^Continue$|Save changes/.test(b.textContent.trim())); if (btn) btn.click(); }); await new Promise(r => setTimeout(r, 250)); };
  await clickContinue(); // -> step 2 (county)
  await pg.evaluate(() => { const sel = document.querySelector('#onb-county'); if (sel && sel.options.length > 1) { sel.value = sel.options[1].value; sel.dispatchEvent(new Event('change', { bubbles:true })); } });
  await new Promise(r => setTimeout(r, 150));
  await clickContinue(); // -> step 3 (issue, already set)
  await clickContinue(); // -> step 4 (details)
  await clickContinue(); // Save changes

  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.case.v2') || '{}').stateSel);
  const problems = [];
  if (stored !== 'California') problems.push('Save did not commit the new state — stored stateSel is ' + JSON.stringify(stored));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Save commits the staged jurisdiction change' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL LOCATION-EDIT CASES PASSED');
process.exit(fails ? 1 : 0);
