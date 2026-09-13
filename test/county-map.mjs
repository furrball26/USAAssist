#!/usr/bin/env node
/*
 * Single-state county map (index.dev.html: StateCountyMap; geometry from
 * content/geo/<ABBR>.json via automation/build-county-geo.mjs).
 *
 * Part 1 is static and is the part that protects users: every state the app
 * offers must have a geo file, and every shape in it must name a county that
 * is actually selectable. A shape whose name doesn't match drops out of the
 * map with nothing failing — a worker in that county simply cannot find
 * themselves, and no test or log says so. Six real cases existed before the
 * build-time reconciliation landed (Virginia's "Charles City"/"James City",
 * "La Salle"/"LaSalle", "Dona Ana"/"Doña Ana", plus two counties the app's
 * list still named by their pre-2015 titles).
 *
 * It also asserts the reverse — no county in the app's list is missing a
 * shape — so the map can never be quietly less complete than the dropdown.
 *
 * Part 2 drives the app: the map renders for a picked state, clicking a
 * county writes the same value the <select> holds, and the <select> is still
 * there (the map is an enhancement; county shapes are real, so some targets
 * are genuinely tiny and the list must always work).
 *
 * Run: node test/county-map.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { resolveChromePath } from './lib/chrome.mjs';
import puppeteer from 'puppeteer-core';
import { gotoApp } from './lib/nav.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };

// ── Part 1 · geometry covers exactly what the app offers ────────────────────
const dev = readFileSync(join(ROOT, 'index.dev.html'), 'utf8');
const ABBR = JSON.parse(dev.match(/const US_STATE_ABBR = (\{.*?\});/s)[1]);
const COUNTIES = JSON.parse(dev.match(/const US_COUNTIES = (\{.*?\});/s)[1]);

const missingFiles = [];
const orphanShapes = [];   // shape names no dropdown entry matches
const missingShapes = [];  // dropdown entries with no shape
let shapes = 0;

for (const [stateName, abbr] of Object.entries(ABBR)) {
  const f = join(ROOT, 'content/geo', abbr + '.json');
  if (!existsSync(f)) { missingFiles.push(abbr); continue; }
  const geo = JSON.parse(readFileSync(f, 'utf8'));
  const list = COUNTIES[stateName] || [];
  const inList = new Set(list);
  const inGeo = new Set();
  for (const c of geo.counties) {
    shapes++;
    inGeo.add(c.name);
    if (!inList.has(c.name)) orphanShapes.push(`${abbr}: "${c.name}"`);
  }
  for (const c of list) if (!inGeo.has(c)) missingShapes.push(`${abbr}: "${c}"`);
}

ok(missingFiles.length === 0, 'every state the app offers has a county-geometry file' + (missingFiles.length ? ': missing ' + missingFiles.join(', ') : ''));
ok(orphanShapes.length === 0,
  `every county shape names a selectable county (${shapes} shapes checked)` +
  (orphanShapes.length ? ` — ORPHANS would vanish from the map: ${orphanShapes.slice(0, 8).join(', ')}` : ''));
ok(missingShapes.length === 0,
  'every county in the dropdown has a shape on the map' +
  (missingShapes.length ? ` — MISSING: ${missingShapes.slice(0, 8).join(', ')}` : ''));

// Name collisions within one state would make an exact-match click ambiguous.
const collisions = [];
for (const [stateName, abbr] of Object.entries(ABBR)) {
  const f = join(ROOT, 'content/geo', abbr + '.json');
  if (!existsSync(f)) continue;
  const seen = new Set();
  for (const c of JSON.parse(readFileSync(f, 'utf8')).counties) {
    if (seen.has(c.name)) collisions.push(`${abbr}: "${c.name}"`);
    seen.add(c.name);
  }
}
ok(collisions.length === 0,
  'no two shapes in a state share a name (Virginia\'s Fairfax county vs Fairfax city stay distinct)' +
  (collisions.length ? ': ' + collisions.join(', ') : ''));

// Geometry files are fetched per state, so size is a user-facing cost.
const sizes = readdirSync(join(ROOT, 'content/geo'))
  .map(f => statSync(join(ROOT, 'content/geo', f)).size);
const biggest = Math.max(...sizes);
ok(biggest < 120 * 1024, `the largest state's geometry stays under 120KB (biggest is ${(biggest / 1024).toFixed(0)}KB — fetched on demand, not bundled)`);

// ── Part 2 · the map in the app ─────────────────────────────────────────────
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = normalize(join(ROOT, p));
  if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
});
await new Promise(r => server.listen(0, r));
const b = await puppeteer.launch({ executablePath: resolveChromePath(), headless: true, args: ['--no-sandbox'] });

try {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await gotoApp(pg, `http://127.0.0.1:${server.address().port}/index.html`);
  await new Promise(r => setTimeout(r, 400));

  // Step 1: pick California off the state map, then continue to counties.
  await pg.evaluate(() => {
    const t = [...document.querySelectorAll('.wlStateBtn')].find(x => x.textContent.trim() === 'CA');
    t && t.click();
  });
  await new Promise(r => setTimeout(r, 250));
  await pg.evaluate(() => {
    const t = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Continue');
    t && t.click();
  });
  await new Promise(r => setTimeout(r, 1500));

  const paths = await pg.evaluate(() => document.querySelectorAll('.wlCountyMap path').length);
  ok(paths === 58, `California's 58 counties render as selectable shapes (got ${paths})`);

  ok(await pg.$('#onb-county') !== null, 'the searchable county <select> is still present alongside the map');

  const a11y = await pg.evaluate(() => {
    const p = document.querySelector('.wlCountyMap path');
    return p ? { label: p.getAttribute('aria-label'), role: p.getAttribute('role'), tab: p.getAttribute('tabindex') } : null;
  });
  ok(a11y && a11y.role === 'button' && a11y.tab === '0' && /County$/.test(a11y.label || ''),
    'county shapes are focusable buttons with a full county name as their label');

  // A click must write exactly what the dropdown holds.
  const picked = await pg.evaluate(() => {
    const t = [...document.querySelectorAll('.wlCountyMap path')]
      .find(p => p.getAttribute('aria-label') === 'Los Angeles County');
    if (!t) return null;
    t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  });
  await new Promise(r => setTimeout(r, 350));
  const sel = await pg.$eval('#onb-county', el => el.value);
  ok(picked && sel === 'Los Angeles County', `clicking a county drives the same value as the select (got "${sel}")`);
  const pressed = await pg.evaluate(() =>
    document.querySelector('.wlCountyMap path[aria-pressed="true"]')?.getAttribute('aria-label'));
  ok(pressed === 'Los Angeles County', 'the chosen county reports aria-pressed="true"');
  ok(errs.length === 0, 'no console/page errors using the county map' + (errs.length ? ': ' + errs[0] : ''));
  await pg.close();
} finally {
  await b.close();
  server.close();
}

console.log(fails === 0 ? '\n✅ COUNTY-MAP PASSED' : `\n❌ ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
