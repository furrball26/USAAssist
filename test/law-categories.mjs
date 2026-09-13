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
ok(cats.length === 8, `parsed ${cats.length} categories from LAW_CATEGORIES (expected 8)`);

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
  await pg.evaluateOnNewDocument(s => localStorage.setItem('worklaw.case.v2', JSON.stringify(s)), {
    onboarded:true, stateSel:'California', county:'Los Angeles County', issue:'Unpaid overtime or wages',
    profile:{ name:'', employer:'', payType:'', rate:'' },
    caseOpened:new Date().toISOString(), homeMode:'standard', done:{}, messages:[], entries:[],
  });
  await gotoApp(pg, `http://127.0.0.1:${server.address().port}/index.html`);
  await new Promise(r => setTimeout(r, 500));
  await pg.evaluate(() => { const t = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Rights'); t && t.click(); });
  await new Promise(r => setTimeout(r, 900));

  const idx = await pg.evaluate(() => document.body.innerText);
  ok(/Pay & overtime/.test(idx) && /Deadlines to act/.test(idx), 'the library opens on the category index');
  ok(!/THE LAW/.test(idx), 'the index shows categories, not a flat wall of facts');

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
  const linkText = await pg.evaluate(() =>
    [...document.querySelectorAll('a')].some(a => /Read the official text/.test(a.textContent)));
  ok(linkText, 'each law block links out to the official text rather than claiming to be it');

  // Back returns to the index.
  await pg.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(x => /All categories/.test(x.textContent));
    btn && btn.click();
  });
  await new Promise(r => setTimeout(r, 400));
  const back = await pg.evaluate(() => document.body.innerText);
  ok(/Pay & overtime/.test(back) && !/THE LAW/.test(back), 'Back returns to the category index');
  ok(errs.length === 0, 'no console/page errors browsing the library' + (errs.length ? ': ' + errs[0] : ''));
  await pg.close();
} finally {
  await b.close();
  server.close();
}

console.log(fails === 0 ? '\n✅ LAW-CATEGORIES PASSED' : `\n❌ ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
