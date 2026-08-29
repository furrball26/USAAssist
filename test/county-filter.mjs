#!/usr/bin/env node
/*
 * County filter regression test (F20).
 *
 * The previously-vestigial countyQuery state now drives a real text filter
 * above the county <select> for large states (Texas has 254 counties). Small
 * states (few counties) don't need or show the filter. Typing narrows the
 * <select>'s options; the currently-selected county always stays in the list
 * even if it no longer matches the filter text.
 *
 * Run: node test/county-filter.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
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

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let fails = 0;

try {

async function toCountyStep(pg, state) {
  await pg.evaluateOnNewDocument(() => localStorage.clear());
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 500));
  await pg.evaluate((s) => { const sel = document.querySelector('#onb-state'); sel.value = s; sel.dispatchEvent(new Event('change', { bubbles:true })); }, state);
  await new Promise(r => setTimeout(r, 150));
  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Continue'); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 300));
}

// Case 1: Texas (254 counties) shows the filter; typing narrows the options,
// and the selection is preserved after filtering it out.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await toCountyStep(pg, 'Texas');

  const filterPresent = await pg.evaluate(() => !!document.querySelector('#onb-county-filter'));
  const unfilteredCount = await pg.evaluate(() => document.querySelector('#onb-county').options.length);

  await pg.evaluate(() => document.querySelector('#onb-county-filter').focus());
  await pg.keyboard.type('Travis', { delay: 20 });
  await new Promise(r => setTimeout(r, 150));
  const filteredOptions = await pg.evaluate(() => [...document.querySelector('#onb-county').options].map(o => o.value).filter(Boolean));

  // Select Travis County, then type a filter that would exclude it — the
  // select must still contain (and keep selected) Travis County.
  await pg.evaluate(() => { const sel = document.querySelector('#onb-county'); sel.value = 'Travis County'; sel.dispatchEvent(new Event('change', { bubbles:true })); });
  await new Promise(r => setTimeout(r, 150));
  await pg.evaluate(() => document.querySelector('#onb-county-filter').focus());
  await pg.keyboard.down('Control'); await pg.keyboard.press('KeyA'); await pg.keyboard.up('Control');
  await pg.keyboard.press('Backspace');
  await pg.keyboard.type('ZZZ_NO_MATCH', { delay: 20 });
  await new Promise(r => setTimeout(r, 150));
  const selValueAfterNoMatchFilter = await pg.evaluate(() => document.querySelector('#onb-county').value);
  const optionsAfterNoMatchFilter = await pg.evaluate(() => [...document.querySelector('#onb-county').options].map(o => o.value).filter(Boolean));

  const problems = [];
  if (!filterPresent) problems.push('#onb-county-filter missing for Texas (254 counties)');
  if (unfilteredCount < 200) problems.push('unexpectedly few county options for Texas: ' + unfilteredCount);
  if (!filteredOptions.every(n => /travis/i.test(n))) problems.push('filtering "Travis" left non-matching options: ' + JSON.stringify(filteredOptions));
  if (filteredOptions.length === 0) problems.push('filtering "Travis" produced zero options');
  if (selValueAfterNoMatchFilter !== 'Travis County') problems.push('selected county was lost after a filter that excludes it — select value is ' + JSON.stringify(selValueAfterNoMatchFilter));
  if (!optionsAfterNoMatchFilter.includes('Travis County')) problems.push('selected county option disappeared from the list entirely: ' + JSON.stringify(optionsAfterNoMatchFilter));
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Texas: county filter narrows options and preserves the current selection' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: a small state (Delaware, 3 counties) does not show the filter.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await toCountyStep(pg, 'Delaware');

  const filterPresent = await pg.evaluate(() => !!document.querySelector('#onb-county-filter'));
  const problems = [];
  if (filterPresent) problems.push('county filter unexpectedly shown for Delaware (only 3 counties)');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' Delaware: no county filter shown for a small county list' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL COUNTY-FILTER CASES PASSED');
process.exit(fails ? 1 : 0);
