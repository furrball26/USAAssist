#!/usr/bin/env node
/*
 * Storage-quota-exceeded regression test (R12, GitHub issue #1).
 *
 * `storageWarning` — "true when the last save to localStorage failed" — used
 * to be computed on every save (see the `saveCase()` result in the App-level
 * persistence effect) but never rendered anywhere: a log entry could appear
 * to save while silently never persisting, with zero on-screen indication,
 * directly contradicting the app's "everything you enter stays in this
 * browser" promise. This test monkeypatches localStorage.setItem to throw a
 * QuotaExceededError-shaped DOMException (as real browsers do when storage
 * is full) and asserts a visible role="alert" warning appears on both the
 * Home screen (in every homeMode) and the Log screen.
 *
 * Run: node test/storage-quota.mjs
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

const WARNING_RE = /couldn.t be saved/i;

function seed(homeMode) {
  return {
    onboarded: true, stateSel: 'Texas', county: 'Travis County', issue: 'Unpaid overtime or wages',
    profile: { name: 'Pat Vega', employer: 'Northgate Co', payType: 'Hourly', rate: '20' },
    caseOpened: new Date().toISOString(), homeMode, entries: [], done: {}, messages: [],
  };
}

// Sets up a page whose *first* localStorage.setItem call (the app's own
// mount-time persistence effect) throws, mirroring a real full quota — the
// seed data itself is written straight into the storage backing store, not
// through setItem, so it is unaffected by the patch.
async function pageWithFailingStorage(seedObj) {
  const pg = await b.newPage();
  await pg.evaluateOnNewDocument((s) => {
    localStorage.clear();
    localStorage.setItem('worklaw.case.v2', JSON.stringify(s));
    const realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'worklaw.case.v2') {
        const err = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        throw err;
      }
      return realSetItem.call(this, key, value);
    };
  }, seedObj);
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));
  return pg;
}

try {

// Case 1: each home mode surfaces the warning after a failed save on mount.
for (const homeMode of ['standard', 'action', 'plain']) {
  const pg = await pageWithFailingStorage(seed(homeMode));
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));

  const alertText = await pg.evaluate(() => {
    const el = [...document.querySelectorAll('[role="alert"]')].find(e => /couldn.t be saved/i.test(e.textContent));
    return el ? el.textContent : null;
  });
  const problems = [];
  if (!alertText || !WARNING_RE.test(alertText)) problems.push(`no role="alert" storage warning found on the ${homeMode} home screen`);
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ` a failed save surfaces a visible alert on Home (${homeMode} mode)` + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2: the warning is also reachable on the Log screen, where a
// perceived-but-unsaved entry is most consequential.
{
  const pg = await pageWithFailingStorage(seed('standard'));
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));

  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Log an incident')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 400));

  const alertText = await pg.evaluate(() => {
    const el = [...document.querySelectorAll('[role="alert"]')].find(e => /couldn.t be saved/i.test(e.textContent));
    return el ? el.textContent : null;
  });
  const problems = [];
  if (!alertText || !WARNING_RE.test(alertText)) problems.push('no role="alert" storage warning found on the Log screen');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' a failed save surfaces a visible alert on the Log screen' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 2b/2c: the warning is also reachable on the records-request and ADA
// process trackers — both write meaningful, exported case data (see
// process-trackers.mjs) but previously rendered no StorageWarningBanner at
// all, so a quota-full save there failed with zero on-screen indication.
{
  const s = seed('standard');
  s.stateSel = 'Texas'; s.county = 'Travis County'; s.issue = 'Fired or pushed out';
  const pg = await pageWithFailingStorage(s);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));

  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Track my records request')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 400));

  const alertText = await pg.evaluate(() => {
    const el = [...document.querySelectorAll('[role="alert"]')].find(e => /couldn.t be saved/i.test(e.textContent));
    return el ? el.textContent : null;
  });
  const problems = [];
  if (!alertText || !WARNING_RE.test(alertText)) problems.push('no role="alert" storage warning found on the records-request tracker');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' a failed save surfaces a visible alert on the records-request tracker' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}
{
  const s = seed('standard');
  s.stateSel = 'California'; s.county = 'Los Angeles County'; s.issue = 'Discrimination';
  const pg = await pageWithFailingStorage(s);
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));

  await pg.evaluate(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Track the ADA process')); if (btn) btn.click(); });
  await new Promise(r => setTimeout(r, 400));

  const alertText = await pg.evaluate(() => {
    const el = [...document.querySelectorAll('[role="alert"]')].find(e => /couldn.t be saved/i.test(e.textContent));
    return el ? el.textContent : null;
  });
  const problems = [];
  if (!alertText || !WARNING_RE.test(alertText)) problems.push('no role="alert" storage warning found on the ADA process tracker');
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' a failed save surfaces a visible alert on the ADA process tracker' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

// Case 3: a normal (non-failing) save shows no warning at all — the banner
// must not be a false positive on every load.
{
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  await pg.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('worklaw.case.v2', JSON.stringify(s)); }, seed('standard'));
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  await new Promise(r => setTimeout(r, 700));

  const alertText = await pg.evaluate(() => {
    const el = [...document.querySelectorAll('[role="alert"]')].find(e => /couldn.t be saved/i.test(e.textContent));
    return el ? el.textContent : null;
  });
  const problems = [];
  if (alertText) problems.push('storage warning shown even though the save should have succeeded: ' + alertText);
  errs.forEach(e => problems.push(e));

  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' no storage warning shown when saves are succeeding' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL STORAGE-QUOTA CASES PASSED');
process.exit(fails ? 1 : 0);
