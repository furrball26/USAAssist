#!/usr/bin/env node
/*
 * The city step (index.dev.html: LawsHome, "stop 2b").
 *
 * US local wage ordinances are MUNICIPAL. Los Angeles County alone holds five
 * that disagree: West Hollywood $20.25, Pasadena $18.57, unincorporated county
 * $18.47, City of Los Angeles $18.42 — a near two-dollar spread inside one
 * county. Picking a county therefore cannot decide what someone is owed, and
 * the app used to respond by listing every locality and leaving the reader to
 * work out which was theirs.
 *
 * This suite protects the three properties that make the step worth its tap:
 *   1. it is asked ONLY where it changes the answer (>1 locality held),
 *   2. it is never a dead end — "somewhere else" always gets you through,
 *   3. the choice actually propagates: it is named on screen, it is stored,
 *      and it survives a reload.
 *
 * Run: node test/city-step.mjs
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
const BASE = `http://127.0.0.1:${server.address().port}/index.html`;
const browser = await puppeteer.launch({ executablePath: resolveChromePath(), headless: true, args: ['--no-sandbox'] });

const open = async (place) => {
  const pg = await browser.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  await pg.setViewport({ width: 390, height: 844 });
  await gotoApp(pg, BASE, { place });
  await new Promise(r => setTimeout(r, 1200));
  return { pg, errs };
};
const clickStarting = (pg, prefix) => pg.evaluate((p) => {
  const b = [...document.querySelectorAll('button')].find(el => (el.textContent || '').trim().startsWith(p));
  if (!b) return false;
  b.click(); return true;
}, prefix);

try {
  // ── 1 · asked where it changes the answer ──
  {
    const { pg, errs } = await open({ state: 'California', county: 'Los Angeles County', city: '' });
    const txt = await pg.evaluate(() => document.body.innerText);
    ok(/Where in Los Angeles County do you work\?/i.test(txt),
       'a county holding several municipal ordinances asks which city');
    for (const name of ['West Hollywood', 'City of Los Angeles', 'Pasadena']) {
      ok(txt.includes(name), `the city step offers ${name}`);
    }
    ok(/Somewhere else in Los Angeles County/i.test(txt),
       'there is always a way through for a town we do not hold');
    ok(errs.length === 0, 'no console/page errors on the city step' + (errs.length ? ': ' + errs[0] : ''));
    await pg.close();
  }

  // ── 2 · NOT asked where it would change nothing ──
  // A county with no local ordinances on file must not interrupt the reader to
  // ask a question whose answer cannot affect a single figure on screen.
  {
    const { pg } = await open({ state: 'California', county: 'Alpine County', city: '' });
    const txt = await pg.evaluate(() => document.body.innerText);
    ok(!/do you work\?/i.test(txt) && /Your rights in California/i.test(txt),
       'a county with no local ordinances on file skips the question entirely');
    await pg.close();
  }

  // ── 3 · the choice propagates, and survives a reload ──
  {
    const { pg } = await open({ state: 'California', county: 'Los Angeles County', city: '' });
    ok(await clickStarting(pg, 'West Hollywood'), 'the West Hollywood option is clickable');
    await new Promise(r => setTimeout(r, 900));
    const after = await pg.evaluate(() => document.body.innerText);
    ok(/Your rights in California/i.test(after), 'picking a city continues to the law');
    ok(/West Hollywood/.test(after), 'the chosen city is named on screen, so the reader can see what the figures are keyed to');

    const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('worklaw.place.v1') || '{}'));
    ok(stored.city === 'West Hollywood', `the city is stored (got "${stored.city}")`);
    await pg.close();
  }

  // ── 3b · a returning reader is not asked twice ──
  /* Deliberately a fresh page with the city already seeded, NOT a reload of the
     page above: the harness seeds through evaluateOnNewDocument, which re-runs
     on every navigation and would re-apply city:'' over whatever the app just
     saved. That would have measured the harness, not the app. */
  {
    const { pg } = await open({ state: 'California', county: 'Los Angeles County', city: 'West Hollywood' });
    const txt = await pg.evaluate(() => document.body.innerText);
    ok(!/do you work\?/i.test(txt) && /Your rights in California/i.test(txt),
       'a reader whose city is already known is not asked for it again');
    ok(/West Hollywood/.test(txt), 'and their city is still what the figures are keyed to');
    await pg.close();
  }

  // ── 4 · "somewhere else" is a real answer, not a dead end ──
  {
    const { pg } = await open({ state: 'California', county: 'Los Angeles County', city: '' });
    ok(await clickStarting(pg, 'Somewhere else'), 'the fallback option is clickable');
    await new Promise(r => setTimeout(r, 900));
    const after = await pg.evaluate(() => document.body.innerText);
    ok(/Your rights in California/i.test(after),
       'not knowing your city still gets you the state and federal law');
    await pg.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(fails ? `\n❌ CITY-STEP FAILED (${fails})` : '\n✅ CITY-STEP PASSED');
process.exit(fails ? 1 : 0);
