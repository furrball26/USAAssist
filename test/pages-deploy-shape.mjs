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

const drive = async (browser, base) => {
  const pg = await browser.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('worklaw.seenWelcome.v1', '1'); } catch (e) {} });
  await pg.goto(base, { waitUntil: 'networkidle0', timeout: 40000 });
  await new Promise(r => setTimeout(r, 2200));
  const out = await pg.evaluate(() => ({
    shapes: document.querySelectorAll('.wlUsMap path[role="button"]').length,
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
    const r = await drive(browser, `http://127.0.0.1:${s.address().port}${PREFIX}/`);
    s.close();
    ok(r.shapes === 0, 'with _-paths excluded the map genuinely cannot render (reproduces the live failure)');
    ok(/couldn.t load/i.test(r.text),
       'a map that fails to load says so out loud instead of silently rendering nothing');
    ok(r.hasSelect, 'the select still works as the fallback when the map is unavailable');
  }
} finally {
  await browser.close();
}

console.log(fails === 0 ? '\n✅ PAGES-DEPLOY-SHAPE PASSED' : `\n❌ ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
