#!/usr/bin/env node
/*
 * The nine states the map cannot give a fingertip
 * (index.dev.html: UsaStatePicker / SmallStateRow / LABEL_FIT_R).
 *
 * Measured on the shipped build at a 390px viewport, the state shapes on the
 * first screen render this small (CSS px, bounding box):
 *
 *   Rhode Island   3.7 x  5.3     New Hampshire   8.2 x 17.4
 *   Delaware       5.3 x  8.7     Massachusetts  17.2 x  9.6
 *   Connecticut    8.7 x  8.7     Maryland       22.5 x 11.3
 *   New Jersey     6.5 x 15.5     Vermont         8.4 x 15.8
 *
 * Rhode Island was a twenty-square-pixel target. These are not "small"
 * controls, they are unhittable ones, and the leader-line column beside the
 * map only NAMES them — the label is ~10 CSS px tall on a phone and is
 * pointer-transparent by design, so it never was a way in. The state was
 * reachable solely through the <select>, which is the fallback, not the
 * flow the whole screen is built around.
 *
 * No claim is made here that every state clears a WCAG target size: fitting
 * the United States into 342px means almost nothing on this map does, which
 * is exactly why the labelled <select> is an equivalent control on the same
 * screen and must stay. This suite covers the states that were impossible
 * rather than merely small, and it derives that set from the GEOMETRY
 * (content/geo/_states.json `lr`, the largest inscribed radius) so that
 * regenerating the geo can never leave the row and the map disagreeing.
 *
 * The threshold is not arbitrary — the data has a clean gap there:
 *   ... VT 10.7, NH 11.8 | TN 18.7, WV 18.8 ...
 * LABEL_FIT_R (15) sits inside it, and already meant "no room for a
 * two-character label". No room for a label, no room for a fingertip.
 *
 * Asserts:
 *   1. the row's buttons are exactly the states under the threshold,
 *   2. each is a real target (>=44px both axes) at 390px,
 *   3. a shape too small to tap is NOT also exposed as a control — otherwise
 *      a screen reader announces a button nobody can reach, twice,
 *   4. tapping one actually advances to that state's counties.
 *
 * Run: node test/small-state-targets.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import puppeteer from 'puppeteer-core';
import { resolveChromePath } from './lib/chrome.mjs';
import { gotoApp } from './lib/nav.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };

// The threshold comes from the app, not from this file — if LABEL_FIT_R moves,
// the expected set moves with it instead of this suite going quietly stale.
const dev = readFileSync(join(ROOT, 'index.dev.html'), 'utf8');
const FIT = Number(dev.match(/const LABEL_FIT_R = (\d+(?:\.\d+)?)/)[1]);
if (!Number.isFinite(FIT)) { console.log('❌ could not read LABEL_FIT_R from index.dev.html'); process.exit(1); }

const geo = JSON.parse(readFileSync(join(ROOT, 'content/geo/_states.json'), 'utf8'));
const expected = geo.states.filter(s => s.lr < FIT).map(s => s.name).sort();

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.css':'text/css', '.svg':'image/svg+xml' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: resolveChromePath(), headless: true, args: ['--no-sandbox'] });

// The row is keyed off the state names, so find it by its buttons rather than
// by a wrapper class that a restyle could rename.
const readRow = page => page.evaluate(names => {
  const set = new Set(names);
  return [...document.querySelectorAll('button')]
    .filter(b => set.has((b.textContent || '').trim()))
    .map(b => { const r = b.getBoundingClientRect(); return { name: b.textContent.trim(), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; });
}, expected);

try {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  await page.setViewport({ width: 390, height: 844 });
  await gotoApp(page, BASE);
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await gotoApp(page, BASE);
  await new Promise(r => setTimeout(r, 800));

  // 1 · the row is exactly the states the map can't serve
  const rows = await readRow(page);
  const got = rows.map(r => r.name).sort();
  ok(got.length === expected.length && got.every((n, i) => n === expected[i]),
     `every state too small to tap (lr < ${FIT}) has a button of its own — expected ${expected.length}, found ${got.length}` +
     (got.length !== expected.length ? `: missing ${expected.filter(n => !got.includes(n)).join(', ') || '(none)'}` : ''));

  // 2 · and it is a real target
  // `rows.every(...)` on an empty row would pass while proving nothing, which
  // is how a suite quietly stops testing. Require the buttons to exist first.
  const tooSmall = rows.filter(r => r.w < 44 || r.h < 44);
  ok(rows.length === expected.length && tooSmall.length === 0,
     `each of those ${expected.length} buttons is at least 44x44 CSS px at 390px` +
     (rows.length !== expected.length ? ` — only ${rows.length} rendered, so there is nothing to measure`
      : tooSmall.length ? ` — under: ${tooSmall.map(r => `${r.name} ${r.w}x${r.h}`).join(', ')}` : ''));

  // 3 · the unhittable shape is not ALSO announced as a control
  const dupes = await page.evaluate(names => {
    const set = new Set(names);
    return [...document.querySelectorAll('.wlUsMap path[role="button"]')]
      .map(p => p.getAttribute('aria-label')).filter(n => set.has(n));
  }, expected);
  ok(dupes.length === 0,
     'a shape too small to tap is not also exposed as a map control' +
     (dupes.length ? ` — still announced: ${dupes.join(', ')}` : ''));

  // 4 · and the button does the job the shape could not. Report a missing
  //     button as a failed assertion rather than throwing: an exception here
  //     would abort the run and hide whatever else is broken.
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(el => (el.textContent || '').trim() === 'Rhode Island');
    if (!b) return false;
    b.click(); return true;
  });
  await new Promise(r => setTimeout(r, 1200));
  const after = clicked ? await page.evaluate(() => document.body.innerText) : '';
  ok(clicked && /Where in Rhode Island\?/i.test(after),
     'tapping Rhode Island advances to its counties — the state the map could not select at all' +
     (clicked ? '' : ' — there is no Rhode Island button to tap'));
  ok(errs.length === 0, 'no console/page errors picking a small state' + (errs.length ? ': ' + errs[0] : ''));
  await page.close();
} finally {
  await browser.close();
  server.close();
}

console.log(fails ? `\n❌ SMALL-STATE TARGETS FAILED (${fails})` : '\n✅ SMALL-STATE TARGETS PASSED');
process.exit(fails ? 1 : 0);
