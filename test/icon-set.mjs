#!/usr/bin/env node
/*
 * Custom icon set regression test (design-desktop-icons.md, Part 1).
 *
 * The app used to render bare Unicode glyphs (⌂ ✦ ◷ ⚖ ◉ ⏱ ▤ ✎ ‹ ✓ ←) as plain
 * text spans. All were replaced with the shared <Icon name=".." /> inline-SVG
 * component. This guards against a regression back to bare glyph text, and
 * confirms every call site actually renders a real <svg> — an unknown or
 * typo'd icon name silently renders nothing, per Icon()'s own contract, so
 * "no bare glyph" alone is not enough.
 *
 * Each law topic also carries its own icon; a missing one is exactly the kind
 * of silent nothing this guards against, so the topic grid is counted too.
 *
 * Run: node test/icon-set.mjs
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

// The 11 glyphs the icon set replaced, plus the "←" back-link arrow. These
// must never again appear as *visible page text* (they're fine inside JS
// comments/strings baked into inline <script>, so we scope the check to the
// rendered #root DOM's textContent, not the raw HTML source). "§" is
// deliberately excluded — it's the correct, legitimate legal-citation symbol
// used throughout real content (e.g. "29 C.F.R. §541.600") and was only ever
// a glyph-icon in the Rights-tab/exempt-tool call sites, which the SVG count
// assertions below already cover.
const BANNED_GLYPHS = ['⌂', '✦', '◷', '⚖', '◉', '⏱', '▤', '✎', '‹', '✓', '←', '⚠'];

const PLACE = { state: 'Texas', county: 'Travis County' };

async function open(pg, place = PLACE) {
  await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`, { place });
  await new Promise(r => setTimeout(r, 800));
}
const rootText = (pg) => pg.evaluate(() => document.getElementById('root').textContent);
const svgCount = (pg) => pg.evaluate(() => document.querySelectorAll('#root svg').length);
const click = async (pg, t) => {
  await pg.evaluate((x) => { const e = [...document.querySelectorAll('button,a')].find(el => el.textContent.includes(x)); e && e.click(); }, t);
  await new Promise(r => setTimeout(r, 450));
};
const newPage = async () => {
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  return { pg, errs };
};

async function check(label, minSvgs, walk, place) {
  const { pg, errs } = await newPage();
  await open(pg, place);
  await walk(pg);
  const text = await rootText(pg);
  const svgs = await svgCount(pg);
  const problems = [];
  BANNED_GLYPHS.forEach(g => { if (text.includes(g)) problems.push('bare glyph "' + g + '" still present as visible text on ' + label); });
  if (svgs < minSvgs) problems.push('expected at least ' + minSvgs + ' <svg> icons on ' + label + ', found ' + svgs);
  errs.forEach(e => problems.push(e));
  await pg.close();
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' ' + label + ': icon set renders, no bare glyphs' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

// Tab bar (3) + location pill (1) + one icon per law topic (8).
await check('Laws (topic grid)', 12, async () => {});
await check('Laws (one topic)', 4, async (pg) => { await click(pg, 'Pay & overtime'); });
await check('Self-check', 4, async (pg) => {
  await click(pg, 'Pay & overtime');
  await click(pg, 'Am I exempt from overtime?');
});
await check('All rights', 3, async (pg) => { await click(pg, 'All rights'); });
await check('Agencies', 4, async (pg) => { await click(pg, 'Agencies'); });

// The two map steps, which is where the back chevrons live.
await check('State map', 3, async () => {}, { state: '', county: '' });
await check('County map', 4, async (pg) => { await click(pg, 'Texas'); }, { state: '', county: '' });

// Every topic must actually resolve an icon — Icon() renders nothing at all
// for a name that isn't in ICON_PATHS, which is invisible in a glyph check.
{
  const { pg, errs } = await newPage();
  await open(pg);
  const withoutIcon = await pg.evaluate(() =>
    [...document.querySelectorAll('.catgrid button')]
      .filter(b => !b.querySelector('svg'))
      .map(b => (b.innerText || '').split('\n')[0]));
  const cards = await pg.evaluate(() => document.querySelectorAll('.catgrid button').length);
  await pg.close();
  const problems = [];
  if (cards === 0) problems.push('no topic cards rendered at all');
  if (withoutIcon.length) problems.push('topic card(s) with no icon: ' + withoutIcon.join(', '));
  errs.forEach(e => problems.push(e));
  const ok = problems.length === 0;
  if (!ok) fails++;
  console.log((ok ? '✅' : '❌') + ' every law topic resolves a real icon' + (ok ? '' : '\n   ' + problems.join('\n   ')));
}

} finally {
  await b.close();
  server.close();
}
console.log(fails ? `\n❌ ${fails} case(s) failed` : '\n✅ ALL ICON-SET CASES PASSED');
process.exit(fails ? 1 : 0);
