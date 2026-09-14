#!/usr/bin/env node
/*
 * GitHub Pages deploy-shape regression test.
 *
 * The maps vanished on the deployed site while every local test passed, because the
 * tests served the repo from the filesystem root and Pages does two things they did not:
 *
 *   1. It runs Jekyll, which SILENTLY excludes every path segment beginning with "_".
 *      content/_federal.json and content/geo/_states.json are exactly that, so both
 *      404'd in production. A repo-root .nojekyll file is the documented opt-out.
 *   2. It serves from a subpath (/USAAssist/), not from /.
 *
 * Neither failure is visible from inside the app: the fetch just fails, and the map
 * component rendered nothing at all, leaving a bare <select> that looked deliberate.
 *
 * So this test asserts the deploy SHAPE, and drives the app through a server that
 * reproduces both Pages behaviours — including the Jekyll exclusion, so that removing
 * .nojekyll fails the build rather than the live site.
 *
 * Run: node test/pages-deploy-shape.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { extname, join, normalize, relative } from 'node:path';
import { resolveChromePath } from './lib/chrome.mjs';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('..', import.meta.url).pathname;
let fails = 0;
const ok = (cond, msg) => { if (!cond) fails++; console.log((cond ? '✅ ' : '❌ ') + msg); };

// ── 1 · the opt-out must exist, because underscore paths are load-bearing ──
const hasNoJekyll = existsSync(ROOT + '.nojekyll');
ok(hasNoJekyll, '.nojekyll exists at the repo root (without it, Jekyll drops every _-prefixed path)');

const underscored = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.startsWith('_') && e.name.endsWith('.json') && p.includes('content')) underscored.push(relative(ROOT, p));
  }
})(ROOT + 'content');
ok(underscored.length > 0, `content/ does ship _-prefixed files, so .nojekyll is load-bearing (${underscored.join(', ')})`);

// ── 2 · drive the app through a server that behaves like Pages ──
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.svg':'image/svg+xml' };
const PREFIX = '/USAAssist';
// jekyll = true reproduces the 404 Pages serves for _-prefixed paths when .nojekyll is absent.
const makeServer = (jekyll) => createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (!p.startsWith(PREFIX)) { res.writeHead(404); res.end('outside subpath'); return; }
  p = p.slice(PREFIX.length) || '/';
  if (p === '/') p = '/index.html';
  if (jekyll && p.split('/').some(seg => seg.startsWith('_'))) { res.writeHead(404); res.end('jekyll excluded'); return; }
  const f = normalize(join(ROOT, p));
  if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});

/*
 * `offline` cuts the app off from CONTENT_FALLBACK_BASE (raw.githubusercontent.com).
 *
 * Without this the Jekyll case below is not a test of our code at all, it is a test of
 * whether the runner has internet: CI has it, so the fallback fetch succeeded, the map
 * rendered anyway, and the assertion failed. The sandbox this was written in blocks that
 * host, so it passed locally for an environmental reason. Blocking it explicitly makes
 * the case deterministic in both places — and narrows it to the thing actually under
 * test, which is what the app does when it cannot get the data at all.
 *
 * (That the fallback DID rescue the map in CI is worth keeping in mind: with the pin
 * repointed at a commit carrying content/geo/, it is now a genuine second line of
 * defence rather than a dead one.)
 */
const drive = async (browser, base, { offline = false } = {}) => {
  const pg = await browser.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  if (offline) {
    await pg.setRequestInterception(true);
    pg.on('request', (r) => {
      if (/raw\.githubusercontent\.com|cdn\.jsdelivr\.net/.test(r.url())) r.abort().catch(() => {});
      else r.continue().catch(() => {});
    });
  }
  await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('worklaw.seenWelcome.v1', '1'); } catch (e) {} });
  await pg.goto(base, { waitUntil: 'networkidle0', timeout: 40000 });
  await new Promise(r => setTimeout(r, 2200));
  const out = await pg.evaluate(() => ({
    // data-state, not role=button: this suite asks whether the geometry LOADED,
    // and nine states are drawn without being controls (see
    // test/small-state-targets.mjs). Counting controls here would report a
    // deploy-shape failure for an a11y decision.
    shapes: document.querySelectorAll('.wlUsMap path[data-state]').length,
    hasSelect: !!document.querySelector('#onb-state'),
    text: document.body.innerText,
  }));
  await pg.close();
  return { ...out, errs };
};

const browser = await puppeteer.launch({ executablePath: resolveChromePath(), headless: true, args: ['--no-sandbox'] });
try {
  // (a) Pages as it actually is, with .nojekyll honoured: the map must render.
  {
    const s = makeServer(false);
    await new Promise(r => s.listen(0, r));
    const r = await drive(browser, `http://127.0.0.1:${s.address().port}${PREFIX}/`);
    s.close();
    ok(r.shapes === 50, `served from a subpath, the US map renders all 50 states (got ${r.shapes})`);
    ok(r.hasSelect, 'the labelled state select is present alongside it');
    ok(r.errs.length === 0, 'no page errors when served from a subpath' + (r.errs.length ? ': ' + r.errs[0] : ''));
  }

  // (b) The regression itself: with Jekyll dropping _-paths, the map cannot load —
  //     and the app must SAY so rather than rendering a bare dropdown.
  {
    const s = makeServer(true);
    await new Promise(r => s.listen(0, r));
    const r = await drive(browser, `http://127.0.0.1:${s.address().port}${PREFIX}/`, { offline: true });
    s.close();
    ok(r.shapes === 0, 'with _-paths excluded and no fallback reachable, the map genuinely cannot render (reproduces the live failure)');
    ok(/couldn.t load/i.test(r.text),
       'a map that fails to load says so out loud instead of silently rendering nothing');
    ok(r.hasSelect, 'the select still works as the fallback when the map is unavailable');
  }
  // (c) The same Jekyll breakage, but with CONTENT_FALLBACK_BASE answering, must recover.
  //
  //     The fallback is FULFILLED FROM LOCAL DISK rather than fetched for real. Probing
  //     the live host first was the obvious approach and was wrong twice over: Node's
  //     fetch and Chrome's take different network paths here, so the probe said
  //     "reachable" while the browser's request failed. What is worth asserting is the
  //     app's retry logic — that fetchContentJson falls back and the app recovers — and
  //     that is testable without any network at all.
  {
    const s = makeServer(true);   // Jekyll still dropping every _-prefixed path
    await new Promise(r => s.listen(0, r));
    const pg = await browser.newPage();
    const served = [];
    await pg.setRequestInterception(true);
    pg.on('request', (r) => {
      const m = r.url().match(/raw\.githubusercontent\.com\/furrball26\/USAAssist\/[0-9a-f]{40}\/(.+)$/);
      if (m) {
        const f = normalize(join(ROOT, m[1]));
        if (f.startsWith(ROOT) && existsSync(f)) {
          served.push(m[1]);
          // Access-Control-Allow-Origin is required: this stands in for a cross-origin
          // host, and without it the browser blocks the response and the retry looks
          // like it failed — which is what the real raw.githubusercontent.com sends.
          r.respond({
            status: 200,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: readFileSync(f),
          }).catch(() => {});
          return;
        }
        r.abort().catch(() => {});
        return;
      }
      r.continue().catch(() => {});
    });
    await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('worklaw.seenWelcome.v1', '1'); } catch (e) {} });
    await pg.goto(`http://127.0.0.1:${s.address().port}${PREFIX}/`, { waitUntil: 'networkidle0', timeout: 40000 });
    await new Promise(r => setTimeout(r, 2200));
    const shapes = await pg.evaluate(() => document.querySelectorAll('.wlUsMap path[data-state]').length);
    await pg.close();
    s.close();
    ok(served.includes('content/geo/_states.json'),
       'a 404 on the primary path actually triggers the CONTENT_FALLBACK_BASE retry');
    ok(shapes === 50,
       'the fallback recovers the map — so the pin must point at a commit that has content/geo/ (the old one did not)');
  }

} finally {
  await browser.close();
}

console.log(fails === 0 ? '\n✅ PAGES-DEPLOY-SHAPE PASSED' : `\n❌ ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
