#!/usr/bin/env node
/*
 * Law-category browse layer (index.dev.html: LAW_CATEGORIES, factsInCategory,
 * RightsLib) and the two-layer fact card.
 *
 * Part 1 is static and is the part that matters most: every topic prefix that
 * ships in content/ must be claimed by exactly one category. Without this, a
 * new prefix added by wl-content lands in no category and its facts become
 * invisible in the library — present in the data, unreachable in the UI, with
 * nothing failing. That is the silent-gap failure mode the 2026-08-29 audit
 * kept finding, so it gets a hard assertion rather than a rendering check.
 *
 * Part 2 drives the app: the index lists categories, opening one shows its
 * facts (state before federal), Back returns, and each card puts the
 * plain-English summary ABOVE a distinct "THE LAW" block carrying the
 * citation and a link to the official text.
 *
 * Run: node test/law-categories.mjs
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

// ── Part 1 · taxonomy covers the data (no browser) ──────────────────────────
const dev = readFileSync(join(ROOT, 'index.dev.html'), 'utf8');
const block = dev.slice(dev.indexOf('const LAW_CATEGORIES = ['), dev.indexOf('const TOPIC_PREFIX_CATEGORY'));
const cats = [...block.matchAll(/\{ key:'([a-z]+)',[\s\S]*?prefixes:\[([^\]]+)\]/g)]
  .map(m => ({ key: m[1], prefixes: m[2].split(',').map(s => s.trim().replace(/^'|'$/g, '')) }));
// Guard the PARSE, not the product decision. A hardcoded count fails whenever
// the taxonomy is deliberately reshaped (8 -> 6 when disability folded into
// discrimination) while still missing the thing worth catching: a regex that
// quietly stops matching and leaves later assertions grading an empty list.
const declared = (block.match(/\{ key:'/g) || []).length;
ok(cats.length === declared && cats.length > 0,
   `parsed every declared category (${cats.length} of ${declared})`);

const owner = {};
let dupes = [];
cats.forEach(c => c.prefixes.forEach(p => {
  if (owner[p]) dupes.push(`${p} claimed by both ${owner[p]} and ${c.key}`);
  owner[p] = c.key;
}));
ok(dupes.length === 0, 'no prefix is claimed by two categories' + (dupes.length ? ': ' + dupes.join('; ') : ''));

const files = ['content/_federal.json'].concat(
  readdirSync(join(ROOT, 'content/states'))
    .filter(f => f.endsWith('.json') && f !== '_TEMPLATE.json')
    .map(f => 'content/states/' + f));
const seen = new Set();
let factCount = 0;
for (const f of files) {
  const j = JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
  for (const fact of j.facts || []) { factCount++; seen.add(String(fact.topic || '').split('.')[0]); }
}
const unmapped = [...seen].filter(p => !owner[p]);
ok(unmapped.length === 0,
  `every topic prefix shipping in content/ is mapped to a category (${seen.size} prefixes, ${factCount} facts)` +
  (unmapped.length ? ` — UNMAPPED: ${unmapped.join(', ')} (their facts would be unreachable in the library)` : ''));

const unused = Object.keys(owner).filter(p => !seen.has(p));
ok(unused.length === 0, 'no category claims a prefix that no longer ships' + (unused.length ? ': ' + unused.join(', ') : ''));

// ── Part 2 · the browse layer in the app ────────────────────────────────────
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.svg':'image/svg+xml' };
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
  // The browse layer is the Laws tab now, reached by having a place already
  // picked — the category grid IS the landing screen once located.
  await gotoApp(pg, `http://127.0.0.1:${server.address().port}/index.html`,
    { place: { state: 'California', county: 'Los Angeles County' } });
  await new Promise(r => setTimeout(r, 900));

  const idx = await pg.evaluate(() => document.body.innerText);
  // Two domains from opposite ends of the list, so the assertion proves the whole
  // grid rendered rather than just its first card.
  ok(/Pay & overtime/.test(idx) && /Deadlines & what you can recover/.test(idx),
     'the Laws tab opens on the topic grid');
  ok(!/THE LAW/.test(idx), 'the grid shows topics, not a flat wall of facts');

  // Opening a category shows its facts, state before federal.
  await pg.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(x => /Pay & overtime/.test(x.textContent));
    btn && btn.click();
  });
  await new Promise(r => setTimeout(r, 500));
  const cat = await pg.evaluate(() => document.body.innerText);
  ok(/THE LAW/.test(cat), 'opening a category renders fact cards with a THE LAW block');
  ok(/CALIFORNIA|CA/.test(cat) && /FEDERAL — APPLIES NATIONWIDE/.test(cat), 'the category shows both state and federal rules');
  const order = cat.indexOf('FEDERAL — APPLIES NATIONWIDE');
  const stIdx = cat.search(/CALIFORNIA/);
  ok(stIdx !== -1 && order !== -1 && stIdx < order, 'state rules come before the federal floor');

  // Every card must lead with plain English, then cite.
  const cards = await pg.evaluate(() =>
    [...document.querySelectorAll('div')]
      .filter(d => /^THE LAW$/m.test(d.innerText || '') && d.querySelectorAll('div').length < 4)
      .length);
  ok(cards > 0, `fact cards render a distinct THE LAW block (${cards} found)`);
  /* Checks the behaviour, not the wording: this used to pin the exact string
     "Read the official text", so rewording the link failed a suite that has
     nothing to do with the wording. What must hold is that every law block
     sends the reader to the authority instead of posing as it. */
  const outbound = await pg.evaluate(() =>
    [...document.querySelectorAll('a')]
      .filter(a => /official text/i.test(a.textContent || ''))
      .map(a => ({ href: a.href, offOrigin: new URL(a.href).origin !== location.origin })));
  ok(outbound.length > 0 && outbound.every(l => /^https:\/\//.test(l.href) && l.offOrigin),
     `each law block links out to the official text rather than claiming to be it (${outbound.length})`);

  // Back returns to the index.
  await pg.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(x => /All topics/.test(x.textContent));
    btn && btn.click();
  });
  await new Promise(r => setTimeout(r, 400));
  const back = await pg.evaluate(() => document.body.innerText);
  ok(/Pay & overtime/.test(back) && !/THE LAW/.test(back), 'Back returns to the topic grid');
  ok(errs.length === 0, 'no console/page errors browsing the library' + (errs.length ? ': ' + errs[0] : ''));
  await pg.close();
} finally {
  await b.close();
  server.close();
}

console.log(fails === 0 ? '\n✅ LAW-CATEGORIES PASSED' : `\n❌ ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
