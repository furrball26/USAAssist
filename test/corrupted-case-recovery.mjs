#!/usr/bin/env node
/*
 * Corrupted-localStorage recovery regression test.
 *
 * The app reads one persisted value on mount — the state and county the reader
 * picked — and feeds it straight into US_STATE_ABBR lookups, the content fetch
 * and the geo fetch. A malformed-but-truthy field (a stateSel persisted as an
 * object rather than a string — reachable from a future schema change, a
 * browser extension, or devtools tampering) must not take the whole app to a
 * permanently blank #root, which reload would not fix since the bad value is
 * never rewritten.
 *
 * Guards both halves: loadPrefs()/sanitizePrefs() coercing a malformed value
 * back to a safe shape, AND the ErrorBoundary catching anything that throws
 * anyway and offering a recovery that actually works.
 *
 * Run: node test/corrupted-case-recovery.mjs
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

const PLACE_KEY = 'worklaw.place.v1';
const WELCOME_KEY = 'worklaw.seenWelcome.v1';

// Seed a raw (possibly malformed) value under the place key, bypassing the
// gotoApp helper's well-formed seeding.
const seedRaw = (pg, raw) => pg.evaluateOnNewDocument((pk, wk, v) => {
  try { localStorage.setItem(wk, '1'); localStorage.setItem(pk, v); } catch (e) {}
}, PLACE_KEY, WELCOME_KEY, raw);

// 1. Every malformed-but-truthy shape must be sanitized rather than crash.
{
  const cases = [
    { label: '`stateSel` as a plain object', raw: JSON.stringify({ stateSel: { nested: 'object' }, county: 'Travis County' }) },
    { label: '`county` as a number',         raw: JSON.stringify({ stateSel: 'Texas', county: 42 }) },
    { label: 'the whole blob as an array',   raw: JSON.stringify([1, 2, 3]) },
    { label: 'the whole blob as a string',   raw: JSON.stringify('Texas') },
    { label: 'unparsable JSON',              raw: '{not json at all' },
    { label: '`stateSel` naming no real state', raw: JSON.stringify({ stateSel: 'Atlantis', county: 'Nowhere' }) },
  ];
  for (const c of cases) {
    const pg = await b.newPage();
    const errs = [];
    pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('CONSOLE ' + m.text()); });
    await seedRaw(pg, c.raw);
    await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`, { freshVisitor: true });
    await new Promise(r => setTimeout(r, 900));

    const rootChildCount = await pg.evaluate(() => document.getElementById('root').childElementCount);
    const bodyText = await pg.evaluate(() => document.body.innerText);
    const problems = [];
    if (rootChildCount === 0) problems.push('#root never mounted (blank page)');
    if (/Something went wrong/.test(bodyText)) problems.push('sanitizePrefs did not prevent the crash — fell through to the ErrorBoundary instead of rendering normally');
    errs.forEach(e => problems.push(e));
    await pg.close();

    const ok = problems.length === 0;
    if (!ok) fails++;
    console.log((ok ? '✅' : '❌') + ' malformed ' + c.label + ' does not white-screen the app' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  }
}

// 2. Defense in depth: if something throws anyway, the ErrorBoundary fallback
//    must render (not a truly blank #root) and its reset button must actually
//    clear the stored place and return the app to the map.
{
  const pg = await b.newPage();
  // Deliberately NOT seeded via evaluateOnNewDocument: that hook re-runs on
  // every navigation, so it would re-write the place during the very reload
  // this case is checking clears it. Set the place by using the app instead.
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
  // localStorage is per-origin: the cases above left a place behind in this
  // same browser. Drop it with a one-shot evaluate (not a persistent hook) so
  // this page starts at the map.
  await pg.evaluate(k => { try { localStorage.removeItem(k); } catch (e) {} }, PLACE_KEY);
  await reloadApp(pg);
  await new Promise(r => setTimeout(r, 1200));
  await pg.select('#onb-state', 'Texas');
  await new Promise(r => setTimeout(r, 800));
  await pg.select('#onb-county', 'Travis County');
  await new Promise(r => setTimeout(r, 800));

  // Make the next render throw from inside the tree, which is the only thing
  // an ErrorBoundary can catch — a corrupted stored value alone is sanitized
  // before it ever reaches a render, which is the point of case 1.
  await pg.evaluate(() => {
    const orig = Array.prototype.map;
    // eslint-disable-next-line no-extend-native
    Array.prototype.map = function () { throw new Error('injected render failure'); };
    window.__restoreMap = () => { Array.prototype.map = orig; };
    // Force a re-render by navigating.
    const btn = [...document.querySelectorAll('.tabbar button')].find(b => /All rights/.test(b.textContent));
    btn && btn.click();
  });
  await new Promise(r => setTimeout(r, 600));

  const bodyText = await pg.evaluate(() => document.body.innerText);
  const problems = [];
  const rootChildCount = await pg.evaluate(() => document.getElementById('root').childElementCount);
  if (rootChildCount === 0) problems.push('#root went blank instead of rendering the ErrorBoundary fallback');
  if (!/Something went wrong/.test(bodyText)) {
    problems.push('the ErrorBoundary did not render its fallback after an injected render failure: ' + JSON.stringify(bodyText.slice(0, 200)));
  } else {
    await pg.evaluate(() => window.__restoreMap && window.__restoreMap());
    const clicked = await pg.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /Reset and start over/i.test(b.textContent));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) problems.push('ErrorBoundary rendered but no reset button was found');
    await new Promise(r => setTimeout(r, 900));
    const stored = await pg.evaluate(k => localStorage.getItem(k), PLACE_KEY);
    const afterText = await pg.evaluate(() => document.body.innerText);
    if (stored !== null) problems.push('the reset button did not clear the stored place');
    if (!/Where do you work/i.test(afterText)) problems.push('recovery did not return the app to the map: ' + JSON.stringify(afterText.slice(0, 200)));
  }
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' ErrorBoundary fallback offers a working recovery path' + (ok ? '' : '\n   ' + problems.join('\n   ')));
  await pg.close();
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL CORRUPTED-CASE-RECOVERY CASES PASSED');
process.exit(fails ? 1 : 0);
