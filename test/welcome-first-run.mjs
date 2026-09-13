#!/usr/bin/env node
/*
 * First-run welcome screen + state-map picker.
 *
 * A genuinely fresh visitor lands on the welcome illustration (index.dev.html:
 * `Welcome`), not on onboarding. This asserts the four things that make that
 * screen safe rather than merely decorative:
 *
 *   1. It appears once. A fresh device sees it; after entering, a reload goes
 *      straight to onboarding. The gate is a device-level key
 *      (SEEN_WELCOME_KEY), NOT the case blob — so it must survive a case
 *      being cleared, which is the whole reason it lives outside saveCase().
 *   2. It never traps anyone. Both the primary button and Skip leave.
 *   3. The illustration is announced as ONE image, not 52 tiles and six
 *      figures — a screen-reader user should hear a sentence, not a list.
 *   4. The state map and the <select> stay in agreement. The map is an
 *      ENHANCEMENT over the labelled select (index.dev.html: UsaStatePicker) —
 *      picking a state on the map must set the same value the select shows,
 *      and every rendered tile must correspond to a state the app has content
 *      for (no dead DC/PR tiles, since content/states/ has neither).
 *
 * Run: node test/welcome-first-run.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
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
const URL_ = `http://127.0.0.1:${PORT}/index.html`;
const b = await puppeteer.launch({ executablePath: resolveChromePath(), headless: true, args: ['--no-sandbox'] });

let fails = 0;
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };
const clickText = async (pg, t) => {
  await pg.evaluate((x) => {
    const e = [...document.querySelectorAll('button,a')].find(el => el.textContent.trim() === x);
    if (e) e.click();
  }, t);
  await new Promise(r => setTimeout(r, 300));
};
/*
 * Each case gets its own browser context, which starts with empty storage.
 *
 * NOT evaluateOnNewDocument(localStorage.clear): that hook re-runs on every
 * navigation, so it wipes the seen flag during the very reload that is meant
 * to prove the flag persisted — the "does it replay?" assertions can then
 * never pass, whatever the app does. An isolated context gives a genuinely
 * fresh device once, and lets reloads behave like real reloads.
 */
const contexts = [];
const freshPage = async () => {
  const ctx = await b.createBrowserContext();
  contexts.push(ctx);
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  return { pg, errs };
};

try {

// ── 1 · a fresh visitor sees the welcome, and it is announced as one image ──
{
  const { pg, errs } = await freshPage();
  await gotoApp(pg, URL_, { freshVisitor: true });
  const t = await pg.evaluate(() => document.body.innerText);
  ok(/Know your rights at work/i.test(t), 'fresh visitor lands on the welcome screen');
  ok(!/Where do you work/i.test(t), 'welcome is shown INSTEAD of onboarding step 1, not alongside it');

  const art = await pg.evaluate(() => {
    const s = [...document.querySelectorAll('svg[role="img"]')]
      .find(el => /United States/i.test(el.getAttribute('aria-label') || ''));
    if (!s) return null;
    return {
      label: s.getAttribute('aria-label'),
      // Anything focusable or individually labelled inside would be announced
      // separately — the whole point of role="img" is that it is not.
      inner: s.querySelectorAll('[role],[aria-label],[tabindex]').length,
    };
  });
  ok(!!art, 'welcome illustration carries role="img" with a US-referencing label');
  ok(art && art.inner === 0, 'illustration announces as one image (no individually-labelled children)');
  ok(errs.length === 0, 'no console/page errors on the welcome screen' + (errs.length ? ': ' + errs[0] : ''));
  await pg.close();
}

// ── 2 · the primary CTA enters the app, and the welcome does not return ──
{
  const { pg } = await freshPage();
  await gotoApp(pg, URL_, { freshVisitor: true });
  await clickText(pg, 'Find my state’s rules');
  let t = await pg.evaluate(() => document.body.innerText);
  ok(/Where do you work/i.test(t), 'primary button enters onboarding');

  await reloadApp(pg);
  t = await pg.evaluate(() => document.body.innerText);
  ok(!/Know your rights at work/i.test(t), 'welcome does not replay on reload');
  await pg.close();
}

// ── 3 · Skip is a real exit, not decoration ──
{
  const { pg } = await freshPage();
  await gotoApp(pg, URL_, { freshVisitor: true });
  await clickText(pg, 'Skip');
  const t = await pg.evaluate(() => document.body.innerText);
  ok(/Where do you work/i.test(t), 'Skip leaves the welcome screen');
  await pg.close();
}

// ── 4 · clearing the case must NOT replay the intro ──
// The flag deliberately lives outside the case blob; if it ever moves into
// saveCase(), an existing user who starts a fresh case gets the first-run
// splash again. Simulate exactly that: case gone, welcome flag intact.
{
  const { pg } = await freshPage();
  await gotoApp(pg, URL_, { freshVisitor: true });
  await clickText(pg, 'Skip');
  await pg.evaluate(() => { try { localStorage.removeItem('worklaw.case.v2'); } catch (e) {} });
  await reloadApp(pg);
  const t = await pg.evaluate(() => document.body.innerText);
  ok(!/Know your rights at work/i.test(t), 'clearing the case does not replay the welcome');
  ok(/Where do you work/i.test(t), 'clearing the case still returns to onboarding');
  await pg.close();
}

// ── 5 · state map is an enhancement over the select, and has no dead tiles ──
{
  const { pg, errs } = await freshPage();
  await gotoApp(pg, URL_);           // seeded: straight to onboarding step 1
  const tiles = await pg.evaluate(() =>
    [...document.querySelectorAll('.wlStateBtn')].map(el => ({
      abbr: el.textContent.trim(), label: el.getAttribute('aria-label'),
    })));
  ok(tiles.length === 50, `map renders one tile per supported state (got ${tiles.length}, expected 50)`);
  ok(!tiles.some(t => t.abbr === 'DC' || t.abbr === 'PR'),
    'no tile for DC/PR — the app has no content file for either, so the tile would select nothing');
  ok(tiles.every(t => t.label && t.label.length > 2), 'every tile has a full state name as its accessible label');

  // The labelled <select> must still be present — the map never replaces it.
  ok(await pg.$('#onb-state') !== null, 'the conventional labelled <select> is still present alongside the map');

  // Picking on the map writes the same value the select reports.
  await pg.evaluate(() => {
    const el = [...document.querySelectorAll('.wlStateBtn')].find(e => e.textContent.trim() === 'CA');
    el && el.click();
  });
  await new Promise(r => setTimeout(r, 250));
  const sel = await pg.$eval('#onb-state', el => el.value);
  ok(sel === 'California', `map selection drives the same state as the select (got "${sel}")`);
  const pressed = await pg.evaluate(() =>
    document.querySelector('.wlStateBtn[aria-pressed="true"]')?.textContent.trim());
  ok(pressed === 'CA', 'the chosen tile reports aria-pressed="true"');
  ok(errs.length === 0, 'no console/page errors using the map' + (errs.length ? ': ' + errs[0] : ''));
  await pg.close();
}

// ── 6 · the grid data itself matches what ships in content/states ──
// Guards the inverse of test 5 at the source: if someone adds a state file
// without a tile, the map silently omits a supported state.
{
  const dev = readFileSync(join(ROOT, 'index.dev.html'), 'utf8');
  const gridAbbrs = [...dev.matchAll(/\['([A-Z]{2})',\d+,\d+\]/g)].map(m => m[1]);
  const shipped = readdirSync(join(ROOT, 'content/states'))
    .filter(f => f.endsWith('.json') && f !== '_TEMPLATE.json')
    .map(f => f.replace('.json', ''));
  const missing = shipped.filter(a => !gridAbbrs.includes(a));
  ok(missing.length === 0, 'every shipped state file has a tile in US_TILE_GRID' + (missing.length ? ': missing ' + missing.join(', ') : ''));
}

} finally {
  await b.close();
  server.close();
}

console.log(fails === 0 ? '\n✅ WELCOME / STATE-MAP PASSED' : `\n❌ ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
